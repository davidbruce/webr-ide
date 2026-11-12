import { For, JSX, Show } from 'solid-js';
import { Icon } from './Icon';
import { PaneId, setState, state } from '../lib/ide';

export interface TabDef {
  id: string;
  label: string;
  icon?: string;
}

/** RStudio-style pane header: tabs on the left, actions + zoom on the right. */
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
  return (
    <div class="pane-header" onDblClick={(e) => e.target === e.currentTarget && setState('zoomed', zoomed() ? null : props.pane)}>
      <div class="pane-tabs" role="tablist">
        <For each={props.tabs}>
          {(t) => (
            <button
              role="tab"
              aria-selected={props.active === t.id}
              class="pane-tab"
              classList={{ active: props.active === t.id }}
              onClick={() => props.onTab?.(t.id)}
            >
              {t.icon && <Icon name={t.icon} size={14} />}
              <span>{t.label}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.info}>
        <div class="pane-info">{props.info}</div>
      </Show>
      <div class="pane-actions">
        {props.actions}
        {props.extraZoom}
        <button
          class="tb-btn"
          title={zoomed() ? 'Restore layout' : 'Zoom pane'}
          onClick={() => setState('zoomed', zoomed() ? null : props.pane)}
        >
          <Icon name={zoomed() ? 'restore' : 'maximize'} size={15} />
        </button>
      </div>
    </div>
  );
}

/** Small toolbar row placed under a pane header. */
export function PaneToolbar(props: { children: JSX.Element }) {
  return <div class="pane-toolbar">{props.children}</div>;
}
