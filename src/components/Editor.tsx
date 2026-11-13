import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { Portal } from 'solid-js/web';
import { monaco, languageFor, statementEnd, isTabularName, TEXT_VIEW_MAX, GRID_MAX, extOf, inRChunk, softFocus } from '../lib/monaco';
import { attachNotebook, type NotebookControls } from './Notebook';
import { preview, renderDocument } from '../lib/render';
import { nb, setOutputMode, stopChunks, anyRunning, runsFor, inlinesFor, setDocPath, moveSavedOutput } from '../lib/notebook';
import { FileSource } from '../lib/grid/source';
import { DataGrid } from './DataGrid';
import { formatBytes } from '../lib/ui';
import { downloadPath, isInstalling, phone, rRoot, showPane, withoutPaneSwitch } from '../lib/ide';
import * as fs from '../lib/opfs';
import {
  registerEditor,
  session,
  state,
  writeWorkspaceFile,
  scheduleIdeStateSave,
  rDisplayPath,
  EditorApi,
  setState,
} from '../lib/ide';
import { rString } from '../lib/r-session';
import { askText, choiceDialog, confirmDialog, isDark, kbd, toast } from '../lib/ui';
import { Icon } from './Icon';
import { PaneHeader } from './Pane';
import { consoleApi } from './Console';
import { outline, rRegions, styleCode, findDefinitions, symbolAt, type OutlineItem, type DefinitionHit } from '../lib/language';
import { installPackages } from '../lib/pkg-actions';
import { openShortcuts } from './Shortcuts';
import { openFindInFiles } from './SearchPanel';
import { desktopEditing } from '../lib/input-mode';
import { settings, openSettings } from '../lib/settings';

interface Tab {
  key: string;
  path: string | null; // null = untitled
  name: string;
  dirty: boolean;
  language: string;
  mode: 'text' | 'grid';
  gridOnly: boolean; // too large for the text editor (no Monaco model)
  fileVersion: number; // bumped when the file changes on disk, to reload the grid
}

