// Presenter view: the current slide, the next one, speaker notes, a timer
// and big previous/next buttons (for touch), with an audience window for the
// projector kept on the same slide.

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { preview } from '../lib/render';
import { attachDeck, audienceOpen, closeAudienceWindow, command, deckState, openAudienceWindow, relayBoard, updateAudienceWindow } from '../lib/presenter';
import { toast } from '../lib/ui';
import { Icon } from './Icon';
import './Presenter.css';

const [open, setOpen] = createSignal(false);
export const presenterOpen = open;
export function openPresenter() {
  setOpen(true);
}

const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
const LS_NOTES = 'webr-ide:presenter-notes-size';
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export function audienceWindow() {
  if (!preview.html || !preview.deck) return;
  if (!openAudienceWindow(preview.html, preview.deck.title)) toast('The browser blocked the new window. Allow pop-ups for this site and try again.', 'warn', 6000);
}

export function PresenterView() {
  // Keep the audience window showing the latest render.
  createEffect(() => {
    if (preview.format === 'revealjs' && preview.html) updateAudienceWindow(preview.html);
  });
  return (
    <Show when={open() && preview.deck}>
      <Portal>
        <Presenter />
      </Portal>
    </Show>
  );
}

function Presenter() {
  let current!: HTMLIFrameElement;
  let next!: HTMLIFrameElement;
  let box!: HTMLDivElement;
  const [started, setStarted] = createSignal(Date.now());
  const [paused, setPaused] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [notesSize, setNotesSize] = createSignal(Number((() => { try { return localStorage.getItem(LS_NOTES); } catch { return null; } })()) || 22);
  const [pen, setPen] = createSignal(false);
  const tick = setInterval(() => setNow(Date.now()), 500);
  onCleanup(() => clearInterval(tick));

  const elapsed = () => (paused() ?? now()) - started();
  const key = () => `${deckState().indexh}.${deckState().indexv ?? 0}`;
  const notes = () => preview.deck?.notes[key()] ?? '';
  const index = () => {
    const keys = Object.keys(preview.deck?.titles ?? {});
    return keys.indexOf(key()) + 1;
  };

  onMount(() => {
    const off = [attachDeck(current.contentWindow, 'lead'), attachDeck(next.contentWindow, 'next')];
    onCleanup(() => off.forEach((f) => f()));
    box.focus();
  });

  function close() {
    setOpen(false);
  }
  function togglePause() {
    const p = paused();
    if (p === null) setPaused(Date.now());
    else {
      setStarted((s) => s + (Date.now() - p));
      setPaused(null);
    }
  }
  function togglePen() {
    const on = !pen();
    setPen(on);
    const msg = JSON.stringify({ namespace: 'ide-board', op: 'mode', mode: on ? 'slide' : null });
    current.contentWindow?.postMessage(msg, '*');
    relayBoard(msg, current.contentWindow);
  }
  function notesBigger(d: number) {
    const v = Math.max(12, Math.min(48, notesSize() + d));
    setNotesSize(v);
    try {
      localStorage.setItem(LS_NOTES, String(v));
    } catch {
      /* ignore */
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLIFrameElement) return;
    // Like reveal.js: arrows move through the grid in vertical mode, else step.
    const grid = preview.deck?.vertical;
    const dir: Record<string, string> = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
    if (grid && dir[e.key]) command(dir[e.key]);
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) command('next');
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) command('prev');
    else if (e.key === 'Home') command('slide', 0, 0);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  };

  return (
    <div class="presenter" ref={box} tabindex="-1" onKeyDown={onKey} role="dialog" aria-label="Presenter view">
      <header class="presenter-bar">
        <span class="presenter-title">{preview.deck!.title}</span>
        <span class="presenter-count">
          Slide {index() || '–'} of {preview.deck!.total}
        </span>
        <span class="presenter-timer" classList={{ paused: paused() !== null }}>
          {clock(elapsed())}
        </span>
        <button class="tb-btn" title={paused() === null ? 'Pause timer' : 'Resume timer'} onClick={togglePause}>
          <Icon name={paused() === null ? 'stop' : 'play'} />
        </button>
        <button class="tb-btn" title="Reset timer" onClick={() => (setStarted(Date.now()), setPaused(null))}>
          <Icon name="refresh" />
        </button>
        <span class="presenter-clock">{new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="tb-spacer" />
        <button class="tb-btn labeled" classList={{ active: pen() }} title="Draw on the slide (also shown to the audience)" onClick={togglePen}>
          <Icon name="edit" />
          <span>Pen</span>
        </button>
        <button
          class="tb-btn labeled"
          classList={{ active: audienceOpen() }}
          title={audienceOpen() ? 'Close the audience window' : 'Open the slides in a separate window for the projector'}
          onClick={() => (audienceOpen() ? closeAudienceWindow() : audienceWindow())}
        >
          <Icon name="expand" />
          <span>{audienceOpen() ? 'Close audience window' : 'Audience window'}</span>
        </button>
        <button class="tb-btn labeled" title="Leave the presenter view (Esc)" onClick={close}>
          <Icon name="close" />
          <span>End</span>
        </button>
      </header>
      <div class="presenter-main">
        <div class="presenter-current">
          <iframe ref={current} sandbox={SANDBOX} srcdoc={preview.html} title="Current slide" />
        </div>
        <div class="presenter-side">
          <div class="presenter-label">Next</div>
          <div class="presenter-next">
            <iframe ref={next} sandbox={SANDBOX} srcdoc={preview.html} title="Next slide" tabindex="-1" />
            <Show when={index() >= preview.deck!.total}>
              <div class="presenter-end">End of presentation</div>
            </Show>
          </div>
          <div class="presenter-label">
            Notes
            <span class="presenter-notes-size">
              <button class="tb-btn tiny" aria-label="Smaller notes" onClick={() => notesBigger(-2)}>
                A−
              </button>
              <button class="tb-btn tiny" aria-label="Larger notes" onClick={() => notesBigger(2)}>
                A+
              </button>
            </span>
          </div>
          <div class="presenter-notes" style={{ 'font-size': `${notesSize()}px` }}>
            <Show when={notes()} fallback={<p class="presenter-empty">No notes for this slide.</p>}>
              <div innerHTML={notes()} />
            </Show>
          </div>
        </div>
      </div>
      <footer class="presenter-nav">
        <button class="presenter-step" onClick={() => command('prev')} aria-label="Previous">
          <Icon name="left" size={28} />
        </button>
        <button class="presenter-step" onClick={() => command('next')} aria-label="Next">
          <Icon name="right" size={28} />
        </button>
      </footer>
    </div>
  );
}
