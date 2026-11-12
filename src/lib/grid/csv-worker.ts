/// <reference lib="webworker" />
// Lazily indexes and serves rows from a (possibly very large) delimited file.
//
// - Indexing streams the file in chunks and records the byte offset of every
//   row start (newlines inside quotes don't count). Rows become available to
//   the UI while indexing continues.
// - Rows are read on demand by slicing the File, so memory stays small.
// - Sort/filter stream the file once more and produce a row-order array.

import { parseRecords, detectDelimiter, compileFilters, toNumber, isMissing, type Filter } from './csv';

const CHUNK = 8 * 1024 * 1024;

let file: File | Blob | null = null;
let fileName = '';
let delim = ',';
let hasHeader = true;
let columns: string[] = [];
let numeric: boolean[] = [];
let offsets = new Uint32Array(1 << 16); // row start offsets (row 0 may be the header); files are capped well below 4 GB
let nOffsets = 0;
let indexed = false;
let generation = 0;
let view: Uint32Array | null = null; // data-row indices after sort/filter; null = identity
let waiters: (() => void)[] = [];
const decoder = new TextDecoder();

type Msg =
  | { type: 'open'; file: File | Blob; name: string; header?: boolean }
  | { type: 'rows'; id: number; start: number; count: number }
  | { type: 'query'; id: number; sort: { col: number; dir: 1 | -1 } | null; filters: Filter[] }
  | { type: 'close' };

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.type === 'open') await open(m.file, m.name, m.header ?? true);
    else if (m.type === 'rows') post({ type: 'rows', id: m.id, rows: await readView(m.start, m.count) });
    else if (m.type === 'query') post({ type: 'query', id: m.id, count: await query(m.sort, m.filters) });
    else if (m.type === 'close') {
      generation++;
      file = null;
    }
  } catch (e) {
    post({ type: 'error', id: (m as any).id, message: String((e as Error)?.message ?? e) });
  }
};

const dataRows = () => Math.max(0, nOffsets - (hasHeader ? 1 : 0));
const rowCount = () => (view ? view.length : dataRows());

function pushOffset(o: number) {
  if (nOffsets === offsets.length) {
    const next = new Uint32Array(offsets.length * 2);
    next.set(offsets);
    offsets = next;
  }
  offsets[nOffsets++] = o;
}

async function open(f: File | Blob, name: string, header: boolean) {
  const gen = ++generation;
  file = f;
  fileName = name;
  hasHeader = header;
  offsets = new Uint32Array(1 << 16);
  nOffsets = 0;
  indexed = false;
  view = null;
  columns = [];
  numeric = [];

  // Sniff delimiter, header and column types from the first 256 KB.
  const sampleText = decoder.decode(await f.slice(0, 256 * 1024).arrayBuffer());
  delim = detectDelimiter(sampleText, name);
  const sample = parseRecords(sampleText.slice(0, sampleText.lastIndexOf('\n') + 1 || undefined), delim);
  const width = Math.max(0, ...sample.slice(0, 200).map((r) => r.length));
  const head = sample[0] ?? [];
  columns = Array.from({ length: width }, (_, i) => (hasHeader ? head[i] ?? '' : '') || `V${i + 1}`);
  const body = hasHeader ? sample.slice(1, 1001) : sample.slice(0, 1000);
  numeric = columns.map((_, c) => {
    let seen = 0;
    for (const r of body) {
      const v = r[c] ?? '';
      if (isMissing(v)) continue;
      if (Number.isNaN(toNumber(v))) return false;
      seen++;
    }
    return seen > 0;
  });
  post({ type: 'meta', columns, numeric, delimiter: delim, size: f.size });

  // Index row starts.
  pushOffset(0);
  let inQuote = false;
  let lastReport = 0;
  for (let pos = 0; pos < f.size; pos += CHUNK) {
    if (gen !== generation) return;
    const bytes = new Uint8Array(await f.slice(pos, Math.min(f.size, pos + CHUNK)).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 34) inQuote = !inQuote;
      else if (b === 10 && !inQuote) pushOffset(pos + i + 1);
    }
    const now = performance.now();
    if (now - lastReport > 150) {
      lastReport = now;
      post({ type: 'progress', rows: dataRows(), bytes: Math.min(f.size, pos + CHUNK), done: false });
    }
  }
  // A trailing newline doesn't start a new row.
  if (nOffsets > 1 && offsets[nOffsets - 1] >= f.size) nOffsets--;
  indexed = true;
  post({ type: 'progress', rows: dataRows(), bytes: f.size, done: true });
  waiters.forEach((w) => w());
  waiters = [];
}

