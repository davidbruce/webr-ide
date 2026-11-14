// The script editor pane on CodeMirror 6 (experimental, Settings → Editor).
// It reuses the Monaco pane's modules — tabs, run, navigation, formatting,
// outline, toolbar, tab strip, grid view — through CmEditor, which gives
// CodeMirror the small part of Monaco's editor interface they use.
// The notebook (chunk outputs, run buttons, inline values) and the debugger
// (breakpoints, the paused line) run on it too, through CmEditor's
// Monaco-style decorations, view zones and widgets (cm-decorations.ts).

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { monaco } from '../../lib/monaco';
import { registerEditor, showPane, setState, isInstalling, phone, checkRenv, writeRenvLock, type EditorApi } from '../../lib/ide';
import { isDark, kbd, reloading } from '../../lib/ui';
import { settings, openSettings } from '../../lib/settings';
import { editSnippets } from '../../lib/snippets';
import { Icon } from '../Icon';
import { PaneHeader } from '../Pane';
import { consoleApi } from '../Console';
import { openShortcuts } from '../Shortcuts';
import { openFindInFiles } from '../SearchPanel';
import type { EditorView } from '../editor/view';
import { createTabs, tabSize } from '../editor/tabs';
import { createRun } from '../editor/run';
import { createNavigation } from '../editor/navigation';
import { createDebugging } from '../editor/debugging';
import { attachNotebook } from '../Notebook';
import { inRChunk } from '../../lib/monaco';
import { createFormatter } from '../editor/format';
import { createOutline, OutlineMenu } from '../editor/OutlineMenu';
import { EditorTabs } from '../editor/EditorTabs';
import { EditorToolbar } from '../editor/EditorToolbar';
import { GridView } from '../editor/GridView';
import { InstallOverlay } from '../editor/InstallOverlay';
import { CmEditor } from './cm-editor';
import { baseExtensions, opts, colorsFor, tabsFor, wrapFor, readOnlyFor, type Shortcuts } from './cm-setup';
import { rIntelligence, syncDiagnostics } from './cm-intel';
import { createCmKeyHandler } from './cm-keys';
import { openPalette } from '../CommandPalette';
import { COMMAND_KEYS } from '../editor/keybindings';
import { stickyScroll } from './cm-sticky';
import { rainbowBrackets } from './cm-brackets';
import { toggleLineComment } from '@codemirror/commands';
import '../Editor.css';
import './cm.css';

const isRLang = (id: string | undefined) => id === 'r' || id === 'quarto';

