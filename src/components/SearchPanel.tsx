// Find in files: search every text file in the workspace (open tabs with
// their unsaved edits), jump to a match, and replace in one file or all.
import { createSignal, For, Show, onCleanup, createEffect, on } from 'solid-js';
import * as fs from '../lib/opfs';
import { state, setState, editor, writeWorkspaceFile, refreshTree, phone, showPane } from '../lib/ide';
import { isBinaryName, IMAGE_EXT, extOf } from '../lib/monaco';
import { confirmDialog, toast } from '../lib/ui';
import { cachedText } from '../lib/text-cache';
import { Icon } from './Icon';

/** Which view the sidebar shows. */
export const [sidebarMode, setSidebarMode] = createSignal<'files' | 'search'>('files');

const [query, setQuery] = createSignal('');
const [replacement, setReplacement] = createSignal('');
const [showReplace, setShowReplace] = createSignal(false);
const [matchCase, setMatchCase] = createSignal(false);
const [wholeWord, setWholeWord] = createSignal(false);
const [useRegex, setUseRegex] = createSignal(false);
const [includeData, setIncludeData] = createSignal(false);
const [focusSeq, setFocusSeq] = createSignal(0);

interface Match {
  line: number;
  col: number; // 1-based
  len: number;
  text: string; // the line
}
interface FileResult {
  path: string;
  matches: Match[];
}

const MAX_MATCHES = 2000;
const MAX_FILE = 5 * 1024 * 1024;

export function openFindInFiles(initial = '') {
  if (initial && !initial.includes('\n')) setQuery(initial);
  setSidebarMode('search');
  if (phone()) showPane('files');
  else setState('sidebarOpen', true);
  setFocusSeq((n) => n + 1);
}

function buildRegex(): RegExp | null {
  const q = query();
  if (!q) return null;
  let src = useRegex() ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord()) src = `(?<![\\w.])(?:${src})(?![\\w.])`;
  return new RegExp(src, matchCase() ? 'g' : 'gi');
}

/** Data files: skipped unless "Include data files" is on (they're big and rarely what you're after). */
const DATA_EXT = new Set(['csv', 'tsv', 'tab', 'psv', 'json', 'geojson', 'xml', 'ndjson', 'jsonl']);

function searchable(n: fs.FileNode) {
  return (
    n.kind === 'file' &&
    !isBinaryName(n.name) &&
    !IMAGE_EXT.has(extOf(n.name)) &&
    (n.size ?? 0) <= MAX_FILE &&
    (includeData() || !DATA_EXT.has(extOf(n.name)))
  );
}

/** Open tabs (with unsaved edits) first; other files from the cache. */
async function textOf(node: fs.FileNode): Promise<string> {
  return editor()?.openText?.(node.path) ?? (await cachedText(state.workspace, node));
}

function matchesIn(text: string, re: RegExp, limit: number): Match[] {
  const out: Match[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const t = lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) && out.length < limit) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      out.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: t });
    }
  }
  return out;
}

