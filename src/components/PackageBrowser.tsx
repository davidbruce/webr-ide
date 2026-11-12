import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { state, refreshPackages, session } from '../lib/ide';
import { pkgCache, checkUpdates, rMinor } from '../lib/packages';
import {
  loadRepoIndex,
  searchNames,
  searchRemote,
  fetchDetails,
  missingDependencies,
  BASE_PACKAGES,
  KNOWN_ISSUES,
  POPULAR,
  type PackageHit,
  type RepoPackage,
} from '../lib/pkg-index';
import { browser, setBrowser, installPackages, updatePackages, removePackage, installing } from '../lib/pkg-actions';
import { formatBytes, toast } from '../lib/ui';
import { Icon } from './Icon';

type Tab = 'browse' | 'installed' | 'updates';

const fmtCount = (n?: number) =>
  n === undefined ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

export function PackageBrowser() {
  return (
    <Show when={browser()}>
      {(b) => (
        <Portal>
          <BrowserModal initialTab={b().tab} initialQuery={b().query} />
        </Portal>
      )}
    </Show>
  );
}

function BrowserModal(props: { initialTab: Tab; initialQuery: string }) {
  const [tab, setTab] = createSignal<Tab>(props.initialTab);
  const [query, setQuery] = createSignal(props.initialQuery);
  const [debounced, setDebounced] = createSignal(props.initialQuery);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [showDetailsNarrow, setShowDetailsNarrow] = createSignal(false);
  let input!: HTMLInputElement;

  const rv = () => pkgCache.rVersion || (session.versionR ? rMinor(session.versionR) : '4.6');
  const [index] = createResource(rv, (v) => loadRepoIndex(v));

  const installedMap = createMemo(() => new Map(state.packages.map((p) => [p.name, p])));
  const installedNames = createMemo(() => new Set(state.packages.map((p) => p.name)));

  onMount(() => {
    void refreshPackages();
    input.focus();
  });

  let timer: number | undefined;
  createEffect(
    on(query, (q) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setDebounced(q), 280);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  // ---------------------------------------------------------------- remote search
  const [remote, setRemote] = createSignal<{ q: string; hits: { name: string; title: string; usedBy: number }[] } | null>(null);
  const [remoteError, setRemoteError] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  let abort: AbortController | null = null;
  createEffect(
    on(debounced, async (q) => {
      abort?.abort();
      if (tab() !== 'browse' || !q.trim()) {
        setRemote(null);
        return;
      }
      abort = new AbortController();
      setSearching(true);
      try {
        const hits = await searchRemote(q.trim(), abort.signal);
        setRemote({ q, hits });
        setRemoteError(false);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setRemoteError(true);
      } finally {
        setSearching(false);
      }
    }),
  );

  const titles = new Map<string, string>(POPULAR.map((p) => [p.name, p.title]));

  // ---------------------------------------------------------------- list contents
  const results = createMemo<PackageHit[]>(() => {
    const idx = index();
    const q = debounced().trim();
    const filterText = (h: { name: string; title?: string }) =>
      !q || h.name.toLowerCase().includes(q.toLowerCase()) || (h.title ?? '').toLowerCase().includes(q.toLowerCase());

    if (tab() === 'installed') {
      return state.packages
        .filter((p) => p.user)
        .map((p) => ({ name: p.name, version: p.version, title: titles.get(p.name) }))
        .filter(filterText);
    }
    if (tab() === 'updates') {
      return Object.values(pkgCache.updates)
        .filter(Boolean)
        .map((u) => ({ name: u.name, version: u.available, title: titles.get(u.name) }))
        .filter(filterText);
    }
    if (!idx) return [];
    if (!q) return POPULAR.filter((p) => idx.has(p.name)).map((p) => ({ name: p.name, version: idx.get(p.name)!.version, title: p.title }));

    const local = searchNames(idx, q, 40);
    const out = new Map<string, PackageHit>();
    // exact name match first
    const exact = local.find((h) => h.name.toLowerCase() === q.toLowerCase());
    if (exact) out.set(exact.name, exact);
    const r = remote();
    if (r && r.q === debounced()) {
      for (const h of r.hits) {
        const p = idx.get(h.name);
        if (!p) continue; // not installable in webR
        titles.set(h.name, h.title);
        out.set(h.name, { name: h.name, version: p.version, title: h.title, usedBy: h.usedBy });
      }
    }
    for (const h of local) if (!out.has(h.name)) out.set(h.name, { ...h, title: titles.get(h.name) });
    return [...out.values()].slice(0, 120);
  });

  // keep a valid selection
  createEffect(
    on(results, (rs) => {
      if (!rs.length) return setSelected(null);
      if (!selected() || !rs.some((r) => r.name === selected())) setSelected(rs[0].name);
    }),
  );

  // ---------------------------------------------------------------- keyboard
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setBrowser(null);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rs = results();
      const i = rs.findIndex((r) => r.name === selected());
      const next = rs[Math.max(0, Math.min(rs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        setSelected(next.name);
        document.getElementById(`pkg-item-${next.name}`)?.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  window.addEventListener('keydown', onKey, true);
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  async function check() {
    try {
      const u = await checkUpdates(session);
      toast(u.length ? `${u.length} update${u.length === 1 ? '' : 's'} available` : 'Everything is up to date');
    } catch (e) {
      toast(`Update check failed: ${e}`, 'error');
    }
  }

  const updateCount = () => Object.values(pkgCache.updates).filter(Boolean).length;
  const userCount = () => state.packages.filter((p) => p.user).length;

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setBrowser(null)}>
      <div class="pkg-browser" role="dialog" aria-label="Package browser" classList={{ 'show-details': showDetailsNarrow() }}>
        <div class="pkg-browser-head">
          <div class="pkg-tabs" role="tablist">
            <For
              each={
                [
                  ['browse', 'Browse', 0],
                  ['installed', 'Installed', userCount()],
                  ['updates', 'Updates', updateCount()],
                ] as [Tab, string, number][]
              }
            >
              {([id, label, count]) => (
                <button role="tab" class="pkg-tab" classList={{ active: tab() === id }} aria-selected={tab() === id} onClick={() => setTab(id)}>
                  {label}
                  <Show when={count}>
                    <span class="pkg-count" classList={{ accent: id === 'updates' }}>
                      {count}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div class="search-box pkg-search">
            <Icon name="search" size={14} />
            <input
              ref={input}
              type="search"
              placeholder={tab() === 'browse' ? 'Search packages (name or topic, e.g. "read excel")' : 'Filter'}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
            />
          </div>
          <Show when={tab() === 'updates'}>
            <button class="tb-btn labeled" onClick={() => void check()} disabled={state.rStatus !== 'ready'}>
              <Icon name="refresh" />
              <span>Check</span>
            </button>
            <button class="btn small primary" disabled={!updateCount()} onClick={() => void updatePackages(Object.keys(pkgCache.updates).filter((k) => pkgCache.updates[k]))}>
              Update all
            </button>
          </Show>
          <button class="tb-btn close-btn" onClick={() => setBrowser(null)} title="Close (Esc)">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div class="pkg-browser-body">
          <div class="pkg-list" role="listbox" aria-label="Packages">
            <Show when={tab() === 'browse' && !debounced().trim()}>
              <div class="pkg-list-caption">Popular packages</div>
            </Show>
            <Show when={tab() === 'browse' && remoteError() && debounced().trim()}>
              <div class="pkg-list-note">Online search is unavailable — showing package-name matches only.</div>
            </Show>
            <Show when={index.error && tab() === 'browse'}>
              <div class="pkg-list-note">Couldn't load the webR package index. Check your connection.</div>
            </Show>
            <For each={results()}>
              {(h) => {
                const inst = () => installedMap().get(h.name);
                const upd = () => pkgCache.updates[h.name];
                return (
                  <button
                    id={`pkg-item-${h.name}`}
                    role="option"
                    aria-selected={selected() === h.name}
                    class="pkg-item"
                    classList={{ selected: selected() === h.name }}
                    onClick={() => {
                      setSelected(h.name);
                      setShowDetailsNarrow(true);
                    }}
                  >
                    <div class="pkg-item-top">
                      <span class="pkg-item-name">{h.name}</span>
                      <Show when={installing().has(h.name)}>
                        <span class="pkg-badge busy">installing…</span>
                      </Show>
                      <Show when={!installing().has(h.name) && upd()}>
                        <span class="pkg-badge update">
                          <Icon name="arrow-up" size={10} /> {upd()!.available}
                        </span>
                      </Show>
                      <Show when={!installing().has(h.name) && !upd() && inst()}>
                        <span class="pkg-badge ok">
                          <Icon name="check" size={10} /> {inst()!.version}
                        </span>
                      </Show>
                      <Show when={KNOWN_ISSUES[h.name]}>
                        <span class="pkg-badge warn" title={KNOWN_ISSUES[h.name]}>
                          ⚠ known issue
                        </span>
                      </Show>
                      <span class="tb-spacer" />
                      <span class="pkg-item-ver">{h.version}</span>
                    </div>
                    <div class="pkg-item-title">{h.title ?? ''}</div>
                    <Show when={h.usedBy}>
                      <div class="pkg-item-meta">used by {fmtCount(h.usedBy)} packages</div>
                    </Show>
                  </button>
                );
              }}
            </For>
            <Show when={searching() && !results().length}>
              <div class="pkg-list-note">Searching…</div>
            </Show>
            <Show when={!searching() && !results().length && (index() || tab() !== 'browse')}>
              <div class="pkg-list-note">
                {tab() === 'updates' ? 'No updates found. Use “Check” to look again.' : tab() === 'installed' ? 'No installed packages yet.' : 'No matching packages in the webR repository.'}
              </div>
            </Show>
          </div>

          <div class="pkg-details">
            <Show when={selected()} fallback={<div class="empty-note">Select a package</div>} keyed>
              {(name) => (
                <Details
                  name={name}
                  repo={index()?.get(name)}
                  index={index()}
                  installed={installedMap().get(name)}
                  installedNames={installedNames()}
                  onBack={() => setShowDetailsNarrow(false)}
                />
              )}
            </Show>
          </div>
        </div>
        <div class="pkg-browser-foot">
          Only packages with a webR (WebAssembly) build are listed · binaries from repo.r-wasm.org (R {rv()}) · descriptions from R-universe · saved in this browser (
          {formatBytes(Object.values(pkgCache.entries).reduce((n, p) => n + p.size, 0))})
        </div>
      </div>
    </div>
  );
}

function Details(props: {
  name: string;
  repo?: RepoPackage;
  index?: Map<string, RepoPackage>;
  installed?: { version: string; user: boolean };
  installedNames: Set<string>;
  onBack: () => void;
}) {
  const [details] = createResource(() => props.name, fetchDetails);
  const upd = () => pkgCache.updates[props.name];
  const busy = () => installing().has(props.name);
  const missing = createMemo(() => (props.index ? missingDependencies(props.index, props.name, props.installedNames) : []));
  const deps = () => (props.repo ? [...props.repo.depends, ...props.repo.imports].filter((d) => !BASE_PACKAGES.has(d)) : []);
  const isSystem = () => props.installed && !props.installed.user;

  return (
    <div class="pkg-details-inner">
      <button class="tb-btn labeled pkg-back" onClick={props.onBack}>
        <Icon name="left" />
        <span>Back</span>
      </button>
      <div class="pkg-details-head">
        <div>
          <h2>{props.name}</h2>
          <div class="pkg-details-title">{details()?.title ?? (details.loading ? '…' : '')}</div>
        </div>
      </div>

      <Show when={KNOWN_ISSUES[props.name]}>
        <div class="pkg-warning" role="note">
          <strong>Known issue in the browser:</strong> {KNOWN_ISSUES[props.name]}
        </div>
      </Show>
      <div class="pkg-actions-row">
        <Show
          when={props.repo}
          fallback={<span class="muted">{props.installed ? 'Installed' : 'Not available in the webR repository'}</span>}
        >
          <Show when={busy()}>
            <button class="btn primary install-busy" disabled>
              <span class="spinner small" aria-hidden="true" />
              Installing{state.installs.current ? ` ${state.installs.current.pkg}` : ''}…
              <Show when={state.installs.done.length}>
                <span class="muted-on-primary">({state.installs.done.length} done)</span>
              </Show>
            </button>
          </Show>
          <Show when={!busy() && !props.installed}>
            <button class="btn primary" onClick={() => installPackages([props.name])}>
              <Icon name="download" /> Install {props.repo!.version}
            </button>
          </Show>
          <Show when={!busy() && props.installed && upd()}>
            <button class="btn primary" onClick={() => void updatePackages([props.name])}>
              <Icon name="arrow-up" /> Update to {upd()!.available}
            </button>
          </Show>
          <Show when={!busy() && props.installed && !upd()}>
            <span class="pkg-installed">
              <Icon name="check" /> Installed {props.installed!.version}
              {isSystem() ? ' (bundled with webR)' : ''}
            </span>
          </Show>
          <Show when={!busy() && props.installed?.user}>
            <button class="btn" onClick={() => void removePackage(props.name, props.installed!.version)}>
              <Icon name="trash" /> Remove
            </button>
          </Show>
        </Show>
      </div>
      <Show when={!props.installed && missing().length}>
        <div class="pkg-deps-note">
          Also installs {missing().length} dependenc{missing().length === 1 ? 'y' : 'ies'}: {missing().slice(0, 12).join(', ')}
          {missing().length > 12 ? `, +${missing().length - 12} more` : ''}
        </div>
      </Show>

      <Show when={details()?.description}>
        <p class="pkg-desc">{details()!.description}</p>
      </Show>
      <Show when={details.error}>
        <p class="muted">Description unavailable offline.</p>
      </Show>

      <dl class="pkg-meta">
        <dt>webR version</dt>
        <dd>{props.repo?.version ?? '—'}</dd>
        <Show when={details()?.cranVersion && details()!.cranVersion !== props.repo?.version}>
          <dt>CRAN version</dt>
          <dd>{details()!.cranVersion}</dd>
        </Show>
        <Show when={props.repo?.license || details()?.license}>
          <dt>License</dt>
          <dd>{props.repo?.license || details()!.license}</dd>
        </Show>
        <Show when={details()?.maintainer}>
          <dt>Maintainer</dt>
          <dd>{details()!.maintainer}</dd>
        </Show>
        <Show when={details()?.published}>
          <dt>Published</dt>
          <dd>{details()!.published}</dd>
        </Show>
        <Show when={details()?.downloads}>
          <dt>Downloads</dt>
          <dd>{details()!.downloads!.toLocaleString()} last month</dd>
        </Show>
        <Show when={details()?.usedBy}>
          <dt>Used by</dt>
          <dd>{details()!.usedBy!.toLocaleString()} packages</dd>
        </Show>
        <Show when={details()?.urls.length || details()?.bugReports}>
          <dt>Links</dt>
          <dd class="pkg-links">
            <For each={details()!.urls}>
              {(u) => (
                <a href={u} target="_blank" rel="noopener noreferrer">
                  {u.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              )}
            </For>
            <Show when={details()?.bugReports}>
              <a href={details()!.bugReports} target="_blank" rel="noopener noreferrer">
                Report an issue
              </a>
            </Show>
          </dd>
        </Show>
      </dl>

      <Show when={deps().length}>
        <h3 class="pkg-section">Dependencies</h3>
        <div class="pkg-chips">
          <For each={deps()}>
            {(d) => (
              <span class="pkg-chip" classList={{ ok: props.installedNames.has(d) }} title={props.installedNames.has(d) ? 'Installed' : 'Will be installed'}>
                <Show when={props.installedNames.has(d)}>
                  <Icon name="check" size={10} />
                </Show>
                {d}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={details()?.authors}>
        <h3 class="pkg-section">Authors</h3>
        <p class="pkg-authors">{details()!.authors}</p>
      </Show>
    </div>
  );
}
