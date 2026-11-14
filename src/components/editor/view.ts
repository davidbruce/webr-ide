// The Monaco editor instance of the script pane: the shared handle the editor
// modules use (`EditorView`), its construction options, and the effects that
// keep its options in step with settings, theme, touch input and locking.

import { createEffect, onCleanup } from 'solid-js';
import { monaco } from '../../lib/monaco';
import type { NotebookControls } from '../Notebook';
import { isInstalling, phone } from '../../lib/ide';
import { isDark } from '../../lib/ui';
import { desktopEditing } from '../../lib/input-mode';
import { settings } from '../../lib/settings';
import { tabSize, type TabsCtx } from './tabs';

/**
 * Shared, mutable handle on the pane's editor. `ed` and `notebook` are set in
 * EditorPane's onMount; code that runs earlier checks `view.ed?.`.
 */
export interface EditorView {
  ed: monaco.editor.IStandaloneCodeEditor;
  notebook: NotebookControls | undefined;
}

export function createEditor(host: HTMLElement) {
  return monaco.editor.create(host, {
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
}

/** Effects and listeners for the editor's options. Call from onMount. */
export function applyEditorOptions(ed: monaco.editor.IStandaloneCodeEditor, tc: TabsCtx) {
  const { models, activeTab } = tc;
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
        : { lineNumbersMinChars: 5, lineDecorationsWidth: 10, folding: true, glyphMargin: true }),
    });
  });
  createEffect(() => {
    const size = tabSize();
    for (const m of models.values()) m.updateOptions({ tabSize: size, indentSize: size, insertSpaces: true });
  });
  // Lock the editor while a package downloads/installs.
  createEffect(() =>
    ed.updateOptions(
      activeTab()?.debugView
        ? { readOnly: true, readOnlyMessage: { value: 'This is a read-only view of the function R is paused in.' } }
        : { readOnly: isInstalling(), readOnlyMessage: { value: 'Editing is paused while a package installs.' } },
    ),
  );
}