export function CmEditorPane() {
  let host!: HTMLDivElement;
  let cm: CmEditor | undefined;
  const view = { notebook: undefined } as EditorView;
  const tc = createTabs(view, { renderActive: () => run.renderActive() });
  const run = createRun(view, tc);
  const nav = createNavigation(view, tc);
  const debugging = createDebugging(view, tc, nav);
  const { formatCode } = createFormatter(view, tc);
  const outlineCtx = createOutline(view, tc);
  const { models, activeTab, inGrid, newFile, isNb } = tc;
  const nbAt = () => view.notebook && isNb();
  const [quickSuggest, setQuickSuggest] = createSignal(true);
  const touch = window.matchMedia('(pointer: coarse)').matches;

  const selectedText = () => {
    const m = cm?.getModel();
    const s = cm?.getSelection();
    return m && s ? m.getValueInRange(s) : '';
  };
  const shortcuts: Shortcuts = {
    runSelection: () => run.runSelection(),
    // Quarto: ⌘⇧↩ runs the chunk; "run everything" runs every chunk.
    sourceEcho: () => (nbAt() ? view.notebook!.runAtCursor() : void run.sourceActive(true)),
    source: () => (nbAt() ? view.notebook!.runAll() : void run.sourceActive(false)),
    runChunk: () => nbAt() && view.notebook!.runAtCursor(),
    runAbove: () => nbAt() && view.notebook!.runAbove(),
    insertChunk: () => nbAt() && view.notebook!.insertChunk(),
    save: () => void tc.saveActive(),
    render: () => run.renderActive(),
    formatCode: (scope) => void formatCode(scope),
    goToDefinition: () => void nav.goToDefinition(),
    help: () => nav.helpAtCursor(),
    outline: () => outlineCtx.openOutline(),
    findInFiles: () => openFindInFiles(selectedText()),
    shortcuts: openShortcuts,
    settings: openSettings,
    palette: () => openCmPalette(),
    focusConsole: () => consoleApi?.focus(),
  };

  /** The command palette with this editor's commands. */
  function openCmPalette() {
    const c = cm;
    if (!c) return;
    const commands = [...c.labels.entries()]
      .filter(([id]) => id !== 'r.palette')
      .map(([id, label]) => ({ id, label, shortcut: COMMAND_KEYS[id] ? kbd(COMMAND_KEYS[id]) : undefined, run: () => c.getAction(id)?.run() }));
    openPalette(commands, () => c.focus());
  }

  const intelFor = (lang: string | undefined) => (isRLang(lang) ? rIntelligence(cm!, { activateOnTyping: quickSuggest() }) : []);
  const readOnly = () => !!activeTab()?.debugView || isInstalling();

  const api: EditorApi = {
    openAt: nav.openAt,
    openText: tc.openText,
    editOpen: tc.editOpen,
    command(id) {
      if (id === 'outline') return outlineCtx.openOutline();
      if (id === 'palette') return openCmPalette();
      cm?.getAction(id)?.run();
    },
    async openFile(path, o) {
      await tc.openFile(path, o);
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
      showPane('script');
      const sel = cm?.getSelection();
      if (!cm || !sel || !cm.getModel()) {
        newFile(undefined, text);
        return;
      }
      cm.executeEdits('history', [{ range: sel, text }]);
      cm.focus();
    },
    getOpenState: tc.getOpenState,
    restoreOpenState: tc.restoreOpenState,
    closeAll: tc.closeAll,
    hasDirty: tc.hasDirty,
    renderActive: run.renderActive,
    beforeCursor() {
      if (!cm?.getModel() || inGrid()) return null;
      const st = cm.view.state;
      const head = st.selection.main.head;
      const line = st.doc.lineAt(head);
      return line.text.slice(0, head - line.from);
    },
    setQuickSuggest: (on) => setQuickSuggest(on),
    key: createCmKeyHandler(() => cm, {
      canEdit: () => !inGrid() && !readOnly(),
      // In a Quarto chunk: run the chunk.
      runSelection: () => {
        const m = cm?.getModel();
        if (nbAt() && m && inRChunk(m, cm!.getPosition()?.lineNumber ?? 1)) view.notebook!.runAtCursor();
        else run.runSelection();
      },
    }),
    layout: () => cm?.layout(),
  };
  registerEditor(api);

  onMount(() => {
    cm = new CmEditor(host, (model) =>
      baseExtensions({
        editorExtension: cm!.extension(),
        extras: [stickyScroll(() => cm?.getModel() ?? null), rainbowBrackets()],
        language: model?.getLanguageId() ?? 'plaintext',
        touch,
        shortcuts,
        intel: intelFor(model?.getLanguageId()),
        isDark: isDark(),
        tabSize: tabSize(),
        wrap: settings.wordWrap,
        readOnly: readOnly(),
      }),
    );
    view.ed = cm.asMonaco();
    view.notebook = attachNotebook(view.ed);
    debugging.attach();

    // Named actions: the toolbar, the palette and EditorApi.command use them.
    const a = (id: string, label: string, fn: () => void) => cm!.addAction(id, fn, label);
    a('r.runLine', 'Run Current Line or Selection', shortcuts.runSelection);
    a('r.source', 'Source File', shortcuts.source);
    a('r.render', 'Render Document', shortcuts.render);
    a('r.runAll', 'Run All Chunks (Quarto)', () => nbAt() && view.notebook!.runAll());
    a('r.insertChunk', 'Insert R Chunk', shortcuts.insertChunk);
    a('r.save', 'Save File', shortcuts.save);
    a('r.saveAll', 'Save All Files', () => void tc.saveAll());
    a('r.newScript', 'New R Script', () => newFile());
    a('r.reformat', 'Reformat Code (styler)', () => shortcuts.formatCode('tokens'));
    a('r.reindent', 'Reindent Lines', () => shortcuts.formatCode('indention'));
    a('r.comment', 'Comment / Uncomment Lines', () => toggleLineComment(cm!.view));
    a('r.definition', 'Go to Function Definition', shortcuts.goToDefinition);
    a('r.help', 'Help for Name at Cursor', shortcuts.help);
    a('r.outline', 'Document Outline…', shortcuts.outline);
    a('r.findInFiles', 'Find in Files…', shortcuts.findInFiles);
    a('r.shortcuts', 'Keyboard Shortcuts', shortcuts.shortcuts);
    a('r.focusConsole', 'Move Focus to Console', shortcuts.focusConsole);
    a('r.settings', 'Settings…', shortcuts.settings);
    a('r.renv', 'Check renv.lock Compatibility', () => void checkRenv());
    a('r.renvWrite', 'Write renv.lock (for renv::restore() on desktop)', () => void writeRenvLock());
    a('r.snippets', 'Edit Code Snippets…', () => void editSnippets());
    a('r.palette', 'Command Palette', shortcuts.palette);
    cm.labels.set('actions.find', 'Find / Replace');

    const diag = syncDiagnostics(cm);
    // A document saved under another name can change language: rebuild its state.
    const lang = monaco.editor.onDidChangeModelLanguage((e) => cm?.resetState(e.model));
    onCleanup(() => (diag.dispose(), lang.dispose()));

    // Options follow the settings; each document has its own state, so they're
    // applied again whenever another document is shown.
    const applyOptions = () => {
      const c = cm;
      if (!c?.getModel()) return;
      c.view.dispatch({
        effects: [
          opts.colors.reconfigure(colorsFor(isDark())),
          opts.tabs.reconfigure(tabsFor(tabSize())),
          opts.wrap.reconfigure(wrapFor(settings.wordWrap)),
          opts.readOnly.reconfigure(readOnlyFor(readOnly())),
          opts.intel.reconfigure(intelFor(c.getModel()?.getLanguageId())),
        ],
      });
    };
    createEffect(applyOptions);
    cm.onDidChangeModel(applyOptions);
    createEffect(() => {
      const size = settings.editorFontSize - (phone() ? 1 : 0);
      host.style.setProperty('--cm-font-size', `${size}px`);
      host.style.setProperty('--cm-line-height', String(phone() ? 1.46 : 1.5));
      cm?.layout();
    });
    createEffect(() => {
      const size = tabSize();
      for (const m of models.values()) m.updateOptions({ tabSize: size, indentSize: size, insertSpaces: true });
    });
    // The on-screen keyboard opened: keep the cursor line in view.
    const vv = window.visualViewport;
    if (vv) {
      let last = vv.height;
      const onViewport = () => {
        const shrank = vv.height < last - 50;
        last = vv.height;
        if (shrank && cm?.hasTextFocus()) requestAnimationFrame(() => cm?.view.dispatch({ scrollIntoView: true }));
      };
      vv.addEventListener('resize', onViewport);
      onCleanup(() => vv.removeEventListener('resize', onViewport));
    }
  });

  onCleanup(() => {
    cm?.dispose();
    for (const m of models.values()) m.dispose();
  });

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
        <div ref={host} class="monaco-host cm-host" classList={{ hidden: !activeTab() || inGrid() }} />
        <InstallOverlay />
        <Show when={inGrid() && activeTab()} keyed>
          {(t) => <GridView tab={t} models={models} />}
        </Show>
        <OutlineMenu outline={outlineCtx} isNb={tc.isNb} />
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
