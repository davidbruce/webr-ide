import { createSignal, type Accessor } from 'solid-js';
import { compileFilters, isMissing, toNumber, type Filter } from './csv';

export type { Filter };
export interface SortSpec {
  col: number;
  dir: 1 | -1;
}
export interface GridRow {
  index: number; // original (unsorted) data-row number, 0-based
  cells: string[];
}

/** What the DataGrid needs from a table, whatever its size or origin. */
export interface GridSource {
  columns: Accessor<string[]>;
  numeric: Accessor<boolean[]>;
  /** Rows in the current (sorted/filtered) view. */
  rowCount: Accessor<number>;
  /** Total data rows before filtering (may grow while indexing). */
  totalRows: Accessor<number>;
  /** 0..1 while the source is still loading/indexing; 1 when done. */
  progress: Accessor<number>;
  /** 0..1 while a sort/filter runs, otherwise null. */
  busy: Accessor<number | null>;
  error: Accessor<string | null>;
  /** Bumped whenever previously fetched rows become invalid. */
  version: Accessor<number>;
  getRows(start: number, count: number): Promise<GridRow[]>;
  setQuery(sort: SortSpec | null, filters: Filter[]): Promise<void>;
  dispose(): void;
}

// ---------------------------------------------------------------- file source (worker)

export class FileSource implements GridSource {
  private worker = new Worker(new URL('./csv-worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private s = {
    columns: createSignal<string[]>([]),
    numeric: createSignal<boolean[]>([]),
    rowCount: createSignal(0),
    totalRows: createSignal(0),
    progress: createSignal(0),
    busy: createSignal<number | null>(null),
    error: createSignal<string | null>(null),
    version: createSignal(0),
  };
  private filtered = false;
  delimiter = ',';
  size = 0;

  columns = this.s.columns[0];
  numeric = this.s.numeric[0];
  rowCount = this.s.rowCount[0];
  totalRows = this.s.totalRows[0];
  progress = this.s.progress[0];
  busy = this.s.busy[0];
  error = this.s.error[0];
  version = this.s.version[0];

  constructor(file: File | Blob, name: string) {
    this.worker.onmessage = (ev) => this.onMessage(ev.data);
    this.worker.onerror = (e) => this.s.error[1](e.message || 'Grid worker failed');
    this.worker.postMessage({ type: 'open', file, name });
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'meta':
        this.delimiter = m.delimiter;
        this.size = m.size;
        this.s.columns[1](m.columns);
        this.s.numeric[1](m.numeric);
        break;
      case 'progress':
        this.s.totalRows[1](m.rows);
        if (!this.filtered) this.s.rowCount[1](m.rows);
        this.s.progress[1](m.done ? 1 : Math.min(0.99, m.bytes / Math.max(1, this.size)));
        break;
      case 'queryProgress':
        this.s.busy[1](m.fraction >= 1 ? null : m.fraction);
        break;
      case 'rows':
      case 'query':
      case 'error': {
        const p = this.pending.get(m.id);
        if (m.type === 'error' && !p) this.s.error[1](m.message);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve(m.type === 'rows' ? m.rows : m.count);
      }
    }
  }

  private call<T>(msg: object): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  getRows(start: number, count: number) {
    return this.call<GridRow[]>({ type: 'rows', start, count });
  }

  async setQuery(sort: SortSpec | null, filters: Filter[]) {
    const active = !!sort || filters.some((f) => f.expr.trim());
    this.s.busy[1](active ? 0 : null);
    try {
      const count = await this.call<number>({ type: 'query', sort, filters });
      this.filtered = active;
      this.s.rowCount[1](active ? count : this.totalRows());
      this.s.version[1]((v) => v + 1);
    } catch (e) {
      if (!String(e).includes('cancelled')) this.s.error[1](String(e));
    } finally {
      this.s.busy[1](null);
    }
  }

  dispose() {
    this.worker.postMessage({ type: 'close' });
    this.worker.terminate();
    this.pending.forEach((p) => p.reject(new Error('closed')));
    this.pending.clear();
  }
}

// ---------------------------------------------------------------- in-memory source (R View())

export class ArraySource implements GridSource {
  private data: string[][]; // rows
  private view: number[];
  columns: Accessor<string[]>;
  numeric: Accessor<boolean[]>;
  rowCount: Accessor<number>;
  totalRows: Accessor<number>;
  progress = () => 1;
  busy = () => null;
  error = () => null;
  version: Accessor<number>;
  private setRowCount: (n: number) => void;
  private setVersion: (f: (v: number) => number) => void;

  constructor(columns: Record<string, unknown[]>) {
    const names = Object.keys(columns);
    const n = names.length ? columns[names[0]]?.length ?? 0 : 0;
    const fmt = (v: unknown) => (v === null || v === undefined ? 'NA' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(7))) : String(v));
    this.data = Array.from({ length: n }, (_, r) => names.map((c) => fmt(columns[c][r])));
    const numeric = names.map((c) => columns[c].some((v) => typeof v === 'number') || columns[c].every((v) => v === null || !Number.isNaN(toNumber(String(v)))));
    this.view = this.data.map((_, i) => i);
    this.columns = () => names;
    this.numeric = () => numeric;
    this.totalRows = () => n;
    const [count, setCount] = createSignal(n);
    const [version, setVersion] = createSignal(0);
    this.rowCount = count;
    this.setRowCount = setCount;
    this.version = version;
    this.setVersion = setVersion;
  }

  async getRows(start: number, count: number) {
    return this.view.slice(start, start + count).map((index) => ({ index, cells: this.data[index] }));
  }

  async setQuery(sort: SortSpec | null, filters: Filter[]) {
    const pred = compileFilters(filters);
    let v = this.data.map((_, i) => i);
    if (pred) v = v.filter((i) => pred(this.data[i]));
    if (sort) {
      const c = sort.col;
      const num = this.numeric()[c];
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      v.sort((a, b) => {
        const x = this.data[a][c];
        const y = this.data[b][c];
        const xm = isMissing(x);
        const ym = isMissing(y);
        if (xm || ym) return xm && ym ? a - b : xm ? 1 : -1;
        const r = num ? toNumber(x) - toNumber(y) : coll.compare(x, y);
        return r * sort.dir || a - b;
      });
    }
    this.view = v;
    this.setRowCount(v.length);
    this.setVersion((x) => x + 1);
  }

  dispose() {}
}
