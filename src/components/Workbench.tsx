import { createEffect, createSignal, For, JSX, on, onCleanup, Show } from 'solid-js';
import { state, setState, editor, phone, showPane, stacked, PhoneTab } from '../lib/ide';
import { Icon } from './Icon';
import { KeyBar, DebugKeys, keyBarTarget, keyboardUp } from './KeyBar';
import { RKeyboard } from './RKeyboard';
import { rKeyboardActive } from '../lib/rkeyboard';
import { EditorPane } from './Editor';
import { CmEditorPane } from './cm/CmEditorPane';
import { settings } from '../lib/settings';
import { ConsolePane } from './Console';
import { EnvPane } from './EnvPane';
import { PlotsPane } from './PlotsPane';
import { Sidebar } from './Sidebar';
import {
  sizes,
  setSizes,
  saveSizes,
  DEFAULT_SIZES,
  panes,
  columnCollapsed,
  restorePane,
  focusPopped,
  popWindows,
  PANE_LABEL,
} from '../lib/layout';
import type { PaneId } from '../lib/ide';

// The editor is chosen once, at start-up (Settings → Editor reloads the page).
const ENGINE = settings.editorEngine;
const PANE_VIEW: Record<PaneId, () => JSX.Element> = {
  script: () => (ENGINE === 'codemirror' ? <CmEditorPane /> : <EditorPane />),
  console: () => <ConsolePane />,
  env: () => <EnvPane />,
  plots: () => <PlotsPane />,
};

/** A column whose panes are all minimized or in their own window: a thin strip. */
function ColumnStrip(props: { panes: PaneId[]; side: 'left' | 'right' }) {
  return (
    <div class="column-strip" classList={{ [props.side]: true }} role="toolbar" aria-label="Minimized panes">
      <For each={props.panes}>
        {(p) => (
          <button
            class="strip-btn"
            classList={{ popped: panes.popped[p] }}
            title={panes.popped[p] ? `${PANE_LABEL[p]} is in its own window` : `Restore ${PANE_LABEL[p]}`}
            onClick={() => (panes.popped[p] ? focusPopped(p) : restorePane(p))}
          >
            <span class="strip-label">{PANE_LABEL[p]}</span>
            <Show when={panes.badge[p]}>
              <span class="pane-badge" aria-label="new output" />
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}



/** While dragging a splitter (saved when it's let go). */
const resize = (patch: Parameters<typeof setSizes>[0]) => setSizes(patch, { save: false });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pointer-driven splitter; works with mouse, pen and touch. */
function Gutter(props: { hidden?: boolean; dir: 'col' | 'row'; onDrag: (clientX: number, clientY: number) => void; onReset?: () => void; label: string }) {
  const [active, setActive] = createSignal(false);
  // At most one resize per frame (pointer events can come faster).
  let frame = 0;
  let last: [number, number] = [0, 0];
  const drag = (x: number, y: number) => {
    last = [x, y];
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      props.onDrag(...last);
    });
  };
  const end = () => {
    setActive(false);
    cancelAnimationFrame(frame);
    frame = 0;
    document.body.classList.remove('resizing-col', 'resizing-row');
    saveSizes();
  };
  return (
    <div
      class={`gutter gutter-${props.dir}`}
      classList={{ active: active(), hidden: !!props.hidden }}
      role="separator"
      aria-orientation={props.dir === 'col' ? 'vertical' : 'horizontal'}
      aria-label={props.label}
      onDblClick={() => props.onReset?.()}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setActive(true);
        document.body.classList.add(props.dir === 'col' ? 'resizing-col' : 'resizing-row');
      }}
      onPointerMove={(e) => active() && drag(e.clientX, e.clientY)}
      onPointerUp={(e) => {
        if (active()) props.onDrag(e.clientX, e.clientY);
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        end();
        editor()?.layout();
      }}
      onPointerCancel={end}
    />
  );
}

