import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { state, setState, editor, phone, showPane, PhoneTab } from '../lib/ide';
import { Icon } from './Icon';
import { KeyBar, keyBarTarget, keyboardUp } from './KeyBar';
import { EditorPane } from './Editor';
import { ConsolePane } from './Console';
import { EnvPane } from './EnvPane';
import { PlotsPane } from './PlotsPane';
import { Sidebar } from './Sidebar';

// ---------------------------------------------------------------- persisted split sizes

interface Layout {
  sidebar: number; // px
  left: number; // fraction of the quadrant area taken by the left column
  leftTop: number; // fraction of the left column taken by the script pane
  rightTop: number; // fraction of the right column taken by environment/history
}

const LS_LAYOUT = 'webr-ide:layout';
const DEFAULT_LAYOUT: Layout = { sidebar: 220, left: 0.56, leftTop: 0.56, rightTop: 0.42 };

function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LS_LAYOUT) ?? '{}') };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

const [layout, setLayoutSignal] = createSignal<Layout>(loadLayout());
function setLayout(patch: Partial<Layout>) {
  const next = { ...layout(), ...patch };
  setLayoutSignal(next);
  localStorage.setItem(LS_LAYOUT, JSON.stringify(next));
}
export function resetLayout() {
  setLayout({ ...DEFAULT_LAYOUT });
  setState('zoomed', null);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pointer-driven splitter; works with mouse, pen and touch. */
function Gutter(props: { hidden?: boolean; dir: 'col' | 'row'; onDrag: (clientX: number, clientY: number) => void; onReset?: () => void; label: string }) {
  const [active, setActive] = createSignal(false);
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
      onPointerMove={(e) => active() && props.onDrag(e.clientX, e.clientY)}
      onPointerUp={(e) => {
        setActive(false);
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing-col', 'resizing-row');
        editor()?.layout();
      }}
      onPointerCancel={() => {
        setActive(false);
        document.body.classList.remove('resizing-col', 'resizing-row');
      }}
    />
  );
}

export function Workbench() {
  let quad!: HTMLDivElement;
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
  createEffect(
    on([phone, () => state.phoneTab], ([isPhone, tab], prev) => {
      if (isPhone) setState('zoomed', tab === 'files' ? 'script' : tab);
      else if (prev?.[0]) setState('zoomed', null);
    }),
  );
  const sidebarShown = () => (phone() ? state.phoneTab === 'files' : state.sidebarOpen);

  const z = () => state.zoomed;
  const leftVisible = () => !z() || z() === 'script' || z() === 'console';
  const rightVisible = () => !z() || z() === 'env' || z() === 'plots';

  const colStyle = () => {
    if (z()) return { 'grid-template-columns': '1fr' };
    const l = layout().left;
    return { 'grid-template-columns': `minmax(0, ${l}fr) var(--gutter) minmax(0, ${1 - l}fr)` };
  };
  const rowStyle = (frac: number, top: 'script' | 'env', bottom: 'console' | 'plots') => {
    if (z() === top || z() === bottom) return { 'grid-template-rows': 'minmax(0, 1fr)' };
    return { 'grid-template-rows': `minmax(0, ${frac}fr) var(--gutter) minmax(0, ${1 - frac}fr)` };
  };

  return (
    <div class="workbench" classList={{ narrow: narrow(), phone: phone(), 'phone-files': phone() && state.phoneTab === 'files', 'sidebar-open': sidebarShown() }}>
      <div
        class="sidebar-wrap"
        classList={{ open: sidebarShown() }}
        style={{ width: narrow() ? undefined : `${layout().sidebar}px` }}
      >
        <Sidebar />
      </div>
      {state.sidebarOpen && !narrow() && (
        <Gutter
          dir="col"
          label="Resize sidebar"
          onDrag={(x) => setLayout({ sidebar: clamp(x - 4, 160, Math.min(480, window.innerWidth * 0.4)) })}
          onReset={() => setLayout({ sidebar: DEFAULT_LAYOUT.sidebar })}
        />
      )}
      {state.sidebarOpen && narrow() && !phone() && <div class="sidebar-scrim" onClick={() => setState('sidebarOpen', false)} />}

      <div class="quadrants" ref={quad} style={colStyle()}>
        <div class="column" ref={leftCol} style={rowStyle(layout().leftTop, 'script', 'console')} classList={{ hidden: !leftVisible() }}>
          <section class="quadrant" classList={{ hidden: z() === 'console' }} aria-label="Source">
            <EditorPane />
          </section>
          <Gutter
            dir="row"
            hidden={!!z()}
            label="Resize script and console"
            onDrag={(_, y) => {
              const r = leftCol.getBoundingClientRect();
              setLayout({ leftTop: clamp((y - r.top) / r.height, 0.12, 0.88) });
            }}
            onReset={() => setLayout({ leftTop: DEFAULT_LAYOUT.leftTop })}
          />
          <section class="quadrant" classList={{ hidden: z() === 'script' }} aria-label="Console">
            <ConsolePane />
          </section>
        </div>
        <Gutter
          dir="col"
          hidden={!!z()}
          label="Resize columns"
          onDrag={(x) => {
            const r = quad.getBoundingClientRect();
            setLayout({ left: clamp((x - r.left) / r.width, 0.2, 0.8) });
          }}
          onReset={() => setLayout({ left: DEFAULT_LAYOUT.left })}
        />
        <div class="column" ref={rightCol} style={rowStyle(layout().rightTop, 'env', 'plots')} classList={{ hidden: !rightVisible() }}>
          <section class="quadrant" classList={{ hidden: z() === 'plots' }} aria-label="Environment">
            <EnvPane />
          </section>
          <Gutter
            dir="row"
            hidden={!!z()}
            label="Resize environment and plots"
            onDrag={(_, y) => {
              const r = rightCol.getBoundingClientRect();
              setLayout({ rightTop: clamp((y - r.top) / r.height, 0.12, 0.88) });
            }}
            onReset={() => setLayout({ rightTop: DEFAULT_LAYOUT.rightTop })}
          />
          <section class="quadrant" classList={{ hidden: z() === 'env' }} aria-label="Plots">
            <PlotsPane />
          </section>
        </div>
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
      <Show when={!keyBarTarget()} fallback={<KeyBar />}>
        <Show when={!keyboardUp()}>
          <PaneTabs />
        </Show>
      </Show>
    </Show>
  );
}

function PaneTabs() {
  return (
    <>
      <nav class="phone-tabs" role="tablist" aria-label="Panes">
        <For each={PHONE_TABS}>
          {(t) => (
            <button
              role="tab"
              class="phone-tab"
              classList={{ active: state.phoneTab === t.id }}
              aria-selected={state.phoneTab === t.id}
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
