// Experimental R keyboard for phones (see lib/rkeyboard.ts): the iPhone's
// letter / 123 / #+= layouts, with an R row and navigation row above, R
// completions in place of the system suggestion bar, a space bar that
// doubles as a trackpad, and 🌐 to switch to the system keyboard.
//
// Built for fast typing:
//   - character keys type on touch-down (overlapping taps can't drop them)
//   - each key's touch area covers its share of the gaps between keys, so
//     there are no dead spots; the visible key is drawn inside it
//   - a touch anywhere on the keyboard never moves focus out of the editor

import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { completions, editor, KeyAction } from '../lib/ide';
import { useSystemKeyboard } from '../lib/rkeyboard';
import { consoleApi } from './Console';
import { keyBarTarget } from './KeyBar';
import { Icon } from './Icon';
import './RKeyboard.css';

type Target = 'editor' | 'console';
/** Letters, iOS's 123 layer, and its #+= layer. */
type Layer = 'abc' | '123' | 'sym';
type Act =
  | { t: 'type'; text: string }
  | { t: 'move'; dir: 'left' | 'right' | 'up' | 'down' }
  | { t: 'layer'; to: Layer }
  | { t: 'tab' | 'undo' | 'redo' | 'run' | 'backspace' | 'enter' | 'hide' | 'globe' | 'shift' };

