// Breakpoints and debugging in the editor: breakpoint dots in the gutter
// (and which lines R can actually stop at), the highlighted line where R is
// paused, and the read-only view of a paused function that has no file.

import { createEffect, createSignal, on, untrack } from 'solid-js';
import { monaco } from '../../lib/monaco';
import { session, state, setBreakpoints, applyBreakpoints } from '../../lib/ide';
import { rString } from '../../lib/r-session';
import { toast } from '../../lib/ui';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';
import type { NavigationCtx } from './navigation';

/**
 * Breakpoint and debug-line state for one editor pane. Call `attach()` from
 * onMount, once the editor exists: it adds the decorations, gutter clicks
 * and the effects that keep them current.
 */
export function createDebugging(view: EditorView, tc: TabsCtx, nav: Pick<NavigationCtx, 'openAt'>) {
  const { tabs, setTabs, models, markSaved, activeTab, isR, patchTab, createModel, activate, closeTab } = tc;
  const { openAt } = nav;

  let bpDecos: monaco.editor.IEditorDecorationsCollection | undefined;
  let debugDecos: monaco.editor.IEditorDecorationsCollection | undefined;
  /** Breakpoint lines R can actually stop at (inside functions), per path. */
  const [validBps, setValidBps] = createSignal<Record<string, Set<number>>>({});

  function renderBreakpoints() {
    const t = activeTab();
    const model = view.ed?.getModel();
    if (!bpDecos || !model) return;
    const lines = t?.path && t.language === 'r' ? (state.breakpoints[t.path] ?? []) : [];
    const valid = t?.path ? validBps()[t.path] : undefined;
    bpDecos.set(
      lines
        .filter((l) => l <= model.getLineCount())
        .map((l) => {
          const ok = !valid || valid.has(l);
          return {
            range: new monaco.Range(l, 1, l, 1),
            options: {
              isWholeLine: true,
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              glyphMarginClassName: ok ? 'bp-dot' : 'bp-dot inactive',
              lineNumberClassName: ok ? 'bp-line-number' : 'bp-line-number inactive',
              glyphMarginHoverMessage: {
                value: ok ? 'Breakpoint: R stops here when the function runs (after you Source the file)' : 'R can only stop inside a function; this line is outside one',
              },
            },
          };
        }),
    );
  }

  /** Ask R which breakpoint lines are inside functions (where it can stop). */
  async function checkBreakpoints(path: string) {
    const lines = state.breakpoints[path] ?? [];
    const t = tabs.list.find((x) => x.path === path);
    const model = t && models.get(t.key);
    if (!model || !lines.length || session.status !== 'ready' || !(await session.waitIdle(2000))) return;
    try {
      const ok = await session.strings(`as.character(.ide_bp_valid(${rString(model.getValue())}, c(${lines.join(',')})))`);
      setValidBps((v) => ({ ...v, [path]: new Set(ok.map(Number)) }));
    } catch {
      /* leave unknown */
    }
  }

  function toggleBreakpoint(line: number) {
    const t = activeTab();
    if (!t || t.language !== 'r' || t.debugView) return;
    if (!t.path) return toast('Save the file first: breakpoints apply when a saved file is sourced', 'warn');
    const cur = state.breakpoints[t.path] ?? [];
    setBreakpoints(t.path, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
    renderBreakpoints();
    void checkBreakpoints(t.path);
    void applyBreakpoints(t.path);
  }

  /** Line to highlight in the read-only view of a function without a file. */
  const [viewLine, setViewLine] = createSignal<number | null>(null);

  /** Highlight where R is paused (and open that file). */
  function renderDebugLine() {
    const loc = state.debug?.location;
    const frame = state.debug && state.debug.stack[state.debug.frame];
    const at = frame?.path && frame.line ? { path: frame.path, line: frame.line } : loc;
    const t = activeTab();
    const line = t?.debugView ? viewLine() : at?.path && t?.path === at.path ? at.line : null;
    debugDecos?.set(
      line ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'debug-line', glyphMarginClassName: 'debug-arrow' } }] : [],
    );
  }

  /**
   * Paused in a function without a file (typed in the console, or from a
   * package): show its source read-only, with the current line if R knows it.
   */
  async function showDebugView(frameIndex: number, rLine: number | null) {
    let res: string[];
    try {
      res = await session.strings(`.ide_debug_fun_view(${frameIndex}L)`);
    } catch {
      return;
    }
    const [name, text, start] = res;
    if (text === undefined) return;
    let tab = tabs.list.find((t) => t.debugView);
    if (tab) {
      const m = models.get(tab.key)!;
      if (m.getValue() !== text) {
        m.setValue(text);
        markSaved(tab.key, m.getAlternativeVersionId(), text);
        patchTab(tab.key, { dirty: false });
      }
      patchTab(tab.key, { name: `${name}()` });
    } else {
      const { key } = createModel(text, `${name}.R`);
      setTabs('list', (l) => [...l, { key, path: null, name: `${name}()`, dirty: false, language: 'r', mode: 'text', gridOnly: false, fileVersion: 0, debugView: true }]);
      tab = tabs.list.find((t) => t.key === key)!;
    }
    if (tabs.active !== tab.key) activate(tab.key);
    // R counts lines in the source reference; the view starts at the function.
    const line = rLine && start ? rLine - Number(start) + 1 : null;
    setViewLine(line && line >= 1 ? line : null);
    if (line) view.ed.revealLineInCenterIfOutsideViewport(line);
    renderDebugLine();
  }

  function closeDebugView() {
    const t = tabs.list.find((x) => x.debugView);
    if (t) void closeTab(t.key, true);
  }

  /** Decorations, gutter clicks and effects. Call from onMount (needs the editor). */
  function attach() {
    const ed = view.ed;
    bpDecos = ed.createDecorationsCollection();
    debugDecos = ed.createDecorationsCollection();
    // Breakpoints: click the margin (or, on touch screens, a line number).
    const touch = window.matchMedia('(pointer: coarse)').matches;
    ed.onMouseDown((e) => {
      const T = monaco.editor.MouseTargetType;
      const onGutter = e.target.type === T.GUTTER_GLYPH_MARGIN || (touch && e.target.type === T.GUTTER_LINE_NUMBERS);
      if (onGutter && e.target.position && isR()) toggleBreakpoint(e.target.position.lineNumber);
    });
    // Breakpoints move with the lines they're on.
    let bpTimer: number | undefined;
    ed.onDidChangeModelContent(() => {
      const t = activeTab();
      const model = ed.getModel();
      if (!t?.path || !model || !(state.breakpoints[t.path] ?? []).length) return;
      const lines = bpDecos!.getRanges().map((r) => r.startLineNumber);
      const now = state.breakpoints[t.path] ?? [];
      // Most edits don't move a breakpoint: leave the list (and what tracks it) alone.
      if (lines.length !== now.length || lines.some((l, i) => l !== now[i])) {
        // Lines that moved keep what R said about them (until it's asked again).
        const valid = validBps()[t.path];
        if (valid && lines.length === now.length) setValidBps((v) => ({ ...v, [t.path!]: new Set(lines.filter((_, i) => valid.has(now[i]))) }));
        setBreakpoints(t.path, lines);
      }
      clearTimeout(bpTimer);
      bpTimer = window.setTimeout(() => {
        void checkBreakpoints(t.path!);
        void applyBreakpoints(t.path!);
      }, 800);
    });
    createEffect(() => {
      const path = activeTab()?.path;
      void (path && state.breakpoints[path]?.join());
      void validBps();
      renderBreakpoints();
    });
    // Which breakpoints R can stop at: when a file opens or R becomes ready
    // (edits are checked after a pause in typing, above).
    createEffect(
      on([() => activeTab()?.path, () => state.rStatus], ([path, status]) => {
        if (path && status === 'ready' && untrack(() => (state.breakpoints[path] ?? []).length)) void checkBreakpoints(path);
      }),
    );
    // Paused: open the file at the current line and highlight it.
    createEffect(
      on(
        () => {
          const d = state.debug;
          const f = d && d.stack[d.frame];
          return d ? `${f?.path ?? d.location?.path}:${f?.line ?? d.location?.line}` : '';
        },
        () => {
          const d = state.debug;
          const f = d && d.stack[d.frame];
          if (!d) {
            closeDebugView();
            return;
          }
          const at = f?.path && f.line ? { path: f.path, line: f.line } : d.location;
          if (at?.path) {
            if (activeTab()?.path !== at.path) void openAt(at.path, at.line, 1);
            else ed.revealLineInCenterIfOutsideViewport(at.line);
          } else if (f) {
            // No file: a read-only view of the function.
            void showDebugView(f.index, f.line ?? d.location?.line ?? null);
          }
          queueMicrotask(renderDebugLine);
        },
      ),
    );
    createEffect(() => {
      void tabs.active;
      renderDebugLine();
    });
  }

  return { attach };
}
