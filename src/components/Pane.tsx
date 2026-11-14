import { createSignal, For, JSX, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from './Icon';
import { PaneId, phone, state } from '../lib/ide';
import {
  isMinimized,
  isPopped,
  minimizePane,
  restorePane,
  expandVertically,
  expandHorizontally,
  toggleMaximize,
  resetLayout,
  restoreAll,
  canPopOut,
  popOut,
  bringBack,
  panes,
} from '../lib/layout';

export interface TabDef {
  id: string;
  label: string;
  icon?: string;
}

/** RStudio-style pane header: tabs on the left, actions and layout controls on the right. */
export function PaneHeader(props: {
  pane: PaneId;
  tabs: TabDef[];
  active: string;
  onTab?: (id: string) => void;
  info?: JSX.Element;
  actions?: JSX.Element;
  extraZoom?: JSX.Element;
}) {
  const zoomed = () => state.zoomed === props.pane;
  const minimized = () => isMinimized(props.pane) && !zoomed() && !phone();
  const popped = () => isPopped(props.pane);
  const [menu, setMenu] = createSignal<DOMRect | null>(null);
  let menuBtn!: HTMLButtonElement;

  return (
    <div
      class="pane-header"
      classList={{ minimized: minimized() }}
      onDblClick={(e) => e.target === e.currentTarget && !popped() && (minimized() ? restorePane(props.pane) : toggleMaximize(props.pane))}
    >
      <div class="pane-tabs" role="tablist">
        <For each={props.tabs}>
          {(t) => (
            <button
              role="tab"
              aria-selected={props.active === t.id}
              class="pane-tab"
              classList={{ active: props.active === t.id }}
              onClick={() => {
                props.onTab?.(t.id);
                if (minimized()) restorePane(props.pane);
              }}
            >
              {t.icon && <Icon name={t.icon} size={14} />}
              <span>{t.label}</span>
            </button>
          )}
        </For>
        <Show when={minimized() && panes.badge[props.pane]}>
          <span class="pane-badge" aria-label="new output" />
        </Show>
      </div>
      <Show when={props.info && !minimized()}>
        <div class="pane-info">{props.info}</div>
      </Show>
      <div class="pane-actions">
        <Show when={!minimized()}>
          {props.actions}
          {props.extraZoom}
        </Show>
        <Show
          when={!popped()}
          fallback={
            <button class="tb-btn pane-return" title="Back to the main window" onClick={() => bringBack(props.pane)}>
              <Icon name="restore" size={15} />
            </button>
          }
        >
          <Show when={!phone()}>
            <button
              class="tb-btn pane-min"
              title={minimized() ? 'Restore pane' : 'Minimize pane'}
              onClick={() => (minimized() ? restorePane(props.pane) : minimizePane(props.pane))}
            >
              <Icon name={minimized() ? 'pane-layout' : 'minimize'} size={15} />
            </button>
            <button ref={menuBtn} class="tb-btn pane-menu-btn" title="Pane layout" aria-haspopup="menu" onClick={() => setMenu(menuBtn.getBoundingClientRect())}>
              <Icon name="chevron-down" size={13} />
            </button>
          </Show>
          <button class="tb-btn pane-zoom" title={zoomed() ? 'Restore layout' : 'Maximize pane'} onClick={() => toggleMaximize(props.pane)}>
            <Icon name={zoomed() ? 'restore' : 'maximize'} size={15} />
          </button>
        </Show>
      </div>
      <Show when={menu()}>
        {(r) => <LayoutMenu pane={props.pane} at={r()} close={() => setMenu(null)} />}
      </Show>
    </div>
  );
}

function LayoutMenu(props: { pane: PaneId; at: DOMRect; close: () => void }) {
  const item = (icon: string, label: string, run: () => void, cls = '') => (
    <button
      class={`menu-item ${cls}`}
      role="menuitem"
      onClick={() => {
        props.close();
        run();
      }}
    >
      <Icon name={icon} /> {label}
    </button>
  );
  const anyChanged = () => !!state.zoomed || Object.values(panes.minimized).some(Boolean);
  return (
    <Portal>
      <div class="menu-backdrop" onClick={props.close}>
        <div
          class="menu pane-menu"
          role="menu"
          style={{ right: `${Math.max(8, window.innerWidth - props.at.right)}px`, top: `${props.at.bottom + 4}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {item('minimize', 'Minimize', () => minimizePane(props.pane), 'lm-minimize')}
          {item('expand-v', 'Expand vertically', () => expandVertically(props.pane), 'lm-expand-v')}
          {item('expand-h', 'Expand horizontally', () => expandHorizontally(props.pane), 'lm-expand-h')}
          {item('maximize', state.zoomed === props.pane ? 'Restore from maximized' : 'Maximize', () => toggleMaximize(props.pane), 'lm-maximize')}
          <Show when={canPopOut(props.pane)}>{item('new-window', 'Open in new window', () => popOut(props.pane), 'lm-popout')}</Show>
          <div class="menu-sep" />
          <Show when={anyChanged()}>{item('restore', 'Show all panes', restoreAll, 'lm-show-all')}</Show>
          {item('grid', 'Reset layout', resetLayout, 'lm-reset')}
        </div>
      </div>
    </Portal>
  );
}
