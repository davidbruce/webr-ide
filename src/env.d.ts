declare module '@wterm/dom/css';
declare const __WEBR_PREFIX__: string;
declare module 'monaco-editor/languages/definitions/markdown/markdown.js' {
  import type { languages } from 'monaco-editor';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage & { tokenizer: Record<string, languages.IMonarchLanguageRule[]> };
}
