import { createEffect, createMemo, createSignal, Index, JSX, on, onCleanup, onMount, Show } from 'solid-js';
import type { Filter, GridRow, GridSource, SortSpec } from '../lib/grid/source';
import { Icon } from './Icon';
import { toast } from '../lib/ui';

const BLOCK = 100;
const MAX_BLOCKS = 80;
const MAX_SCROLL_PX = 6_000_000; // keep the scroll spacer under browser height limits
const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

const fmtInt = (n: number) => n.toLocaleString();

/**
 * Virtualized, read-only spreadsheet view over a GridSource: sticky header,
 * per-column filters, click-to-sort, resizable columns, keyboard navigation.
 */
export function DataGrid(props: { source: GridSource; actions?: JSX.Element; class?: string }) {
  const src = () => props.source;
  const rowH = touch ? 32 : 26;
  const headH = rowH;
  const filterH = touch ? 36 : 30;

  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewW, setViewW] = createSignal(800);
  const [viewH, setViewH] = createSignal(400);

  // ---------------------------------------------------------------- query state
  const [sort, setSort] = createSignal<SortSpec | null>(null);
  const [colFilters, setColFilters] = createSignal<Record<number, string>>({});
  const [search, setSearch] = createSignal('');
  const filters = (): Filter[] => [
    ...Object.entries(colFilters()).map(([c, expr]) => ({ col: Number(c), expr })),
    ...(search().trim() ? [{ col: -1, expr: search() }] : []),
  ];
  const activeFilters = () => filters().filter((f) => f.expr.trim()).length;

  let queryTimer: number | undefined;
  function applyQuery(delay = 350) {
    clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => void src().setQuery(sort(), filters()), delay);
  }

  // ---------------------------------------------------------------- columns
  const [widths, setWidths] = createSignal<number[]>([]);
  let autosized = false;
  createEffect(
    on(
      () => src().columns(),
      (cols) => {
        autosized = false;
        setWidths(cols.map((c) => clampW(c.length * 8 + 34)));
      },
    ),
  );
  const clampW = (w: number) => Math.max(64, Math.min(320, Math.round(w)));
  const lefts = createMemo(() => {
    const out = [0];
    for (const w of widths()) out.push(out[out.length - 1] + w);
    return out;
  });
  const totalW = () => lefts()[lefts().length - 1] ?? 0;
  const rnW = createMemo(() => Math.max(44, String(src().totalRows()).length * 8 + 20));

  const visibleCols = createMemo(() => {
    const L = lefts();
    const x0 = scrollLeft();
    const x1 = x0 + viewW() - rnW();
    const out: number[] = [];
    for (let c = 0; c < L.length - 1; c++) if (L[c + 1] >= x0 && L[c] <= x1) out.push(c);
    return out;
  });

  // ---------------------------------------------------------------- rows (virtualized, block cache)
  const contentH = () => src().rowCount() * rowH;
  const scaled = () => contentH() > MAX_SCROLL_PX;
  const spacerH = () => (scaled() ? MAX_SCROLL_PX : contentH());
  const bodyH = () => Math.max(0, viewH() - headH - filterH);
  const visibleCount = () => Math.ceil(bodyH() / rowH) + 1;

  const firstRow = createMemo(() => {
    const n = src().rowCount();
    if (!scaled()) return Math.min(Math.floor(scrollTop() / rowH), Math.max(0, n - 1));
    const maxScroll = Math.max(1, spacerH() - bodyH());
    const frac = Math.min(1, scrollTop() / maxScroll);
    return Math.floor(frac * Math.max(0, n - visibleCount() + 1));
  });
  // Where the rendered rows sit inside the scroll content.
  const layerTop = () => (scaled() ? scrollTop() : firstRow() * rowH);

  const cache = new Map<number, GridRow[]>();
  const loading = new Set<number>();
  const [tick, setTick] = createSignal(0);

  createEffect(
    on(
      () => src().version(),
      () => {
        cache.clear();
        loading.clear();
        setTick((t) => t + 1);
      },
      { defer: true },
    ),
  );

  function ensureBlocks(first: number, last: number) {
    const v = src().version();
    for (let b = Math.floor(first / BLOCK); b <= Math.floor(last / BLOCK); b++) {
      if (cache.has(b) || loading.has(b)) continue;
      loading.add(b);
      src()
        .getRows(b * BLOCK, BLOCK)
        .then((rows) => {
          if (v !== src().version()) return;
          cache.set(b, rows);
          if (cache.size > MAX_BLOCKS) {
            // Evict the block farthest from the viewport.
            const mid = Math.floor(firstRow() / BLOCK);
            const far = [...cache.keys()].sort((x, y) => Math.abs(y - mid) - Math.abs(x - mid))[0];
            cache.delete(far);
          }
          if (!autosized && rows.length) autosize(rows);
          setTick((t) => t + 1);
        })
        .catch(() => {})
        .finally(() => loading.delete(b));
    }
  }

  function autosize(rows: GridRow[]) {
    autosized = true;
    const cols = src().columns();
    setWidths(
      cols.map((c, i) => {
        let max = c.length + 3;
        for (const r of rows.slice(0, 60)) max = Math.max(max, (r.cells[i] ?? '').length);
        return clampW(max * 7.6 + 22);
      }),
    );
  }

  const rows = createMemo(() => {
    tick();
    const n = src().rowCount();
    const first = firstRow();
    const last = Math.min(n - 1, first + visibleCount());
    if (last >= first) ensureBlocks(first, Math.min(n - 1, last + BLOCK / 2));
    const out: { i: number; row: GridRow | null }[] = [];
    for (let i = first; i <= last; i++) {
      const block = cache.get(Math.floor(i / BLOCK));
      out.push({ i, row: block?.[i % BLOCK] ?? null });
    }
    return out;
  });

  // ---------------------------------------------------------------- selection & keyboard
  const [sel, setSel] = createSignal<{ r: number; c: number } | null>(null);

  function cellText(r: number, c: number): string | null {
    const block = cache.get(Math.floor(r / BLOCK));
    return block?.[r % BLOCK]?.cells[c] ?? null;
  }

  function scrollToCell(r: number, c: number) {
    if (!scaled()) {
      const y = r * rowH;
      if (y < scrollTop()) scroller.scrollTop = y;
      else if (y + rowH > scrollTop() + bodyH()) scroller.scrollTop = y + rowH - bodyH();
    } else {
      const n = src().rowCount();
      if (r < firstRow() || r > firstRow() + visibleCount() - 2) {
        const maxScroll = Math.max(1, spacerH() - bodyH());
        scroller.scrollTop = (Math.max(0, r - 2) / Math.max(1, n - visibleCount() + 1)) * maxScroll;
      }
    }
    const L = lefts();
    const x0 = L[c];
    const x1 = L[c + 1];
    const w = viewW() - rnW();
    if (x0 < scrollLeft()) scroller.scrollLeft = x0;
    else if (x1 > scrollLeft() + w) scroller.scrollLeft = x1 - w;
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const s = sel();
    const n = src().rowCount();
    const nc = src().columns().length;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && s) {
      const t = cellText(s.r, s.c);
      if (t !== null) {
        void navigator.clipboard?.writeText(t).then(() => toast('Copied cell'));
        e.preventDefault();
      }
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageDown: [visibleCount() - 1, 0],
      PageUp: [-(visibleCount() - 1), 0],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    let target: { r: number; c: number } | null = null;
    if (e.key in moves) {
      const [dr, dc] = moves[e.key];
      const cur = s ?? { r: firstRow(), c: 0 };
      target = { r: Math.max(0, Math.min(n - 1, cur.r + dr)), c: Math.max(0, Math.min(nc - 1, cur.c + dc)) };
    } else if (e.key === 'Home' && (e.metaKey || e.ctrlKey)) target = { r: 0, c: 0 };
    else if (e.key === 'End' && (e.metaKey || e.ctrlKey)) target = { r: n - 1, c: s?.c ?? 0 };
    if (target) {
      e.preventDefault();
      setSel(target);
      scrollToCell(target.r, target.c);
    }
  }

  // ---------------------------------------------------------------- sorting & resizing
  function toggleSort(c: number) {
    const s = sort();
    setSort(!s || s.col !== c ? { col: c, dir: 1 } : s.dir === 1 ? { col: c, dir: -1 } : null);
    applyQuery(0);
  }

  function startResize(c: number, e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths()[c];
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidths((w) => w.map((x, i) => (i === c ? Math.max(48, startW + ev.clientX - startX) : x)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- layout
  onMount(() => {
    const ro = new ResizeObserver(() => {
      setViewW(scroller.clientWidth);
      setViewH(scroller.clientHeight);
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });
  onCleanup(() => clearTimeout(queryTimer));

  // Reset scroll + selection when the query changes.
  createEffect(
    on(
      () => src().version(),
      () => {
        if (scroller) scroller.scrollTop = 0;
        setSel(null);
      },
      { defer: true },
    ),
  );

  const status = () => {
    const parts = [`${fmtInt(src().rowCount())} row${src().rowCount() === 1 ? '' : 's'}`];
    if (activeFilters()) parts[0] += ` (filtered from ${fmtInt(src().totalRows())})`;
    parts.push(`${src().columns().length} columns`);
    return parts.join(' · ');
  };

  return (
    <div class={`data-grid ${props.class ?? ''}`}>
      <div class="pane-toolbar grid-toolbar">
        <div class="search-box">
          <Icon name="search" size={13} />
          <input
            type="search"
            placeholder="Search all columns"
            value={search()}
            onInput={(e) => {
              setSearch(e.currentTarget.value);
              applyQuery();
            }}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
          />
        </div>
        <Show when={activeFilters() || sort()}>
          <button
            class="tb-btn labeled"
            title="Clear sorting and filters"
            onClick={() => {
              setSort(null);
              setColFilters({});
              setSearch('');
              applyQuery(0);
            }}
          >
            <Icon name="close" />
            <span>Clear</span>
          </button>
        </Show>
        <span class="tb-spacer" />
        {props.actions}
      </div>

      <div
        class="grid-scroller"
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={() => {
          setScrollTop(scroller.scrollTop);
          setScrollLeft(scroller.scrollLeft);
        }}
        style={{ '--row-h': `${rowH}px`, '--rn-w': `${rnW()}px` }}
      >
        <div class="grid-content" style={{ width: `${totalW() + rnW()}px`, height: `${spacerH() + headH + filterH}px` }}>
          {/* sticky header + filter row */}
          <div class="grid-head" style={{ width: `${totalW() + rnW()}px` }}>
            <div class="grid-head-row" style={{ height: `${headH}px` }}>
              <div class="grid-corner" />
              <div class="grid-cells">
                <Index each={visibleCols()}>
                  {(c) => {
                    const s = () => sort();
                    return (
                      <div
                        class="grid-hcell"
                        classList={{ sorted: s()?.col === c(), num: src().numeric()[c()] }}
                        style={{ left: `${lefts()[c()]}px`, width: `${widths()[c()]}px` }}
                        onClick={() => toggleSort(c())}
                        title={`${src().columns()[c()]} — click to sort`}
                      >
                        <span class="grid-hlabel">{src().columns()[c()]}</span>
                        <Show when={s()?.col === c()}>
                          <span class="grid-sort">{s()!.dir === 1 ? '▲' : '▼'}</span>
                        </Show>
                        <span class="grid-resize" onPointerDown={(e) => startResize(c(), e)} onClick={(e) => e.stopPropagation()} />
                      </div>
                    );
                  }}
                </Index>
              </div>
            </div>
            <div class="grid-filter-row" style={{ height: `${filterH}px` }}>
              <div class="grid-corner">
                <Icon name="search" size={12} />
              </div>
              <div class="grid-cells">
                <Index each={visibleCols()}>
                  {(c) => (
                    <div class="grid-fcell" style={{ left: `${lefts()[c()]}px`, width: `${widths()[c()]}px` }}>
                      <input
                        type="text"
                        placeholder={src().numeric()[c()] ? '>5, 1..10' : 'filter'}
                        value={colFilters()[c()] ?? ''}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setColFilters((f) => ({ ...f, [c()]: v }));
                          applyQuery();
                        }}
                        autocapitalize="off"
                        autocorrect="off"
                        spellcheck={false}
                        title="Text: contains · =x !=x · >5 >=5 <5 <=5 · 1..10 · empty / !empty"
                      />
                    </div>
                  )}
                </Index>
              </div>
            </div>
          </div>

          {/* visible rows */}
          <div class="grid-rows" style={{ top: `${headH + filterH}px`, transform: `translateY(${layerTop()}px)` }}>
            <Index each={rows()}>
              {(r) => (
                <div class="grid-row" classList={{ odd: r().i % 2 === 1 }} style={{ width: `${totalW() + rnW()}px` }}>
                  <div class="grid-rn" classList={{ 'sel-row': sel()?.r === r().i }}>
                    {r().row ? fmtInt(r().row!.index + 1) : ''}
                  </div>
                  <div class="grid-cells">
                    <Index each={visibleCols()}>
                      {(c) => {
                        const v = () => r().row?.cells[c()];
                        return (
                          <div
                            class="grid-cell"
                            classList={{
                              num: src().numeric()[c()],
                              na: v() === 'NA' || v() === '',
                              selected: sel()?.r === r().i && sel()?.c === c(),
                              pending: !r().row,
                            }}
                            style={{ left: `${lefts()[c()]}px`, width: `${widths()[c()]}px` }}
                            title={v() && v()!.length > 20 ? v() : undefined}
                            onClick={() => setSel({ r: r().i, c: c() })}
                          >
                            {v() ?? ''}
                          </div>
                        );
                      }}
                    </Index>
                  </div>
                </div>
              )}
            </Index>
          </div>
        </div>
      </div>

      <div class="grid-status">
        <span>{status()}</span>
        <Show when={src().progress() < 1}>
          <span class="grid-progress">
            Indexing… {fmtInt(src().totalRows())} rows ({Math.round(src().progress() * 100)}%)
          </span>
        </Show>
        <Show when={src().busy() !== null}>
          <span class="grid-progress">
            {sort() ? 'Sorting' : 'Filtering'}… {Math.round((src().busy() ?? 0) * 100)}%
          </span>
        </Show>
        <Show when={src().error()}>
          <span class="grid-error">{src().error()}</span>
        </Show>
        <span class="tb-spacer" />
        <Show when={sel()}>
          <span class="muted">
            Row {fmtInt(sel()!.r + 1)}, {src().columns()[sel()!.c]}
          </span>
        </Show>
      </div>
    </div>
  );
}
