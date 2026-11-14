// Pane layout on tablets and desktops: split sizes, minimized panes, and panes
// opened in their own window. (Phones show one pane at a time instead.)
//
//   left column: script / console     right column: environment / plots
//
// A minimized pane shrinks to its header and the other pane in its column takes
// the height. With both panes of a column minimized, the column becomes a thin
// strip and the other column takes the width. There is always a pane on
// screen, and the script comes back first.
import { batch, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { delegateEvents, DelegatedEvents } from 'solid-js/web';
import { PaneId, setState, state, editor, onDesktopPane } from './ide-state';

export interface SplitSizes {
  sidebar: number; // px
  left: number; // fraction of the quadrant area taken by the left column
  leftTop: number; // fraction of the left column taken by the script pane
  rightTop: number; // fraction of the right column taken by environment/history
}

export const PANES: PaneId[] = ['script', 'console', 'env', 'plots'];
export const PANE_LABEL: Record<PaneId, string> = { script: 'Source', console: 'Console', env: 'Environment', plots: 'Plots' };
const COLUMN: Record<PaneId, 'left' | 'right'> = { script: 'left', console: 'left', env: 'right', plots: 'right' };
const SIBLING: Record<PaneId, PaneId> = { script: 'console', console: 'script', env: 'plots', plots: 'env' };
const COLUMN_PANES = { left: ['script', 'console'], right: ['env', 'plots'] } as const;

const LS_LAYOUT = 'webr-ide:layout';
export const DEFAULT_SIZES: SplitSizes = { sidebar: 220, left: 0.56, leftTop: 0.56, rightTop: 0.42 };

interface Saved extends SplitSizes {
  minimized?: PaneId[];
}

function load(): Saved {
  try {
    return { ...DEFAULT_SIZES, ...JSON.parse(localStorage.getItem(LS_LAYOUT) ?? '{}') };
  } catch {
    return { ...DEFAULT_SIZES };
  }
}

const saved = load();
const [sizes, setSizesSignal] = createSignal<SplitSizes>({ sidebar: saved.sidebar, left: saved.left, leftTop: saved.leftTop, rightTop: saved.rightTop });
const [panes, setPanes] = createStore({
  minimized: Object.fromEntries(PANES.map((p) => [p, !!saved.minimized?.includes(p)])) as Record<PaneId, boolean>,
  /** Open in a window of its own. */
  popped: Object.fromEntries(PANES.map((p) => [p, false])) as Record<PaneId, boolean>,
  /** New output in a pane that isn't on screen. */
  badge: Object.fromEntries(PANES.map((p) => [p, false])) as Record<PaneId, boolean>,
});
export { sizes, panes };

function persist() {
  try {
    const minimized = PANES.filter((p) => panes.minimized[p]);
    localStorage.setItem(LS_LAYOUT, JSON.stringify({ ...sizes(), minimized }));
  } catch {
    /* private mode */
  }
}

/** `save: false` while a splitter is dragged; saveSizes() when it's let go. */
export function setSizes(patch: Partial<SplitSizes>, opts: { save?: boolean } = {}) {
  setSizesSignal({ ...sizes(), ...patch });
  if (opts.save !== false) persist();
}

export const saveSizes = persist;

/** Not in the main window's grid (minimized, or in its own window). */
const away = (p: PaneId) => panes.minimized[p] || panes.popped[p];
export const isMinimized = (p: PaneId) => panes.minimized[p];
export const isPopped = (p: PaneId) => panes.popped[p];
/** Both panes of the column are minimized or popped out: the column is a strip. */
export const columnCollapsed = (col: 'left' | 'right') => COLUMN_PANES[col].every(away);

function relayout() {
  queueMicrotask(() => editor()?.layout());
  persist();
}

/** Make sure something is on screen: the script first. */
function ensureVisible() {
  if (PANES.every(away)) {
    const p = panes.popped.script ? PANES.find((x) => !panes.popped[x]) : 'script';
    if (p) setPanes('minimized', p, false);
  }
}

export function minimizePane(p: PaneId) {
  batch(() => {
    if (state.zoomed) setState('zoomed', null);
    setPanes('minimized', p, true);
    ensureVisible();
  });
  relayout();
}

export function restorePane(p: PaneId) {
  batch(() => {
    if (state.zoomed && state.zoomed !== p) setState('zoomed', null);
    setPanes('minimized', p, false);
    setPanes('badge', p, false);
  });
  relayout();
}

/** Fill the column's height: the pane above or below is minimized. */
export function expandVertically(p: PaneId) {
  batch(() => {
    setState('zoomed', null);
    setPanes('minimized', p, false);
    if (!panes.popped[SIBLING[p]]) setPanes('minimized', SIBLING[p], true);
  });
  relayout();
}

/** Fill the width: the other column shrinks to a strip. */
export function expandHorizontally(p: PaneId) {
  const other = COLUMN[p] === 'left' ? 'right' : 'left';
  batch(() => {
    setState('zoomed', null);
    setPanes('minimized', p, false);
    for (const q of COLUMN_PANES[other]) if (!panes.popped[q]) setPanes('minimized', q, true);
  });
  relayout();
}

export function toggleMaximize(p: PaneId) {
  batch(() => {
    if (state.zoomed === p) setState('zoomed', null);
    else {
      setPanes('minimized', p, false);
      setState('zoomed', p);
    }
  });
  relayout();
}

/** Every pane back in the grid (sizes kept). */
export function restoreAll() {
  batch(() => {
    setState('zoomed', null);
    for (const p of PANES) setPanes('minimized', p, false);
  });
  relayout();
}

export function resetLayout() {
  setSizesSignal({ ...DEFAULT_SIZES });
  restoreAll();
}

export function setPopped(p: PaneId, on: boolean) {
  batch(() => {
    if (on && state.zoomed === p) setState('zoomed', null);
    setPanes('popped', p, on);
    if (!on) setPanes('minimized', p, false);
    ensureVisible();
  });
  relayout();
}

/** The pane is on screen in the main window (or its own window). */
export function paneShowing(p: PaneId): boolean {
  if (panes.popped[p]) return true;
  if (state.zoomed) return state.zoomed === p;
  return !panes.minimized[p];
}

// Desktop hooks from ide-state.ts: bring a pane back for code that was run (the
// console) or help that was asked for; mark new output in a hidden pane.
onDesktopPane({
  reveal(p) {
    if (p === 'script' || p === 'console' || p === 'plots') {
      if (state.zoomed && state.zoomed !== p && !panes.popped[p]) setState('zoomed', null);
      if (panes.minimized[p]) restorePane(p);
    }
  },
  output(p) {
    if (!paneShowing(p)) setPanes('badge', p, true);
  },
});

// A saved layout with every pane minimized: show the script.
ensureVisible();

// ---------------------------------------------------------------- panes in their own window

/**
 * Environment, Plots and the Console can open in a window of their own (on a
 * computer; phones and tablets open tabs, not windows). The Workbench moves
 * the live pane into it, and back when the window closes.
 */
const [popWindows, setPopWindows] = createSignal<Partial<Record<PaneId, Window>>>({});
export { popWindows };

export function canPopOut(p: PaneId): boolean {
  return p !== 'script' && navigator.maxTouchPoints === 0;
}

function mirrorDocument(w: Window, title: string) {
  const doc = w.document;
  doc.title = `${title} — webR IDE`;
  const copyAttrs = () => {
    for (const a of [...document.documentElement.attributes]) doc.documentElement.setAttribute(a.name, a.value);
  };
  copyAttrs();
  const copyNode = (n: Node) => {
    if (n instanceof HTMLLinkElement && n.rel === 'stylesheet') {
      const l = doc.createElement('link');
      l.rel = 'stylesheet';
      l.href = n.href; // absolute: the new window's address is about:blank
      doc.head.append(l);
    } else if (n instanceof HTMLStyleElement) {
      doc.head.append(doc.importNode(n, true));
    }
  };
  document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(copyNode);
  // Theme changes, and styles added later (Monaco's token colours, Vite in development).
  const attrs = new MutationObserver(copyAttrs);
  attrs.observe(document.documentElement, { attributes: true });
  const head = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(copyNode)));
  head.observe(document.head, { childList: true });
  w.addEventListener('pagehide', () => {
    attrs.disconnect();
    head.disconnect();
  });
  // Solid listens for clicks etc. on the document: the new window's too.
  delegateEvents([...DelegatedEvents], doc);
  doc.body.className = 'popout-body';
  const root = doc.createElement('div');
  root.className = 'popout-root';
  doc.body.append(root);
}

