// CodeMirror 6 configuration for the experimental editor: languages, the
// RStudio-like colours, options that follow the settings (compartments), the
// Tab key (snippets, completion, indenting) and the RStudio shortcuts.

import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
  type Command,
  type KeyBinding,
} from '@codemirror/view';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
  type Language,
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, toggleLineComment } from '@codemirror/commands';
import { acceptCompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, snippet } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { lintGutter, lintKeymap } from '@codemirror/lint';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { r } from '@codemirror/legacy-modes/mode/r';
import { tags as t } from '@lezer/highlight';
import { snippetNameIn, resolveR, snippets } from '../../lib/snippets';

// ---------------------------------------------------------------- languages

export const rLanguage: Language = StreamLanguage.define(r);

/** Quarto / R Markdown: a YAML header, then Markdown with ```{r} chunks highlighted as R. */
function quarto(): LanguageSupport {
  return yamlFrontmatter({ content: markdown({ codeLanguages: (info) => (/^\{?\s*r\b/i.test(info) ? rLanguage : null) }) });
}

/** The language for a Monaco language id (see languageFor in lib/monaco). */
export function languageExtension(id: string): Extension {
  switch (id) {
    case 'r':
      return rLanguage;
    case 'quarto':
      return quarto();
    case 'markdown':
      return markdown();
    case 'json':
      return json();
    case 'css':
      return css();
    case 'html':
      return html();
    case 'javascript':
      return javascript();
    case 'typescript':
      return javascript({ typescript: true });
    default:
      return [];
  }
}

// ---------------------------------------------------------------- look

const light = HighlightStyle.define([
  { tag: t.comment, color: '#4C886B', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword], color: '#0000FF' },
  { tag: [t.string, t.special(t.string)], color: '#036A07' },
  { tag: t.number, color: '#0000CD' },
  { tag: [t.atom, t.bool, t.null, t.constant(t.name)], color: '#585CF6' },
  { tag: t.operator, color: '#687687' },
  { tag: [t.heading], fontWeight: '700', color: '#2b5b84' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: [t.link, t.url], color: '#2266b8' },
  { tag: [t.propertyName, t.attributeName], color: '#7a3e9d' },
  { tag: [t.typeName, t.tagName], color: '#a0522d' },
]);
const dark = HighlightStyle.define([
  { tag: t.comment, color: '#7f9f7f', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword], color: '#8fb4ff' },
  { tag: [t.string, t.special(t.string)], color: '#a5d6a7' },
  { tag: t.number, color: '#f2c47e' },
  { tag: [t.atom, t.bool, t.null, t.constant(t.name)], color: '#d7a6ff' },
  { tag: t.operator, color: '#a8b3bf' },
  { tag: [t.heading], fontWeight: '700', color: '#8fb4ff' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: [t.link, t.url], color: '#8fb4ff' },
  { tag: [t.propertyName, t.attributeName], color: '#d7a6ff' },
  { tag: [t.typeName, t.tagName], color: '#f2c47e' },
]);

/** The editor's frame, from the app's colour tokens (so it follows light/dark). */
const frame = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg-pane)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace', lineHeight: 'var(--cm-line-height, 1.5)' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-toolbar)', color: 'var(--text-faint)', borderRight: '1px solid var(--border-soft)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-select) !important' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)', outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-pane)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: '"SF Mono", Menlo, monospace', maxHeight: '16em' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-text)' },
  '.cm-completionDetail': { marginLeft: '0.8em', opacity: 0.7, fontStyle: 'normal' },
  '.cm-completionInfo': { maxWidth: '420px', padding: '6px 10px' },
  '.cm-panels': { backgroundColor: 'var(--bg-toolbar)', color: 'var(--text)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 55%, transparent)' },
});

// ---------------------------------------------------------------- options

/** Options that change with the settings, swapped in place. */
export const opts = {
  colors: new Compartment(),
  tabs: new Compartment(),
  wrap: new Compartment(),
  readOnly: new Compartment(),
  intel: new Compartment(),
};

export const colorsFor = (isDark: boolean) => syntaxHighlighting(isDark ? dark : light);
export const tabsFor = (size: number) => [EditorState.tabSize.of(size), indentUnit.of(' '.repeat(size))];
export const wrapFor = (on: boolean) => (on ? EditorView.lineWrapping : []);
export const readOnlyFor = (on: boolean) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];

// ---------------------------------------------------------------- Tab

/** Insert spaces to the next tab stop (as Monaco does), or indent a selection. */
const tabOrIndent: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  const unit = state.facet(indentUnit).length || 2;
  view.dispatch(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      const col = range.head - line.from;
      const pad = ' '.repeat(unit - (col % unit));
      return { changes: { from: range.head, insert: pad }, range: EditorSelection.cursor(range.head + pad.length) };
    }),
  );
  return true;
};

