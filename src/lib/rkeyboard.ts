// Experimental R keyboard: on phones, the editor and console can use an
// on-screen keyboard drawn by the IDE instead of the iPhone/Android one.
// The text areas they type into get inputmode="none", which keeps the system
// keyboard down while they still have focus and a cursor.

import { createEffect, createRoot, createSignal } from 'solid-js';
import { phone } from './ide-state';

const LS = 'webr-ide:r-keyboard';
const coarse = window.matchMedia('(pointer: coarse)');

function load() {
  try {
    return localStorage.getItem(LS) === '1';
  } catch {
    return false;
  }
}

const [enabled, setEnabledSignal] = createSignal(load());
/** The setting (Workspace menu → Experimental: R keyboard). */
export const rKeyboardEnabled = enabled;
/** The user switched to the system keyboard with 🌐 (until they switch back). */
const [native, setNative] = createSignal(false);
const [touch, setTouch] = createSignal(coarse.matches);
coarse.addEventListener('change', () => setTouch(coarse.matches));

/** Whether the editor and console use the R keyboard right now. */
export const rKeyboardActive = () => enabled() && phone() && touch() && !native();

export function setRKeyboardEnabled(on: boolean) {
  setEnabledSignal(on);
  setNative(false);
  try {
    localStorage.setItem(LS, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** The text areas the editor and console type into. */
const TARGETS = '.monaco-editor textarea.inputarea, .monaco-editor .native-edit-context, .cm-editor .cm-content, .console-term textarea';

function apply() {
  const none = rKeyboardActive();
  // Lets CSS keep Monaco's hidden text area in a fixed, always-visible spot
  // (see .rk-active in styles.css), so Safari never scrolls the page to it.
  document.documentElement.classList.toggle('rk-active', none);
  for (const el of Array.from(document.querySelectorAll(TARGETS))) {
    if (none) el.setAttribute('inputmode', 'none');
    else el.removeAttribute('inputmode');
  }
}

createRoot(() => createEffect(apply));
// A tap reaches pointerdown before it focuses anything, so set the attribute
// there too (for text areas created since the last change).
document.addEventListener('pointerdown', () => enabled() && apply(), true);
// Text areas created later (e.g. a new editor) pick it up when focused.
document.addEventListener(
  'focusin',
  (e) => {
    const el = e.target as Element;
    if (el.matches?.(TARGETS)) {
      if (rKeyboardActive()) el.setAttribute('inputmode', 'none');
      else el.removeAttribute('inputmode');
    }
  },
  true,
);

/**
 * Swap between the R keyboard and the system one while typing. Call from a
 * tap: the focused field is refocused so the browser re-reads inputmode.
 */
export function useSystemKeyboard(on: boolean) {
  const el = document.activeElement as HTMLElement | null;
  setNative(on);
  apply();
  if (el && el.matches(TARGETS)) {
    el.blur();
    el.focus();
  }
}

/** Leaving the editor/console ends a 🌐 switch, so the R keyboard is back next time. */
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (native() && !document.activeElement?.matches?.(TARGETS)) setNative(false);
  }, 300);
});
