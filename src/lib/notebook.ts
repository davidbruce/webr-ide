// Notebook-style chunk execution for Quarto (.qmd) and R Markdown (.Rmd)
// documents: each ```{r} chunk can be run on its own, with its output shown
// under the chunk (inline) or in the Output tab (pane). Inline `r` expressions
// can be evaluated too. Output is saved per document under .ide/outputs/ in
// the workspace, so it survives reloads.

import { createStore, produce } from 'solid-js/store';
import { session } from './ide';
import { toast } from './ui';
import * as fs from './opfs';
import { parseManifest, widgetPage } from './html-page';

export interface TableData {
  nrow: number;
  ncol: number;
  names: string[];
  types: string[];
  rownames: string[];
  /** Formatted cells, column by column (at most the first 1000 rows). */
  cols: string[][];
}

export type OutItem =
  | { kind: 'text'; stream: 'stdout' | 'message' | 'warning' | 'error'; text: string }
  | { kind: 'plot'; url: string; width: number; height: number }
  | { kind: 'table'; table: TableData }
  | { kind: 'widget'; html: string; height: number };

export interface ChunkRun {
  id: string;
  /** Monaco model URI of the document. */
  doc: string;
  /** Chunk label (from `{r label}` or `#| label:`), or '' */
  label: string;
  /** First line of the chunk (```{r}), kept current as the document is edited. */
  line: number;
  /** The code as last run (used to re-attach saved output). */
  code: string;
  status: 'queued' | 'running' | 'done' | 'error';
  items: OutItem[];
  ms: number;
  /** Bumped on every run, so views can scroll to fresh output. */
  seq: number;
}

export interface InlineValue {
  id: string;
  doc: string;
  code: string;
  status: 'queued' | 'done' | 'error';
  text: string;
}

export type OutputMode = 'inline' | 'pane';

const LS_MODE = 'webr-ide:chunk-output';
function loadMode(): OutputMode {
  try {
    return localStorage.getItem(LS_MODE) === 'pane' ? 'pane' : 'inline';
  } catch {
    return 'inline';
  }
}

const [nb, setNb] = createStore({
  mode: loadMode(),
  runs: {} as Record<string, ChunkRun>,
  inlines: {} as Record<string, InlineValue>,
  /** Notebook document shown in the editor (model URI), if any. */
  activeDoc: null as string | null,
  /** Run most recently started, for the pane to scroll to. */
  latest: null as string | null,
});
export { nb };

export function setOutputMode(mode: OutputMode) {
  setNb('mode', mode);
  try {
    localStorage.setItem(LS_MODE, mode);
  } catch {
    /* ignore */
  }
}

export function setActiveDoc(doc: string | null) {
  if (nb.activeDoc !== doc) setNb('activeDoc', doc);
}

export const isNotebookName = (name: string) => /\.(qmd|rmd)$/i.test(name);

export const runsFor = (doc: string | null) =>
  doc ? Object.values(nb.runs).filter((r) => r.doc === doc).sort((a, b) => a.line - b.line) : [];
export const inlinesFor = (doc: string | null) => (doc ? Object.values(nb.inlines).filter((r) => r.doc === doc) : []);

// ---------------------------------------------------------------- chunks

export interface Chunk {
  /** 1-based line of the opening fence. */
  start: number;
  /** 1-based line of the closing fence (or the last line if unclosed). */
  end: number;
  label: string;
  code: string;
}

