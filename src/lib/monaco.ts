import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { completions } from './ide';

(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('rstudio-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '4C886B', fontStyle: 'italic' },
    { token: 'keyword', foreground: '0000FF' },
    { token: 'string', foreground: '036A07' },
    { token: 'number', foreground: '0000CD' },
    { token: 'constant', foreground: '585CF6' },
    { token: 'operator', foreground: '687687' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f2f6fb',
    'editorLineNumber.foreground': '#a0a7b0',
    'editorLineNumber.activeForeground': '#3c4650',
    'editorGutter.background': '#f7f8fa',
  },
});

monaco.editor.defineTheme('rstudio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7f9f7f', fontStyle: 'italic' },
    { token: 'keyword', foreground: '8fb4ff' },
    { token: 'string', foreground: 'a5d6a7' },
    { token: 'number', foreground: 'f2c47e' },
    { token: 'constant', foreground: 'd7a6ff' },
  ],
  colors: {
    'editor.background': '#1d2127',
    'editor.lineHighlightBackground': '#262b33',
    'editorLineNumber.foreground': '#5d6672',
    'editorGutter.background': '#1a1d22',
  },
});

/** Pick a Monaco language id from a filename. */
export function languageFor(filename: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  if (ext === '.r') return 'r';
  if (ext === '.rmd' || ext === '.qmd' || ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.rprofile' || lower === '.rprofile' || lower === '.renviron') return 'r';
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id;
  }
  return 'plaintext';
}

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'rds', 'rda', 'rdata',
  'xlsx', 'xls', 'docx', 'pptx', 'parquet', 'feather', 'sqlite', 'db', 'so', 'wasm', 'mp3', 'mp4', 'mov', 'woff', 'woff2', 'ttf',
]);
export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
export const TABULAR_EXT = new Set(['csv', 'tsv', 'tab', 'psv']);
export const isTabularName = (name: string) => TABULAR_EXT.has(extOf(name));
/** Tabular files above this open in the grid only (no text editor). */
export const TEXT_VIEW_MAX = 10 * 1024 * 1024;
/** Tabular files above this aren't opened at all. */
export const GRID_MAX = 500 * 1024 * 1024;

export function isBinaryName(name: string) {
  return BINARY_EXT.has(extOf(name)) || name === '.RData';
}

// R completions backed by R's own completion engine (utils:::.completeToken).
monaco.languages.registerCompletionItemProvider('r', {
  triggerCharacters: ['$', '@', ':', '('],
  async provideCompletionItems(model, position) {
    const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const { token, items } = await completions(line);
    if (!items.length) return { suggestions: [] };
    const range = new monaco.Range(position.lineNumber, position.column - token.length, position.lineNumber, position.column);
    return {
      suggestions: items.slice(0, 500).map((label, i) => ({
        label,
        kind: label.endsWith('=') || label.endsWith('= ')
          ? monaco.languages.CompletionItemKind.Property
          : label.includes('::')
            ? monaco.languages.CompletionItemKind.Module
            : monaco.languages.CompletionItemKind.Variable,
        insertText: label,
        range,
        sortText: String(i).padStart(5, '0'),
      })),
    };
  },
});

/**
 * From `start` (1-based line), find the last line of the R statement that
 * begins there: keep going while brackets are open, a string is unterminated,
 * or the line ends with a binary operator / comma.
 */
export function statementEnd(model: monaco.editor.ITextModel, start: number): number {
  const n = model.getLineCount();
  let depth = 0;
  let quote: string | null = null;
  for (let ln = start; ln <= n; ln++) {
    const text = model.getLineContent(ln);
    let lastCode = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '#') break;
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      if (!/\s/.test(c)) lastCode = text.slice(0, i + 1);
    }
    const trailingOp = /(\|>|%[^%]*%|[-+*/^&|~,=<>!]|<-|->|\$|@)\s*$/.test(lastCode) && !/^\s*$/.test(lastCode);
    if (depth === 0 && !quote && !trailingOp) return ln;
  }
  return n;
}

export { monaco };
