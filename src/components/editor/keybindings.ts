// Editor keyboard: the snippet Tab key, RStudio-style shortcuts and the
// command-palette actions, plus the handler for the phone key bar and the R
// keyboard (EditorApi.key).

import { monaco, inRChunk } from '../../lib/monaco';
import { withoutPaneSwitch, checkRenv, writeRenvLock, type KeyAction } from '../../lib/ide';
import { consoleApi } from '../Console';
import { expandSnippet, snippetAtCursor, loadSnippets, editSnippets } from '../../lib/snippets';
import { openShortcuts } from '../Shortcuts';
import { openFindInFiles } from '../SearchPanel';
import { openSettings } from '../../lib/settings';
import { kbd } from '../../lib/ui';
import { openPalette } from '../CommandPalette';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';
import type { RunCtx } from './run';

/** Shortcuts of the app's commands, as shown in the palette (both editors). */
export const COMMAND_KEYS: Record<string, string> = {
  'r.runLine': 'mod+enter',
  'r.source': 'mod+shift+S',
  'r.render': 'mod+shift+K',
  'r.runAll': 'mod+alt+R',
  'r.insertChunk': 'mod+alt+I',
  'r.save': 'mod+S',
  'r.reformat': 'mod+shift+A',
  'r.reindent': 'mod+I',
  'r.comment': 'mod+shift+C',
  'r.definition': 'F2',
  'r.help': 'F1',
  'r.outline': 'mod+shift+O',
  'r.findInFiles': 'mod+shift+F',
  'r.shortcuts': 'alt+shift+K',
  'r.focusConsole': 'mod+2',
  'r.settings': 'mod+,',
  'actions.find': 'mod+F',
};

/** The command palette for the Monaco editor: its actions, ours and Monaco's own. */
export function palette(ed: monaco.editor.IStandaloneCodeEditor | undefined) {
  if (!ed?.getModel()) return;
  // Monaco's own shortcut labels (not public API; shown when available).
  const keyLabel = (id: string): string | undefined => {
    try {
      return (ed as unknown as { _standaloneKeybindingService?: { lookupKeybinding(id: string): { getLabel(): string | null } | undefined } })._standaloneKeybindingService
        ?.lookupKeybinding(id)
        ?.getLabel() ?? undefined;
    } catch {
      return undefined;
    }
  };
  // Monaco prefixes the ids of actions added to an editor ("<editor>:r.save").
  const ours = (id: string) => id.replace(/^.*:(?=r\.)/, '');
  const commands = ed
    .getSupportedActions()
    .filter((a) => a.label && ours(a.id) !== 'r.palette' && a.id !== 'editor.action.quickCommand' && a.isSupported())
    .map((a) => {
      const id = ours(a.id);
      return { id, label: a.label, shortcut: COMMAND_KEYS[id] ? kbd(COMMAND_KEYS[id]) : keyLabel(a.id), run: () => void a.run() };
    });
  openPalette(commands, () => ed.focus());
}

/** Tab after a snippet's name expands it (also with the completion list open). */
export function registerSnippetTab(ed: monaco.editor.IStandaloneCodeEditor) {
  const C = monaco.KeyCode;
  const snippetKey = ed.createContextKey<boolean>('rSnippetAtCursor', false);
  ed.onDidChangeCursorSelection(() => snippetKey.set(snippetAtCursor(ed)));
  ed.onDidChangeModel(() => void loadSnippets().then(() => snippetKey.set(snippetAtCursor(ed))));
  ed.addCommand(
    C.Tab,
    () => {
      if (expandSnippet(ed)) ed.trigger('snippet', 'hideSuggestWidget', null);
      else ed.trigger('keyboard', 'tab', null);
    },
    'rSnippetAtCursor && editorTextFocus && !inSnippetMode && !editorReadonly',
  );
}

export interface CommandDeps {
  isNb: () => boolean;
  newFile: TabsCtx['newFile'];
  saveActive: TabsCtx['saveActive'];
  saveAll: TabsCtx['saveAll'];
  runSelection: RunCtx['runSelection'];
  sourceActive: RunCtx['sourceActive'];
  renderActive: RunCtx['renderActive'];
  formatCode: (scope: 'tokens' | 'indention') => Promise<void>;
  goToDefinition: () => Promise<void>;
  helpAtCursor: () => void;
  openOutline: () => void;
}