export function SearchPanel() {
  const [results, setResults] = createSignal<FileResult[]>([]);
  const [error, setError] = createSignal('');
  const [searching, setSearching] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  let input!: HTMLInputElement;
  let seq = 0;
  let timer: number | undefined;

  async function run() {
    const my = ++seq;
    setError('');
    let re: RegExp | null;
    try {
      re = buildRegex();
    } catch {
      setError('Invalid regular expression');
      setResults([]);
      return;
    }
    if (!re) {
      setResults([]);
      return;
    }
    setSearching(true);
    const out: FileResult[] = [];
    let total = 0;
    let slice = performance.now();
    for (const n of fs.flattenTree(state.tree)) {
      if (!searchable(n) || total >= MAX_MATCHES) continue;
      let text: string;
      try {
        text = await textOf(n);
      } catch {
        continue;
      }
      // Let typing and scrolling through every ~10 ms of searching.
      if (performance.now() - slice > 10) {
        await new Promise((r) => setTimeout(r));
        slice = performance.now();
      }
      if (my !== seq) return;
      const matches = matchesIn(text, re, MAX_MATCHES - total);
      if (matches.length) {
        out.push({ path: n.path, matches });
        total += matches.length;
      }
    }
    if (my !== seq) return;
    setResults(out);
    setSearching(false);
  }

  const schedule = (ms = 200) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(), ms);
  };
  createEffect(on([query, matchCase, wholeWord, useRegex, includeData, () => state.workspace], () => schedule(), { defer: false }));
  createEffect(on(focusSeq, () => queueMicrotask(() => input?.focus()), { defer: true }));
  onCleanup(() => clearTimeout(timer));

  const total = () => results().reduce((s, r) => s + r.matches.length, 0);

  /** The replacement for one match (regex mode supports $1 etc.). */
  function replaceFn(): (s: string) => string {
    const repl = replacement();
    if (!useRegex()) return () => repl;
    const re = buildRegex()!;
    const one = new RegExp(re.source, re.flags.replace('g', ''));
    return (s) => s.replace(one, repl);
  }

  async function replaceIn(paths: string[]): Promise<number> {
    const re = buildRegex();
    if (!re) return 0;
    const fn = replaceFn();
    let count = 0;
    for (const path of paths) {
      const node = fs.flattenTree(state.tree).find((n) => n.path === path);
      if (!node) continue;
      const text = await textOf(node);
      const matches = matchesIn(text, re, Infinity);
      if (!matches.length) continue;
      count += matches.length;
      const edits = matches.map((m) => ({
        range: { startLineNumber: m.line, startColumn: m.col, endLineNumber: m.line, endColumn: m.col + m.len },
        text: fn(m.text.slice(m.col - 1, m.col - 1 + m.len)),
      }));
      // Open tabs are edited in place (undoable, saved with the file);
      // other files are rewritten.
      if (editor()?.editOpen?.(path, edits)) continue;
      const lines = text.split(/(\r?\n)/);
      const byLine = new Map<number, Match[]>();
      for (const m of matches) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
      for (const [ln, ms] of byLine) {
        let t = lines[(ln - 1) * 2];
        for (const m of [...ms].reverse()) t = t.slice(0, m.col - 1) + fn(t.slice(m.col - 1, m.col - 1 + m.len)) + t.slice(m.col - 1 + m.len);
        lines[(ln - 1) * 2] = t;
      }
      await writeWorkspaceFile(path, lines.join(''));
    }
    void refreshTree();
    void run();
    return count;
  }

  async function replaceAll() {
    const files = results().map((r) => r.path);
    if (!files.length) return;
    const ok = await confirmDialog(
      'Replace in files',
      `Replace ${total()} match${total() === 1 ? '' : 'es'} in ${files.length} file${files.length === 1 ? '' : 's'} with "${replacement()}"? Files open in tabs can be undone there; other files are changed on disk.`,
      { okLabel: 'Replace All', danger: true },
    );
    if (!ok) return;
    const n = await replaceIn(files);
    toast(`Replaced ${n} match${n === 1 ? '' : 'es'}`);
  }

  function Toggle(p: { on: boolean; set: (v: boolean) => void; label: string; title: string }) {
    return (
      <button class="search-toggle" classList={{ on: p.on }} aria-pressed={p.on} title={p.title} onClick={() => p.set(!p.on)}>
        {p.label}
      </button>
    );
  }

  return (
    <div class="search-panel">
      <div class="search-form">
        <div class="search-row">
          <button class="tb-btn tiny" title={showReplace() ? 'Hide replace' : 'Replace'} onClick={() => setShowReplace(!showReplace())}>
            <Icon name={showReplace() ? 'chevron-down' : 'chevron'} size={12} />
          </button>
          <div class="search-box">
            <Icon name="search" size={13} />
            <input
              ref={input}
              type="search"
              placeholder="Find in files"
              value={query()}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && schedule(0)}
            />
          </div>
        </div>
        <div class="search-row search-opts">
          <Toggle on={matchCase()} set={setMatchCase} label="Aa" title="Match case" />
          <Toggle on={wholeWord()} set={setWholeWord} label="ab" title="Whole word" />
          <Toggle on={useRegex()} set={setUseRegex} label=".*" title="Regular expression" />
          <Toggle on={includeData()} set={setIncludeData} label="csv" title="Include data files (CSV, TSV, JSON…)" />
          <span class="search-count">
            {error() || (searching() ? 'Searching…' : query() ? `${total()}${total() >= MAX_MATCHES ? '+' : ''} in ${results().length} file${results().length === 1 ? '' : 's'}` : '')}
          </span>
        </div>
        <Show when={showReplace()}>
          <div class="search-row">
            <div class="search-box">
              <Icon name="replace" size={13} />
              <input
                type="text"
                placeholder={useRegex() ? 'Replace ($1 for groups)' : 'Replace'}
                value={replacement()}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                onInput={(e) => setReplacement(e.currentTarget.value)}
              />
            </div>
            <button class="btn small" disabled={!total()} onClick={() => void replaceAll()}>
              All
            </button>
          </div>
        </Show>
      </div>
      <div class="search-results scroll">
        <For each={results()}>
          {(r) => (
            <div class="search-file">
              <div class="search-file-head" onClick={() => setCollapsed((c) => ({ ...c, [r.path]: !c[r.path] }))}>
                <Icon name={collapsed()[r.path] ? 'chevron' : 'chevron-down'} size={12} />
                <span class="search-file-name">{fs.basename(r.path)}</span>
                <span class="search-file-dir">{fs.dirname(r.path)}</span>
                <span class="search-file-count">{r.matches.length}</span>
                <Show when={showReplace()}>
                  <button
                    class="tb-btn tiny"
                    title={`Replace in ${fs.basename(r.path)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void replaceIn([r.path]).then((n) => toast(`Replaced ${n} in ${fs.basename(r.path)}`));
                    }}
                  >
                    <Icon name="replace" size={13} />
                  </button>
                </Show>
              </div>
              <Show when={!collapsed()[r.path]}>
                <For each={r.matches}>
                  {(m) => {
                    // Show a little context before the match, trimmed.
                    const start = Math.max(0, m.col - 1 - 24);
                    const pre = (start ? '…' : '') + m.text.slice(start, m.col - 1).trimStart();
                    return (
                      <button class="search-match" onClick={() => void editor()?.openAt?.(r.path, m.line, m.col, m.line, m.col + m.len)}>
                        <span class="search-line">{m.line}</span>
                        <span class="search-text">
                          {pre}
                          <mark>{m.text.slice(m.col - 1, m.col - 1 + m.len)}</mark>
                          {m.text.slice(m.col - 1 + m.len, m.col - 1 + m.len + 80)}
                        </span>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>
          )}
        </For>
        <Show when={query() && !searching() && !results().length && !error()}>
          <div class="empty-note">No matches</div>
        </Show>
      </div>
    </div>
  );
}
