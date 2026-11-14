import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { state, setState, session, refreshPackages, writeWorkspaceFile, downloadBlob, setPlotSizeHint, restartR, PackageEntry, checkRenv, writeRenvLock } from '../lib/ide';
import { pkgCache, checkUpdates, clearOtherRVersions, cachedBytes } from '../lib/packages';
import { wsConfig } from '../lib/workspace-config';
import { openSettings } from '../lib/settings';
import { installPackages, updatePackages, removePackage, openPackageBrowser } from '../lib/pkg-actions';
import { rString } from '../lib/r-session';
import { askText, formatBytes, toast } from '../lib/ui';
import { Icon } from './Icon';
import { PaneHeader } from './Pane';
import { OutputPane } from './Notebook';
import { PreviewPane } from './Preview';
import { HelpPane } from './HelpPane';
import { openHelpIndex } from '../lib/help';

// ---------------------------------------------------------------- plot history

const MAX_PLOTS = 10; // keep the 10 most recent plots
const DEVICE_SCALE = 2;
const [plots, setPlots] = createSignal<HTMLCanvasElement[]>([]);
const [index, setIndex] = createSignal(-1);
export const [plotFullscreen, setPlotFullscreen] = createSignal(false);
let receivingInto: HTMLCanvasElement | null = null;
const [plotVersion, setPlotVersion] = createSignal(0);

function newCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'plot-canvas';
  c.width = 1;
  c.height = 1;
  return c;
}

session.on((ev) => {
  if (ev.type === 'canvasNewPage') {
    const c = newCanvas();
    receivingInto = c;
    setPlots((p) => [...p, c].slice(-MAX_PLOTS));
    setIndex(plots().length - 1);
    if (state.plotTab !== 'plots') setState('plotTab', 'plots');
  } else if (ev.type === 'canvasImage') {
    let c = receivingInto;
    if (!c) {
      c = newCanvas();
      receivingInto = c;
      setPlots((p) => [...p, c!].slice(-MAX_PLOTS));
    }
    // Always show the plot being drawn (e.g. abline() after browsing back).
    const at = plots().indexOf(c);
    if (at >= 0 && at !== index()) setIndex(at);
    if (state.plotTab !== 'plots') setState('plotTab', 'plots');
    if (c.width !== ev.image.width || c.height !== ev.image.height) {
      c.width = ev.image.width;
      c.height = ev.image.height;
      // webR's canvas device renders at 2x; show it at its logical size so
      // text matches the requested pointsize, shrinking to fit if needed.
      c.style.maxWidth = `${ev.image.width / DEVICE_SCALE}px`;
      c.style.maxHeight = `${ev.image.height / DEVICE_SCALE}px`;
    }
    c.getContext('2d')!.drawImage(ev.image, 0, 0);
    ev.image.close?.();
    setPlotVersion((v) => v + 1);
  }
});

const current = () => plots()[index()] ?? null;

function canvasBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('export failed'))), 'image/png'));
}

async function savePlotToWorkspace() {
  const c = current();
  if (!c) return;
  const name = await askText('Save Plot as PNG', `plots/plot-${index() + 1}.png`, { okLabel: 'Save', selectStem: true });
  if (!name) return;
  await writeWorkspaceFile(name.endsWith('.png') ? name : `${name}.png`, new Uint8Array(await (await canvasBlob(c)).arrayBuffer()));
  toast(`Saved ${name}`);
}

async function downloadPlot() {
  const c = current();
  if (c) downloadBlob(await canvasBlob(c), `plot-${index() + 1}.png`);
}

async function copyPlot() {
  const c = current();
  if (!c) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(c) })]);
    toast('Plot copied to clipboard');
  } catch (e) {
    toast(`Copy failed: ${e}`, 'error');
  }
}

function removeCurrent() {
  const i = index();
  const removed = plots()[i];
  if (removed === receivingInto) receivingInto = null;
  setPlots((p) => p.filter((_, j) => j !== i));
  setIndex(Math.min(i, plots().length - 1));
}

function clearPlots() {
  receivingInto = null;
  setPlots([]);
  setIndex(-1);
}

function PlotNav() {
  return (
    <>
      <button class="tb-btn" disabled={index() <= 0} onClick={() => setIndex((i) => i - 1)} title="Previous plot">
        <Icon name="left" />
      </button>
      <span class="plot-count">{plots().length ? `${index() + 1} / ${plots().length}` : '0 / 0'}</span>
      <button class="tb-btn" disabled={index() >= plots().length - 1} onClick={() => setIndex((i) => i + 1)} title="Next plot">
        <Icon name="right" />
      </button>
    </>
  );
}

