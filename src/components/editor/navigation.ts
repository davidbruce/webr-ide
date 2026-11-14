// Moving around code: open a file at a range, go to a function's definition
// (F2, and ⌘-click / F12 through Monaco's definition provider and editor
// opener), and R help for the name at the cursor.

import { onCleanup } from 'solid-js';
import { monaco, softFocus } from '../../lib/monaco';
import { showPane, session } from '../../lib/ide';
import { toast } from '../../lib/ui';
import { findDefinitions, symbolAt, type DefinitionHit } from '../../lib/language';
import { openHelp } from '../../lib/help';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';

export type NavigationCtx = ReturnType<typeof createNavigation>;

export function createNavigation(view: EditorView, tc: TabsCtx) {
  const { tabs, models, patchTab, activate, openFile } = tc;

  const keyOfUri = (uri: monaco.Uri) => tabs.list.find((t) => models.get(t.key)?.uri.toString() === uri.toString())?.key ?? null;
  const pathOfUri = (uri: monaco.Uri) => tabs.list.find((t) => t.key === keyOfUri(uri))?.path ?? null;

  function select(range: monaco.IRange) {
    view.ed.setSelection(range);
    view.ed.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
  }

  async function openAt(path: string, line: number, column: number, endLine = line, endColumn = column) {
    await openFile(path);
    const t = tabs.list.find((x) => x.path === path);
    if (!t || t.gridOnly) return;
    if (t.mode === 'grid') patchTab(t.key, { mode: 'text' });
    showPane('script');
    select(new monaco.Range(line, column, endLine, endColumn));
    softFocus(view.ed);
  }

  function jumpTo(hit: DefinitionHit) {
    const key = hit.uri && keyOfUri(hit.uri);
    if (key) {
      activate(key);
      select(new monaco.Range(hit.line, hit.column, hit.line, hit.column));
    } else if (hit.path) void openAt(hit.path, hit.line, hit.column);
  }

  /** R help for the name at the cursor, in the Help tab. */
  function helpAtCursor() {
    const model = view.ed?.getModel();
    const pos = view.ed?.getPosition();
    const sym = model && pos ? symbolAt(model, pos) : null;
    if (!sym) return toast('Put the cursor on a function name to see its help', 'warn');
    showHelp(sym.name);
  }

  function showHelp(name: string) {
    if (session.status !== 'ready') return toast('R is still starting…', 'warn');
    const [pkg, topic] = name.includes('::') ? name.split(/:::?/) : [null, name];
    void openHelp(topic, pkg ?? '');
  }

  async function goToDefinition() {
    const model = view.ed?.getModel();
    const pos = view.ed?.getPosition();
    const sym = model && pos ? symbolAt(model, pos) : null;
    if (!sym) return;
    if (!sym.name.includes('::')) {
      const hits = await findDefinitions(sym.name, model, pathOfUri);
      // Not on the definition itself: jump to the first one elsewhere.
      const target = hits.find((h) => !(h.uri?.toString() === model!.uri.toString() && h.line === pos!.lineNumber)) ?? hits[0];
      if (target) return jumpTo(target);
    }
    toast(`${sym.name} isn't defined in this workspace — showing its help`);
    showHelp(sym.name);
  }

  /** Register the definition provider and editor opener (disposed on cleanup). Call from onMount. */
  function registerProviders() {
    // ⌘-click / F12 on a function: its definition in an open tab.
    const defProvider = monaco.languages.registerDefinitionProvider(['r', 'quarto'], {
      async provideDefinition(model, position) {
        const sym = symbolAt(model, position);
        if (!sym || sym.name.includes('::')) return null;
        const hits = await findDefinitions(sym.name, model, pathOfUri);
        return hits.map((h) => ({
          uri: h.uri ?? monaco.Uri.from({ scheme: 'webr-ws', path: `/${h.path}` }),
          range: new monaco.Range(h.line, h.column, h.line, h.column + sym.name.length),
        }));
      },
    });
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, sel) {
        const at = sel && 'startLineNumber' in sel ? sel : sel ? { startLineNumber: sel.lineNumber, startColumn: sel.column, endLineNumber: sel.lineNumber, endColumn: sel.column } : null;
        if (resource.scheme === 'webr-ws') {
          const path = decodeURIComponent(resource.path.slice(1));
          void openAt(path, at?.startLineNumber ?? 1, at?.startColumn ?? 1, at?.endLineNumber, at?.endColumn);
          return true;
        }
        const key = keyOfUri(resource);
        if (!key) return false;
        activate(key);
        if (at) select(at);
        return true;
      },
    });
    onCleanup(() => {
      defProvider.dispose();
      opener.dispose();
    });
  }

  return { openAt, helpAtCursor, goToDefinition, registerProviders };
}
