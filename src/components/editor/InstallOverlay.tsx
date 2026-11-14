// The card over the editor while a package downloads/installs (the editor
// is read-only until it finishes).

import { Show } from 'solid-js';
import { isInstalling, state } from '../../lib/ide';
import './InstallOverlay.css';

export function InstallOverlay() {
  return (
    <Show when={isInstalling()}>
      <div class="install-overlay" role="status" aria-live="polite">
        <div class="install-card">
          <div class="spinner" aria-hidden="true" />
          <div>
            <div class="install-title">
              Installing {state.installs.current?.pkg ?? 'packages'}
              <Show when={state.installs.current?.version}>
                <span class="install-ver"> {state.installs.current!.version}</span>
              </Show>
              …
            </div>
            <div class="install-sub">
              <Show when={state.installs.done.length} fallback="Downloading from repo.r-wasm.org">
                {state.installs.done.length} package{state.installs.done.length === 1 ? '' : 's'} installed so far
              </Show>
              {' · '}editor locked until it finishes
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