// ---------------------------------------------------------------- pane

export function PlotsPane() {
  // Another workspace: its own plots (R restarts too).
  createEffect(on(() => state.workspace, (ws, prev) => prev && ws !== prev && clearPlots(), { defer: true }));
  return (
    <div class="pane">
      <PaneHeader
        pane="plots"
        tabs={[
          { id: 'plots', label: 'Plots' },
          { id: 'output', label: 'Output' },
          { id: 'preview', label: 'Preview' },
          { id: 'packages', label: 'Packages' },
          { id: 'help', label: 'Help' },
        ]}
        active={state.plotTab}
        onTab={(id) => setState('plotTab', id as 'plots' | 'output' | 'preview' | 'packages' | 'help')}
      />
      <Show when={state.plotTab === 'plots'}>
        <PlotsView />
      </Show>
      <Show when={state.plotTab === 'output'}>
        <OutputPane />
      </Show>
      <Show when={state.plotTab === 'preview'}>
        <PreviewPane />
      </Show>
      <Show when={state.plotTab === 'packages'}>
        <PackagesView />
      </Show>
      <Show when={state.plotTab === 'help'}>
        <HelpPane />
      </Show>
      <PlotFullscreen />
    </div>
  );
}

function PlotsView() {
  let stage!: HTMLDivElement;
  let timer: number | undefined;

  onMount(() => {
    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const w = Math.floor(r.width - 16);
        const h = Math.floor(r.height - 16);
        setPlotSizeHint(w, h);
        if (session.status === 'ready') void session.setPlotSize(w, h);
      }, 250);
    });
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });

  return (
    <>
      <div class="pane-toolbar">
        <PlotNav />
        <span class="tb-sep" />
        <button class="tb-btn labeled" disabled={!current()} onClick={() => setPlotFullscreen(true)} title="Expand plot">
          <Icon name="expand" />
          <span>Expand</span>
        </button>
        <button class="tb-btn" disabled={!current()} onClick={() => void savePlotToWorkspace()} title="Save PNG to workspace">
          <Icon name="save" />
        </button>
        <button class="tb-btn" disabled={!current()} onClick={() => void downloadPlot()} title="Download PNG">
          <Icon name="download" />
        </button>
        <span class="tb-spacer" />
        <button class="tb-btn" disabled={!current()} onClick={removeCurrent} title="Remove plot">
          <Icon name="close" />
        </button>
        <button class="tb-btn" disabled={!plots().length} onClick={clearPlots} title="Clear all plots">
          <Icon name="broom" />
        </button>
      </div>
      <div class="pane-body plot-stage" ref={stage} onDblClick={() => current() && setPlotFullscreen(true)}>
        <Show when={current()} fallback={<div class="empty-note">Plots will appear here</div>}>
          {current()}
        </Show>
      </div>
    </>
  );
}