function whenIndexed(): Promise<void> {
  return indexed ? Promise.resolve() : new Promise((r) => waiters.push(r));
}

/** Byte range of a data row. */
function rowRange(dataRow: number): [number, number] {
  const r = dataRow + (hasHeader ? 1 : 0);
  const start = offsets[r];
  const end = r + 1 < nOffsets ? offsets[r + 1] : indexed ? file!.size : start;
  return [start, end];
}

/** Read rows [start, start+count) of the current view. */
async function readView(start: number, count: number): Promise<{ index: number; cells: string[] }[]> {
  if (!file) return [];
  const total = rowCount();
  const end = Math.min(total, start + count);
  if (end <= start) return [];
  const want: number[] = [];
  for (let i = start; i < end; i++) want.push(view ? view[i] : i);

  // Coalesce contiguous data rows into single reads.
  const out = new Map<number, string[]>();
  const sorted = [...want].sort((a, b) => a - b);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const [s] = rowRange(sorted[i]);
    const [, e] = rowRange(sorted[j]);
    if (e > s) {
      const text = decoder.decode(await file.slice(s, e).arrayBuffer());
      const recs = parseRecords(text, delim);
      for (let k = i; k <= j; k++) out.set(sorted[k], recs[k - i] ?? []);
    }
    i = j + 1;
  }
  return want.map((index) => ({ index, cells: out.get(index) ?? [] }));
}

/** Stream every data row in order (after indexing), in parsed batches. */
async function forEachRow(fn: (row: number, cells: string[]) => void, gen: number) {
  await whenIndexed();
  const total = dataRows();
  let row = 0;
  let lastReport = 0;
  while (row < total) {
    if (gen !== generation) throw new Error('cancelled');
    const [s] = rowRange(row);
    // Extend the batch to roughly CHUNK bytes, ending on a row boundary.
    let last = row;
    while (last + 1 < total && rowRange(last + 1)[1] - s < CHUNK) last++;
    const [, e] = rowRange(last);
    const recs = parseRecords(decoder.decode(await file!.slice(s, e).arrayBuffer()), delim);
    for (let k = row; k <= last; k++) fn(k, recs[k - row] ?? []);
    row = last + 1;
    const now = performance.now();
    if (now - lastReport > 150) {
      lastReport = now;
      post({ type: 'queryProgress', fraction: row / total });
    }
  }
}

async function query(sort: { col: number; dir: 1 | -1 } | null, filters: Filter[]): Promise<number> {
  const gen = generation;
  const pred = compileFilters(filters);
  if (!pred && !sort) {
    view = null;
    return rowCount();
  }
  await whenIndexed();
  const total = dataRows();
  const keep = new Uint32Array(total);
  let n = 0;
  const col = sort?.col ?? -1;
  const isNum = col >= 0 && numeric[col];
  const numKeys = isNum ? new Float64Array(total) : null;
  const strKeys: string[] | null = sort && !isNum ? new Array(total) : null;

  await forEachRow((row, cells) => {
    if (pred && !pred(cells)) return;
    keep[n++] = row;
    if (numKeys) numKeys[row] = toNumber(cells[col] ?? '');
    else if (strKeys) strKeys[row] = cells[col] ?? '';
  }, gen);

  let v = keep.subarray(0, n);
  if (sort) {
    const dir = sort.dir;
    const arr = Array.from(v);
    if (numKeys) {
      arr.sort((a, b) => {
        const x = numKeys[a];
        const y = numKeys[b];
        const xn = Number.isNaN(x);
        const yn = Number.isNaN(y);
        if (xn || yn) return xn && yn ? a - b : xn ? 1 : -1; // missing values last
        return x === y ? a - b : (x - y) * dir;
      });
    } else {
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      arr.sort((a, b) => {
        const x = strKeys![a];
        const y = strKeys![b];
        const xm = isMissing(x);
        const ym = isMissing(y);
        if (xm || ym) return xm && ym ? a - b : xm ? 1 : -1;
        return coll.compare(x, y) * dir || a - b;
      });
    }
    v = Uint32Array.from(arr);
  }
  if (gen !== generation) throw new Error('cancelled');
  view = v;
  post({ type: 'queryProgress', fraction: 1 });
  return view.length;
}

export {};
void fileName;
