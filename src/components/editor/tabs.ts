// Editor tabs: the tab store, one Monaco model per text tab (with its saved
// version and view state), and opening, saving, closing, reloading, renaming
// and deleting the files behind them.

import { createStore, produce } from 'solid-js/store';
import { monaco, languageFor, isTabularName, TEXT_VIEW_MAX, softFocus } from '../../lib/monaco';
import { setDocPath, moveSavedOutput } from '../../lib/notebook';
import { state, writeWorkspaceFile, scheduleIdeStateSave } from '../../lib/ide';
import * as fs from '../../lib/opfs';
import { askText, choiceDialog, toast } from '../../lib/ui';
import { saveSnippets } from '../../lib/snippets';
import { settings } from '../../lib/settings';
import { wsConfig } from '../../lib/workspace-config';
import { preview } from '../../lib/render';
import type { EditorView } from './view';

/** Tab width: the workspace's own, else the user's. */
export const tabSize = () => wsConfig.settings.tabSize ?? settings.tabSize;

export interface Tab {
  key: string;
  path: string | null; // null = untitled
  name: string;
  dirty: boolean;
  language: string;
  mode: 'text' | 'grid';
  gridOnly: boolean; // too large for the text editor (no Monaco model)
  fileVersion: number; // bumped when the file changes on disk, to reload the grid
  /** Read-only view of a paused function that has no file (closed when debugging ends). */
  debugView?: boolean;
  /** A file in the app's storage, not the workspace (path is null). */
  appFile?: string;
}

export type TabsCtx = ReturnType<typeof createTabs>;

/**
 * The tab store and file operations for one editor pane. `deps.renderActive`
 * re-renders a previewed document on save (it lives with the run commands).
 */
export function createTabs(view: EditorView, deps: { renderActive: () => void }) {
  const [tabs, setTabs] = createStore<{ list: Tab[]; active: string | null }>({ list: [], active: null });
  const models = new Map<string, monaco.editor.ITextModel>();
  const savedVersion = new Map<string, number>();
  /** The text as last saved: an edit undone back to it isn't a change (CodeMirror's undo makes new versions). */
  const savedText = new Map<string, string>();
  function markSaved(key: string, version: number, text: string) {
    savedVersion.set(key, version);
    savedText.set(key, text);
  }
  function isDirty(key: string, model: monaco.editor.ITextModel) {
    if (model.getAlternativeVersionId() === savedVersion.get(key)) return false;
    const text = savedText.get(key);
    // (Lengths first: typing nearly always changes it, so the full compare is rare.)
    return text === undefined || model.getValueLength() !== text.length || model.getValue() !== text;
  }
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
    model.updateOptions({ tabSize: tabSize(), indentSize: tabSize(), insertSpaces: true });
    models.set(key, model);
    markSaved(key, model.getAlternativeVersionId(), content);
    model.onDidChangeContent(() => {
      const dirty = isDirty(key, model);
      const i = tabs.list.findIndex((t) => t.key === key);
      if (i >= 0 && tabs.list[i].dirty !== dirty) setTabs('list', i, 'dirty', dirty);
    });
    return { key, model, language };
  }

  function activate(key: string | null) {
    if (tabs.active && view.ed) viewStates.set(tabs.active, view.ed.saveViewState());
    setTabs('active', key);
    if (!view.ed) return;
    const model = key ? models.get(key) ?? null : null;
    view.ed.setModel(model);
    if (key && viewStates.get(key)) view.ed.restoreViewState(viewStates.get(key)!);
    if (model) softFocus(view.ed);
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

  function openAppFile(appFile: string, name: string, text: string) {
    const existing = tabs.list.find((t) => t.appFile === appFile);
    if (existing) return activate(existing.key);
    const { key, language } = createModel(text, name);
    setTabs('list', (l) => [...l, { key, path: null, appFile, name, dirty: false, language, mode: 'text', gridOnly: false, fileVersion: 0 }]);
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
    if (tab.appFile) {
      try {
        const version = model.getAlternativeVersionId();
        const text = model.getValue();
        if (tab.appFile === 'snippets/r.snippets') await saveSnippets(text);
        else await fs.writeAppFile(tab.appFile, text);
        markSaved(key, version, text);
        setTabs('list', (t) => t.key === key, 'dirty', isDirty(key, model));
        return true;
      } catch (e) {
        toast(`Couldn't save ${tab.name}: ${e}`, 'error');
        return false;
      }
    }
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
      const text = model.getValue();
      await writeWorkspaceFile(path, text);
      markSaved(key, version, text);
      setDocPath(model.uri.toString(), state.workspace, path);
      // Like quarto preview: re-render on save while this document is previewed.
      if (preview.doc === model.uri.toString() && preview.status !== 'rendering' && tabs.active === key) queueMicrotask(deps.renderActive);
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
    savedText.delete(key);
    viewStates.delete(key);
    scheduleIdeStateSave();
    return true;
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
        markSaved(tab.key, model.getAlternativeVersionId(), text);
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
    if (mode === 'text') queueMicrotask(() => softFocus(view.ed));
  }

  // ---------------------------------------------------------------- EditorApi: open files

  function openText(path: string) {
    const t = tabs.list.find((x) => x.path === path);
    const m = t && models.get(t.key);
    return m ? m.getValue() : null;
  }

  function editOpen(path: string, edits: { range: monaco.IRange; text: string }[]) {
    const t = tabs.list.find((x) => x.path === path);
    const m = t && models.get(t.key);
    if (!m) return false;
    m.pushStackElement();
    m.pushEditOperations([], edits.map((e) => ({ range: monaco.Range.lift(e.range), text: e.text })), () => null);
    m.pushStackElement();
    return true;
  }

  async function saveActive() {
    if (tabs.active) await save(tabs.active);
  }

  async function saveAll() {
    for (const t of [...tabs.list]) if (t.dirty) await save(t.key);
  }

  function onRenamed(from: string, to: string) {
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
  }

  function onDeleted(path: string) {
    void moveSavedOutput(state.workspace, path, null);
    for (const t of [...tabs.list]) {
      if (t.path === path || t.path?.startsWith(path + '/')) {
        if (t.dirty) {
          const i = tabs.list.findIndex((x) => x.key === t.key);
          setTabs('list', i, 'path', null);
        } else void closeTab(t.key, true);
      }
    }
  }

  function getOpenState() {
    const open = tabs.list.filter((t) => t.path).map((t) => t.path!);
    const a = activeTab();
    return { open, active: a?.path ?? null };
  }

  async function restoreOpenState(s: { open: string[]; active: string | null }) {
    for (const p of s.open ?? []) {
      if (await fs.exists(state.workspace, p)) await openFile(p);
    }
    const a = tabs.list.find((t) => t.path === s.active);
    if (a) activate(a.key);
  }

  async function closeAll(force = false) {
    for (const t of [...tabs.list]) if (!(await closeTab(t.key, force))) return false;
    return true;
  }

  const hasDirty = () => tabs.list.some((t) => t.dirty);

  return {
    tabs,
    setTabs,
    models,
    savedVersion,
    markSaved,
    isDirty,
    activeTab,
    isR,
    isNb,
    isTabular,
    inGrid,
    patchTab,
    createModel,
    activate,
    openFile,
    openAppFile,
    newFile,
    save,
    closeTab,
    reloadIfOpen,
    setMode,
    openText,
    editOpen,
    saveActive,
    saveAll,
    onRenamed,
    onDeleted,
    getOpenState,
    restoreOpenState,
    closeAll,
    hasDirty,
  };
}