export function Workbench() {
  let quadEl!: HTMLDivElement;
  let leftCol!: HTMLDivElement;
  let rightCol!: HTMLDivElement;
  const [narrow, setNarrow] = createSignal(window.innerWidth <= 1000);

  const onResize = () => {
    const n = window.innerWidth <= 1000;
    if (n !== narrow()) setState('sidebarOpen', !n); // rotate: drawer closes in portrait, docks in landscape
    setNarrow(n);
  };
  window.addEventListener('resize', onResize);
  onCleanup(() => window.removeEventListener('resize', onResize));

  // On narrow (portrait) screens the sidebar starts closed and overlays the panes.
  if (narrow()) setState('sidebarOpen', false);

  // Phones show one pane at a time (the bottom tabs pick which), using the
  // same mechanism as zooming a pane; the Files tab shows the sidebar instead.
  // Stacked (iPad split view): the Code tab shows the script and console together.
  const codeTab = () => stacked() && (state.phoneTab === 'script' || state.phoneTab === 'console');
  createEffect(
    on([phone, () => state.phoneTab, stacked], ([isPhone, tab], prev) => {
      if (isPhone) setState('zoomed', tab === 'files' ? 'script' : codeTab() ? null : tab);
      else if (prev?.[0]) setState('zoomed', null);
    }),
  );
  const sidebarShown = () => (phone() ? state.phoneTab === 'files' : state.sidebarOpen);

  const z = () => state.zoomed;
  // Minimizing is for larger screens; phones show one pane at a time.
  const leftCollapsed = () => !phone() && columnCollapsed('left');
  const rightCollapsed = () => !phone() && columnCollapsed('right');
  const leftVisible = () => !z() || z() === 'script' || z() === 'console';
  const rightVisible = () => (!z() && !codeTab()) || z() === 'env' || z() === 'plots';
  /** In the grid: not popped out, and (unless maximized) not hidden by a zoom. */
  const inGrid = (p: PaneId) => !panes.popped[p] && (!z() || z() === p);
  const minimized = (p: PaneId) => !phone() && !z() && panes.minimized[p];

  const colStyle = () => {
    if (z() || codeTab()) return { 'grid-template-columns': '1fr' };
    if (leftCollapsed() && rightCollapsed()) return { 'grid-template-columns': 'var(--strip-w) var(--strip-w)' };
    if (leftCollapsed()) return { 'grid-template-columns': 'var(--strip-w) minmax(0, 1fr)' };
    if (rightCollapsed()) return { 'grid-template-columns': 'minmax(0, 1fr) var(--strip-w)' };
    const l = sizes().left;
    return { 'grid-template-columns': `minmax(0, ${l}fr) var(--gutter) minmax(0, ${1 - l}fr)` };
  };
  const rowStyle = (frac: number, top: PaneId, bottom: PaneId) => {
    const t = inGrid(top);
    const b = inGrid(bottom);
    if (!t || !b) return { 'grid-template-rows': 'minmax(0, 1fr)' };
    if (minimized(top) && minimized(bottom)) return { 'grid-template-rows': 'auto auto' };
    if (minimized(top)) return { 'grid-template-rows': 'auto minmax(0, 1fr)' };
    if (minimized(bottom)) return { 'grid-template-rows': 'minmax(0, 1fr) auto' };
    return { 'grid-template-rows': `minmax(0, ${frac}fr) var(--gutter) minmax(0, ${1 - frac}fr)` };
  };
  const rowGutterHidden = (top: PaneId, bottom: PaneId) => !inGrid(top) || !inGrid(bottom) || minimized(top) || minimized(bottom);
  // A pane in its own window is the same live pane, moved there (so the
  // console keeps its scrollback, the plots their history, and so on).
  const quad = (p: PaneId) => {
    let section!: HTMLElement;
    let host!: HTMLDivElement;
    createEffect(() => {
      const w = popWindows()[p];
      const target = (w && !w.closed && w.document.querySelector('.popout-root')) || section;
      if (host.parentNode !== target) {
        target.append(host);
        queueMicrotask(() => editor()?.layout());
      }
    });
    return (
      <section ref={section} class="quadrant" classList={{ hidden: !inGrid(p), minimized: minimized(p) }} aria-label={p === 'script' ? 'Source' : PANE_LABEL[p]}>
        <div ref={host} class="pane-host">
          {PANE_VIEW[p]()}
        </div>
      </section>
    );
  };

  return (
    <div class="workbench" classList={{ narrow: narrow(), phone: phone(), stacked: stacked(), 'phone-files': phone() && state.phoneTab === 'files', 'sidebar-open': sidebarShown() }}>
      <div
        class="sidebar-wrap"
        classList={{ open: sidebarShown() }}
        style={{ width: narrow() ? undefined : `${sizes().sidebar}px` }}
      >
        <Sidebar />
      </div>
      {state.sidebarOpen && !narrow() && (
        <Gutter
          dir="col"
          label="Resize sidebar"
          onDrag={(x) => resize({ sidebar: clamp(x - 4, 160, Math.min(480, window.innerWidth * 0.4)) })}
          onReset={() => setSizes({ sidebar: DEFAULT_SIZES.sidebar })}
        />
      )}
      {state.sidebarOpen && narrow() && !phone() && <div class="sidebar-scrim" onClick={() => setState('sidebarOpen', false)} />}

      <div class="quadrants" ref={quadEl} style={colStyle()}>
        <Show when={!z() && !codeTab() && leftCollapsed()}>
          <ColumnStrip panes={['script', 'console']} side="left" />
        </Show>
        <div class="column" ref={leftCol} style={rowStyle(sizes().leftTop, 'script', 'console')} classList={{ hidden: !leftVisible() || (!z() && leftCollapsed()) }}>
          {quad('script')}
          <Gutter
            dir="row"
            hidden={rowGutterHidden('script', 'console')}
            label="Resize script and console"
            onDrag={(_, y) => {
              const r = leftCol.getBoundingClientRect();
              resize({ leftTop: clamp((y - r.top) / r.height, 0.12, 0.88) });
            }}
            onReset={() => setSizes({ leftTop: DEFAULT_SIZES.leftTop })}
          />
          {quad('console')}
        </div>
        <Gutter
          dir="col"
          hidden={!!z() || codeTab() || leftCollapsed() || rightCollapsed()}
          label="Resize columns"
          onDrag={(x) => {
            const r = quadEl.getBoundingClientRect();
            resize({ left: clamp((x - r.left) / r.width, 0.2, 0.8) });
          }}
          onReset={() => setSizes({ left: DEFAULT_SIZES.left })}
        />
        <div class="column" ref={rightCol} style={rowStyle(sizes().rightTop, 'env', 'plots')} classList={{ hidden: !rightVisible() || (!z() && rightCollapsed()) }}>
          {quad('env')}
          <Gutter
            dir="row"
            hidden={rowGutterHidden('env', 'plots')}
            label="Resize environment and plots"
            onDrag={(_, y) => {
              const r = rightCol.getBoundingClientRect();
              resize({ rightTop: clamp((y - r.top) / r.height, 0.12, 0.88) });
            }}
            onReset={() => setSizes({ rightTop: DEFAULT_SIZES.rightTop })}
          />
          {quad('plots')}
        </div>
        <Show when={!z() && !codeTab() && rightCollapsed()}>
          <ColumnStrip panes={['env', 'plots']} side="right" />
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- phone tab bar

const PHONE_TABS: { id: PhoneTab; label: string; icon: string }[] = [
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'script', label: 'Script', icon: 'file' },
  { id: 'console', label: 'Console', icon: 'to-console' },
  { id: 'env', label: 'Environment', icon: 'table' },
  { id: 'plots', label: 'Plots', icon: 'image' },
];

/**
 * Bottom of the screen on phones: pane tabs, or programming keys while the
 * editor or console has the keyboard (nothing while another field has it).
 */
export function PhoneTabs() {
  return (
    <Show when={phone()}>
      <Show when={state.debug}>
        <DebugKeys />
      </Show>
      <Show when={!keyBarTarget()} fallback={<Show when={rKeyboardActive()} fallback={<KeyBar />}><RKeyboard /></Show>}>
        <Show when={!keyboardUp()}>
          <PaneTabs />
        </Show>
      </Show>
    </Show>
  );
}

function PaneTabs() {
  // Stacked: one "Code" tab for the script and console.
  const tabs = () =>
    stacked() ? PHONE_TABS.filter((t) => t.id !== 'console').map((t) => (t.id === 'script' ? { ...t, label: 'Code' } : t)) : PHONE_TABS;
  const isActive = (id: PhoneTab) => state.phoneTab === id || (stacked() && id === 'script' && state.phoneTab === 'console');
  return (
    <>
      <nav class="phone-tabs" role="tablist" aria-label="Panes">
        <For each={tabs()}>
          {(t) => (
            <button
              role="tab"
              class="phone-tab"
              classList={{ active: isActive(t.id) }}
              aria-selected={isActive(t.id)}
              onClick={() => showPane(t.id)}
            >
              <span class="phone-tab-icon">
                <Icon name={t.icon} size={22} />
                <Show when={(t.id === 'console' || t.id === 'plots') && state.phoneBadges[t.id]}>
                  <span class="phone-badge" aria-label="new output" />
                </Show>
              </span>
              <span class="phone-tab-label">{t.label}</span>
            </button>
          )}
        </For>
      </nav>
    </>
  );
}
