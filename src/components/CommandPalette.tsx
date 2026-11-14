// The command palette (⌘⇧P), shared by both editors: each passes in its
// commands (openPalette). Typing filters by words in any order; ↑/↓ and the
// mouse move one highlight; ↩ runs; Esc closes. Recently run commands come
// first. Styled like the app's other popups, without an opening animation.

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from './Icon';
import './CommandPalette.css';

export interface PaletteCommand {
  id: string;
  label: string;
  /** Shortcut as shown (e.g. ⌘⇧A). */
  shortcut?: string;
  run(): void;
}

const [current, setCurrent] = createSignal<{ commands: PaletteCommand[]; onClose?: () => void } | null>(null);

/** Open the palette with these commands; `onClose` runs when it closes (e.g. refocus the editor). */
export function openPalette(commands: PaletteCommand[], onClose?: () => void) {
  setCurrent({ commands, onClose });
}

const LS_RECENT = 'webr-ide:palette-recent';
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LS_RECENT) ?? '[]');
  } catch {
    return [];
  }
}
function noteRecent(id: string) {
  const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 8);
  try {
    localStorage.setItem(LS_RECENT, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

/** Every word of the query in the label; earlier and word-start matches rank higher. */
function rank(label: string, words: string[]): number | null {
  const l = label.toLowerCase();
  let score = 0;
  for (const w of words) {
    const i = l.indexOf(w);
    if (i < 0) return null;
    score += i === 0 ? 0 : /\W/.test(l[i - 1]) ? 1 : 3;
  }
  return score;
}

/** The label with the query's words in bold. */
function Highlighted(props: { label: string; words: string[] }) {
  const parts = () => {
    const l = props.label.toLowerCase();
    const marks = new Array(props.label.length).fill(false);
    for (const w of props.words) {
      const i = l.indexOf(w);
      if (i >= 0) for (let k = i; k < i + w.length; k++) marks[k] = true;
    }
    const out: { text: string; on: boolean }[] = [];
    for (let k = 0; k < props.label.length; k++) {
      const last = out[out.length - 1];
      if (last && last.on === marks[k]) last.text += props.label[k];
      else out.push({ text: props.label[k], on: marks[k] });
    }
    return out;
  };
  return <For each={parts()}>{(p) => (p.on ? <b>{p.text}</b> : p.text)}</For>;
}

/** Mounted once (App). */
export function CommandPalette() {
  return <Show when={current()}>{(c) => <Palette commands={c().commands} onClose={c().onClose} />}</Show>;
}

function Palette(props: { commands: PaletteCommand[]; onClose?: () => void }) {
  const [query, setQuery] = createSignal('');
  const [index, setIndex] = createSignal(0);
  const recent = loadRecent();
  const words = () => query().toLowerCase().split(/\s+/).filter(Boolean);
  const items = createMemo(() => {
    const ws = words();
    const all = [...props.commands].sort((a, b) => a.label.localeCompare(b.label));
    if (!ws.length) {
      const r = recent.map((id) => all.find((c) => c.id === id)).filter((c): c is PaletteCommand => !!c);
      return [...r, ...all.filter((c) => !recent.includes(c.id))];
    }
    return all
      .map((c) => ({ c, s: rank(c.label, ws) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => a.s! - b.s! || a.c.label.localeCompare(b.c.label))
      .map((x) => x.c);
  });
  const recentCount = () => (words().length ? 0 : recent.filter((id) => props.commands.some((c) => c.id === id)).length);

  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  queueMicrotask(() => input?.focus());

  // Keep the highlighted row in view as ↑/↓ move it.
  createEffect(() => {
    const i = index();
    list?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    const onClose = props.onClose; // (read before closing removes this component)
    setCurrent(null);
    onClose?.();
  }
  function run(c: PaletteCommand) {
    noteRecent(c.id);
    close();
    queueMicrotask(() => c.run());
  }

  function onKey(e: KeyboardEvent) {
    const n = items().length;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (n) setIndex((i) => Math.max(0, Math.min(n - 1, i + (e.key === 'PageDown' ? 8 : -8))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = items()[index()];
      if (c) run(c);
    }
  }
  // Escape from anywhere (e.g. after clicking the list).
  const onDocKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onDocKey);
  onCleanup(() => document.removeEventListener('keydown', onDocKey));

  return (
    <Portal>
      <div class="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        <div class="palette" role="dialog" aria-label="Command palette">
          <div class="palette-search">
            <Icon name="command" size={15} />
            <input
              ref={input}
              type="text"
              placeholder="Type a command"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setIndex(0);
              }}
              onKeyDown={onKey}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              enterkeyhint="go"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={`palette-item-${index()}`}
            />
          </div>
          <div class="palette-list" id="palette-list" role="listbox" ref={list}>
            <For each={items()}>
              {(c, i) => (
                <>
                  <Show when={i() === 0 && recentCount() > 0}>
                    <div class="palette-group">Recently used</div>
                  </Show>
                  <Show when={i() === recentCount() && recentCount() > 0}>
                    <div class="palette-group">All commands</div>
                  </Show>
                  <div
                    id={`palette-item-${i()}`}
                    data-i={i()}
                    role="option"
                    aria-selected={i() === index()}
                    class="palette-item"
                    classList={{ active: i() === index() }}
                    // mousemove, not mouseenter: rows scrolling under a still pointer don't steal the highlight
                    onMouseMove={() => i() !== index() && setIndex(i())}
                    onClick={() => run(c)}
                  >
                    <span class="palette-label">
                      <Highlighted label={c.label} words={words()} />
                    </span>
                    <Show when={c.shortcut}>
                      <kbd class="palette-key">{c.shortcut}</kbd>
                    </Show>
                  </div>
                </>
              )}
            </For>
            <Show when={!items().length}>
              <div class="palette-empty">No matching commands</div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