const POPOUT_PAGE = `${import.meta.env.BASE_URL}popout.html`;

/** Resolves once the window has loaded popout.html (not the initial about:blank). */
function whenLoaded(w: Window): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (w.closed) return resolve(false);
      try {
        if (w.location.pathname.endsWith('/popout.html') && w.document.readyState === 'complete') return resolve(true);
      } catch {
        /* still navigating */
      }
      if (Date.now() - started > 15_000) return resolve(false);
      setTimeout(check, 30);
    };
    check();
  });
}

/** Open a pane in its own window (call from a click: browsers block other pop-ups). */
export function popOut(p: PaneId): boolean {
  const w = window.open(`${POPOUT_PAGE}?pane=${p}`, `webr-ide-${p}`, 'popup=yes,width=760,height=600');
  if (!w) return false;
  void whenLoaded(w).then((ok) => {
    if (!ok) {
      w.close();
      return;
    }
    if (!w.document.querySelector('.popout-root')) mirrorDocument(w, PANE_LABEL[p]);
    // Closed or reloaded: the pane comes back to the main window.
    w.addEventListener('pagehide', () => {
      if (popWindows()[p] === w) closePopped(p);
    });
    setPopWindows({ ...popWindows(), [p]: w });
    setPopped(p, true);
    w.focus();
  });
  return true;
}

function closePopped(p: PaneId) {
  const next = { ...popWindows() };
  delete next[p];
  setPopWindows(next);
  setPopped(p, false);
}

/** Put a popped-out pane back in the main window. */
export function bringBack(p: PaneId) {
  const w = popWindows()[p];
  closePopped(p);
  w?.close();
}

export function focusPopped(p: PaneId) {
  popWindows()[p]?.focus();
}

window.addEventListener('pagehide', () => Object.values(popWindows()).forEach((w) => w?.close()));
