import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { monaco, languageFor, statementEnd, isTabularName, TEXT_VIEW_MAX, GRID_MAX, extOf } from '../lib/monaco';
import { FileSource } from '../lib/grid/source';
import { DataGrid } from './DataGrid';
import { formatBytes } from '../lib/ui';
import { downloadPath, isInstalling } from '../lib/ide';
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
import { askText, choiceDialog, isDark, modKey, toast } from '../lib/ui';
import { Icon } from './Icon';
import { PaneHeader } from './Pane';
import { consoleApi } from './Console';

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
  const [tabs, setTabs] = createStore<{ list: Tab[]; active: string | null }>({ list: [], active: null });
  const models = new Map<string, monaco.editor.ITextModel>();
  const savedVersion = new Map<string, number>();
  const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  let keySeq = 0;
  let untitledSeq = 0;

  const activeTab = () => tabs.list.find((t) => t.key === tabs.active) ?? null;
  const isR = () => activeTab()?.language === 'r';
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
    if (model) ed.focus();
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
    const { key, language } = createModel(text, name);
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
    if (mode === 'text') queueMicrotask(() => ed?.focus());
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

  const api: EditorApi = {
    openFile,
    newFile,
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
      const sel = ed?.getSelection();
      if (!ed || !sel || !ed.getModel()) {
        newFile(undefined, text);
        return;
      }
      ed.executeEdits('history', [{ range: sel, text, forceMoveMarkers: true }]);
      ed.focus();
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
    ed.addCommand(K.CtrlCmd | C.Enter, runSelection);
    ed.addCommand(K.WinCtrl | C.Enter, runSelection);
    ed.addCommand(K.CtrlCmd | K.Shift | C.Enter, () => void sourceActive(true));
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyS, () => void sourceActive(false));
    ed.addCommand(K.CtrlCmd | C.KeyS, () => void api.saveActive());
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyR, runAll);
    ed.addCommand(K.CtrlCmd | K.Shift | C.KeyM, () => ed.trigger('kbd', 'type', { text: ' |> ' }));
    ed.addCommand(K.Alt | C.Minus, () => ed.trigger('kbd', 'type', { text: ' <- ' }));
    ed.addCommand(K.CtrlCmd | C.Digit2, () => consoleApi?.focus());

    createEffect(() => monaco.editor.setTheme(isDark() ? 'rstudio-dark' : 'rstudio-light'));
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
        <button class="tb-btn" title={`Save (${modKey}S)`} disabled={!activeTab() || activeTab()!.gridOnly} onClick={() => void api.saveActive()}>
          <Icon name="save" />
        </button>
        <button class="tb-btn" title="Find / Replace" disabled={!activeTab() || inGrid()} onClick={() => ed.getAction('actions.find')?.run()}>
          <Icon name="search" />
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
        <span class="tb-sep" />
        <span class="tb-spacer" />
        <Show when={!isTabular()}>
        <button
          class="tb-btn labeled run"
          disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
          title={`Run the current line or selection (${modKey}↩)`}
          onClick={() => {
            runSelection();
            ed.focus();
          }}
        >
          <Icon name="play" />
          <span>Run</span>
        </button>
        <button
          class="tb-btn labeled run"
          disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
          title={`Run the whole script (${modKey}⌥R)`}
          onClick={() => {
            runAll();
            ed.focus();
          }}
        >
          <Icon name="run-all" />
          <span>Run All</span>
        </button>
        <button
          class="tb-btn labeled"
          disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
          title={`Source the file (${modKey}⇧S) — long-press or ${modKey}⇧↩ to echo`}
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
              {modKey}↩ runs the current line · {modKey}⌥R runs the whole script
            </p>
          </div>
        </Show>
      </div>
    </div>
  );
}
