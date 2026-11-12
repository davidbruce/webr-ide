// Notebook UI for Quarto / R Markdown documents: run buttons on each ```{r}
// chunk, output rendered under the chunk (Monaco view zones) or in the
// Output tab of the side pane.

import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js';
import { render } from 'solid-js/web';
import { monaco } from '../lib/monaco';
import { ansiToHtml } from '../lib/ansi';
import {
  nb,
  runsFor,
  parseChunks,
  newRun,
  dropRun,
  forgetDoc,
  clearDoc,
  updateRun,
  runChunkCode,
  stopChunks,
  setActiveDoc,
  parseInline,
  newInline,
  dropInline,
  inlinesFor,
  runInlineCode,
  loadSaved,
  restoreRun,
  restoreInline,
  setChunkSource,
  type Chunk,
  type ChunkRun,
  type InlineExpr,
  type OutItem,
  type TableData,
} from '../lib/notebook';
import { state, setState } from '../lib/ide';
import { toast } from '../lib/ui';
import { Icon } from './Icon';

// ---------------------------------------------------------------- output view

/** Full-window view of a plot or an interactive widget. */
function openOverlay(item: Extract<OutItem, { kind: 'plot' | 'widget' }>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const close = () => {
    dispose();
    host.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const dispose = render(
    () => (
      <div class="nb-zoom" classList={{ widget: item.kind === 'widget' }} role="dialog" aria-label="Output" onClick={close}>
        {item.kind === 'plot' ? (
          <img src={item.url} alt="Plot" />
        ) : (
          <iframe class="nb-zoom-frame" sandbox={WIDGET_SANDBOX} srcdoc={item.html} title="Interactive output" onClick={(e) => e.stopPropagation()} />
        )}
        <button class="tb-btn nb-zoom-close" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
    ),
    host,
  );
}

const ICON_PLAY = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const ICON_ABOVE =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10M8 2.5v8M5 5.5l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const WIDGET_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
const PAGE_ROWS = 10;

function PagedTable(p: { table: TableData }) {
  const [page, setPage] = createSignal(0);
  const t = () => p.table;
  const shown = () => (t().cols[0]?.length ?? 0);
  const pages = () => Math.max(1, Math.ceil(shown() / PAGE_ROWS));
  const rows = () => {
    const from = page() * PAGE_ROWS;
    return Array.from({ length: Math.max(0, Math.min(PAGE_ROWS, shown() - from)) }, (_, i) => from + i);
  };
  const numeric = (type: string) => /^(dbl|int|num|double|integer|numeric|cpl|drtn|time|units)/.test(type);
  const fmt = (n: number) => n.toLocaleString();
  return (
    <div class="nb-table">
      <div class="nb-table-scroll">
        <table>
          <thead>
            <tr>
              <Show when={t().rownames.length}>
                <th class="rn" />
              </Show>
              <For each={t().names}>
                {(name, j) => (
                  <th classList={{ num: numeric(t().types[j()] ?? '') }}>
                    <div class="nb-col">{name}</div>
                    <div class="nb-type">&lt;{t().types[j()]}&gt;</div>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => (
                <tr>
                  <Show when={t().rownames.length}>
                    <th class="rn">{t().rownames[r]}</th>
                  </Show>
                  <For each={t().cols}>
                    {(col, j) => (
                      <td classList={{ num: numeric(t().types[j()] ?? ''), na: col[r] === 'NA' }}>{col[r]}</td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="nb-table-foot">
        <span>
          {shown() ? `${fmt(page() * PAGE_ROWS + 1)}–${fmt(page() * PAGE_ROWS + rows().length)} of ` : ''}
          {fmt(t().nrow)} row{t().nrow === 1 ? '' : 's'} · {fmt(t().ncol)} column{t().ncol === 1 ? '' : 's'}
          {t().nrow > shown() ? ` (first ${fmt(shown())} shown)` : ''}
        </span>
        <Show when={pages() > 1}>
          <span class="nb-pager">
            <button class="tb-btn tiny" disabled={page() === 0} aria-label="Previous page" onClick={() => setPage((x) => x - 1)}>
              <Icon name="left" size={14} />
            </button>
            <span>
              {page() + 1} / {pages()}
            </span>
            <button class="tb-btn tiny" disabled={page() >= pages() - 1} aria-label="Next page" onClick={() => setPage((x) => x + 1)}>
              <Icon name="right" size={14} />
            </button>
          </span>
        </Show>
      </div>
    </div>
  );
}

/**
 * An interactive widget in a sandboxed frame. Until tapped, a transparent
 * cover lets scrolling (wheel or swipe) move the editor instead of getting
 * caught by the widget; tapping elsewhere puts the cover back.
 */
function WidgetFrame(p: { item: Extract<OutItem, { kind: 'widget' }> }) {
  const [live, setLive] = createSignal(false);
  let box!: HTMLDivElement;
  const away = (e: PointerEvent) => {
    if (!box.contains(e.target as Node)) setLive(false);
  };
  document.addEventListener('pointerdown', away, true);
  onCleanup(() => document.removeEventListener('pointerdown', away, true));
  return (
    <div class="nb-widget" ref={box} onMouseLeave={() => setLive(false)}>
      <iframe sandbox={WIDGET_SANDBOX} srcdoc={p.item.html} style={{ height: `${p.item.height}px` }} title="Interactive output" loading="lazy" />
      <Show when={!live()}>
        <button class="nb-widget-cover" aria-label="Interact with this output" onClick={() => setLive(true)}>
          <span>Click to interact</span>
        </button>
      </Show>
      <button class="tb-btn tiny nb-widget-expand" title="Open full size" aria-label="Open full size" onClick={() => openOverlay(p.item)}>
        <Icon name="expand" size={13} />
      </button>
    </div>
  );
}

function OutItemView(p: { item: OutItem }) {
  const item = p.item;
  switch (item.kind) {
    case 'text':
      return <pre class={`nb-text nb-${item.stream}`} innerHTML={ansiToHtml(item.text)} />;
    case 'plot':
      return (
        <img
          class="nb-plot"
          src={item.url}
          alt="Plot"
          style={{ 'max-width': `min(100%, ${item.width}px)` }}
          title="Tap to enlarge"
          onClick={() => openOverlay(item)}
        />
      );
    case 'table':
      return <PagedTable table={item.table} />;
    case 'widget':
      return <WidgetFrame item={item} />;
  }
}

const formatMs = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

export function ChunkOutput(p: { run: ChunkRun; inPane?: boolean; onJump?: () => void }) {
  return (
    <div
      class="nb-out"
      classList={{ stale: p.run.status === 'running' || p.run.status === 'queued', error: p.run.status === 'error', 'in-pane': p.inPane }}
    >
      <div class="nb-out-head">
        <Show when={p.inPane}>
          <button class="nb-out-title" title="Show this chunk in the editor" onClick={() => p.onJump?.()}>
            <Icon name="r" size={13} class="r-icon" />
            <span>{p.run.label || `Chunk at line ${p.run.line}`}</span>
          </button>
        </Show>
        <span class="nb-out-status">
          <Switch>
            <Match when={p.run.status === 'running'}>
              <span class="spinner small" aria-hidden="true" /> Running…
            </Match>
            <Match when={p.run.status === 'queued'}>Queued</Match>
            <Match when={p.run.status === 'error'}>
              <span class="nb-bad">✕</span> {formatMs(p.run.ms)}
            </Match>
            <Match when={p.run.seq > 0}>
              <span class="nb-ok">✓</span> {formatMs(p.run.ms)}
            </Match>
          </Switch>
        </span>
        <Show
          when={p.run.status === 'running' || p.run.status === 'queued'}
          fallback={
            <button class="tb-btn tiny" title="Clear output" aria-label="Clear output" onClick={() => dropRun(p.run.id)}>
              <Icon name="close" size={12} />
            </button>
          }
        >
          <button class="tb-btn tiny" title="Stop" aria-label="Stop" onClick={stopChunks}>
            <Icon name="stop" size={12} />
          </button>
        </Show>
      </div>
      <For each={p.run.items}>{(item) => <OutItemView item={item} />}</For>
      <Show when={p.run.seq > 0 && !p.run.items.length && p.run.status === 'done'}>
        <div class="nb-empty">No output</div>
      </Show>
    </div>
  );
}

/**
 * Monaco's touch handling swallows the click a tap would produce inside view
 * zones; turn short, still taps on buttons and plots back into clicks.
 */
function tapToClick(el: HTMLElement) {
  let start: { x: number; y: number; t: number } | null = null;
  el.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      start = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
    },
    { passive: true },
  );
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const s = start;
    start = null;
    if (!s || !t || Date.now() - s.t > 600 || Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10) return;
    const target = (e.target as Element).closest?.('button, img, a, summary');
    if (!target || !el.contains(target)) return;
    e.preventDefault();
    (target as HTMLElement).click();
  });
}

// ---------------------------------------------------------------- editor integration

export interface NotebookControls {
  runAtCursor(): void;
  /** Evaluate inline `r` code on the cursor line; false if there is none. */
  runInlineAtCursor(): boolean;
  runAll(): void;
  runAbove(): void;
  clear(): void;
  insertChunk(): void;
}

let active: {
  ed: monaco.editor.IStandaloneCodeEditor;
  runChunkAt(line: number): void;
  runAbove(line: number): void;
  jump(id: string): void;
} | null = null;

const [paneWidth, setPaneWidth] = createSignal(0);

/** Scroll the editor to a run's chunk (from the Output pane). */
export function jumpToRun(id: string) {
  active?.jump(id);
}

/**
 * Wire notebook behaviour into the editor. Must be called inside a Solid
 * owner (it creates effects). `isNotebook` says whether a model is a
 * Quarto / R Markdown document.
 */
export function attachNotebook(ed: monaco.editor.IStandaloneCodeEditor): NotebookControls {
  const runDeco = new Map<string, string>(); // run id → model decoration id
  const inlineDeco = new Map<string, string>(); // inline value id → decoration over `r ...`
  const hintsChanged = new monaco.Emitter<void>();
  const chunkShade = ed.createDecorationsCollection();
  interface Zone {
    zoneId: string;
    zone: monaco.editor.IViewZone;
    inner: HTMLDivElement;
    dispose: () => void;
    ro: ResizeObserver;
  }
  const zones = new Map<string, Zone>();
  let chunks: Chunk[] = [];

  const model = () => {
    const m = ed.getModel();
    return m && m.getLanguageId() === 'quarto' ? m : null;
  };
  const docOf = (m: monaco.editor.ITextModel) => m.uri.toString();

  const contentWidth = () => {
    const l = ed.getLayoutInfo();
    return Math.max(200, l.contentWidth - l.verticalScrollbarWidth - 28);
  };

  function plotSize() {
    const w = nb.mode === 'pane' && paneWidth() > 0 ? paneWidth() - 24 : contentWidth();
    const width = Math.max(280, Math.min(w, 760));
    const height = Math.round(Math.min(width * 0.62, 460));
    return { width, height, chars: Math.max(40, Math.floor(Math.max(280, w) / 7.9)) };
  }

  function chunkFor(id: string, m: monaco.editor.ITextModel): Chunk | null {
    const d = runDeco.get(id);
    const r = d ? m.getDecorationRange(d) : null;
    if (!r) return null;
    return chunks.find((c) => c.start <= r.endLineNumber && c.end >= r.startLineNumber) ?? null;
  }

  function track(id: string, m: monaco.editor.ITextModel, c: Chunk) {
    const old = runDeco.get(id);
    const [deco] = m.deltaDecorations(old ? [old] : [], [
      {
        range: new monaco.Range(c.start, 1, c.end, 1),
        options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      },
    ]);
    runDeco.set(id, deco);
  }

  /** Re-parse chunks, keep run decorations aligned to them, drop orphaned output. */
  function refresh() {
    const m = model();
    if (!m) {
      chunks = [];
      chunkShade.clear();
      syncBars();
      syncZones();
      return;
    }
    chunks = parseChunks(m.getLinesContent());
    syncBars();
    chunkShade.set(
      chunks.map((c) => ({
        range: new monaco.Range(c.start, 1, c.end, 1),
        options: { isWholeLine: true, className: 'nb-chunk-line' },
      })),
    );
    // Drop inline values whose expression was edited or removed.
    for (const v of inlinesFor(docOf(m))) {
      const d = inlineDeco.get(v.id);
      const r = d ? m.getDecorationRange(d) : null;
      const text = r ? m.getValueInRange(r) : '';
      const code = /^`r[ \t]+([^`]+)`$/.exec(text)?.[1].trim();
      if (code !== v.code && v.status !== 'queued') dropInline(v.id);
    }
    for (const run of runsFor(docOf(m))) {
      const c = chunkFor(run.id, m);
      if (!c) {
        if (run.status !== 'running') dropRun(run.id);
        continue;
      }
      const r = m.getDecorationRange(runDeco.get(run.id)!)!;
      if (r.startLineNumber !== c.start || r.endLineNumber !== c.end) track(run.id, m, c);
      if (run.line !== c.start || run.label !== c.label) updateRun(run.id, { line: c.start, label: c.label });
    }
    syncZones();
  }

  // Run buttons at the right end of each chunk's ```{r} line (like RStudio).
  interface Bar {
    line: number;
    node: HTMLDivElement;
    widget: monaco.editor.IContentWidget;
  }
  const bars: Bar[] = [];
  let barSeq = 0;
  function makeBar(line: number): Bar {
    const node = document.createElement('div');
    node.className = 'nb-bar';
    const group = document.createElement('div');
    group.className = 'nb-bar-group';
    node.appendChild(group);
    const id = `webr-ide.nb-bar.${++barSeq}`;
    const bar: Bar = {
      line,
      node,
      widget: {
        getId: () => id,
        getDomNode: () => node,
        getPosition: () => ({ position: { lineNumber: bar.line, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }),
      },
    };
    const button = (label: string, title: string, icon: 'play' | 'run-all', onRun: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `nb-bar-btn ${icon}`;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = label;
      for (const t of ['mousedown', 'pointerdown', 'touchstart'] as const) b.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onRun();
      });
      group.appendChild(b);
    };
    button(ICON_ABOVE, 'Run all chunks above', 'run-all', () => active?.runAbove(bar.line));
    button(ICON_PLAY, 'Run chunk', 'play', () => active?.runChunkAt(bar.line));
    ed.addContentWidget(bar.widget);
    return bar;
  }
  function syncBars() {
    const width = `${contentWidth()}px`;
    while (bars.length > chunks.length) ed.removeContentWidget(bars.pop()!.widget);
    chunks.forEach((c, i) => {
      const b = bars[i] ?? (bars[i] = makeBar(c.start));
      b.node.style.setProperty('--nb-bar-right', width);
      if (b.line !== c.start) {
        b.line = c.start;
        ed.layoutContentWidget(b.widget);
      }
    });
  }

  function makeZone(id: string, line: number, acc: monaco.editor.IViewZoneChangeAccessor): Zone {
    const node = document.createElement('div');
    node.className = 'nb-zone';
    const inner = document.createElement('div');
    inner.className = 'nb-zone-inner';
    inner.style.width = `${contentWidth()}px`;
    node.appendChild(inner);
    // Keep clicks/selection inside the output away from the editor.
    for (const t of ['mousedown', 'dblclick', 'contextmenu'] as const) inner.addEventListener(t, (e) => e.stopPropagation());
    inner.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') e.stopPropagation();
    });
    tapToClick(inner);
    // Let long text output scroll on its own before the editor scrolls.
    inner.addEventListener(
      'wheel',
      (e) => {
        const pre = (e.target as HTMLElement).closest?.('.nb-text') as HTMLElement | null;
        if (!pre) return;
        const canY = pre.scrollHeight > pre.clientHeight && (e.deltaY < 0 ? pre.scrollTop > 0 : pre.scrollTop + pre.clientHeight < pre.scrollHeight - 1);
        const canX = pre.scrollWidth > pre.clientWidth && Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (canY || canX) e.stopPropagation();
      },
      { passive: true },
    );
    const dispose = render(() => <Show when={nb.runs[id]}>{(run) => <ChunkOutput run={run()} />}</Show>, inner);
    const zone: monaco.editor.IViewZone = { afterLineNumber: line, heightInPx: 36, domNode: node };
    const zoneId = acc.addZone(zone);
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(inner.offsetHeight) + 10;
      if (h !== zone.heightInPx && zones.get(id)?.zoneId === zoneId) {
        zone.heightInPx = h;
        ed.changeViewZones((a) => a.layoutZone(zoneId));
      }
    });
    ro.observe(inner);
    return { zoneId, zone, inner, dispose, ro };
  }

  function removeZone(id: string, acc?: monaco.editor.IViewZoneChangeAccessor) {
    const z = zones.get(id);
    if (!z) return;
    zones.delete(id);
    z.ro.disconnect();
    z.dispose();
    acc?.removeZone(z.zoneId);
  }

  function syncZones() {
    const m = model();
    const want = new Map<string, number>();
    if (m && nb.mode === 'inline') {
      for (const run of runsFor(docOf(m))) {
        if (run.seq === 0 && run.status !== 'queued' && run.status !== 'running') continue;
        const d = runDeco.get(run.id);
        const r = d ? m.getDecorationRange(d) : null;
        if (r) want.set(run.id, r.endLineNumber);
      }
    }
    ed.changeViewZones((acc) => {
      for (const id of [...zones.keys()]) if (!want.has(id)) removeZone(id, acc);
      for (const [id, line] of want) {
        const z = zones.get(id);
        if (!z) zones.set(id, makeZone(id, line, acc));
        else if (z.zone.afterLineNumber !== line) {
          z.zone.afterLineNumber = line;
          acc.layoutZone(z.zoneId);
        }
      }
    });
  }

  function trackInline(id: string, m: monaco.editor.ITextModel, x: InlineExpr) {
    const old = inlineDeco.get(id);
    const [deco] = m.deltaDecorations(old ? [old] : [], [
      {
        range: new monaco.Range(x.line, x.startCol, x.line, x.endCol),
        options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      },
    ]);
    inlineDeco.set(id, deco);
  }

  function runInline(x: InlineExpr) {
    const m = model();
    if (!m || state.rStatus !== 'ready') return;
    const doc = docOf(m);
    let id = inlinesFor(doc).find((v) => {
      const r = inlineDeco.has(v.id) ? m.getDecorationRange(inlineDeco.get(v.id)!) : null;
      return r && r.startLineNumber === x.line && r.startColumn === x.startCol;
    })?.id;
    if (!id) id = newInline(doc, x.code);
    trackInline(id, m, x);
    void runInlineCode(id, x.code);
  }

  /** Chunks and inline expressions in document order. */
  function runInOrder(filter: (line: number) => boolean) {
    const m = model();
    if (!m) return;
    const inl = parseInline(m.getLinesContent());
    const work = [
      ...chunks.filter((c) => filter(c.end)).map((c) => ({ line: c.start, run: () => runChunk(c) })),
      ...inl.filter((x) => filter(x.line)).map((x) => ({ line: x.line, run: () => runInline(x) })),
    ].sort((a, b) => a.line - b.line);
    for (const w of work) w.run();
  }

  /** Bring back saved output the first time a document is shown. */
  async function restore(m: monaco.editor.ITextModel) {
    const doc = docOf(m);
    const saved = await loadSaved(doc);
    if (!saved || m.isDisposed()) return;
    const cs = parseChunks(m.getLinesContent());
    const taken = new Set(runsFor(doc).map((r) => r.line));
    const used = new Set<Chunk>();
    for (const s of saved.chunks) {
      const c =
        (s.label && cs.find((c) => c.label === s.label)) ||
        cs.find((c) => !used.has(c) && c.code === s.code) ||
        (saved.chunkCount === cs.length && s.index >= 0 ? cs[s.index] : undefined);
      if (!c || used.has(c) || taken.has(c.start)) continue;
      used.add(c);
      const id = restoreRun(doc, c, s);
      track(id, m, c);
    }
    const xs = parseInline(m.getLinesContent());
    const usedX = new Set<InlineExpr>();
    for (const s of saved.inline) {
      const x = xs.find((x) => !usedX.has(x) && x.code === s.code);
      if (!x) continue;
      usedX.add(x);
      trackInline(restoreInline(doc, s), m, x);
    }
    if (ed.getModel() === m) refresh();
    hintsChanged.fire();
  }

  function runChunk(c: Chunk) {
    const m = model();
    if (!m) return;
    if (state.rStatus !== 'ready') {
      toast('R is still starting…', 'warn');
      return;
    }
    const doc = docOf(m);
    let id = runsFor(doc).find((r) => chunkFor(r.id, m) === c)?.id;
    if (!id) id = newRun(doc, c);
    track(id, m, c);
    updateRun(id, { line: c.start, label: c.label });
    void runChunkCode(id, c.code, plotSize());
    if (nb.mode === 'pane' && state.plotTab !== 'output') setState('plotTab', 'output');
  }

  const chunkAt = (line: number) => chunks.find((c) => c.start <= line && c.end >= line) ?? null;

  active = {
    ed,
    runChunkAt(line) {
      refresh();
      const c = chunkAt(line);
      if (c) runChunk(c);
    },
    runAbove(line) {
      refresh();
      runInOrder((l) => l < line);
    },
    jump(id) {
      const m = model();
      const c = m && chunkFor(id, m);
      if (!c) return;
      ed.revealLineNearTop(c.start, monaco.editor.ScrollType.Smooth);
      ed.setPosition({ lineNumber: Math.min(c.start + 1, c.end), column: 1 });
      ed.focus();
    },
  };

  let timer: number | undefined;
  const subs = [
    ed.onDidChangeModelContent(() => {
      clearTimeout(timer);
      timer = window.setTimeout(refresh, 120);
    }),
    ed.onDidChangeModel(() => {
      // The editor drops view zones when its model changes.
      for (const id of [...zones.keys()]) removeZone(id);
      const m = model();
      setActiveDoc(m ? docOf(m) : null);
      refresh();
      if (m) void restore(m);
    }),
    ed.onDidLayoutChange(() => {
      const w = `${contentWidth()}px`;
      for (const z of zones.values()) z.inner.style.width = w;
      for (const b of bars) b.node.style.setProperty('--nb-bar-right', w);
    }),
    monaco.editor.onWillDisposeModel((m) => {
      if (m.getLanguageId() !== 'quarto') return;
      for (const r of runsFor(docOf(m))) runDeco.delete(r.id);
      for (const v of inlinesFor(docOf(m))) inlineDeco.delete(v.id);
      forgetDoc(docOf(m));
    }),
    // Inline `r` values shown after the expression.
    monaco.languages.registerInlayHintsProvider('quarto', {
      onDidChangeInlayHints: hintsChanged.event,
      provideInlayHints(m) {
        const hints: monaco.languages.InlayHint[] = [];
        for (const v of inlinesFor(docOf(m))) {
          const d = inlineDeco.get(v.id);
          const r = d ? m.getDecorationRange(d) : null;
          if (!r) continue;
          const text = v.status === 'queued' ? '…' : v.text.length > 80 ? v.text.slice(0, 79) + '…' : v.text;
          hints.push({
            position: { lineNumber: r.endLineNumber, column: r.endColumn },
            label: v.status === 'error' ? ` ⚠ ${text}` : ` = ${text}`,
            paddingLeft: false,
            tooltip: v.status === 'error' ? `Error: ${v.text}` : v.text,
          });
        }
        return { hints, dispose() {} };
      },
    }),
  ];
  setChunkSource((doc) => {
    const m = monaco.editor.getModel(monaco.Uri.parse(doc));
    return m && !m.isDisposed() ? parseChunks(m.getLinesContent()) : null;
  });

  createEffect(() => {
    for (const v of Object.values(nb.inlines)) void [v.status, v.text];
    hintsChanged.fire();
  });

  // Show/hide zones when runs start, finish, are cleared, or the mode changes.
  createEffect(() => {
    void nb.mode;
    for (const r of Object.values(nb.runs)) void [r.status, r.seq];
    syncZones();
  });

  onCleanup(() => {
    clearTimeout(timer);
    for (const s of subs) s.dispose();
    for (const id of [...zones.keys()]) removeZone(id);
    while (bars.length) ed.removeContentWidget(bars.pop()!.widget);
    if (active?.ed === ed) active = null;
  });

  const cursorLine = () => ed.getPosition()?.lineNumber ?? 1;
  return {
    runAtCursor() {
      refresh();
      const c = chunkAt(cursorLine());
      if (c) runChunk(c);
      else toast('Put the cursor inside an R chunk to run it', 'warn');
    },
    runInlineAtCursor() {
      const m = model();
      const pos = ed.getPosition();
      if (!m || !pos) return false;
      const xs = parseInline(m.getLinesContent()).filter((x) => x.line === pos.lineNumber);
      if (!xs.length) return false;
      const at = xs.filter((x) => x.startCol <= pos.column && x.endCol >= pos.column);
      for (const x of at.length ? at : xs) runInline(x);
      return true;
    },
    runAll() {
      refresh();
      if (!chunks.length) toast('This document has no R chunks', 'warn');
      runInOrder(() => true);
    },
    runAbove() {
      active?.runAbove(chunkAt(cursorLine())?.start ?? cursorLine());
    },
    clear() {
      const m = model();
      if (m) clearDoc(docOf(m));
    },
    insertChunk() {
      const sel = ed.getSelection();
      if (!sel || !model()) return;
      const line = sel.startLineNumber;
      const text = ed.getModel()!.getLineContent(line);
      const prefix = text.trim() ? '\n' : '';
      ed.executeEdits('insert-chunk', [
        { range: new monaco.Range(line, text.length + 1, line, text.length + 1), text: `${prefix}\`\`\`{r}\n\n\`\`\``, forceMoveMarkers: true },
      ]);
      const at = line + (prefix ? 2 : 1);
      ed.setPosition({ lineNumber: at, column: 1 });
      ed.focus();
    },
  };
}