export function EditorPane() {
  let host!: HTMLDivElement;
  let ed: monaco.editor.IStandaloneCodeEditor;
  let notebook: NotebookControls | undefined;
  const [tabs, setTabs] = createStore<{ list: Tab[]; active: string | null }>({ list: [], active: null });
  const models = new Map<string, monaco.editor.ITextModel>();
  const savedVersion = new Map<string, number>();
  const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  let keySeq = 0;
  let untitledSeq = 0;

  const activeTab = () => tabs.list.find((t) => t.key === tabs.active) ?? null;
  const isR = () => activeTab()?.language === 'r';
  const isNb = () => activeTab()?.language === 'quarto';
  const isTabular = () => !!activeTab() && isTabularName(activeTab()!.name);
  const inGrid = () => activeTab()?.mode === 'grid';

  function patchTab(key: string, patch: Partial<Tab>) {
    const i = tabs.list.findIndex((t) => t.key === key);
    if (i >= 0) setTabs('list', i, patch);
  }

  function createModel(content: string, name: string): { key: string; model: monaco.editor.ITextModel; language: string } {
    const key = `t${++keySeq}`;
    const language = languageFor(name);
    const model = monaco.editor.createModel(content, language, monaco.Uri.parse(`inmemory://webr-ide/${key}/${encodeURIComponent(name)}`));
    model.updateOptions({ tabSize: settings.tabSize, indentSize: settings.tabSize, insertSpaces: true });
    models.set(key, model);
    savedVersion.set(key, model.getAlternativeVersionId());
    model.onDidChangeContent(() => {
      const dirty = model.getAlternativeVersionId() !== savedVersion.get(key);
      const i = tabs.list.findIndex((t) => t.key === key);
      if (i >= 0 && tabs.list[i].dirty !== dirty) setTabs('list', i, 'dirty', dirty);
    });
    return { key, model, language };
  }

  function activate(key: string | null) {
    if (tabs.active && ed) viewStates.set(tabs.active, ed.saveViewState());
    setTabs('active', key);
    if (!ed) return;
    const model = key ? models.get(key) ?? null : null;
    ed.setModel(model);
    if (key && viewStates.get(key)) ed.restoreViewState(viewStates.get(key)!);
    if (model) softFocus(ed);
    scheduleIdeStateSave();
  }

  async function openFile(path: string, opts: { grid?: boolean } = {}) {
    const existing = tabs.list.find((t) => t.path === path);
    if (existing) {
      if (opts.grid && !existing.gridOnly) patchTab(existing.key, { mode: 'grid' });
      return activate(existing.key);
    }
    const name = fs.basename(path);
    let file: File;
    try {
      file = await fs.readFileObject(state.workspace, path);
    } catch (e) {
      toast(`Cannot open ${path}: ${e}`, 'error');
      return;
    }
    const tabular = isTabularName(name);
    if (tabular && file.size > TEXT_VIEW_MAX) {
      // Too big for the text editor: grid only, no Monaco model.
      const key = `t${++keySeq}`;
      setTabs('list', (l) => [...l, { key, path, name, dirty: false, language: 'plaintext', mode: 'grid', gridOnly: true, fileVersion: 0 }]);
      activate(key);
      return;
    }
    const text = await file.text();
    const { key, language, model } = createModel(text, name);
    setDocPath(model.uri.toString(), state.workspace, path);
    setTabs('list', (l) => [...l, { key, path, name, dirty: false, language, mode: tabular && opts.grid ? 'grid' : 'text', gridOnly: false, fileVersion: 0 }]);
    activate(key);
  }

  function newFile(name?: string, content = '') {
    const n = name ?? `Untitled${++untitledSeq}.R`;
    const { key, language } = createModel(content, n);
    setTabs('list', (l) => [...l, { key, path: null, name: n, dirty: content.length > 0, language, mode: 'text', gridOnly: false, fileVersion: 0 }]);
    activate(key);
  }

  async function save(key: string): Promise<boolean> {
    const tab = tabs.list.find((t) => t.key === key);
    const model = models.get(key);
    if (!tab || !model) return false;
    let path = tab.path;
    if (!path) {
      const base = state.selectedPath && state.tree.length ? selectedFolder() : '';
      const name = await askText('Save File', base ? `${base}/${tab.name}` : tab.name, { okLabel: 'Save', selectStem: true });
      if (!name) return false;
      path = fs.splitPath(name).join('/');
      if (!path) return false;
      if (await fs.exists(state.workspace, path)) {
        toast(`"${path}" already exists`, 'error');
        return false;
      }
    }
    try {
      const version = model.getAlternativeVersionId();
      await writeWorkspaceFile(path, model.getValue());
      savedVersion.set(key, version);
      setDocPath(model.uri.toString(), state.workspace, path);
      // Like quarto preview: re-render on save while this document is previewed.
      if (preview.doc === model.uri.toString() && preview.status !== 'rendering' && tabs.active === key) queueMicrotask(renderActive);
      const i = tabs.list.findIndex((t) => t.key === key);
      const name = fs.basename(path);
      const language = languageFor(name);
      if (language !== tab.language) monaco.editor.setModelLanguage(model, language);
      setTabs('list', i, (t) => ({ path, name, language, dirty: model.getAlternativeVersionId() !== version, fileVersion: t.fileVersion + 1 }));
      scheduleIdeStateSave();
      return true;
    } catch (e) {
      toast(`Save failed: ${e}`, 'error');
      return false;
    }
  }

  function selectedFolder(): string {
    const p = state.selectedPath;
    const node = fs.flattenTree(state.tree).find((n) => n.path === p);
    if (!node) return '';
    return node.kind === 'directory' ? node.path : fs.dirname(node.path);
  }

  async function closeTab(key: string, force = false): Promise<boolean> {
    const tab = tabs.list.find((t) => t.key === key);
    if (!tab) return true;
    if (tab.dirty && !force) {
      const r = await choiceDialog('Unsaved changes', `Save changes to "${tab.name}" before closing?`, 'Save', {
        label: "Don't Save",
        value: 'discard',
      });
      if (r === null) return false;
      if (r !== 'discard' && !(await save(key))) return false;
    }
    const idx = tabs.list.findIndex((t) => t.key === key);
    setTabs('list', (l) => l.filter((t) => t.key !== key));
    if (tabs.active === key) {
      const next = tabs.list[Math.min(idx, tabs.list.length - 1)];
      activate(next?.key ?? null);
    }
    models.get(key)?.dispose();
    models.delete(key);
    savedVersion.delete(key);
    viewStates.delete(key);
    scheduleIdeStateSave();
    return true;
  }

  function submitCode(code: string) {
    if (!code.trim()) return;
    if (session.status !== 'ready') {
      toast('R is still starting…', 'warn');
      return;
    }
    session.submit(code);
  }

  function runSelection() {
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!model || !sel) return;
    if (!sel.isEmpty()) {
      submitCode(model.getValueInRange(sel));
      return;
    }
    // In Quarto / R Markdown, only lines inside R chunks are code; on other
    // lines, ⌘↩ / Ctrl+Enter evaluates inline `r` code.
    if (model.getLanguageId() === 'quarto' && !inRChunk(model, sel.startLineNumber)) {
      notebook?.runInlineAtCursor();
      return;
    }
    const n = model.getLineCount();
    let start = sel.startLineNumber;
    // On a blank/comment line, RStudio runs the next statement.
    while (start < n && /^\s*(#.*)?$/.test(model.getLineContent(start))) start++;
    const end = statementEnd(model, start);
    const code = model.getValueInRange(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)));
    submitCode(code);
    let next = end + 1;
    while (next < n && /^\s*$/.test(model.getLineContent(next))) next++;
    if (next <= n) {
      ed.setPosition({ lineNumber: next, column: 1 });
      ed.revealLineInCenterIfOutsideViewport(next);
    } else {
      ed.setPosition({ lineNumber: end, column: model.getLineMaxColumn(end) });
    }
  }

  function runAll() {
    const model = ed?.getModel();
    if (model) submitCode(model.getValue());
  }

  async function sourceActive(echo: boolean) {
    const tab = activeTab();
    if (!tab) return;
    if (tab.language !== 'r') {
      toast('Only R scripts can be sourced', 'warn');
      return;
    }
    if (!tab.path) {
      runAll();
      return;
    }
    if (tab.dirty && !(await save(tab.key))) return;
    submitCode(`source(${rString(rDisplayPath(tab.path))}${echo ? ', echo = TRUE' : ''})`);
  }

  function renderActive() {
    const tab = activeTab();
    const model = tab && models.get(tab.key);
    if (!tab || !model || tab.language !== 'quarto') {
      toast('Open a Quarto (.qmd) or R Markdown (.Rmd) document to render it', 'warn');
      return;
    }
    if (state.rStatus !== 'ready') {
      toast('R is still starting…', 'warn');
      return;
    }
    const dir = tab.path && fs.dirname(tab.path) ? `${rRoot()}/${fs.dirname(tab.path)}` : rRoot();
    setState('plotTab', 'preview');
    showPane('plots');
    void renderDocument({ doc: model.uri.toString(), path: tab.path, name: tab.name, text: model.getValue(), dir, dark: isDark() });
  }

  async function reloadIfOpen(path: string) {
    const tab = tabs.list.find((t) => t.path === path);
    if (!tab || tab.dirty) return;
    if (tab.gridOnly) {
      patchTab(tab.key, { fileVersion: tab.fileVersion + 1 });
      return;
    }
    const model = models.get(tab.key)!;
    try {
      const text = await fs.readText(state.workspace, path);
      if (text !== model.getValue()) {
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        savedVersion.set(tab.key, model.getAlternativeVersionId());
        const i = tabs.list.findIndex((t) => t.key === tab.key);
        setTabs('list', i, { dirty: false, fileVersion: tab.fileVersion + 1 });
      }
    } catch {
      /* ignore */
    }
  }

  function setMode(mode: 'text' | 'grid') {
    const t = activeTab();
    if (!t || (mode === 'text' && t.gridOnly)) return;
    // Re-read the file into the grid if text edits were saved since it was last shown.
    patchTab(t.key, { mode, fileVersion: mode === 'grid' ? t.fileVersion + 1 : t.fileVersion });
    if (mode === 'text') queueMicrotask(() => softFocus(ed));
  }

  function importToR() {
    const t = activeTab();
    if (!t?.path) return;
    const stem = t.name.replace(/\.[^.]+$/, '').replace(/[^\w.]/g, '_');
    const name = /^[A-Za-z.]/.test(stem) ? stem : `data_${stem}`;
    const ext = extOf(t.name);
    const path = rString(rDisplayPath(t.path));
    const call = ext === 'tsv' || ext === 'tab' ? `read.delim(${path})` : ext === 'psv' ? `read.delim(${path}, sep = "|")` : `read.csv(${path})`;
    submitCode(`${name} <- ${call}`);
  }

  /** Grid for one tab: builds a FileSource from the saved file (or unsaved text). */
  function GridView(p: { tab: Tab }) {
    const [src, setSrc] = createSignal<FileSource | null>(null);
    const [blocked, setBlocked] = createSignal<number | null>(null);
    createEffect(
      on(
        () => [p.tab.fileVersion, p.tab.path] as const,
        async () => {
          src()?.dispose();
          setSrc(null);
          const model = models.get(p.tab.key);
          let blob: Blob;
          if (model && (p.tab.dirty || !p.tab.path)) blob = new Blob([model.getValue()], { type: 'text/csv' });
          else if (p.tab.path) blob = await fs.readFileObject(state.workspace, p.tab.path);
          else return;
          if (blob.size > GRID_MAX) {
            setBlocked(blob.size);
            return;
          }
          setBlocked(null);
          setSrc(new FileSource(blob, p.tab.name));
        },
      ),
    );
    onCleanup(() => src()?.dispose());
    return (
      <div class="grid-host">
        <Show when={blocked() !== null}>
          <div class="grid-blocked">
            <Icon name="table" size={36} />
            <h3>This file is too large to preview</h3>
            <p>
              {p.tab.name} is {formatBytes(blocked()!)}. The grid viewer handles files up to {formatBytes(GRID_MAX)}. Download it and open it in a
              desktop app such as Numbers, Excel or a dedicated CSV viewer — or load just the columns you need in R.
            </p>
            <Show when={p.tab.path}>
              <button class="btn primary" onClick={() => void downloadPath(p.tab.path!)}>
                Download {p.tab.name}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={src()} keyed>
          {(source) => <DataGrid source={source} />}
        </Show>
      </div>
    );
  }

  // ---------------------------------------------------------------- navigation

  const keyOfUri = (uri: monaco.Uri) => tabs.list.find((t) => models.get(t.key)?.uri.toString() === uri.toString())?.key ?? null;
  const pathOfUri = (uri: monaco.Uri) => tabs.list.find((t) => t.key === keyOfUri(uri))?.path ?? null;

  function select(range: monaco.IRange) {
    ed.setSelection(range);
    ed.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
  }

  async function openAt(path: string, line: number, column: number, endLine = line, endColumn = column) {
    await openFile(path);
    const t = tabs.list.find((x) => x.path === path);
    if (!t || t.gridOnly) return;
    if (t.mode === 'grid') patchTab(t.key, { mode: 'text' });
    showPane('script');
    select(new monaco.Range(line, column, endLine, endColumn));
    softFocus(ed);
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
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    const sym = model && pos ? symbolAt(model, pos) : null;
    if (!sym) return toast('Put the cursor on a function name to see its help', 'warn');
    showHelp(sym.name);
  }

  function showHelp(name: string) {
    if (session.status !== 'ready') return toast('R is still starting…', 'warn');
    const [pkg, topic] = name.includes('::') ? name.split(/:::?/) : [null, name];
    session.submit(`help(${rString(topic)}${pkg ? `, package = ${rString(pkg)}` : ''})`);
  }

  async function goToDefinition() {
    const model = ed?.getModel();
    const pos = ed?.getPosition();
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

  // ---------------------------------------------------------------- formatting

  /** Replace lines from..to with `text`, editing only the lines that differ. */
  function replaceLines(model: monaco.editor.ITextModel, from: number, to: number, text: string): boolean {
    const oldL = model.getLinesContent().slice(from - 1, to);
    const newL = text.split('\n');
    let a = 0;
    while (a < oldL.length && a < newL.length && oldL[a] === newL[a]) a++;
    let b = 0;
    while (b < oldL.length - a && b < newL.length - a && oldL[oldL.length - 1 - b] === newL[newL.length - 1 - b]) b++;
    if (a === oldL.length && a === newL.length) return false;
    const s = from + a;
    const e = to - b;
    const mid = newL.slice(a, newL.length - b);
    let range: monaco.Range;
    let txt: string;
    if (e < s) {
      // Only new lines: insert them before line s.
      range = s > model.getLineCount() ? new monaco.Range(e, model.getLineMaxColumn(e), e, model.getLineMaxColumn(e)) : new monaco.Range(s, 1, s, 1);
      txt = s > model.getLineCount() ? '\n' + mid.join('\n') : mid.join('\n') + '\n';
    } else if (!mid.length) {
      // Only removed lines.
      range = s > 1 ? new monaco.Range(s - 1, model.getLineMaxColumn(s - 1), e, model.getLineMaxColumn(e)) : new monaco.Range(s, 1, e + 1, 1);
      txt = '';
    } else {
      range = new monaco.Range(s, 1, e, model.getLineMaxColumn(e));
      txt = mid.join('\n');
    }
    ed.pushUndoStop();
    ed.executeEdits('format', [{ range, text: txt }]);
    ed.pushUndoStop();
    return true;
  }

  /** Format the selection, or the whole script / chunk, with styler. */
  async function formatCode(scope: 'tokens' | 'indention', retried = false) {
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!model || !sel || inGrid()) return;
    const region = rRegions(model).find((r) => sel.startLineNumber >= r.line && sel.startLineNumber < r.line + r.text.split('\n').length);
    if (!region) return toast(model.getLanguageId() === 'quarto' ? 'Put the cursor in an R chunk to format it' : 'Only R code can be formatted', 'warn');
    const regionEnd = region.line + region.text.split('\n').length - 1;
    let from = region.line;
    let to = regionEnd;
    if (!sel.isEmpty()) {
      from = Math.max(from, sel.startLineNumber);
      to = Math.min(to, sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber);
    }
    const version = model.getVersionId();
    let res;
    let text: string;
    if (scope === 'indention') {
      // Re-indent the whole script or chunk (indentation depends on what
      // surrounds the selection), then keep only the selected lines.
      res = await styleCode(region.text, 'indention');
      if (res.ok) {
        const out = res.text.split('\n');
        if (out.length === regionEnd - region.line + 1) text = out.slice(from - region.line, to - region.line + 1).join('\n');
        else {
          from = region.line;
          to = regionEnd;
          text = res.text;
        }
      }
    } else {
      const lines = model.getLinesContent().slice(from - 1, to);
      const indent = lines.filter((l) => l.trim()).reduce<string | null>((m, l) => {
        const ws = /^\s*/.exec(l)![0];
        return m === null || ws.length < m.length ? ws : m;
      }, null) ?? '';
      res = await styleCode(lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n'));
      if (res.ok) text = res.text.split('\n').map((l) => (l ? indent + l : l)).join('\n');
    }
    if (!res.ok) {
      if (res.missing && !retried) {
        const ok = await confirmDialog(
          'Install styler?',
          'Formatting R code uses the styler package. Install it now? It downloads once and is saved for offline use.',
          { okLabel: 'Install' },
        );
        if (!ok) return;
        installPackages(['styler']);
        await new Promise((r) => setTimeout(r, 50));
        if (await session.waitIdle(10 * 60_000)) return formatCode(scope, true);
        return;
      }
      return toast(`Couldn't format: ${res.message}`, 'error', 7000);
    }
    if (model.isDisposed() || model.getVersionId() !== version) return toast('The code changed while formatting — try again', 'warn');
    if (!replaceLines(model, from, to, text!)) toast(scope === 'indention' ? 'Indentation is already tidy' : 'Already formatted');
  }

  // ---------------------------------------------------------------- outline

  const [outlineMenu, setOutlineMenu] = createSignal<null | { items: OutlineItem[]; current: number; x: number; y: number }>(null);
  let outlineBtn!: HTMLButtonElement;

  function openOutline() {
    const model = ed?.getModel();
    if (!model || inGrid()) return;
    const items = outline(model);
    const line = ed.getPosition()?.lineNumber ?? 1;
    let current = -1;
    items.forEach((it, i) => it.line <= line && (current = i));
    const r = outlineBtn.getBoundingClientRect();
    setOutlineMenu({ items, current, x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 4 });
    queueMicrotask(() => document.querySelector('.outline-menu .menu-item.current')?.scrollIntoView({ block: 'center' }));
  }

  function goToLine(line: number) {
    setOutlineMenu(null);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.revealLineNearTop(line, monaco.editor.ScrollType.Smooth);
    softFocus(ed);
  }

  function palette() {
    if (!ed?.getModel()) return;
    ed.focus();
    ed.trigger('toolbar', 'editor.action.quickCommand', null);
  }

  const api: EditorApi = {
    openAt,
    openText(path) {
      const t = tabs.list.find((x) => x.path === path);
      const m = t && models.get(t.key);
      return m ? m.getValue() : null;
    },
    editOpen(path, edits) {
      const t = tabs.list.find((x) => x.path === path);
      const m = t && models.get(t.key);
      if (!m) return false;
      m.pushStackElement();
      m.pushEditOperations([], edits.map((e) => ({ range: monaco.Range.lift(e.range), text: e.text })), () => null);
      m.pushStackElement();
      return true;
    },
    command(id) {
      if (id === 'outline') return openOutline();
      if (id === 'palette') return palette();
      ed?.getAction(id)?.run();
    },
    async openFile(path, opts) {
      await openFile(path, opts);
      showPane('script');
    },
    newFile(name, content) {
      newFile(name, content);
      showPane('script');
    },
    async saveActive() {
      if (tabs.active) await save(tabs.active);
    },
    async saveAll() {
      for (const t of [...tabs.list]) if (t.dirty) await save(t.key);
    },
    runSelection,
    sourceActive,
    reloadIfOpen,
    onRenamed(from, to) {
      void moveSavedOutput(state.workspace, from, to).then(() => {
        for (const t of tabs.list) {
          const m = models.get(t.key);
          if (m && t.path) setDocPath(m.uri.toString(), state.workspace, t.path);
        }
      });
      setTabs(
        'list',
        produce((list) => {
          for (const t of list) {
            if (t.path === from || t.path?.startsWith(from + '/')) {
              t.path = to + t.path.slice(from.length);
              t.name = fs.basename(t.path);
              const lang = languageFor(t.name);
              if (lang !== t.language) {
                t.language = lang;
                const m = models.get(t.key);
                if (m) monaco.editor.setModelLanguage(m, lang);
              }
            }
          }
        }),
      );
      scheduleIdeStateSave();
    },
    onDeleted(path) {
      void moveSavedOutput(state.workspace, path, null);
      for (const t of [...tabs.list]) {
        if (t.path === path || t.path?.startsWith(path + '/')) {
          if (t.dirty) {
            const i = tabs.list.findIndex((x) => x.key === t.key);
            setTabs('list', i, 'path', null);
          } else void closeTab(t.key, true);
        }
      }
    },
    insertText(text) {
      showPane('script');
      const sel = ed?.getSelection();
      if (!ed || !sel || !ed.getModel()) {
        newFile(undefined, text);
        return;
      }
      ed.executeEdits('history', [{ range: sel, text, forceMoveMarkers: true }]);
      softFocus(ed);
    },
    getOpenState() {
      const open = tabs.list.filter((t) => t.path).map((t) => t.path!);
      const a = activeTab();
      return { open, active: a?.path ?? null };
    },
    async restoreOpenState(s) {
      for (const p of s.open ?? []) {
        if (await fs.exists(state.workspace, p)) await openFile(p);
      }
      const a = tabs.list.find((t) => t.path === s.active);
      if (a) activate(a.key);
    },
    async closeAll(force = false) {
      for (const t of [...tabs.list]) if (!(await closeTab(t.key, force))) return false;
      return true;
    },
    hasDirty: () => tabs.list.some((t) => t.dirty),
    renderActive,
    beforeCursor() {
      const m = ed?.getModel();
      const pos = ed?.getPosition();
      return m && pos && !inGrid() ? m.getLineContent(pos.lineNumber).slice(0, pos.column - 1) : null;
    },
    setQuickSuggest(on) {
      ed?.updateOptions({ quickSuggestions: on ? { other: true, comments: false, strings: false } : false });
    },
    key(action) {
      if (!ed?.getModel() || inGrid()) return;
      const go = (cmd: string, args: unknown = null) => ed.trigger('keybar', cmd, args);
      // The suggestion list is open: ↑/↓ move through it and Tab accepts, as on a keyboard.
      const suggesting = () =>
        !!(ed as any)._contextKeyService?.getContextKeyValue?.('suggestWidgetVisible') || !!document.querySelector('.suggest-widget.visible');
      switch (action.type) {
        case 'move':
          if (suggesting() && (action.dir === 'up' || action.dir === 'down')) go(action.dir === 'down' ? 'selectNextSuggestion' : 'selectPrevSuggestion');
          else go({ left: 'cursorLeft', right: 'cursorRight', up: 'cursorUp', down: 'cursorDown' }[action.dir]);
          break;
        case 'text': {
          const sel = ed.getSelection();
          if (!sel) return;
          ed.executeEdits('keybar', [{ range: sel, text: action.text, forceMoveMarkers: true }]);
          for (let i = 0; i < (action.back ?? 0); i++) go('cursorLeft');
          break;
        }
        case 'tab':
          go(suggesting() ? 'acceptSelectedSuggestion' : 'tab');
          break;
        case 'type':
          go('type', { text: action.text });
          break;
        case 'backspace':
          go('deleteLeft');
          break;
        case 'enter':
          if (suggesting()) go('acceptSelectedSuggestion');
          else go('type', { text: '\n' });
          break;
        case 'complete': {
          const pos = ed.getPosition();
          if (!pos) return;
          const from = Math.max(1, pos.column - action.remove);
          ed.executeEdits('keyboard', [{ range: new monaco.Range(pos.lineNumber, from, pos.lineNumber, pos.column), text: action.text, forceMoveMarkers: true }]);
          for (let i = 0; i < (action.back ?? 0); i++) go('cursorLeft');
          break;
        }
        case 'undo':
          go('undo');
          break;
        case 'redo':
          go('redo');
          break;
        case 'run':
          // Stay in the editor (keyboard up); the Console tab gets a dot.
          withoutPaneSwitch(() => (isNb() && inRChunk(ed.getModel()!, ed.getPosition()?.lineNumber ?? 1) ? notebook?.runAtCursor() : runSelection()));
          break;
      }
      ed.focus();
    },
    layout: () => ed?.layout(),
  };
  registerEditor(api);

  onMount(() => {
    ed = monaco.editor.create(host, {
      model: null,
      theme: isDark() ? 'rstudio-dark' : 'rstudio-light',
      automaticLayout: true,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
      fontSize: 14,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: 'all',
      wordWrap: 'off',
      smoothScrolling: true,
      padding: { top: 6 },
      fixedOverflowWidgets: true,
      bracketPairColorization: { enabled: true },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: 'off',
    });
    const K = monaco.KeyMod;
    const C = monaco.KeyCode;
    notebook = attachNotebook(ed);
    ed.addCommand(K.CtrlCmd | C.Enter, runSelection);
    ed.addCommand(K.WinCtrl | C.Enter, runSelection);
    ed.addCommand(K.CtrlCmd | K.Shift | C.Enter, () => (isNb() ? notebook!.runAtCursor() : void sourceActive(true)));
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyS, () => void sourceActive(false));
    ed.addCommand(K.CtrlCmd | C.KeyS, () => void api.saveActive());
    // Quarto: every chunk. Scripts: source the file (what "run everything" means there).
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyR, () => (isNb() ? notebook!.runAll() : void sourceActive(false)));
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyC, () => isNb() && notebook!.runAtCursor());
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyP, () => isNb() && notebook!.runAbove());
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyI, () => isNb() && notebook!.insertChunk());
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyK, renderActive);
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyM, () => ed.trigger('kbd', 'type', { text: ' |> ' }));
    ed.addCommand(K.Alt | C.Minus, () => ed.trigger('kbd', 'type', { text: ' <- ' }));
    ed.addCommand(K.CtrlCmd | C.Digit2, () => consoleApi?.focus());

    // Actions: these also appear in the command palette (⌘⇧P / F1 in Monaco).
    const action = (id: string, label: string, keys: number[], run: () => void, group?: string) =>
      ed.addAction({ id, label, keybindings: keys, run, contextMenuGroupId: group, contextMenuOrder: 1 });
    action('r.reformat', 'Reformat Code (styler)', [K.CtrlCmd | K.Shift | C.KeyA], () => void formatCode('tokens'), '1_modification');
    action('r.reindent', 'Reindent Lines', [K.CtrlCmd | C.KeyI], () => void formatCode('indention'), '1_modification');
    // ⌘/ is Monaco's own toggle; ⌘⇧C is RStudio's.
    action('r.comment', 'Comment / Uncomment Lines', [K.CtrlCmd | K.Shift | C.KeyC], () => ed.trigger('kbd', 'editor.action.commentLine', null), '1_modification');
    action('r.definition', 'Go to Function Definition', [C.F2], () => void goToDefinition(), 'navigation');
    action('r.help', 'Help for Name at Cursor', [C.F1], helpAtCursor, 'navigation');
    action('r.outline', 'Document Outline…', [K.CtrlCmd | K.Shift | C.KeyO], openOutline);
    action('r.runLine', 'Run Current Line or Selection', [], runSelection);
    action('r.runAll', 'Run All Chunks (Quarto)', [], () => isNb() && notebook!.runAll());
    action('r.source', 'Source File', [], () => void sourceActive(false));
    action('r.render', 'Render Document', [], renderActive);
    action('r.insertChunk', 'Insert R Chunk', [], () => isNb() && notebook!.insertChunk());
    action('r.save', 'Save File', [], () => void api.saveActive());
    action('r.saveAll', 'Save All Files', [], () => void api.saveAll());
    action('r.newScript', 'New R Script', [], () => newFile());
    action('r.findInFiles', 'Find in Files…', [K.CtrlCmd | K.Shift | C.KeyF], () => openFindInFiles(ed.getModel()?.getValueInRange(ed.getSelection()!) ?? ''));
    action('r.shortcuts', 'Keyboard Shortcuts', [K.Alt | K.Shift | C.KeyK], openShortcuts);
    action('r.focusConsole', 'Move Focus to Console', [], () => consoleApi?.focus());
    action('r.settings', 'Settings…', [K.CtrlCmd | C.Comma], openSettings);
    action('r.palette', 'Command Palette', [K.CtrlCmd | K.Shift | C.KeyP], palette);
    // F1 is R help here (as in RStudio); the palette is ⌘⇧P.
    monaco.editor.addKeybindingRule({ keybinding: C.F1, command: '-editor.action.quickCommand' });

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

    // Desktop style (mouse/trackpad, or an iPad with a keyboard): suggestion
    // details (signature and help) open beside the list, and no separate
    // argument-hint popup. Touch typing keeps the compact list and the popup.
    createEffect(() => {
      const desk = desktopEditing();
      ed.updateOptions({ parameterHints: { enabled: !desk } });
      try {
        const widget = (ed.getContribution('editor.contrib.suggestController') as any)?.widget?.value;
        widget?._storageService?.store('expandSuggestionDocs', desk, 0 /* profile */, 0 /* user */);
      } catch (e) {
        console.warn('could not set suggestion details', e);
      }
    });

    createEffect(() => monaco.editor.setTheme(isDark() ? 'rstudio-dark' : 'rstudio-light'));
    // Touch screens: allow scrolling past the end, so the last lines can be
    // brought up above the on-screen keyboard.
    const coarse = window.matchMedia('(pointer: coarse)');
    const scrollPast = () => ed.updateOptions({ scrollBeyondLastLine: coarse.matches });
    scrollPast();
    coarse.addEventListener('change', scrollPast);
    onCleanup(() => coarse.removeEventListener('change', scrollPast));

    // When the keyboard opens (the visual viewport shrinks) while typing in
    // the editor, resize straight away and keep the cursor line in view.
    const vv = window.visualViewport;
    if (vv) {
      let lastHeight = vv.height;
      let raf = 0;
      const onViewport = () => {
        const shrank = vv.height < lastHeight - 50;
        lastHeight = vv.height;
        if (!shrank || !ed.hasTextFocus()) return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          ed.layout();
          const pos = ed.getPosition();
          if (pos) ed.revealPositionInCenterIfOutsideViewport(pos, monaco.editor.ScrollType.Immediate);
        });
      };
      vv.addEventListener('resize', onViewport);
      onCleanup(() => vv.removeEventListener('resize', onViewport));
    }

    // Settings. Phones: a narrower gutter and slightly smaller text leave room for code.
    createEffect(() => {
      const size = settings.editorFontSize - (phone() ? 1 : 0);
      const lineHeight = Math.round(size * (phone() ? 1.46 : 1.5));
      ed.updateOptions({
        fontSize: size,
        lineHeight,
        wordWrap: settings.wordWrap ? 'on' : 'off',
        hover: { enabled: settings.hoverHelp ? 'on' : 'off' },
        ...(phone()
          ? { lineNumbersMinChars: 2, lineDecorationsWidth: 6, folding: false, glyphMargin: false }
          : { lineNumbersMinChars: 5, lineDecorationsWidth: 10, folding: true }),
      });
    });
    createEffect(() => {
      const tabSize = settings.tabSize;
      for (const m of models.values()) m.updateOptions({ tabSize, indentSize: tabSize, insertSpaces: true });
    });
    // Lock the editor while a package downloads/installs.
    createEffect(() => ed.updateOptions({ readOnly: isInstalling(), readOnlyMessage: { value: 'Editing is paused while a package installs.' } }));
  });

  onCleanup(() => {
    ed?.dispose();
    for (const m of models.values()) m.dispose();
  });

  // Warn before leaving with unsaved changes.
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (api.hasDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));

  return (
    <div class="pane">
      <PaneHeader
        pane="script"
        tabs={[]}
        active=""
        info={
          <div class="editor-tabs" role="tablist">
            <For each={tabs.list}>
              {(t) => (
                <div
                  class="editor-tab"
                  classList={{ active: tabs.active === t.key, dirty: t.dirty }}
                  role="tab"
                  aria-selected={tabs.active === t.key}
                  title={t.path ?? t.name}
                  onClick={() => activate(t.key)}
                  onAuxClick={(e) => e.button === 1 && void closeTab(t.key)}
                >
                  <Icon
                    name={t.language === 'r' ? 'r' : isTabularName(t.name) ? 'table' : 'file'}
                    size={14}
                    class={t.language === 'r' ? 'r-icon' : isTabularName(t.name) ? 'table-icon' : ''}
                  />
                  <span class="editor-tab-name">{t.name}</span>
                  <button
                    class="editor-tab-close"
                    aria-label={`Close ${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(t.key);
                    }}
                  >
                    <span class="dirty-dot" />
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )}
            </For>
            <button class="editor-tab-new" title="New R script" onClick={() => newFile()}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        }
      />
      <div class="pane-toolbar">
        <button class="tb-btn" title={`Save (${kbd('mod+S')})`} disabled={!activeTab() || activeTab()!.gridOnly} onClick={() => void api.saveActive()}>
          <Icon name="save" />
        </button>
        <button class="tb-btn" title="Find / Replace" disabled={!activeTab() || inGrid()} onClick={() => ed.getAction('actions.find')?.run()}>
          <Icon name="search" />
        </button>
        <button
          ref={outlineBtn}
          class="tb-btn"
          title={`Outline: sections, functions and headings (${kbd('mod+shift+O')})`}
          disabled={!activeTab() || inGrid() || !['r', 'quarto', 'markdown'].includes(activeTab()!.language)}
          onClick={openOutline}
        >
          <Icon name="outline" />
        </button>
        <button class="tb-btn" title={`Command palette (${kbd('mod+shift+P')})`} disabled={!activeTab() || inGrid()} onClick={palette}>
          <Icon name="command" />
        </button>
        <Show when={isTabular()}>
          <span class="tb-sep" />
          <div class="view-toggle" role="group" aria-label="View as">
            <button
              class="tb-btn labeled"
              classList={{ active: !inGrid() }}
              disabled={activeTab()!.gridOnly}
              title={activeTab()!.gridOnly ? `Too large for the text editor (over ${formatBytes(TEXT_VIEW_MAX)})` : 'Edit as text'}
              onClick={() => setMode('text')}
            >
              <Icon name="file" />
              <span>Text</span>
            </button>
            <button class="tb-btn labeled" classList={{ active: inGrid() }} title="View as a spreadsheet grid" onClick={() => setMode('grid')}>
              <Icon name="table" />
              <span>Grid</span>
            </button>
          </div>
          <button
            class="tb-btn labeled"
            disabled={!activeTab()!.path || state.rStatus !== 'ready'}
            title="Import into R as a data frame"
            onClick={importToR}
          >
            <Icon name="to-console" />
            <span>Import to R</span>
          </button>
        </Show>
        <Show when={isNb()}>
          <span class="tb-sep" />
          <button class="tb-btn" title={`Insert an R chunk (${kbd('mod+alt+I')})`} onClick={() => notebook?.insertChunk()}>
            <Icon name="plus" />
          </button>
          <div class="view-toggle" role="group" aria-label="Chunk output">
            <button
              class="tb-btn labeled"
              classList={{ active: nb.mode === 'inline' }}
              title="Show chunk output under each chunk"
              onClick={() => setOutputMode('inline')}
            >
              <span>Inline</span>
            </button>
            <button
              class="tb-btn labeled"
              classList={{ active: nb.mode === 'pane' }}
              title="Show chunk output in the Output tab"
              onClick={() => {
                setOutputMode('pane');
                setState('plotTab', 'output');
              }}
            >
              <span>Pane</span>
            </button>
          </div>
          <button class="tb-btn" title="Clear all chunk output" disabled={!runsFor(nb.activeDoc).length && !inlinesFor(nb.activeDoc).length} onClick={() => notebook?.clear()}>
            <Icon name="broom" />
          </button>
        </Show>
        <span class="tb-sep" />
        <span class="tb-spacer" />
        <Show when={isNb()}>
          <Show when={anyRunning()}>
            <button class="tb-btn labeled danger" title="Stop running chunks" onClick={stopChunks}>
              <Icon name="stop" />
              <span>Stop</span>
            </button>
          </Show>
          <button
            class="tb-btn labeled"
            disabled={state.rStatus !== 'ready' || isInstalling() || preview.status === 'rendering'}
            title={`Render to HTML in the Preview tab (${kbd('mod+shift+K')})`}
            onClick={renderActive}
          >
            <Icon name="book" />
            <span>Render</span>
          </button>
          <button
            class="tb-btn labeled run"
            disabled={state.rStatus !== 'ready' || isInstalling()}
            title={`Run the chunk at the cursor (${kbd('mod+shift+enter')})`}
            onClick={() => notebook?.runAtCursor()}
          >
            <Icon name="play" />
            <span>Run Chunk</span>
          </button>
          <button
            class="tb-btn labeled run"
            disabled={state.rStatus !== 'ready' || isInstalling()}
            title={`Run every R chunk (${kbd('mod+alt+R')})`}
            onClick={() => notebook?.runAll()}
          >
            <Icon name="run-all" />
            <span>Run All</span>
          </button>
        </Show>
        <Show when={!isTabular() && !isNb()}>
        <button
          class="tb-btn labeled run"
          disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
          title={`Run the current line or selection (${kbd('mod+enter')})`}
          onClick={() => {
            runSelection();
            softFocus(ed);
          }}
        >
          <Icon name="play" />
          <span>Run</span>
        </button>
        <button
          class="tb-btn labeled"
          disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
          title={`Source the file (${kbd('mod+shift+S')}) — long-press or ${kbd('mod+shift+enter')} to echo`}
          onClick={(e) => void sourceActive(e.shiftKey || e.altKey)}
          onContextMenu={(e) => {
            e.preventDefault();
            void sourceActive(true);
          }}
        >
          <Icon name="source" />
          <span>Source</span>
        </button>
        </Show>
      </div>
      <div class="pane-body editor-body">
        <div ref={host} class="monaco-host" classList={{ hidden: !activeTab() || inGrid() }} />
        <Show when={isInstalling()}>
          <div class="install-overlay" role="status" aria-live="polite">
            <div class="install-card">
              <div class="spinner" aria-hidden="true" />
              <div>
                <div class="install-title">
                  Installing {state.installs.current?.pkg ?? 'packages'}
                  <Show when={state.installs.current?.version}>
                    <span class="install-ver"> {state.installs.current!.version}</span>
                  </Show>
                  …
                </div>
                <div class="install-sub">
                  <Show when={state.installs.done.length} fallback="Downloading from repo.r-wasm.org">
                    {state.installs.done.length} package{state.installs.done.length === 1 ? '' : 's'} installed so far
                  </Show>
                  {' · '}editor locked until it finishes
                </div>
              </div>
            </div>
          </div>
        </Show>
        <Show when={inGrid() && activeTab()} keyed>
          {(t) => <GridView tab={t} />}
        </Show>
        <Show when={outlineMenu()}>
          {(m) => (
            <Portal>
              <div class="menu-backdrop" onClick={() => setOutlineMenu(null)}>
                <div class="menu outline-menu" style={{ left: `${Math.max(8, m().x)}px`, top: `${m().y}px` }} onClick={(e) => e.stopPropagation()}>
                  <div class="menu-title">Outline</div>
                  <div class="menu-scroll">
                    <Show
                      when={m().items.length}
                      fallback={
                        <div class="outline-empty">
                          Nothing here yet. Add a section with <code># Section ----</code>
                          {isNb() ? ' or a heading with ## Heading' : ''}, or define a function.
                        </div>
                      }
                    >
                      <For each={m().items}>
                        {(it, i) => (
                          <button
                            class="menu-item outline-item"
                            classList={{ current: i() === m().current, [it.kind]: true }}
                            style={{ 'padding-left': `${10 + it.level * 14}px` }}
                            onClick={() => goToLine(it.line)}
                          >
                            <span class="outline-kind">{it.kind === 'function' ? 'ƒ' : it.kind === 'chunk' ? '{r}' : '#'}</span>
                            <span class="outline-name">{it.name}</span>
                            <span class="outline-line">{it.line}</span>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </div>
            </Portal>
          )}
        </Show>
        <Show when={!activeTab()}>
          <div class="empty-state">
            <Icon name="file" size={36} />
            <p>No file open</p>
            <div class="empty-actions">
              <button class="btn primary" onClick={() => newFile()}>
                New R Script
              </button>
              <button class="btn" onClick={() => setState('sidebarOpen', true)}>
                Browse Files
              </button>
            </div>
            <p class="hint">
              {kbd('mod+enter')} runs the current line · {kbd('mod+shift+S')} sources the whole script
            </p>
          </div>
        </Show>
      </div>
    </div>
  );
}