function PlotFullscreen() {
  // The canvas element lives in the pane; the modal shows a PNG snapshot of it,
  // replaced by a full-size re-render when the plot is the latest one.
  const [hires, setHires] = createSignal<{ canvas: HTMLCanvasElement; url: string } | null>(null);
  const src = createMemo(() => {
    plotVersion();
    const c = current();
    if (!plotFullscreen() || !c) return '';
    const h = hires();
    return h && h.canvas === c ? h.url : c.toDataURL('image/png');
  });
  let body: HTMLDivElement | undefined;
  let renderSeq = 0;

  async function rerender() {
    const c = current();
    const isLatest = c && c === plots()[plots().length - 1];
    if (!c || !isLatest || !body || session.status !== 'ready') return;
    const r = body.getBoundingClientRect();
    const w = Math.min(2400, r.width - 32);
    const h = Math.min(1800, r.height - 32);
    if (w < 100 || h < 100) return;
    const seq = ++renderSeq;
    const bmp = await session.renderLatestPlot(w, h);
    if (!bmp || seq !== renderSeq || !plotFullscreen() || current() !== c) return;
    const tmp = document.createElement('canvas');
    tmp.width = bmp.width;
    tmp.height = bmp.height;
    tmp.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close?.();
    setHires({ canvas: c, url: tmp.toDataURL('image/png') });
  }

  createEffect(
    on([plotFullscreen, current, plotVersion], ([open]) => {
      if (open) queueMicrotask(() => void rerender());
      else setHires(null);
    }),
  );
  const onKey = (e: KeyboardEvent) => {
    if (!plotFullscreen()) return;
    if (e.key === 'Escape') setPlotFullscreen(false);
    else if (e.key === 'ArrowLeft' && index() > 0) setIndex((i) => i - 1);
    else if (e.key === 'ArrowRight' && index() < plots().length - 1) setIndex((i) => i + 1);
  };
  window.addEventListener('keydown', onKey, true);
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  return (
    <Show when={plotFullscreen() && current()}>
      <Portal>
        <div class="modal-backdrop plot-modal-backdrop" onClick={(e) => e.target === e.currentTarget && setPlotFullscreen(false)}>
          <div class="plot-modal" role="dialog" aria-label="Plot" tabIndex={-1} ref={(el) => queueMicrotask(() => el.focus())}>
            <div class="plot-modal-header">
              <PlotNav />
              <span class="tb-spacer" />
              <button class="tb-btn" onClick={() => void copyPlot()} title="Copy image">
                <Icon name="image" />
              </button>
              <button class="tb-btn" onClick={() => void savePlotToWorkspace()} title="Save PNG to workspace">
                <Icon name="save" />
              </button>
              <button class="tb-btn" onClick={() => void downloadPlot()} title="Download PNG">
                <Icon name="download" />
              </button>
              <button class="tb-btn close-btn" onClick={() => setPlotFullscreen(false)} title="Close (Esc)">
                <Icon name="close" size={18} />
              </button>
            </div>
            <div class="plot-modal-body" ref={body}>
              <img src={src()} alt={`Plot ${index() + 1}`} class="plot-image" />
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

// ---------------------------------------------------------------- packages

function PackagesView() {
  const [filter, setFilter] = createSignal('');
  const [install, setInstall] = createSignal('');
  const [checking, setChecking] = createSignal(false);
  const match = (p: PackageEntry) => !filter() || p.name.toLowerCase().includes(filter().toLowerCase());
  const userPkgs = createMemo(() => state.packages.filter((p) => p.user && match(p)));
  const systemPkgs = createMemo(() => state.packages.filter((p) => !p.user && match(p)));
  const updates = createMemo(() => Object.values(pkgCache.updates).filter(Boolean));

  onMount(() => void refreshPackages());
  createEffect(on(() => state.busy, (b) => !b && void refreshPackages(), { defer: true }));

  function doInstall(e: Event) {
    e.preventDefault();
    const pkgs = install()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (!pkgs.length) return;
    installPackages(pkgs);
    setInstall('');
  }

  async function check() {
    if (!(await session.waitIdle(3000))) return toast('R is busy', 'warn');
    setChecking(true);
    try {
      const u = await checkUpdates(session);
      toast(u.length ? `${u.length} update${u.length === 1 ? '' : 's'} available` : 'All saved packages are up to date');
    } catch (e) {
      toast(`Update check failed (offline?): ${e}`, 'error');
    } finally {
      setChecking(false);
    }
  }

  const update = (names: string[]) => void updatePackages(names);
  const remove = (p: PackageEntry) => void removePackage(p.name, p.version);

  const Row = (p: PackageEntry) => {
    const cached = () => pkgCache.entries[p.name];
    const upd = () => pkgCache.updates[p.name];
    return (
      <tr>
        <td class="pkg-check">
          <input
            type="checkbox"
            checked={p.attached}
            aria-label={`Attach ${p.name}`}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              session.submit(on ? `library(${p.name})` : `detach("package:${p.name}", unload = TRUE)`);
            }}
          />
        </td>
        <td class="pkg-name">
          <button class="link" onClick={() => void openHelpIndex(p.name)}>
            {p.name}
          </button>
        </td>
        <td class="pkg-ver">
          <span>{p.version}</span>
          <Show when={upd()}>
            <button class="pkg-update" title={`Update to ${upd()!.available}`} onClick={() => void update([p.name])}>
              <Icon name="arrow-up" size={11} />
              {upd()!.available}
            </button>
          </Show>
        </td>
        <td class="pkg-actions">
          <Show when={cached()}>
            <span class="pkg-saved" title={`Saved offline: ${cached()!.name}_${cached()!.version}.tgz (${formatBytes(cached()!.size)}) for R ${cached()!.rVersion}`}>
              <Icon name="offline" size={15} />
            </span>
          </Show>
          <Show when={p.user}>
            <button class="tb-btn tiny" title={`Remove ${p.name}`} onClick={() => void remove(p)}>
              <Icon name="trash" size={14} />
            </button>
          </Show>
        </td>
      </tr>
    );
  };

  return (
    <>
      <div class="pane-toolbar">
        <button class="tb-btn labeled" onClick={() => openPackageBrowser()} title="Search and install packages">
          <Icon name="search" />
          <span>Browse</span>
        </button>
        <form class="install-form" onSubmit={doInstall}>
          <input
            type="text"
            placeholder="Quick install: dplyr ggplot2"
            value={install()}
            onInput={(e) => setInstall(e.currentTarget.value)}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
          <button class="tb-btn" type="submit" disabled={!install().trim() || state.rStatus !== 'ready'} title="Install">
            <Icon name="download" />
          </button>
        </form>
        <span class="tb-spacer" />
        <div class="search-box small">
          <Icon name="search" size={13} />
          <input type="search" placeholder="Filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <button class="tb-btn" onClick={() => void check()} disabled={checking() || state.rStatus !== 'ready'} title="Check saved packages for updates">
          <Icon name="arrow-up" />
        </button>
        <button class="tb-btn" onClick={() => void refreshPackages()} title="Refresh">
          <Icon name="refresh" />
        </button>
      </div>
      <Show when={updates().length}>
        <div class="pane-banner">
          <span>
            {updates().length} update{updates().length === 1 ? '' : 's'} available
          </span>
          <button class="btn small primary" onClick={() => void update(updates().map((u) => u.name))}>
            Update all
          </button>
        </div>
      </Show>
      <Show when={pkgCache.pendingRestart.length}>
        <div class="pane-banner warn">
          <span>Restart R to finish removing {pkgCache.pendingRestart.join(', ')}</span>
          <button class="btn small" onClick={() => void restartR()}>
            Restart R
          </button>
        </div>
      </Show>
      <div class="pane-body scroll">
        <Show when={state.packages.length} fallback={<div class="empty-note">{state.rStatus === 'ready' ? 'Loading…' : 'Waiting for R…'}</div>}>
          <table class="pkg-table">
            <colgroup>
              <col style={{ width: '40px' }} />
              <col />
              <col style={{ width: '38%' }} />
              <col style={{ width: '64px' }} />
            </colgroup>
            <tbody>
              <tr class="env-group">
                <th colSpan={4}>
                  User library <span class="muted">· saved in this browser</span>
                </th>
              </tr>
              <Show when={userPkgs().length} fallback={<tr><td colSpan={4} class="empty-row">No installed packages yet — install one above.</td></tr>}>
                <For each={userPkgs()}>{Row}</For>
              </Show>
              <tr class="env-group">
                <th colSpan={4}>System library <span class="muted">· bundled with webR</span></th>
              </tr>
              <For each={systemPkgs()}>{Row}</For>
            </tbody>
          </table>
        </Show>
        <div class="pane-footnote">
          <Show when={state.tree.some((n) => n.path === 'renv.lock')}>
            This workspace has an renv.lock ·{' '}
            <button class="link" onClick={() => void checkRenv()}>
              Check compatibility
            </button>
            {' · '}
            <button class="link" onClick={() => void writeRenvLock()}>
              Update from this workspace
            </button>
            <br />
          </Show>
          <Show when={wsConfig.library.mode === 'workspace'}>
            This workspace has its own library ({Object.keys(wsConfig.library.packages).length} packages) ·{' '}
            <button class="link" onClick={openSettings}>
              Change
            </button>
            <br />
          </Show>
          {Object.keys(pkgCache.entries).length} package{Object.keys(pkgCache.entries).length === 1 ? '' : 's'} saved offline ·{' '}
          {formatBytes(cachedBytes())} · R {pkgCache.rVersion || '…'}
          <Show when={pkgCache.otherVersionsBytes > 0}>
            {' · '}
            {formatBytes(pkgCache.otherVersionsBytes)} for other R versions{' '}
            <button class="link" onClick={() => void clearOtherRVersions().then(() => toast('Cleared old package archives'))}>
              Clear
            </button>
          </Show>
          <Show when={pkgCache.checkedAt}>
            <br />
            Checked for updates {new Date(pkgCache.checkedAt).toLocaleTimeString()}
          </Show>
        </div>
      </div>
    </>
  );
}

