// The script editor pane: wires the editor modules in ./editor (tabs, run,
// debugging, navigation, formatting, outline, keyboard, view options) around
// one Monaco editor, registers the EditorApi, and lays out the pane.

import { onCleanup, onMount, Show } from 'solid-js';
import { softFocus } from '../lib/monaco';
import { attachNotebook } from './Notebook';
import { registerEditor, showPane, setState, type EditorApi } from '../lib/ide';
import { kbd, reloading } from '../lib/ui';
import { Icon } from './Icon';
import { PaneHeader } from './Pane';
import { createEditor, applyEditorOptions, type EditorView } from './editor/view';
import { createTabs } from './editor/tabs';
import { createRun } from './editor/run';
import { createNavigation } from './editor/navigation';
import { createDebugging } from './editor/debugging';
import { createFormatter } from './editor/format';
import { registerSnippetTab, registerCommands, createKeyHandler, palette } from './editor/keybindings';
import { createOutline, OutlineMenu } from './editor/OutlineMenu';
import { EditorTabs } from './editor/EditorTabs';
import { EditorToolbar } from './editor/EditorToolbar';
import { GridView } from './editor/GridView';
import { InstallOverlay } from './editor/InstallOverlay';
import './Editor.css';

export function EditorPane() {
  let host!: HTMLDivElement;
  // `ed` and `notebook` are set in onMount; the modules read them through this handle.
  const view = { notebook: undefined } as EditorView;
  const tc = createTabs(view, { renderActive: () => run.renderActive() });
  const run = createRun(view, tc);
  const nav = createNavigation(view, tc);
  const debugging = createDebugging(view, tc, nav);
  const { formatCode } = createFormatter(view, tc);
  const outlineCtx = createOutline(view, tc);
  const { models, activeTab, isNb, inGrid, newFile } = tc;

  const api: EditorApi = {
    openAt: nav.openAt,
    openText: tc.openText,
    editOpen: tc.editOpen,
    command(id) {
      if (id === 'outline') return outlineCtx.openOutline();
      if (id === 'palette') return palette(view.ed);
      view.ed?.getAction(id)?.run();
    },
    async openFile(path, opts) {
      await tc.openFile(path, opts);
      showPane('script');
    },
    async openAppFile(appFile, name, text) {
      tc.openAppFile(appFile, name, text);
      showPane('script');
    },
    newFile(name, content) {
      newFile(name, content);
      showPane('script');
    },
    saveActive: tc.saveActive,
    saveAll: tc.saveAll,
    runSelection: run.runSelection,
    sourceActive: run.sourceActive,
    reloadIfOpen: tc.reloadIfOpen,
    onRenamed: tc.onRenamed,
    onDeleted: tc.onDeleted,
    insertText(text) {
      const ed = view.ed;
      showPane('script');
      const sel = ed?.getSelection();
      if (!ed || !sel || !ed.getModel()) {
        newFile(undefined, text);
        return;
      }
      ed.executeEdits('history', [{ range: sel, text, forceMoveMarkers: true }]);
      softFocus(ed);
    },
    getOpenState: tc.getOpenState,
    restoreOpenState: tc.restoreOpenState,
    closeAll: tc.closeAll,
    hasDirty: tc.hasDirty,
    renderActive: run.renderActive,
    beforeCursor() {
      const m = view.ed?.getModel();
      const pos = view.ed?.getPosition();
      return m && pos && !inGrid() ? m.getLineContent(pos.lineNumber).slice(0, pos.column - 1) : null;
    },
    setQuickSuggest(on) {
      view.ed?.updateOptions({ quickSuggestions: on ? { other: true, comments: false, strings: false } : false });
    },
    key: createKeyHandler(view, tc, run),
    layout: () => view.ed?.layout(),
  };
  registerEditor(api);

  onMount(() => {
    const ed = (view.ed = createEditor(host));
    view.notebook = attachNotebook(ed);
    registerSnippetTab(ed);
    debugging.attach();
    registerCommands(view, {
      isNb,
      newFile,
      saveActive: tc.saveActive,
      saveAll: tc.saveAll,
      runSelection: run.runSelection,
      sourceActive: run.sourceActive,
      renderActive: run.renderActive,
      formatCode,
      goToDefinition: nav.goToDefinition,
      helpAtCursor: nav.helpAtCursor,
      openOutline: outlineCtx.openOutline,
    });
    nav.registerProviders();
    applyEditorOptions(ed, tc);
  });

  onCleanup(() => {
    view.ed?.dispose();
    for (const m of models.values()) m.dispose();
  });

  // Warn before leaving with unsaved changes.
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (api.hasDirty() && !reloading.now) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));

  return (
    <div class="pane">
      <PaneHeader pane="script" tabs={[]} active="" info={<EditorTabs tabs={tc} />} />
      <EditorToolbar view={view} tabs={tc} run={run} outline={outlineCtx} />
      <div class="pane-body editor-body">
        <div ref={host} class="monaco-host" classList={{ hidden: !activeTab() || inGrid() }} />
        <InstallOverlay />
        <Show when={inGrid() && activeTab()} keyed>
          {(t) => <GridView tab={t} models={models} />}
        </Show>
        <OutlineMenu outline={outlineCtx} isNb={isNb} />
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