// ---------------------------------------------------------------- Output pane

export function OutputPane() {
  let body!: HTMLDivElement;
  const runs = () => nb.mode !== 'pane' ? [] : runsFor(nb.activeDoc).filter((r) => r.seq > 0 || r.status === 'queued' || r.status === 'running');
  const ro = new ResizeObserver(() => setPaneWidth(body?.clientWidth ?? 0));
  createEffect(() => {
    // Bring the chunk that just started into view.
    const id = nb.latest;
    if (!id) return;
    void nb.runs[id]?.seq;
    queueMicrotask(() => body?.querySelector(`[data-run="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });
  onCleanup(() => ro.disconnect());
  return (
    <div
      class="pane-body nb-pane"
      ref={(el) => {
        body = el;
        ro.observe(el);
      }}
    >
      <Show
        when={nb.activeDoc}
        fallback={
          <div class="empty-state">
            <Icon name="book" size={32} />
            <p>Open a Quarto (.qmd) or R Markdown (.Rmd) document to run its chunks.</p>
          </div>
        }
      >
        <Show
          when={runs().length}
          fallback={
            <div class="empty-state">
              <Icon name="play" size={32} />
              <p>{nb.mode === 'pane' ? 'Run a chunk to see its output here.' : 'Chunk output is shown inline under each chunk.'}</p>
            </div>
          }
        >
          <For each={runs()}>
            {(run) => (
              <div data-run={run.id}>
                <ChunkOutput run={run} inPane onJump={() => jumpToRun(run.id)} />
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