const SEQ = { left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B' } as const;
const EDITOR_KEYS: Partial<Record<Act['t'], KeyAction>> = {
  tab: { type: 'tab' },
  undo: { type: 'undo' },
  redo: { type: 'redo' },
  run: { type: 'run' },
  backspace: { type: 'backspace' },
  enter: { type: 'enter' },
};

/** Send one action to the editor or the console. */
function perform(a: Act, target: Target) {
  if (a.t === 'hide') {
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  if (a.t === 'globe') {
    useSystemKeyboard(true);
    return;
  }
  if (target === 'editor') {
    const ed = editor();
    if (a.t === 'type') ed?.key?.({ type: 'type', text: a.text });
    else if (a.t === 'move') ed?.key?.({ type: 'move', dir: a.dir });
    else if (EDITOR_KEYS[a.t]) ed?.key?.(EDITOR_KEYS[a.t]!);
  } else {
    const c = consoleApi;
    if (!c) return;
    if (a.t === 'type') c.input(a.text);
    else if (a.t === 'move') c.input(SEQ[a.dir]);
    else if (a.t === 'backspace') c.input('\x7f');
    else if (a.t === 'enter' || a.t === 'run') c.input('\r');
    else if (a.t === 'tab') c.input('\t');
    // Only refocus if focus really left (refocusing is a blur + focus).
    if (!document.activeElement?.closest('.console-term')) c.focus();
  }
}

interface KeyDef {
  /** Shown on the key (or an icon). */
  label?: string;
  icon?: string;
  act: Act;
  /** Long-press alternative (the key then acts on release). */
  alt?: Act & { t: 'type' };
  repeat?: boolean;
  /** Relative width of the visible key. */
  w?: number;
  /** Extra touch area beside the key (in key widths), e.g. iOS's A and L. */
  padL?: number;
  padR?: number;
  kind?: 'mod' | 'run';
  title?: string;
}

const type = (text: string, alt?: string): KeyDef => ({
  label: text.trim() || text,
  act: { t: 'type', text },
  alt: alt === undefined ? undefined : { t: 'type', text: alt },
});
const letters = (row: string) => [...row].map((ch) => type(ch));
const pad = (k: KeyDef, padL = 0, padR = 0): KeyDef => ({ ...k, padL, padR });

const NAV: KeyDef[] = [
  { icon: 'tab', act: { t: 'tab' }, title: 'Tab' },
  { icon: 'arrow-left', act: { t: 'move', dir: 'left' }, repeat: true, title: 'Left' },
  { icon: 'arrow-up', act: { t: 'move', dir: 'up' }, repeat: true, title: 'Up' },
  { icon: 'arrow-down', act: { t: 'move', dir: 'down' }, repeat: true, title: 'Down' },
  { icon: 'arrow-right', act: { t: 'move', dir: 'right' }, repeat: true, title: 'Right' },
  { icon: 'undo', act: { t: 'undo' }, title: 'Undo' },
  { icon: 'redo', act: { t: 'redo' }, title: 'Redo' },
  { icon: 'play', act: { t: 'run' }, kind: 'run', title: 'Run' },
  { icon: 'chevron-down', act: { t: 'hide' }, title: 'Hide keyboard' },
];

const R_ROW: KeyDef[] = [
  { ...type(' <- ', ' -> '), label: '<-' },
  { ...type(' |> ', ' %>% '), label: '|>' },
  type('(', '['),
  type(')', ']'),
  type('[', '[['),
  type(']', ']]'),
  type('{', '}'),
  type('"', "'"),
  type('$', '@'),
  type('~', '`'),
];

const BACKSPACE: KeyDef = { icon: 'backspace', act: { t: 'backspace' }, repeat: true, w: 1.35, padL: 0.15, kind: 'mod', title: 'Delete' };
const SHIFT: KeyDef = { icon: 'shift', act: { t: 'shift' }, w: 1.35, padR: 0.15, kind: 'mod', title: 'Shift (twice for caps lock)' };
const layerKey = (label: string, to: Layer, title: string, padR = 0): KeyDef => ({ label, act: { t: 'layer', to }, w: 1.35, padR, kind: 'mod', title });
const PUNCT_ROW = ['.', ',', '?', '!', "'"].map((ch) => ({ ...type(ch), w: 1.42 }));
const middle = (row: string) => {
  const keys = letters(row);
  return [pad(keys[0], 0.5), ...keys.slice(1, -1), pad(keys[keys.length - 1], 0, 0.5)];
};

// The same layouts as the iPhone keyboard.
const LAYERS: Record<Layer, KeyDef[][]> = {
  abc: [letters('qwertyuiop'), middle('asdfghjkl'), [SHIFT, ...letters('zxcvbnm'), BACKSPACE]],
  '123': [letters('1234567890'), letters('-/:;()$&@"'), [layerKey('#+=', 'sym', 'More symbols', 0.15), ...PUNCT_ROW, BACKSPACE]],
  sym: [letters('[]{}#%^*+='), letters('_\\|~<>€£¥•'), [layerKey('123', '123', 'Numbers', 0.15), ...PUNCT_ROW, BACKSPACE]],
};
const SPACE: KeyDef = { label: 'space', act: { t: 'type', text: ' ' }, w: 5.2, title: 'Space (drag to move the cursor)' };
const GLOBE: KeyDef = { icon: 'globe', act: { t: 'globe' }, w: 1.35, kind: 'mod', title: 'Switch to the system keyboard' };
const RETURN: KeyDef = { label: 'return', act: { t: 'enter' }, w: 2.6, kind: 'mod', title: 'Return' };
const BOTTOM: Record<'abc' | 'other', KeyDef[]> = {
  abc: [layerKey('123', '123', 'Numbers and symbols'), GLOBE, SPACE, RETURN],
  other: [layerKey('ABC', 'abc', 'Letters'), GLOBE, SPACE, RETURN],
};

/** Don't let a touch on the keyboard move focus away from the editor/console. */
const keepFocus = (e: Event) => e.preventDefault();

export function RKeyboard() {
  const [layer, setLayer] = createSignal<Layer>('abc');
  const [shift, setShift] = createSignal<'off' | 'once' | 'lock'>('off');
  const [chips, setChips] = createSignal<{ label: string; fn: boolean }[]>([]);
  const [token, setToken] = createSignal('');
  const target = () => keyBarTarget() ?? 'editor';
  let lastShift = 0;

  // R completions in place of the system suggestion bar.
  let seq = 0;
  let timer: number | undefined;
  function refreshSuggestions() {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const id = ++seq;
      const before = target() === 'editor' ? editor()?.beforeCursor?.() : consoleApi?.beforeCursor();
      if (before == null) return setChips([]);
      const word = /[A-Za-z0-9._]*(::?)?[A-Za-z0-9._]*$/.exec(before)?.[0] ?? '';
      const inCall = /[(,]\s*$/.test(before);
      if (!word && !inCall) return setChips([]);
      const res = await completions(before);
      if (id !== seq) return;
      setToken(res.token);
      setChips(res.items.slice(0, 30).map((label, i) => ({ label, fn: res.fn[i] })));
    }, 150);
  }
  onCleanup(() => clearTimeout(timer));

  function choose(c: { label: string; fn: boolean }) {
    const after = c.fn ? '()' : '';
    const remove = token().length;
    if (target() === 'editor') editor()?.key?.({ type: 'complete', remove, text: c.label + after, back: after ? 1 : 0 });
    else consoleApi?.input('\x7f'.repeat(remove) + c.label + after + (after ? SEQ.left : ''));
    refreshSuggestions();
  }

  function act(a: Act) {
    if (a.t === 'shift') {
      const now = Date.now();
      setShift(shift() === 'off' ? 'once' : shift() === 'once' && now - lastShift < 350 ? 'lock' : 'off');
      lastShift = now;
      return;
    }
    if (a.t === 'layer') {
      setLayer(a.to);
      return;
    }
    // Like iOS: a space after numbers or symbols goes back to letters.
    if (a.t === 'type' && a.text === ' ' && layer() !== 'abc') setLayer('abc');
    let out = a;
    if (a.t === 'type' && shift() !== 'off' && /^[a-z]$/.test(a.text)) {
      out = { t: 'type', text: a.text.toUpperCase() };
      if (shift() === 'once') setShift('off');
    }
    perform(out, target());
    if (a.t !== 'hide' && a.t !== 'globe') refreshSuggestions();
  }

  onMount(() => {
    // The strip replaces Monaco's own popup while this keyboard is up.
    editor()?.setQuickSuggest?.(false);
    refreshSuggestions();
  });
  onCleanup(() => editor()?.setQuickSuggest?.(true));

  const upper = () => shift() !== 'off';

  return (
    <div class="rk" role="group" aria-label="R keyboard" onPointerDown={keepFocus} onMouseDown={keepFocus}>
      <div class="rk-suggest">
        <Show when={chips().length} fallback={<span class="rk-suggest-empty">{target() === 'console' ? 'Console' : 'Editor'}</span>}>
          <For each={chips()}>
            {(c) => (
              <div role="button" class="rk-chip" classList={{ fn: c.fn }} onClick={() => choose(c)}>
                {c.label}
                {c.fn ? '()' : ''}
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="rk-tools">
        <Row keys={NAV} act={act} disabled={(k) => target() === 'console' && (k.act.t === 'undo' || k.act.t === 'redo')} />
        <Row keys={R_ROW} act={act} />
      </div>
      <div class="rk-keys">
        <For each={LAYERS[layer()]}>{(row) => <Row keys={row} act={act} upper={upper()} shift={shift()} />}</For>
        <Row keys={layer() === 'abc' ? BOTTOM.abc : BOTTOM.other} act={act} />
      </div>
    </div>
  );
}

function Row(p: { keys: KeyDef[]; act: (a: Act) => void; upper?: boolean; shift?: 'off' | 'once' | 'lock'; disabled?: (k: KeyDef) => boolean }) {
  return (
    <div class="rk-row">
      <For each={p.keys}>
        {(k) => (
          <Key
            k={k}
            act={p.act}
            label={p.upper && k.label && /^[a-z]$/.test(k.label) ? k.label.toUpperCase() : (k.label ?? '')}
            icon={k.act.t === 'shift' && p.shift && p.shift !== 'off' ? 'shift-on' : k.icon}
            active={k.act.t === 'shift' && p.shift === 'lock'}
            disabled={p.disabled?.(k)}
          />
        )}
      </For>
    </div>
  );
}

/**
 * One key. Plain keys act on touch-down; keys with a long-press alternate and
 * the space bar (a trackpad when dragged) act on release, or on a cancelled
 * touch (iOS cancels a touch when another finger lands, which would
 * otherwise drop the key). Arrows and delete repeat while held.
 */
function Key(p: { k: KeyDef; act: (a: Act) => void; label: string; icon?: string; active?: boolean; disabled?: boolean }) {
  const [pressed, setPressed] = createSignal(false);
  // The space bar doubles as a trackpad.
  const trackpad = p.k.act.t === 'type' && p.k.act.text === ' ';
  const onRelease = !!p.k.alt || trackpad;
  let timer: number | undefined;
  let done = false;
  let start: { x: number; y: number; dx: number; dy: number; at: number } | null = null;
  const stop = () => {
    clearTimeout(timer);
    clearInterval(timer);
    timer = undefined;
  };
  onCleanup(stop);
  const finish = (cancelled: boolean) => {
    stop();
    setPressed(false);
    // A cancelled short touch still counts; a long one (or a drag) doesn't.
    if (!done && !p.disabled && start && (!cancelled || performance.now() - start.at < 400)) p.act(p.k.act);
    done = true;
    start = null;
  };
  const w = p.k.w ?? 1;
  const total = w + (p.k.padL ?? 0) + (p.k.padR ?? 0);
  return (
    <div
      role="button"
      // A fixed class plus toggles (a reactive class string would overwrite the toggles).
      class="rk-key"
      classList={{
        mod: p.k.kind === 'mod',
        run: p.k.kind === 'run',
        pressed: pressed(),
        active: !!p.active,
        char: !p.icon && p.label.length === 1,
        space: trackpad,
        disabled: !!p.disabled,
      }}
      style={{
        flex: `${total} 1 0`,
        '--pad-l': `${((p.k.padL ?? 0) / total) * 100}%`,
        '--pad-r': `${((p.k.padR ?? 0) / total) * 100}%`,
      }}
      aria-disabled={p.disabled}
      aria-label={p.k.title ?? p.label}
      data-label={p.label}
      onPointerDown={(e) => {
        e.preventDefault();
        done = false;
        start = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, at: performance.now() };
        setPressed(true);
        if (p.disabled) return;
        if (p.k.repeat) {
          p.act(p.k.act);
          done = true;
          timer = window.setTimeout(() => (timer = window.setInterval(() => p.act(p.k.act), 60)), 380);
        } else if (p.k.alt) {
          timer = window.setTimeout(() => {
            done = true;
            setPressed(false);
            p.act(p.k.alt!);
          }, 420);
        } else if (!onRelease) {
          p.act(p.k.act);
          done = true;
        }
      }}
      onPointerMove={(e) => {
        // Space bar as a trackpad: drag to move the cursor.
        if (!trackpad || !start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!done && Math.abs(dx) < 10 && Math.abs(dy) < 14) return;
        if (!done) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        done = true;
        const stepsX = Math.trunc(dx / 9) - start.dx;
        const stepsY = Math.trunc(dy / 22) - start.dy;
        for (let i = 0; i < Math.abs(stepsX); i++) p.act({ t: 'move', dir: stepsX > 0 ? 'right' : 'left' });
        for (let i = 0; i < Math.abs(stepsY); i++) p.act({ t: 'move', dir: stepsY > 0 ? 'down' : 'up' });
        start.dx += stepsX;
        start.dy += stepsY;
      }}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
      onPointerLeave={() => {
        // Sliding off an arrow/delete stops its repeat.
        if (p.k.repeat) stop();
      }}
    >
      <span class="rk-face">{p.icon ? <Icon name={p.icon} size={20} /> : p.label}</span>
      <Show when={p.k.alt && !p.icon}>
        <span class="rk-alt">{p.k.alt!.text.trim()}</span>
      </Show>
    </div>
  );
}
