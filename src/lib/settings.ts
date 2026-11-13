// User preferences, kept in this browser (localStorage). Theme and the R
// keyboard keep their own storage (ui.ts, rkeyboard.ts); the Settings dialog
// shows them all in one place.
import { createStore } from 'solid-js/store';
import { createSignal } from 'solid-js';

export interface Settings {
  /** Editor font size in px (phones use one less). */
  editorFontSize: number;
  consoleFontSize: number;
  tabSize: 2 | 4;
  wordWrap: boolean;
  /** Help box when holding the pointer over a function. */
  hoverHelp: boolean;
  /** Underline syntax errors as you type. */
  syntaxCheck: boolean;
  /** Warn about misspelled functions, wrong arguments and unused variables. */
  lint: boolean;
}

const coarse = window.matchMedia('(pointer: coarse)').matches;
export const DEFAULTS: Settings = {
  editorFontSize: 14,
  consoleFontSize: coarse ? 14 : 13,
  tabSize: 2,
  wordWrap: false,
  hoverHelp: true,
  syntaxCheck: true,
  lint: true,
};

const LS_KEY = 'webr-ide:settings';

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

const [settings, setStore] = createStore<Settings>(load());
export { settings };

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setStore(key, value as any);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

export function resetSettings() {
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) setSetting(k, DEFAULTS[k]);
}

const [settingsOpen, setSettingsOpen] = createSignal(false);
export { settingsOpen, setSettingsOpen };
export const openSettings = () => setSettingsOpen(true);
