// "A new version is ready" banner. Reloading saves open files and the R
// environment first, so nothing is lost.
import { createSignal, Show } from 'solid-js';
import { updateReady } from '../lib/app-update';
import { editor, saveEnvironmentImage, session } from '../lib/ide';
import { choiceDialog, toast } from '../lib/ui';
import { Icon } from './Icon';
import './UpdateBanner.css';

export function UpdateBanner() {
  const [hidden, setHidden] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function reload() {
    const apply = updateReady();
    if (!apply) return;
    if (editor()?.hasDirty()) {
      const r = await choiceDialog('Unsaved changes', 'Save your open files before reloading?', 'Save & Reload', {
        label: 'Reload Without Saving',
        value: 'discard',
      });
      if (r === null) return;
      if (r !== 'discard') await editor()?.saveAll();
    }
    setBusy(true);
    try {
      if (session.idle) await saveEnvironmentImage(true, { auto: true });
      await apply();
    } catch (e) {
      setBusy(false);
      toast(`Update failed: ${e}`, 'error');
    }
  }

  return (
    <Show when={updateReady() && !hidden()}>
      <div class="update-banner" role="status">
        <Icon name="refresh" size={15} />
        <span>A new version of webR IDE is ready.</span>
        <button class="btn small primary" disabled={busy()} onClick={() => void reload()}>
          {busy() ? 'Reloading…' : 'Reload'}
        </button>
        <button class="tb-btn tiny" aria-label="Later" title="Later (updates on the next launch)" onClick={() => setHidden(true)}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </Show>
  );
}
