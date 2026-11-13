// Phone key bar: while the editor or console has the on-screen keyboard, the
// bottom tab bar turns into keys the phone keyboard lacks: Tab, arrows,
// undo/redo and Run. The buttons never take focus, so the keyboard stays up.

import { createSignal, For, onCleanup } from 'solid-js';
import { editor, KeyAction, debugCommand, type DebugCommand } from '../lib/ide';
import { consoleApi } from './Console';
import { Icon } from './Icon';
import { rKeyboardActive, rKeyboardEnabled, useSystemKeyboard } from '../lib/rkeyboard';

type Target = 'editor' | 'console';

function targetOf(el: Element | null): Target | null {
  if (!el) return null;
  if (el.closest('.monaco-editor')) return 'editor';
  if (el.closest('.console-term')) return 'console';
  return null;
}
const isText = (el: Element | null) =>
  !!el &&
  (el.matches('textarea, [contenteditable="true"], select') ||
    (el.matches('input') && !/^(checkbox|radio|range|button|submit|color|file)$/.test((el as HTMLInputElement).type)));

/** Which text area has focus (and so the keyboard), if it's one the bar serves. */
const [target, setTarget] = createSignal<Target | null>(null);
export const keyBarTarget = target;
/** Whether any text field has focus (the keyboard is up). */
const [typing, setTyping] = createSignal(false);
export const keyboardUp = typing;

// Update after the tap that moved focus has finished: changing the bottom
// bar during that tap can make iOS drop the keyboard.
let settle: number | undefined;
const sync = () => {
  clearTimeout(settle);
  settle = window.setTimeout(() => {
    const el = document.activeElement;
    setTarget(targetOf(el));
    setTyping(isText(el));
    // No system keyboard to disturb with the R keyboard: swap at once (the
    // 0 ms wait still lets a blur-then-refocus settle without a flicker).
  }, rKeyboardActive() ? 0 : 250);
};
document.addEventListener('focusin', sync);
document.addEventListener('focusout', sync);

interface Key {
  title: string;
  icon: string;
  editor?: KeyAction;
  /** Characters sent to the console's line editor. */
  console?: string;
  repeat?: boolean;
}

const KEYS: Key[] = [
  { title: 'Tab (accepts a suggestion; completes in the console)', icon: 'tab', editor: { type: 'tab' }, console: '\t' },
  { title: 'Left', icon: 'arrow-left', editor: { type: 'move', dir: 'left' }, console: '\x1b[D', repeat: true },
  { title: 'Up (suggestions / previous command)', icon: 'arrow-up', editor: { type: 'move', dir: 'up' }, console: '\x1b[A', repeat: true },
  { title: 'Down (suggestions / next command)', icon: 'arrow-down', editor: { type: 'move', dir: 'down' }, console: '\x1b[B', repeat: true },
  { title: 'Right', icon: 'arrow-right', editor: { type: 'move', dir: 'right' }, console: '\x1b[C', repeat: true },
  { title: 'Undo', icon: 'undo', editor: { type: 'undo' } },
  { title: 'Redo', icon: 'redo', editor: { type: 'redo' } },
];

function press(k: Key | 'run', t: Target) {
  if (t === 'editor') {
    editor()?.key?.(k === 'run' ? { type: 'run' } : k.editor!);
  } else {
    const data = k === 'run' ? '\r' : k.console;
    if (data) consoleApi?.input(data);
    consoleApi?.focus();
  }
}

/** A button that acts on tap (and repeats while held), without taking focus. */
function KeyButton(p: { k: Key | 'run'; class?: string; title: string; icon: string }) {
  let timer: number | undefined;
  let repeated = false;
  const stop = () => {
    clearTimeout(timer);
    clearInterval(timer);
    timer = undefined;
  };
  onCleanup(stop);
  return (
    <button
      type="button"
      class={`keybar-key ${p.class ?? ''}`}
      title={p.title}
      aria-label={p.title}
      tabindex="-1"
      // Keep focus (and the keyboard) in the editor or console.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse') e.preventDefault();
        repeated = false;
        const k = p.k;
        if (k !== 'run' && k.repeat && target()) {
          timer = window.setTimeout(() => {
            repeated = true;
            press(k, target()!);
            timer = window.setInterval(() => target() && press(k, target()!), 70);
          }, 380);
        }
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onClick={() => {
        stop();
        if (repeated || !target()) return;
        press(p.k, target()!);
      }}
    >
      <Icon name={p.icon} size={20} />
    </button>
  );
}

const DEBUG_KEYS: { cmd: DebugCommand; title: string; icon: string; class?: string }[] = [
  { cmd: 'next', title: 'Next line', icon: 'step-over' },
  { cmd: 'step', title: 'Step into the function call', icon: 'step-into' },
  { cmd: 'finish', title: 'Finish this function', icon: 'step-out' },
  { cmd: 'continue', title: 'Continue', icon: 'continue', class: 'run' },
  { cmd: 'stop', title: 'Stop debugging', icon: 'stop', class: 'danger' },
];

/** Phones, while R is paused: the debugger's buttons, above the bottom bar. */
export function DebugKeys() {
  return (
    <div class="keybar debug-keys" role="toolbar" aria-label="Debugger">
      <For each={DEBUG_KEYS}>
        {(k) => (
          <button
            type="button"
            class={`keybar-key ${k.class ?? ''}`}
            title={k.title}
            aria-label={k.title}
            tabindex="-1"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => debugCommand(k.cmd)}
          >
            <Icon name={k.icon} size={20} />
          </button>
        )}
      </For>
    </div>
  );
}

export function KeyBar() {
  const keys = () => KEYS.filter((k) => (target() === 'console' ? k.console : k.editor));
  return (
    <div class="keybar" role="toolbar" aria-label="Programming keys">
      <For each={keys()}>{(k) => <KeyButton k={k} title={k.title} icon={k.icon} />}</For>
      <KeyButton k="run" class="run" title={target() === 'console' ? 'Run (Enter)' : 'Run the current line or chunk'} icon="play" />
      {rKeyboardEnabled() && (
        <button
          type="button"
          class="keybar-key"
          title="Back to the R keyboard"
          aria-label="Back to the R keyboard"
          tabindex="-1"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useSystemKeyboard(false)}
        >
          <Icon name="keyboard" size={20} />
        </button>
      )}
    </div>
  );
}
