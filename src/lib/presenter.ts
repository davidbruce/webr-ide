// Presenting slides across windows: an audience window (a separate browser
// window, e.g. on a projector) and the presenter view in the IDE, kept on the
// same slide. Every deck runs in a sandboxed frame and is driven through
// reveal.js's postMessage API; each deck reports its position, and the
// others follow. Pen drawings ("ide-board" messages) are relayed the same way.

import { createSignal } from 'solid-js';

export interface DeckState {
  indexh: number;
  indexv: number;
  indexf?: number;
}

/** Position shared by all decks. */
const [deckState, setDeckState] = createSignal<DeckState>({ indexh: 0, indexv: 0 });
export { deckState };
export const [audienceOpen, setAudienceOpen] = createSignal(false);

/** lead: presenter view's slide · view: the Preview tab · next: upcoming-slide preview · audience: audience window. */
type Role = 'lead' | 'view' | 'next' | 'audience';
const decks = new Map<Window, Role>();

const send = (w: Window | null | undefined, msg: object) => {
  try {
    w?.postMessage(JSON.stringify(msg), '*');
  } catch {
    /* window gone */
  }
};
const call = (w: Window | null | undefined, method: string, ...args: unknown[]) => send(w, { method, args });
const same = (a: DeckState, b: DeckState) => a.indexh === b.indexh && (a.indexv ?? 0) === (b.indexv ?? 0) && (a.indexf ?? -1) === (b.indexf ?? -1);

/** Register a deck frame; returns an unregister function. */
export function attachDeck(win: Window | null | undefined, role: Role): () => void {
  if (!win) return () => {};
  decks.set(win, role);
  return () => {
    if (decks.get(win) === role) decks.delete(win);
  };
}

/** Send a reveal.js command to the deck(s) the presenter drives. */
export function command(method: string, ...args: unknown[]) {
  const roles = [...decks.values()];
  const target: Role = roles.includes('lead') ? 'lead' : roles.includes('view') ? 'view' : 'audience';
  for (const [w, role] of decks) if (role === target) call(w, method, ...args);
}

export function resetDeckState() {
  setDeckState({ indexh: 0, indexv: 0 });
}

function followers(except: Window) {
  return [...decks].filter(([w, role]) => w !== except && role !== 'next').map(([w]) => w);
}

function showNext(state: DeckState) {
  for (const [w, role] of decks) {
    if (role !== 'next') continue;
    call(w, 'setState', { indexh: state.indexh, indexv: state.indexv, indexf: state.indexf ?? -1 });
    call(w, 'next');
  }
}

/** Share pen strokes / modes with every other deck. */
export function relayBoard(raw: string, from: Window | null) {
  for (const [w, role] of decks) if (w !== from && role !== 'next') w.postMessage(raw, '*');
}

function onMessage(e: MessageEvent) {
  const src = e.source as Window | null;
  const role = src ? decks.get(src) : undefined;
  if (!role || !src || typeof e.data !== 'string' || e.data[0] !== '{') return;
  let m: { namespace?: string; eventName?: string; state?: DeckState };
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  if (m.namespace === 'ide-board') {
    if (role !== 'next') relayBoard(e.data, src);
    return;
  }
  if (m.namespace !== 'reveal' || !m.state) return;
  if (m.eventName === 'ready') {
    if (role === 'next') {
      call(src, 'configure', { controls: false, progress: false, slideNumber: false, transition: 'none', keyboard: false, touch: false });
      showNext(deckState());
    } else call(src, 'setState', { ...deckState(), indexf: deckState().indexf ?? -1 });
    return;
  }
  if (role === 'next' || !/^(slidechanged|fragmentshown|fragmenthidden|overviewhidden)$/.test(m.eventName ?? '')) return;
  const st: DeckState = { indexh: m.state.indexh, indexv: m.state.indexv ?? 0, indexf: m.state.indexf };
  if (same(st, deckState())) return;
  setDeckState(st);
  for (const w of followers(src)) call(w, 'setState', { ...st, indexf: st.indexf ?? -1 });
  showNext(st);
}
window.addEventListener('message', onMessage);

// ---------------------------------------------------------------- audience window

let audience: { win: Window; frame: HTMLIFrameElement; detach: () => void } | null = null;
let closedPoll: number | undefined;

/**
 * Open (or refresh) a separate window showing the slides, to put on a
 * projector or external display. Must be called from a user action.
 */
export function openAudienceWindow(html: string, title: string): boolean {
  if (audience && !audience.win.closed) {
    if (audience.frame.srcdoc !== html) audience.frame.srcdoc = html;
    audience.win.focus();
    return true;
  }
  const win = window.open('', 'webr-ide-audience', 'popup=yes,width=1280,height=760');
  if (!win) return false;
  const d = win.document;
  d.open();
  d.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
  d.close();
  d.title = `${title} — audience`;
  const style = d.createElement('style');
  style.textContent = `html,body{margin:0;height:100%;background:#000;overflow:hidden}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0}
button{position:fixed;top:12px;right:12px;z-index:2;padding:8px 14px;border:0;border-radius:8px;background:rgba(30,34,40,.85);color:#fff;font:14px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;opacity:0;transition:opacity .2s}
body.show button{opacity:1}`;
  d.head.appendChild(style);
  const frame = d.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('allow', 'fullscreen');
  frame.title = title;
  frame.srcdoc = html;
  d.body.appendChild(frame);
  const full = d.createElement('button');
  full.textContent = 'Full screen';
  full.addEventListener('click', () => {
    const el = d.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    (el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el))?.();
    frame.focus();
  });
  d.body.appendChild(full);
  let hide: number | undefined;
  d.addEventListener('mousemove', () => {
    d.body.classList.add('show');
    win.clearTimeout(hide);
    hide = win.setTimeout(() => d.body.classList.remove('show'), 2000);
  });
  // The deck in this window reports to the window, not to us.
  win.addEventListener('message', onMessage);
  const detach = attachDeck(frame.contentWindow, 'audience');
  audience = { win, frame, detach };
  setAudienceOpen(true);
  clearInterval(closedPoll);
  closedPoll = window.setInterval(() => {
    if (audience?.win.closed) closeAudienceWindow();
  }, 1000);
  return true;
}

/** Re-render: show the new slides in the audience window too. */
export function updateAudienceWindow(html: string) {
  if (audience && !audience.win.closed && audience.frame.srcdoc !== html) audience.frame.srcdoc = html;
}

export function closeAudienceWindow() {
  clearInterval(closedPoll);
  if (!audience) return;
  audience.detach();
  if (!audience.win.closed) audience.win.close();
  audience = null;
  setAudienceOpen(false);
}
