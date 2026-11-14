// Storage problems: a banner that stays up while files can't be saved, and
// a details dialog listing what the browser supports (copyable, for support).

import { createResource, createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { storageDiagnostics, storageIssue } from '../lib/opfs';
import { toast } from '../lib/ui';
import { Icon } from './Icon';
import './StorageInfo.css';

const [open, setOpen] = createSignal(false);
export const openStorageInfo = () => setOpen(true);

export function StorageBanner() {
  const [hidden, setHidden] = createSignal(false);
  return (
    <Show when={storageIssue() && !hidden()}>
      <div class="storage-banner" role="alert">
        <span class="storage-banner-text">
          <strong>Files won't be saved.</strong> {storageIssue()}
        </span>
        <button class="btn small" onClick={openStorageInfo}>
          Details
        </button>
        <button class="tb-btn tiny" aria-label="Hide" title="Hide (files still won't be saved)" onClick={() => setHidden(true)}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </Show>
  );
}

function Dialog() {
  const [rows] = createResource(storageDiagnostics);
  const text = () => (rows() ?? []).map(([k, v]) => `${k}: ${v}`).join('\n');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      toast('Copied');
    } catch {
      toast('Copy failed; select the text instead', 'warn');
    }
  }
  return (
    <div class="modal-backdrop dialog-backdrop" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div class="dialog storage-info" role="dialog" aria-label="Storage details">
        <h3>Storage details</h3>
        <Show when={storageIssue()}>
          <p class="storage-info-issue">{storageIssue()}</p>
        </Show>
        <table>
          <tbody>
            <For each={rows() ?? []}>
              {([k, v]) => (
                <tr>
                  <th>{k}</th>
                  <td>{v}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <div class="dialog-actions">
          <button class="btn" onClick={() => void copy()}>
            Copy
          </button>
          <button class="btn primary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function StorageInfo() {
  return (
    <Show when={open()}>
      <Portal>
        <Dialog />
      </Portal>
    </Show>
  );
}
