// Result of checking a workspace's renv.lock against webR: a verdict, the
// packages that differ or are missing, and a button to set the workspace up.
import { createMemo, createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { renvCheck, setRenvCheck, type CheckRow, type RowStatus } from '../lib/renv';
import { markRenvChecked, session, setLibraryMode } from '../lib/ide';
import { installPackages } from '../lib/pkg-actions';
import { pkgCache } from '../lib/packages';
import { toast } from '../lib/ui';

const LABEL: Record<RowStatus, string> = {
  missing: 'Not available for webR',
  issue: "Available, but doesn't work in the browser",
  older: 'Older version in webR',
  newer: 'Newer version in webR',
  same: 'Same version',
  builtin: 'Built into webR',
  skip: 'Not needed',
};
const ORDER: RowStatus[] = ['missing', 'issue', 'older', 'newer', 'same', 'builtin', 'skip'];

export function RenvDialog() {
  const [showAll, setShowAll] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const groups = createMemo(() => {
    const r = renvCheck();
    if (!r) return [];
    return ORDER.map((status) => ({ status, rows: r.rows.filter((x) => x.status === status) })).filter((g) => g.rows.length);
  });

  const headline = () => {
    const r = renvCheck()!;
    const total = r.rows.filter((x) => x.status !== 'skip').length;
    const bad = r.rows.filter((x) => x.status === 'missing' || x.status === 'issue').length;
    const differ = r.rows.filter((x) => x.status === 'older' || x.status === 'newer').length;
    switch (r.verdict) {
      case 'compatible':
        return { kind: 'ok', title: 'Compatible', text: `All ${total} packages are available for webR at the locked versions.` };
      case 'versions':
        return {
          kind: 'ok',
          title: 'Compatible, with different versions',
          text: `All ${total} packages are available for webR; ${differ} at a different version than locked (webR only has the current build of each package).`,
        };
      case 'none':
        return { kind: 'bad', title: 'Not compatible', text: `None of the ${total} packages are available for webR.` };
      default:
        return {
          kind: 'warn',
          title: 'Partly compatible',
          text: r.repoError ?? `${bad} of ${total} packages aren't available for webR, so code that uses them won't run. The rest can be installed.`,
        };
    }
  };

  function close() {
    const r = renvCheck();
    if (r) void markRenvChecked(r.hash);
    setRenvCheck(null);
  }

  async function install() {
    const r = renvCheck();
    if (!r) return;
    setBusy(true);
    try {
      await markRenvChecked(r.hash);
      setRenvCheck(null);
      await setLibraryMode('workspace', {});
      if (!(await session.waitIdle(60_000))) return;
      const need = r.installable.filter((n) => !pkgCache.linked[n]);
      if (need.length) installPackages(need);
      else toast('All of these packages are already in this workspace');
    } finally {
      setBusy(false);
    }
  }

  const Row = (p: { row: CheckRow }) => (
    <tr>
      <td class="renv-name">{p.row.name}</td>
      <td class="renv-ver">
        {p.row.version}
        <Show when={p.row.webrVersion && p.row.webrVersion !== p.row.version}>
          <span class="renv-arrow"> → {p.row.webrVersion}</span>
        </Show>
      </td>
      <td class="renv-note">{p.row.note ?? (p.row.source !== 'CRAN' && p.row.source !== 'Repository' ? p.row.source : '')}</td>
    </tr>
  );

  return (
    <Show when={renvCheck()}>
      {(r) => (
        <Portal>
          <div class="modal-backdrop dialog-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
            <div class="dialog renv" role="dialog" aria-label="renv.lock check">
              <h3>renv.lock</h3>
              <div class={`renv-verdict ${headline().kind}`}>
                <strong>{headline().title}</strong>
                <span>{headline().text}</span>
              </div>
              <Show when={r().lock.rVersion}>
                <p class="renv-r">
                  Locked for R {r().lock.rVersion}; webR runs R {session.versionR || '…'}.
                </p>
              </Show>
              <div class="renv-table">
                <For each={groups()}>
                  {(g) => (
                    <Show when={showAll() || !['same', 'builtin', 'skip'].includes(g.status)}>
                      <h4 class={`renv-group ${g.status}`}>
                        {LABEL[g.status]} ({g.rows.length})
                      </h4>
                      <table>
                        <tbody>
                          <For each={g.rows}>{(row) => <Row row={row} />}</For>
                        </tbody>
                      </table>
                    </Show>
                  )}
                </For>
                <button class="link" onClick={() => setShowAll(!showAll())}>
                  {showAll() ? 'Hide matching packages' : `Show all ${r().rows.length} packages`}
                </button>
              </div>
              <div class="dialog-actions">
                <button class="btn" onClick={close}>
                  Not Now
                </button>
                <span class="tb-spacer" />
                <button class="btn primary" disabled={busy() || !r().installable.length} onClick={() => void install()}>
                  Install {r().installable.length} package{r().installable.length === 1 ? '' : 's'} into this workspace
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
