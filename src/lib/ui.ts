import { createSignal } from 'solid-js';

// ---------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
export { toasts };
let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 6000 : 3000) {
  const id = ++toastId;
  setToasts((t) => [...t, { id, text, kind }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
}

// ---------------------------------------------------------------- dialogs

export interface DialogRequest {
  title: string;
  message?: string;
  input?: { value: string; placeholder?: string; selectStem?: boolean };
  okLabel?: string;
  cancelLabel?: string | null;
  danger?: boolean;
  extra?: { label: string; value: string };
  resolve: (value: string | null) => void;
}

const [dialog, setDialog] = createSignal<DialogRequest | null>(null);
export { dialog, setDialog };

export function askText(title: string, value = '', opts: { message?: string; okLabel?: string; selectStem?: boolean } = {}) {
  return new Promise<string | null>((resolve) =>
    setDialog({ title, message: opts.message, input: { value, selectStem: opts.selectStem }, okLabel: opts.okLabel ?? 'OK', resolve }),
  );
}

export function confirmDialog(title: string, message: string, opts: { okLabel?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) =>
    setDialog({ title, message, okLabel: opts.okLabel ?? 'OK', danger: opts.danger, resolve: (v) => resolve(v !== null) }),
  );
}

/** Three-way choice: returns 'ok', the extra value, or null for cancel. */
export function choiceDialog(title: string, message: string, ok: string, extra: { label: string; value: string }) {
  return new Promise<string | null>((resolve) => setDialog({ title, message, okLabel: ok, extra, resolve }));
}

// ---------------------------------------------------------------- image viewer

export const [imageView, setImageView] = createSignal<null | { title: string; url: string }>(null);

// ---------------------------------------------------------------- theme

export type ThemePref = 'light' | 'dark' | 'system';
const LS_THEME = 'webr-ide:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

const [themePref, setThemePrefSignal] = createSignal<ThemePref>((localStorage.getItem(LS_THEME) as ThemePref) || 'light');
const [systemDark, setSystemDark] = createSignal(media.matches);
media.addEventListener('change', (e) => setSystemDark(e.matches));
export { themePref };

export const isDark = () => (themePref() === 'system' ? systemDark() : themePref() === 'dark');

export function setThemePref(t: ThemePref) {
  localStorage.setItem(LS_THEME, t);
  setThemePrefSignal(t);
}

// ---------------------------------------------------------------- misc

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || navigator.userAgent.includes('Mac');
export const modKey = isMac ? '⌘' : 'Ctrl+';
