// CSV / delimited-text helpers shared by the grid worker and tests.

export const DELIMITERS = [',', '\t', ';', '|'] as const;

/** Parse delimited text (RFC 4180 quoting) into records. */
export function parseRecords(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  const d = delim.charCodeAt(0);
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */ && field === '') {
      // quoted field
      i++;
      let start = i;
      let parts = '';
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          parts += text.slice(start);
          i = n;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          parts += text.slice(start, q + 1);
          i = q + 2;
          start = i;
          continue;
        }
        parts += text.slice(start, q);
        i = q + 1;
        break;
      }
      field = parts;
      // skip anything up to the next delimiter/newline (malformed input)
      while (i < n) {
        const k = text.charCodeAt(i);
        if (k === d || k === 10 || k === 13) break;
        field += text[i++];
      }
      continue;
    }
    if (c === d) {
      row.push(field);
      field = '';
      i++;
    } else if (c === 10 || c === 13) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    } else {
      // unquoted run
      let j = i;
      while (j < n) {
        const k = text.charCodeAt(j);
        if (k === d || k === 10 || k === 13) break;
        j++;
      }
      field += text.slice(i, j);
      i = j;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Guess the delimiter from a sample: the candidate with the most consistent, non-zero count per line. */
export function detectDelimiter(sample: string, filename = ''): string {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'tsv' || ext === 'tab') return '\t';
  if (ext === 'psv') return '|';
  const lines = sample.split(/\r?\n/).slice(0, 30).filter((l) => l.length);
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const first = counts[0] ?? 0;
    if (!first) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 100 + Math.min(first, 50);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

const NA = new Set(['', 'NA', 'NaN', 'null', 'NULL', 'N/A', '#N/A']);
export function isMissing(v: string): boolean {
  return NA.has(v.trim());
}

/** Parse a number if the whole string is numeric (allows thousands separators and %). */
export function toNumber(v: string): number {
  const s = v.trim();
  if (!s) return NaN;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  const cleaned = s.replace(/,(?=\d{3}(\D|$))/g, '').replace(/%$/, '');
  return cleaned !== s ? Number(cleaned) : NaN;
}

// ---------------------------------------------------------------- filters

export type Filter = { col: number; expr: string }; // col -1 = any column

export type Predicate = (cells: string[]) => boolean;

/**
 * Build a row predicate from per-column filter expressions:
 *   text      contains (case-insensitive)
 *   =x  !=x   equals / not equals
 *   >5 >=5 <5 <=5   numeric comparison
 *   1..10     numeric range (inclusive)
 *   empty / !empty  missing / not missing
 */
export function compileFilters(filters: Filter[]): Predicate | null {
  const parts = filters.filter((f) => f.expr.trim()).map((f) => compileOne(f.col, f.expr.trim()));
  if (!parts.length) return null;
  return (cells) => parts.every((p) => p(cells));
}

function compileOne(col: number, expr: string): Predicate {
  const get = (cells: string[]) => (col < 0 ? cells : [cells[col] ?? '']);
  const anyCell = (test: (v: string) => boolean) => (cells: string[]) => get(cells).some(test);

  if (expr === 'empty') return anyCell((v) => isMissing(v));
  if (expr === '!empty') return (cells) => get(cells).every((v) => !isMissing(v));
  let m = /^(-?[\d.eE+]+)\s*\.\.\s*(-?[\d.eE+]+)$/.exec(expr);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return anyCell((v) => {
      const n = toNumber(v);
      return n >= lo && n <= hi;
    });
  }
  m = /^(>=|<=|!=|>|<|=)\s*(.*)$/.exec(expr);
  if (m) {
    const op = m[1];
    const rhs = m[2];
    const num = toNumber(rhs);
    const lower = rhs.toLowerCase();
    if (op === '=' || op === '!=') {
      const eq = (v: string) => (Number.isNaN(num) ? v.trim().toLowerCase() === lower : toNumber(v) === num || v.trim() === rhs);
      return op === '=' ? anyCell(eq) : (cells) => get(cells).every((v) => !eq(v));
    }
    if (!Number.isNaN(num)) {
      const cmp =
        op === '>' ? (n: number) => n > num : op === '>=' ? (n: number) => n >= num : op === '<' ? (n: number) => n < num : (n: number) => n <= num;
      return anyCell((v) => {
        const n = toNumber(v);
        return !Number.isNaN(n) && cmp(n);
      });
    }
    // string comparison
    const scmp =
      op === '>' ? (s: string) => s > lower : op === '>=' ? (s: string) => s >= lower : op === '<' ? (s: string) => s < lower : (s: string) => s <= lower;
    return anyCell((v) => scmp(v.toLowerCase()));
  }
  const needle = expr.toLowerCase();
  return anyCell((v) => v.toLowerCase().includes(needle));
}