/** Keyboard shortcuts and command-palette actions. Call from onMount. */
export function registerCommands(view: EditorView, d: CommandDeps) {
  const ed = view.ed;
  const { isNb, newFile, runSelection, sourceActive, renderActive, formatCode, goToDefinition, helpAtCursor, openOutline } = d;
  const K = monaco.KeyMod;
  const C = monaco.KeyCode;
  ed.addCommand(K.CtrlCmd | C.Enter, runSelection);
  ed.addCommand(K.WinCtrl | C.Enter, runSelection);
  ed.addCommand(K.CtrlCmd | K.Shift | C.Enter, () => (isNb() ? view.notebook!.runAtCursor() : void sourceActive(true)));
  ed.addCommand(K.CtrlCmd | K.Shift | C.KeyS, () => void sourceActive(false));
  ed.addCommand(K.CtrlCmd | C.KeyS, () => void d.saveActive());
  // Quarto: every chunk. Scripts: source the file (what "run everything" means there).
  ed.addCommand(K.CtrlCmd | K.Alt | C.KeyR, () => (isNb() ? view.notebook!.runAll() : void sourceActive(false)));
  ed.addCommand(K.CtrlCmd | K.Alt | C.KeyC, () => isNb() && view.notebook!.runAtCursor());
  ed.addCommand(K.CtrlCmd | K.Alt | C.KeyP, () => isNb() && view.notebook!.runAbove());
  ed.addCommand(K.CtrlCmd | K.Alt | C.KeyI, () => isNb() && view.notebook!.insertChunk());
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
  action('r.runAll', 'Run All Chunks (Quarto)', [], () => isNb() && view.notebook!.runAll());
  action('r.source', 'Source File', [], () => void sourceActive(false));
  action('r.render', 'Render Document', [], renderActive);
  action('r.insertChunk', 'Insert R Chunk', [], () => isNb() && view.notebook!.insertChunk());
  action('r.save', 'Save File', [], () => void d.saveActive());
  action('r.saveAll', 'Save All Files', [], () => void d.saveAll());
  action('r.newScript', 'New R Script', [], () => newFile());
  action('r.findInFiles', 'Find in Files…', [K.CtrlCmd | K.Shift | C.KeyF], () => openFindInFiles(ed.getModel()?.getValueInRange(ed.getSelection()!) ?? ''));
  action('r.shortcuts', 'Keyboard Shortcuts', [K.Alt | K.Shift | C.KeyK], openShortcuts);
  action('r.focusConsole', 'Move Focus to Console', [], () => consoleApi?.focus());
  action('r.settings', 'Settings…', [K.CtrlCmd | C.Comma], openSettings);
  action('r.renv', 'Check renv.lock Compatibility', [], () => void checkRenv());
  action('r.renvWrite', 'Write renv.lock (for renv::restore() on desktop)', [], () => void writeRenvLock());
  action('r.snippets', 'Edit Code Snippets…', [], () => void editSnippets());
  action('r.palette', 'Command Palette', [K.CtrlCmd | K.Shift | C.KeyP], () => palette(view.ed));
  // F1 is R help here (as in RStudio); the palette is ⌘⇧P.
  monaco.editor.addKeybindingRule({ keybinding: C.F1, command: '-editor.action.quickCommand' });
}

/** EditorApi.key: the phone key bar and the R keyboard, acting on the focused editor. */
export function createKeyHandler(view: EditorView, tc: TabsCtx, run: RunCtx) {
  const { isNb, inGrid } = tc;
  const { runSelection } = run;
  return function key(action: KeyAction) {
    const ed = view.ed;
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
        // Like the Tab key: within a snippet, the next placeholder; else expand a snippet name.
        if ((ed as any)._contextKeyService?.getContextKeyValue?.('hasNextTabstop')) go(suggesting() ? 'acceptSelectedSuggestion' : 'jumpToNextSnippetPlaceholder');
        else if (expandSnippet(ed)) go('hideSuggestWidget');
        else go(suggesting() ? 'acceptSelectedSuggestion' : 'tab');
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
        withoutPaneSwitch(() => (isNb() && inRChunk(ed.getModel()!, ed.getPosition()?.lineNumber ?? 1) ? view.notebook?.runAtCursor() : runSelection()));
        break;
    }
    ed.focus();
  };
}