/** Tab after a snippet's name: insert the snippet (from r.snippets, `r expr` filled in by R). */
export const expandSnippet: Command = (view) => {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  const name = snippetNameIn(line.text.slice(0, sel.head - line.from));
  if (!name) return false;
  const from = sel.head - name.length;
  void resolveR(snippets().get(name)!).then((body) => {
    snippet(body.replace(/\$(\d+)/g, '${$1}').replace(/\\\$/g, '$'))(view, { label: name }, from, sel.head);
  });
  return true;
};

const tabKey: KeyBinding = { key: 'Tab', run: (v) => expandSnippet(v) || acceptCompletion(v) || tabOrIndent(v), shift: indentLess };

// ---------------------------------------------------------------- the editor

export interface Shortcuts {
  runSelection(): void;
  sourceEcho(): void;
  source(): void;
  runChunk(): void;
  runAbove(): void;
  insertChunk(): void;
  save(): void;
  render(): void;
  formatCode(scope: 'tokens' | 'indention'): void;
  goToDefinition(): void;
  help(): void;
  outline(): void;
  findInFiles(): void;
  shortcuts(): void;
  settings(): void;
  palette(): void;
  focusConsole(): void;
}

const typeText = (text: string): Command => (view) => {
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
  return true;
};

/** RStudio's shortcuts (Mod = ⌘ on a Mac, Ctrl elsewhere). */
function rstudioKeys(s: Shortcuts): KeyBinding[] {
  const run = (f: () => void): Command => () => (f(), true);
  return [
    { key: 'Mod-Enter', run: run(s.runSelection) },
    { key: 'Ctrl-Enter', run: run(s.runSelection) },
    { key: 'Mod-Shift-Enter', run: run(s.sourceEcho) },
    { key: 'Mod-Shift-s', run: run(s.source) },
    { key: 'Mod-Alt-r', run: run(s.source) },
    { key: 'Mod-Alt-c', run: run(s.runChunk) },
    { key: 'Mod-Alt-p', run: run(s.runAbove) },
    { key: 'Mod-Alt-i', run: run(s.insertChunk) },
    { key: 'Mod-s', run: run(s.save) },
    { key: 'Mod-Shift-k', run: run(s.render) },
    { key: 'Mod-Shift-m', run: typeText(' |> ') },
    { key: 'Alt--', run: typeText(' <- ') },
    { key: 'Mod-2', run: run(s.focusConsole) },
    { key: 'Mod-Shift-a', run: run(() => s.formatCode('tokens')) },
    { key: 'Mod-i', run: run(() => s.formatCode('indention')) },
    { key: 'Mod-Shift-c', run: toggleLineComment },
    { key: 'F2', run: run(s.goToDefinition) },
    { key: 'F1', run: run(s.help) },
    { key: 'Mod-Shift-o', run: run(s.outline) },
    { key: 'Mod-Shift-f', run: run(s.findInFiles) },
    { key: 'Alt-Shift-k', run: run(s.shortcuts) },
    { key: 'Mod-,', run: run(s.settings) },
    { key: 'Mod-Shift-p', run: run(s.palette) },
  ];
}

/** Everything a document's state needs (the language comes from its model). */
export function baseExtensions(cfg: { editorExtension: Extension; extras: Extension; language: string; touch: boolean; shortcuts: Shortcuts; intel: Extension; isDark: boolean; tabSize: number; wrap: boolean; readOnly: boolean }): Extension {
  return [
    cfg.editorExtension, // decorations, the glyph margin and line numbers (CmEditor)
    cfg.extras, // sticky scroll, rainbow brackets
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    // On touch screens the browser draws the selection, so iOS keeps its own
    // handles and magnifier; with a mouse CodeMirror draws it (multiple cursors).
    cfg.touch ? [] : [drawSelection(), rectangularSelection(), crosshairCursor()],
    dropCursor(),
    EditorState.allowMultipleSelections.of(!cfg.touch),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    lintGutter(),
    languageExtension(cfg.language),
    frame,
    opts.colors.of(colorsFor(cfg.isDark)),
    opts.tabs.of(tabsFor(cfg.tabSize)),
    opts.wrap.of(wrapFor(cfg.wrap)),
    opts.readOnly.of(readOnlyFor(cfg.readOnly)),
    opts.intel.of(cfg.intel),
    Prec.high(keymap.of([tabKey, ...rstudioKeys(cfg.shortcuts)])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
    EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
  ];
}

/** True while the completion list is open. */
export const completing = (view: EditorView) => completionStatus(view.state) === 'active';