const OPEN = /^(\s*)(`{3,})\s*\{\s*r\b([^}]*)\}\s*$/i;

/** Find the executable R chunks in a Quarto / R Markdown document. */
export function parseChunks(lines: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    if (!m) {
      // Skip over other fenced blocks so their contents aren't misread.
      const other = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
      if (other) {
        const fence = other[1];
        for (i++; i < lines.length; i++) if (lines[i].trim().startsWith(fence) && lines[i].trim().replace(/[`~]/g, '') === '') break;
      }
      continue;
    }
    const fence = m[2];
    let j = i + 1;
    while (j < lines.length && !(lines[j].trim().startsWith(fence) && /^\s*`+\s*$/.test(lines[j]))) j++;
    const body = lines.slice(i + 1, j);
    let label = m[3].replace(/^[\s,]+/, '').split(/[\s,]/)[0] ?? '';
    if (label.includes('=')) label = '';
    const opt = body.map((l) => /^\s*#\|\s*label:\s*["']?([^"'\s]+)/.exec(l)).find(Boolean);
    if (opt) label = opt[1];
    chunks.push({ start: i + 1, end: Math.min(j + 1, lines.length), label, code: body.join('\n') });
    i = j;
  }
  return chunks;
}


export interface InlineExpr {
  line: number;
  /** 1-based columns of the whole `r ...` span (end exclusive). */
  startCol: number;
  endCol: number;
  code: string;
}

/** Inline `r expr` code in the prose (outside chunks, code blocks and YAML). */
export function parseInline(lines: string[]): InlineExpr[] {
  const out: InlineExpr[] = [];
  let fence: string | null = null;
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    for (i = 1; i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i]); i++);
    i++;
  }
  for (; i < lines.length; i++) {
    const t = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(t);
    if (fence) {
      if (f && t.trim().startsWith(fence) && t.trim().replace(/[`~]/g, '') === '') fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    for (const m of t.matchAll(/`r[ \t]+([^`]+)`/g)) {
      out.push({ line: i + 1, startCol: m.index! + 1, endCol: m.index! + m[0].length + 1, code: m[1].trim() });
    }
  }
  return out;
}

// ---------------------------------------------------------------- running

let seq = 0;

export function newRun(doc: string, chunk: Chunk): string {
  const id = `run${++seq}`;
  setNb('runs', id, { id, doc, label: chunk.label, line: chunk.start, code: chunk.code, status: 'done', items: [], ms: 0, seq: 0 });
  return id;
}

export function newInline(doc: string, code: string): string {
  const id = `inl${++seq}`;
  setNb('inlines', id, { id, doc, code, status: 'done', text: '' });
  return id;
}

export function dropRun(id: string, save = true) {
  const r = nb.runs[id];
  if (!r) return;
  if (r.status === 'queued') cancelled.add(id);
  setNb('runs', produce((runs) => void delete runs[id]));
  if (save) scheduleSave(r.doc);
}

export function dropInline(id: string, save = true) {
  const v = nb.inlines[id];
  if (!v) return;
  cancelled.add(id);
  setNb('inlines', produce((all) => void delete all[id]));
  if (save) scheduleSave(v.doc);
}

/** Forget a document's output in memory (e.g. its tab closed); saved output stays. */
export function forgetDoc(doc: string) {
  for (const r of Object.values(nb.runs)) if (r.doc === doc) dropRun(r.id, false);
  for (const v of Object.values(nb.inlines)) if (v.doc === doc) dropInline(v.id, false);
  loaded.delete(doc);
  docPaths.delete(doc);
}

/** Clear a document's output, including what was saved. */
export function clearDoc(doc: string) {
  for (const r of Object.values(nb.runs)) if (r.doc === doc) dropRun(r.id, false);
  for (const v of Object.values(nb.inlines)) if (v.doc === doc) dropInline(v.id, false);
  scheduleSave(doc);
}

export function updateRun(id: string, patch: Partial<ChunkRun>) {
  if (nb.runs[id]) setNb('runs', id, patch);
}

const cancelled = new Set<string>();

/** Cancel queued work and interrupt the running chunk. */
export function stopChunks() {
  let running = false;
  for (const r of Object.values(nb.runs)) {
    if (r.status === 'queued') {
      cancelled.add(r.id);
      setNb('runs', r.id, 'status', r.items.some((i) => i.kind === 'text' && i.stream === 'error') ? 'error' : 'done');
    } else if (r.status === 'running') running = true;
  }
  for (const v of Object.values(nb.inlines)) {
    if (v.status === 'queued') {
      cancelled.add(v.id);
      setNb('inlines', v.id, 'status', v.text ? 'done' : 'error');
    }
  }
  if (running) session.interrupt();
}

export const anyRunning = () =>
  Object.values(nb.runs).some((r) => r.status === 'running' || r.status === 'queued') ||
  Object.values(nb.inlines).some((v) => v.status === 'queued');

function toPlot(bmp: ImageBitmap): OutItem {
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { kind: 'plot', url: c.toDataURL('image/png'), width: c.width / 2, height: c.height / 2 };
}

function parseTable(text: string): TableData {
  const [dims, names, types, rownames, ...cols] = text.split('\x1e');
  const [nrow, ncol] = dims.split('\x1f').map(Number);
  const split = (s: string | undefined) => (s ? s.split('\x1f') : []);
  const shown = Math.min(nrow, 1000);
  return {
    nrow,
    ncol,
    names: split(names),
    types: split(types),
    rownames: split(rownames),
    cols: cols.map((c) => (shown ? c.split('\x1f') : [])),
  };
}

async function toItems(res: Awaited<ReturnType<typeof session.runChunk>>): Promise<OutItem[]> {
  const items: OutItem[] = [];
  for (const it of res.items) {
    if (it.type === 'plot') {
      const bmp = res.images[Number(it.text) - 1];
      if (bmp) items.push(toPlot(bmp));
    } else if (it.type === 'table') {
      items.push({ kind: 'table', table: parseTable(it.text) });
    } else if (it.type === 'widget') {
      const m = parseManifest(it.text);
      items.push({ kind: 'widget', html: await widgetPage(m), height: m.height ?? 420 });
    } else if (it.text !== '' || it.type !== 'stdout') {
      // Merge consecutive output of the same kind (e.g. a run of messages).
      const last = items[items.length - 1];
      if (last?.kind === 'text' && last.stream === it.type) last.text += '\n' + it.text;
      else items.push({ kind: 'text', stream: it.type, text: it.text });
    }
  }
  // Plots that weren't announced by a page hook (unusual devices) go last.
  const used = new Set(res.items.filter((i) => i.type === 'plot').map((i) => Number(i.text) - 1));
  for (let i = 0; i < res.images.length; i++) if (!used.has(i)) items.push(toPlot(res.images[i]));
  return items;
}

let tail: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): Promise<void> {
  const p = tail.then(job);
  tail = p.catch(() => {});
  return p;
}

/** Queue a chunk's code; its output replaces the run's previous output when done. */
export function runChunkCode(id: string, code: string, size: { width: number; height: number; chars: number }): Promise<void> {
  if (session.status !== 'ready') {
    toast('R is still starting…', 'warn');
    return Promise.resolve();
  }
  cancelled.delete(id);
  setNb('runs', id, 'status', 'queued');
  return enqueue(async () => {
    if (cancelled.has(id) || !nb.runs[id]) return;
    setNb('runs', id, { status: 'running', code });
    setNb('latest', id);
    const t0 = performance.now();
    let items: OutItem[];
    try {
      items = await toItems(await session.runChunk(code, size));
    } catch (e) {
      items = [{ kind: 'text', stream: 'error', text: String((e as Error)?.message ?? e) }];
    }
    const old = nb.runs[id];
    if (!old) return;
    const failed = items.some((i) => i.kind === 'text' && i.stream === 'error');
    setNb('runs', id, { items, status: failed ? 'error' : 'done', ms: performance.now() - t0, seq: old.seq + 1 });
    scheduleSave(old.doc);
  });
}

/** Queue an inline `r` expression. */
export function runInlineCode(id: string, code: string): Promise<void> {
  if (session.status !== 'ready') return Promise.resolve();
  cancelled.delete(id);
  setNb('inlines', id, { status: 'queued', code });
  return enqueue(async () => {
    if (cancelled.has(id) || !nb.inlines[id]) return;
    let r: { ok: boolean; text: string };
    try {
      r = await session.inlineValue(code);
    } catch (e) {
      r = { ok: false, text: String((e as Error)?.message ?? e) };
    }
    const v = nb.inlines[id];
    if (!v) return;
    setNb('inlines', id, { status: r.ok ? 'done' : 'error', text: r.text });
    scheduleSave(v.doc);
  });
}

// ---------------------------------------------------------------- saved output

/** Saved output of one document, matched back to its chunks when reopened. */
export interface SavedOutput {
  version: 1;
  chunkCount: number;
  chunks: { index: number; label: string; code: string; status: 'done' | 'error'; ms: number; items: OutItem[] }[];
  inline: { code: string; ok: boolean; text: string }[];
}

const SAVE_MAX = 25 * 1024 * 1024;
const docPaths = new Map<string, { ws: string; path: string }>();
const loaded = new Set<string>();
const saveTimers = new Map<string, number>();
/** Supplies the current chunk list of a document (set by the editor integration). */
let chunkSource: ((doc: string) => Chunk[] | null) | null = null;
export function setChunkSource(fn: (doc: string) => Chunk[] | null) {
  chunkSource = fn;
}

export const outputsPath = (path: string) => `${fs.IDE_DIR}/outputs/${encodeURIComponent(path)}.json`;

/** Tell the notebook where a document is saved (null for untitled). */
export function setDocPath(doc: string, ws: string, path: string | null) {
  const before = docPaths.get(doc);
  if (!path) {
    docPaths.delete(doc);
    return;
  }
  docPaths.set(doc, { ws, path });
  // Saved-as or renamed: keep its output with it.
  if (before && before.path !== path) scheduleSave(doc);
  else if (!before && (runsFor(doc).length || inlinesFor(doc).length)) scheduleSave(doc);
}

function scheduleSave(doc: string) {
  clearTimeout(saveTimers.get(doc));
  saveTimers.set(
    doc,
    window.setTimeout(() => {
      saveTimers.delete(doc);
      void saveDoc(doc);
    }, 600),
  );
}

async function saveDoc(doc: string) {
  const where = docPaths.get(doc);
  if (!where) return;
  const file = outputsPath(where.path);
  const chunks = chunkSource?.(doc) ?? [];
  const runs = runsFor(doc).filter((r) => r.seq > 0 && (r.status === 'done' || r.status === 'error'));
  const inline = inlinesFor(doc).filter((v) => v.status !== 'queued');
  try {
    if (!runs.length && !inline.length) {
      if (await fs.exists(where.ws, file)) await fs.remove(where.ws, file);
      return;
    }
    const data: SavedOutput = {
      version: 1,
      chunkCount: chunks.length,
      chunks: runs.map((r) => ({
        index: chunks.findIndex((c) => c.start === r.line),
        label: r.label,
        code: r.code,
        status: r.status as 'done' | 'error',
        ms: r.ms,
        items: JSON.parse(JSON.stringify(r.items)),
      })),
      inline: inline.map((v) => ({ code: v.code, ok: v.status === 'done', text: v.text })),
    };
    let json = JSON.stringify(data);
    if (json.length > SAVE_MAX) {
      // Interactive widgets carry their libraries; drop them first.
      for (const c of data.chunks)
        c.items = c.items.map((i) =>
          i.kind === 'widget' ? { kind: 'text', stream: 'message', text: 'Interactive output was too large to save. Run the chunk again to see it.' } : i,
        );
      json = JSON.stringify(data);
    }
    if (json.length > SAVE_MAX) return;
    await fs.writeFile(where.ws, file, json);
  } catch (e) {
    console.warn('saving chunk output failed', e);
  }
}

/** Load a document's saved output once (when it is first shown). */
export async function loadSaved(doc: string): Promise<SavedOutput | null> {
  const where = docPaths.get(doc);
  if (!where || loaded.has(doc)) return null;
  loaded.add(doc);
  try {
    const file = outputsPath(where.path);
    if (!(await fs.exists(where.ws, file))) return null;
    const data = JSON.parse(await fs.readText(where.ws, file)) as SavedOutput;
    return data?.version === 1 ? data : null;
  } catch {
    return null;
  }
}

/** Create runs for saved output (ids are returned so the editor can track them). */
export function restoreRun(doc: string, chunk: Chunk, saved: SavedOutput['chunks'][number]): string {
  const id = newRun(doc, chunk);
  setNb('runs', id, { code: saved.code, status: saved.status, items: saved.items, ms: saved.ms, seq: 1 });
  return id;
}

export function restoreInline(doc: string, saved: SavedOutput['inline'][number]): string {
  const id = newInline(doc, saved.code);
  setNb('inlines', id, { status: saved.ok ? 'done' : 'error', text: saved.text });
  return id;
}

/** Keep saved output with a file that was renamed or moved, or delete it with the file. */
export async function moveSavedOutput(ws: string, from: string, to: string | null) {
  try {
    const dir = `${fs.IDE_DIR}/outputs`;
    if (!(await fs.exists(ws, dir))) return;
    const names = fs.flattenTree(await fs.listTree(ws, true)).filter((n) => n.path.startsWith(dir + '/')).map((n) => n.path.slice(dir.length + 1));
    for (const name of names) {
      const path = decodeURIComponent(name.replace(/\.json$/, ''));
      if (path !== from && !path.startsWith(from + '/')) continue;
      if (to === null) await fs.remove(ws, `${dir}/${name}`);
      else await fs.rename(ws, `${dir}/${name}`, outputsPath(to + path.slice(from.length)));
    }
  } catch (e) {
    console.warn('moving saved output failed', e);
  }
}
