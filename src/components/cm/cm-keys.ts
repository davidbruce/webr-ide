// EditorApi.key for the CodeMirror pane: the phone key bar and the R keyboard
// acting on the editor (the Monaco pane's version is in editor/keybindings.ts).

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cursorCharLeft, cursorCharRight, cursorLineDown, cursorLineUp, deleteCharBackward, insertNewlineAndIndent, redo, undo } from '@codemirror/commands';
import { acceptCompletion, deleteBracketPair, moveCompletionSelection, nextSnippetField, hasNextSnippetField } from '@codemirror/autocomplete';
import { withoutPaneSwitch, type KeyAction } from '../../lib/ide';
import { completing, expandSnippet } from './cm-setup';
import type { CmEditor } from './cm-editor';

/** Text typed as if from a keyboard, so auto-closing brackets and completion apply. */
function typeIn(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, () => view.state.update(view.state.replaceSelection(text))));
  if (!handled) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
}

function back(view: EditorView, n = 0) {
  for (let i = 0; i < n; i++) cursorCharLeft(view);
}

export function createCmKeyHandler(ed: () => CmEditor | undefined, deps: { canEdit: () => boolean; runSelection: () => void }) {
  return function key(action: KeyAction) {
    const cm = ed();
    if (!cm?.getModel() || !deps.canEdit()) return;
    const view = cm.view;
    switch (action.type) {
      case 'move':
        if (completing(view) && (action.dir === 'up' || action.dir === 'down')) moveCompletionSelection(action.dir === 'down')(view);
        else ({ left: cursorCharLeft, right: cursorCharRight, up: cursorLineUp, down: cursorLineDown })[action.dir](view);
        break;
      case 'text':
        view.dispatch(view.state.replaceSelection(action.text), { scrollIntoView: true });
        back(view, action.back);
        break;
      case 'tab':
        // Like the Tab key: the next placeholder of a snippet, else expand a
        // snippet name, accept a suggestion, or indent.
        if (hasNextSnippetField(view.state)) nextSnippetField(view);
        else if (!expandSnippet(view) && !acceptCompletion(view)) typeIn(view, ' '.repeat(view.state.tabSize - ((view.state.selection.main.head - view.state.doc.lineAt(view.state.selection.main.head).from) % view.state.tabSize)));
        break;
      case 'type':
        typeIn(view, action.text);
        break;
      case 'backspace':
        if (!deleteBracketPair(view)) deleteCharBackward(view);
        break;
      case 'enter':
        if (completing(view)) acceptCompletion(view);
        else insertNewlineAndIndent(view);
        break;
      case 'complete': {
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        const from = Math.max(line.from, head - action.remove);
        view.dispatch({ changes: { from, to: head, insert: action.text }, selection: EditorSelection.cursor(from + action.text.length), scrollIntoView: true });
        back(view, action.back);
        break;
      }
      case 'undo':
        undo(view);
        break;
      case 'redo':
        redo(view);
        break;
      case 'run':
        // Stay in the editor (keyboard up); the Console tab gets a dot.
        withoutPaneSwitch(deps.runSelection);
        break;
    }
    view.focus();
  };
}
