// Progress while R starts: what's happening, how far along, and a note when
// it's the slow first start (the runtime downloads once, then works offline).
import { createSignal, onCleanup, Show } from 'solid-js';
import { boot, bootStarted } from '../lib/boot';

export function StartupCard() {
  const [now, setNow] = createSignal(performance.now());
  const timer = window.setInterval(() => setNow(performance.now()), 500);
  onCleanup(() => clearInterval(timer));
  const elapsed = () => Math.max(0, Math.round((now() - bootStarted()) / 1000));
  const pct = () => {
    const b = boot();
    return b?.total ? Math.min(100, Math.round(((b.done ?? 0) / b.total) * 100)) : null;
  };
  return (
    <Show when={boot()}>
      {(b) => (
        <div class="startup-card" role="status" aria-live="polite">
          <div class="startup-row">
            <span class="spinner small" aria-hidden="true" />
            <span class="startup-label">
              {b().label}
              <Show when={b().total}>
                <span class="startup-count">
                  {' '}
                  {b().done ?? 0}/{b().total}
                </span>
              </Show>
              …
            </span>
            <span class="startup-time">{elapsed()}s</span>
          </div>
          <div class="startup-bar" classList={{ indeterminate: pct() === null }}>
            <div style={{ width: pct() === null ? undefined : `${pct()}%` }} />
          </div>
          <Show when={elapsed() >= 8}>
            <div class="startup-note">The first start downloads R (about 50 MB). After that it starts faster and works offline.</div>
          </Show>
        </div>
      )}
    </Show>
  );
}
