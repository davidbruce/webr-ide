// Editor language features for R: syntax errors as you type, function hints,
// help on hover, the document outline, formatting and go-to-definition.
// Most of it asks the running R session; all of it waits while R is busy.
import { createEffect, createRoot, on } from 'solid-js';
import { monaco, inRChunk } from './monaco';
import { session, state, completions } from './ide';
import { rString } from './r-session';
import * as fs from './opfs';
import { cachedText } from './text-cache';
import { settings } from './settings';

// ---------------------------------------------------------------- R regions

const CHUNK_START = /^\s*```+\s*\{\s*[rR]\b[^}]*\}\s*$/;
const FENCE = /^\s*```/;

/** A run of R code in a model: the whole file, or one Quarto chunk. */
export interface RRegion {
  /** First line of the code (1-based). */
  line: number;
  text: string;
}

export function rRegions(model: monaco.editor.ITextModel): RRegion[] {
  const lang = model.getLanguageId();
  if (lang === 'r') return [{ line: 1, text: model.getValue() }];
  if (lang !== 'quarto') return [];
  const out: RRegion[] = [];
  const n = model.getLineCount();
  for (let ln = 1; ln <= n; ln++) {
    if (!CHUNK_START.test(model.getLineContent(ln))) {
      if (FENCE.test(model.getLineContent(ln))) {
        // Skip other fenced blocks so a ``` inside them isn't mistaken for a chunk.
        while (ln < n && !/^\s*```+\s*$/.test(model.getLineContent(++ln)));
      }
      continue;
    }
    const lines: string[] = [];
    let end = ln + 1;
    while (end <= n && !/^\s*```+\s*$/.test(model.getLineContent(end))) lines.push(model.getLineContent(end++));
    out.push({ line: ln + 1, text: lines.join('\n') });
    ln = end;
  }
  return out;
}

/** First line of the R code containing `line` (1 for a script), or null outside R code. */
function regionStart(model: monaco.editor.ITextModel, line: number): number | null {
  const lang = model.getLanguageId();
  if (lang === 'r') return 1;
  if (lang !== 'quarto') return null;
  for (let ln = line; ln >= 1; ln--) {
    const t = model.getLineContent(ln);
    if (CHUNK_START.test(t)) return ln < line ? ln + 1 : null;
    if (FENCE.test(t)) return null;
  }
  return null;
}

const isRCode = (model: monaco.editor.ITextModel, line: number) =>
  model.getLanguageId() === 'r' || (model.getLanguageId() === 'quarto' && inRChunk(model, line));

// ---------------------------------------------------------------- scanner

interface Open {
  ch: string;
  /** Offset of the bracket in the text. */
  at: number;
  /** For "(": the function being called, if any. */
  fn: string | null;
  /** Offsets just after the "(" and after each top-level comma. */
  args: number[];
}

/**
 * Walk R code, skipping strings and comments. Returns the brackets still open
 * at the end, an unterminated string's start, and each line's bracket depth.
 */
export function scanR(text: string): { open: Open[]; quoteAt: number; lineDepth: number[] } {
  const open: Open[] = [];
  const lineDepth = [0];
  let quote: string | null = null;
  let quoteAt = -1;
  let raw: string | null = null; // closing sequence of a raw string r"(...)"
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      lineDepth.push(open.length);
      continue;
    }
    if (raw) {
      if (text.startsWith(raw, i)) {
        i += raw.length - 1;
        raw = null;
        quoteAt = -1;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) {
        quote = null;
        quoteAt = -1;
      }
      continue;
    }
    if (c === '#') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
      continue;
    }
    if ((c === 'r' || c === 'R') && (text[i + 1] === '"' || text[i + 1] === "'") && !/[\w.]/.test(text[i - 1] ?? '')) {
      const m = /^[rR](["'])(-*)([([{])/.exec(text.slice(i, i + 40));
      if (m) {
        const close = { '(': ')', '[': ']', '{': '}' }[m[3]]!;
        raw = close + m[2] + m[1];
        quoteAt = i;
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      quoteAt = i;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      let fn: string | null = null;
      if (c === '(') {
        const m = /([A-Za-z.][\w.]*(?:::?:?[A-Za-z.][\w.]*)?|`[^`]+`)\s*$/.exec(text.slice(Math.max(0, i - 120), i));
        if (m && !/^(function|if|for|while|switch|return)$/.test(m[1])) {
          const before = text.slice(Math.max(0, i - 120), i - m[0].length);
          fn = /[$@]\s*$/.test(before) ? null : m[1].replace(/^`|`$/g, '');
        }
      }
      open.push({ ch: c, at: i, fn, args: [i + 1] });
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const want = { ')': '(', ']': '[', '}': '{' }[c];
      // Tolerate a stray closer: drop back to its opener if there is one.
      const k = open.map((o) => o.ch).lastIndexOf(want);
      if (k >= 0) open.length = k;
      continue;
    }
    if (c === ',' && open.length) open[open.length - 1].args.push(i + 1);
  }
  return { open, quoteAt: quote || raw ? quoteAt : -1, lineDepth };
}

// ---------------------------------------------------------------- R calls

/** Run an R helper when R is free; null if R stays busy or fails. */
async function ask(code: string, wait = 800): Promise<string[] | null> {
  if (session.status !== 'ready' || !(await session.waitIdle(wait))) return null;
  try {
    return await session.strings(code);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- diagnostics

const OWNER = 'r-syntax';
const checkTimers = new WeakMap<monaco.editor.ITextModel, number>();
const pendingChecks = new Set<monaco.editor.ITextModel>();
const lastEdit = new WeakMap<monaco.editor.ITextModel, number>();

function scheduleCheck(model: monaco.editor.ITextModel, delay = 700) {
  clearTimeout(checkTimers.get(model));
  checkTimers.set(model, window.setTimeout(() => void checkModel(model), delay));
}

async function checkModel(model: monaco.editor.ITextModel) {
  if (model.isDisposed()) return;
  const regions = settings.syntaxCheck ? rRegions(model) : [];
  if (!regions.length) {
    monaco.editor.setModelMarkers(model, OWNER, []);
    return;
  }
  if (!session.idle) {
    pendingChecks.add(model); // checked when R is next idle
    return;
  }
  const version = model.getVersionId();
  const res = await ask(`vapply(c(${regions.map((r) => rString(r.text)).join(', ')}), .ide_parse_check, "", USE.NAMES = FALSE)`, 0);
  if (!res || model.isDisposed() || model.getVersionId() !== version) return;
  const markers: monaco.editor.IMarkerData[] = [];
  const typing = Date.now() - (lastEdit.get(model) ?? 0) < 2500;
  res.forEach((msg, i) => {
    // Code that is still being typed is incomplete: wait for a longer pause
    // before flagging an unclosed bracket or string.
    if (msg && typing && /unexpected end of input|INCOMPLETE_STRING/.test(msg)) {
      scheduleCheck(model, 2600);
      return;
    }
    if (msg) markers.push(markerFor(model, regions[i], msg));
  });
  monaco.editor.setModelMarkers(model, OWNER, markers);
  // Code that parses: look for problems once typing has paused a little longer.
  if (!markers.length) scheduleLint(model, Math.max(300, 1500 - (Date.now() - (lastEdit.get(model) ?? 0))));
}

// ---------------------------------------------------------------- problems (codetools)

const LINT_OWNER = 'r-lint';
const LINT_MAX_LINES = 4000;
const lintTimers = new WeakMap<monaco.editor.ITextModel, number>();
const pendingLints = new Set<monaco.editor.ITextModel>();

function scheduleLint(model: monaco.editor.ITextModel, delay: number) {
  clearTimeout(lintTimers.get(model));
  lintTimers.set(model, window.setTimeout(() => void lintModel(model), delay));
}

/**
 * Check each R region with codetools. R works in slices of ~100 ms (results
 * for unchanged statements are cached in R), so a long first check never
 * holds up code you run; it stops when you edit and picks up when R is idle.
 */
async function lintModel(model: monaco.editor.ITextModel) {
  if (model.isDisposed()) return;
  if (!settings.lint) {
    monaco.editor.setModelMarkers(model, LINT_OWNER, []);
    return;
  }
  const version = model.getVersionId();
  const markers: monaco.editor.IMarkerData[] = [];
  for (const region of rRegions(model)) {
    if (region.text.split('\n').length > LINT_MAX_LINES) continue;
    for (;;) {
      if (!session.idle) {
        pendingLints.add(model);
        return;
      }
      const res = await ask(`.ide_lint(${rString(region.text)}, 0.1)`, 0);
      if (!res || model.isDisposed() || model.getVersionId() !== version) return;
      for (let i = 1; i + 1 < res.length; i += 2) markers.push(lintMarker(model, region.line + Number(res[i]) - 1, res[i + 1]));
      if (res[0] === '1') break;
      markers.length = 0; // partial: the next call returns this region's full list
      await new Promise((r) => setTimeout(r, 30)); // let queued work (your code) run first
    }
  }
  if (model.getVersionId() === version) monaco.editor.setModelMarkers(model, LINT_OWNER, markers);
}

/** A codetools message → a friendlier warning on the name it's about. */
function lintMarker(model: monaco.editor.ITextModel, line: number, msg: string): monaco.editor.IMarkerData {
  line = Math.max(1, Math.min(line, model.getLineCount()));
  const text = model.getLineContent(line);
  const quoted = /[‘'"`]([^’'"`]+)[’'"`]/.exec(msg)?.[1];
  let message = msg;
  let name = quoted;
  let m: RegExpExecArray | null;
  if (/no visible global function definition/.test(msg)) message = `Unknown function '${quoted}': not defined, or its package isn't loaded`;
  else if ((m = /assigned but may not be used/.exec(msg))) message = `'${quoted}' is assigned but never used`;
  else if ((m = /^possible error in ([\w.:]+)\(.*\): (.*)$/.exec(msg))) {
    name = m[1];
    message = `${m[1]}(): ${m[2]}`;
  }
  let start = 1;
  let end = text.length + 1;
  if (name) {
    const at = new RegExp(`(^|[^\\w.])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w.])`).exec(text);
    if (at) {
      start = at.index + at[1].length + 1;
      end = start + at[2].length;
    }
  }
  if (start === 1) start = (/^\s*/.exec(text)?.[0].length ?? 0) + 1;
  return { severity: monaco.MarkerSeverity.Warning, source: 'codetools', message, startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: Math.max(end, start + 1) };
}

/** Turn R's parse error into a marker on the offending token. */
function markerFor(model: monaco.editor.ITextModel, region: RRegion, msg: string): monaco.editor.IMarkerData {
  const m = /^<text>:(\d+):(\d+): (.*)$/m.exec(msg);
  const what = m ? m[3] : msg.split('\n')[0];
  const base = { severity: monaco.MarkerSeverity.Error, source: 'R' };
  // Code that just stops: point at what was left open instead of the end.
  if (/unexpected end of input|INCOMPLETE_STRING/.test(what)) {
    const { open, quoteAt } = scanR(region.text);
    const at = quoteAt >= 0 ? quoteAt : open.length ? open[open.length - 1].at : -1;
    if (at >= 0) {
      const p = offsetToPos(region, at);
      const close = quoteAt >= 0 ? region.text[quoteAt] : { '(': ')', '[': ']', '{': '}' }[open[open.length - 1].ch];
      return {
        ...base,
        message: quoteAt >= 0 ? `Unterminated string: missing closing ${close}` : `Unmatched '${region.text[at]}': missing '${close}'`,
        startLineNumber: p.lineNumber,
        startColumn: p.column,
        endLineNumber: p.lineNumber,
        endColumn: p.column + 1,
      };
    }
  }
  const line = m ? region.line + Number(m[1]) - 1 : region.line;
  const lineText = model.getLineContent(Math.min(line, model.getLineCount()));
  // R's column is the last character of the token it choked on.
  let end = m ? Math.max(1, Math.min(Number(m[2]), lineText.length)) : lineText.length;
  if (end === 0) end = 1;
  let start = end;
  const tok = /unexpected (?:symbol|numeric constant|string constant)/.test(what);
  if (tok) while (start > 1 && /[\w.'"]/.test(lineText[start - 2])) start--;
  // Inside an unclosed ( or [: say which one, it's usually the real problem.
  let hint = '';
  if (m) {
    const lines = region.text.split('\n');
    const offset = lines.slice(0, Number(m[1]) - 1).reduce((n, l) => n + l.length + 1, 0) + start - 1;
    const open = scanR(region.text.slice(0, offset)).open.pop();
    if (open && open.ch !== '{') {
      const p = offsetToPos(region, open.at);
      const close = open.ch === '(' ? ')' : ']';
      if (p.lineNumber < line) hint = ` — the '${open.ch}' on line ${p.lineNumber} is still open: missing '${close}' or ','?`;
    }
  }
  return {
    ...base,
    message: `Syntax error: ${what}${hint}`,
    startLineNumber: line,
    startColumn: start,
    endLineNumber: line,
    endColumn: Math.max(end + 1, start + 1),
  };
}

function offsetToPos(region: RRegion, offset: number): monaco.IPosition {
  const before = region.text.slice(0, offset);
  const nl = before.lastIndexOf('\n');
  const lineNumber = region.line + (before.match(/\n/g)?.length ?? 0);
  return { lineNumber, column: offset - nl };
}

/**
 * Everything this module registers. When the dev server reloads the module,
 * the previous copy's registrations are removed first, or every edit would
 * add another copy of each suggestion.
 */
const subs: { dispose(): void }[] = [];
const g = globalThis as { __rLanguageSubs?: { dispose(): void }[] };
g.__rLanguageSubs?.forEach((d) => d.dispose());
g.__rLanguageSubs = subs;

function watchModel(model: monaco.editor.ITextModel) {
  scheduleCheck(model, 200);
  subs.push(
    model.onDidChangeContent(() => {
      lastEdit.set(model, Date.now());
      scheduleCheck(model);
    }),
    model.onDidChangeLanguage(() => scheduleCheck(model, 0)),
    model.onWillDispose(() => {
      clearTimeout(checkTimers.get(model));
      clearTimeout(lintTimers.get(model));
      pendingChecks.delete(model);
      pendingLints.delete(model);
    }),
  );
}
subs.push(monaco.editor.onDidCreateModel(watchModel));
for (const m of monaco.editor.getModels()) watchModel(m);

const offSession = session.on((ev) => {
  if (ev.type === 'install' || (ev.type === 'status' && ev.status !== 'ready')) {
    helpCache.clear();
    sigCache.clear();
  }
  if (ev.type === 'idle' && pendingChecks.size) {
    const list = [...pendingChecks];
    pendingChecks.clear();
    for (const m of list) scheduleCheck(m, 100);
  }
  if (ev.type === 'idle' && pendingLints.size) {
    const list = [...pendingLints];
    pendingLints.clear();
    for (const m of list) scheduleLint(m, 300);
  }
  // Running code can define functions or load packages: recheck open files.
  if (ev.type === 'idle' && settings.lint)
    for (const m of monaco.editor.getModels()) if (['r', 'quarto'].includes(m.getLanguageId())) scheduleLint(m, 800);
  // Recheck everything once R is up (models opened while it was starting).
  if (ev.type === 'status' && ev.status === 'ready') for (const m of monaco.editor.getModels()) scheduleCheck(m, 300);
});

// ---------------------------------------------------------------- signatures

interface Sig {
  params: { name: string; def: string }[];
}
const sigCache = new Map<string, { at: number; sig: Sig | null }>();

/** Arguments of an R function, or null if it isn't one. Cached briefly. */
export async function signatureOf(fn: string): Promise<Sig | null> {
  const hit = sigCache.get(fn);
  if (hit && performance.now() - hit.at < 10000) return hit.sig;
  const res = await ask(`.ide_signature(${rString(fn)})`);
  if (!res) return null;
  const params: Sig['params'] = [];
  if (res[0] !== '\x02') for (let i = 0; i + 1 < res.length; i += 2) params.push({ name: res[i], def: res[i + 1] });
  const sig = res.length ? { params } : null;
  sigCache.set(fn, { at: performance.now(), sig });
  return sig;
}

function signatureLabel(fn: string, sig: Sig): { label: string; ranges: [number, number][] } {
  let label = `${fn}(`;
  const ranges: [number, number][] = [];
  sig.params.forEach((p, i) => {
    if (i) label += ', ';
    const start = label.length;
    label += p.def ? `${p.name} = ${p.def}` : p.name;
    ranges.push([start, label.length]);
  });
  return { label: label + ')', ranges };
}

/** Which parameter the argument being typed fills, following R's matching. */
function activeParam(sig: Sig, argTexts: string[]): number {
  const names = sig.params.map((p) => p.name);
  const dots = names.indexOf('...');
  const used = new Set<number>();
  const named = (t: string) => /^\s*([A-Za-z.][\w.]*|`[^`]+`)\s*=(?!=)/.exec(t)?.[1].replace(/^`|`$/g, '') ?? null;
  const match = (n: string) => {
    const exact = names.indexOf(n);
    if (exact >= 0) return exact;
    const partial = names.findIndex((p, i) => (dots < 0 || i < dots) && p.startsWith(n) && !used.has(i));
    return partial >= 0 ? partial : dots;
  };
  for (const t of argTexts.slice(0, -1)) {
    const n = named(t);
    if (n !== null) used.add(match(n));
  }
  let pos = 0;
  const nextPositional = () => {
    while (pos < names.length && (used.has(pos) || names[pos] === '...')) {
      if (names[pos] === '...') return dots;
      pos++;
    }
    return pos < names.length ? pos : dots;
  };
  argTexts.forEach((t, i) => {
    const last = i === argTexts.length - 1;
    const n = named(t);
    if (last) return;
    if (n === null) {
      const k = nextPositional();
      if (k >= 0 && k !== dots) used.add(k);
    }
  });
  const cur = argTexts[argTexts.length - 1];
  const n = named(cur);
  return n !== null ? match(n) : nextPositional();
}

/** The innermost function call around the cursor and the text of its arguments so far. */
export function enclosingCall(model: monaco.editor.ITextModel, position: monaco.IPosition): { fn: string; args: string[] } | null {
  const start = regionStart(model, position.lineNumber);
  if (start === null) return null;
  const from = Math.max(start, position.lineNumber - 200);
  const upTo = model.getValueInRange(new monaco.Range(from, 1, position.lineNumber, position.column));
  const { open, quoteAt } = scanR(upTo);
  if (quoteAt >= 0) return null; // typing a string
  for (let k = open.length - 1; k >= 0; k--) {
    const o = open[k];
    if (o.ch === '{') return null;
    if (o.ch !== '(') continue;
    if (!o.fn) return null;
    const bounds = [...o.args, upTo.length + 1];
    return { fn: o.fn, args: o.args.map((s, i) => upTo.slice(s, bounds[i + 1] - 1)) };
  }
  return null;
}

const namedArg = (t: string) => /^\s*([A-Za-z.][\w.]*|`[^`]+`)\s*=(?!=)/.exec(t)?.[1].replace(/^`|`$/g, '') ?? null;

const signatureProvider: monaco.languages.SignatureHelpProvider = {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [')'],
  async provideSignatureHelp(model, position) {
    if (!isRCode(model, position.lineNumber)) return null;
    const call = enclosingCall(model, position);
    if (!call) return null;
    const sig = await signatureOf(call.fn);
    if (!sig) return null;
    const argTexts = call.args;
    const { label, ranges } = signatureLabel(call.fn, sig);
    const active = sig.params.length ? activeParam(sig, argTexts) : -1;
    return {
      value: {
        signatures: [{ label, parameters: ranges.map((r) => ({ label: r })) }],
        activeSignature: 0,
        activeParameter: active,
      },
      dispose() {},
    };
  },
};

// ---------------------------------------------------------------- hover

// ---------------------------------------------------------------- completions

const helpCache = new Map<string, { until: number; value: Promise<string[] | null> }>();
/**
 * Cached R help lookups (summary or argument texts) for a function. Help only
 * changes when packages are installed or R restarts, which clear the cache.
 * A topic with no help is retried after a while (a library() call may add it);
 * a lookup that failed because R was busy isn't kept at all.
 */
function helpFor(kind: 'summary' | 'args', fn: string): Promise<string[] | null> {
  const key = `${kind}:${fn}`;
  const hit = helpCache.get(key);
  if (hit && performance.now() < hit.until) return hit.value;
  const value = ask(kind === 'summary' ? `.ide_help_summary(${rString(fn)})` : `.ide_help_args(${rString(fn)})`, 1500);
  helpCache.set(key, { until: Infinity, value });
  void value.then((v) => {
    if (helpCache.get(key)?.value !== value) return;
    if (v === null) helpCache.delete(key);
    else if (!v.length) helpCache.set(key, { until: performance.now() + 15000, value });
  });
  return value;
}

type RItem = monaco.languages.CompletionItem & { _fn?: string; _arg?: string };

/** Signature, title and description of a function, as Markdown. */
async function functionDoc(fn: string): Promise<{ detail?: string; doc?: string }> {
  const sig = await signatureOf(fn);
  const help = await helpFor('summary', fn);
  const detail = sig ? signatureLabel(fn.replace(/^.*::/, ''), sig).label : undefined;
  let doc = '';
  if (help && help.length >= 3) doc = `**${help[1]}** — *${help[0]}*\n\n${help[2]}`;
  return { detail, doc };
}

const rCompletions: monaco.languages.CompletionItemProvider = {
  // "," and ", " inside a call bring the argument names back.
  triggerCharacters: ['$', '@', ':', '(', ',', ' '],
  async provideCompletionItems(model, position, context) {
    const none = { suggestions: [] };
    if (!isRCode(model, position.lineNumber)) return none;
    const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const trig = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : null;
    const call = enclosingCall(model, position);
    const argStart = /(^|[(,])\s*$/.test(lineBefore) || (/^\s*$/.test(lineBefore) && !!call);
    if (trig === ' ' && !/,\s$/.test(lineBefore)) return none;
    if ((trig === ',' || trig === ' ' || trig === '(') && !(argStart && call)) return none;

    // Inside a call, complete as if the call started on this line, so R
    // offers its arguments even when the call spans several lines.
    const current = call ? call.args[call.args.length - 1].replace(/\s*\n\s*/g, ' ').trimStart() : '';
    let res = await completions(call ? `${call.fn}(${current}` : lineBefore);
    if (!res.items.length && call) res = await completions(lineBefore);
    const { token, items, fn } = res;
    if (!items.length) return none;

    const sig = call ? await signatureOf(call.fn) : null;
    const used = new Set(call ? call.args.slice(0, -1).map(namedArg).filter((n): n is string => !!n) : []);
    // Functions that take their data through "..." (c, list, paste, ...): the
    // argument names after each comma would just get in the way.
    if (argStart && trig && sig && sig.params[0]?.name === '...') return none;

    const range = new monaco.Range(position.lineNumber, position.column - token.length, position.lineNumber, position.column);
    const parenFollows = model.getLineContent(position.lineNumber).slice(position.column - 1).trimStart().startsWith('(');
    const K = monaco.languages.CompletionItemKind;
    const nextArg = sig && call ? activeParam(sig, call.args) : -1;
    const suggestions: RItem[] = [];
    items.slice(0, 500).forEach((label, i) => {
      const isArg = /=\s*$/.test(label) && !!call;
      if (isArg) {
        const name = label.replace(/\s*=\s*$/, '');
        if (used.has(name)) return;
        const p = sig?.params.findIndex((x) => x.name === name) ?? -1;
        suggestions.push({
          label: { label: `${name} =`, description: p >= 0 && sig!.params[p].def ? sig!.params[p].def : undefined },
          kind: K.Field,
          insertText: `${name} = `,
          filterText: name,
          range,
          // The function's own order; arguments of a generic's methods follow, in R's order.
          sortText: `0${String(p >= 0 ? p : 500 + i).padStart(4, '0')}`,
          preselect: p >= 0 && p === nextArg,
          command: undefined,
          _fn: call!.fn,
          _arg: name,
        });
        return;
      }
      if (label === '...') return;
      // While choosing an argument, only the argument names.
      if (argStart && trig) return;
      const isFn = fn[i] && !parenFollows;
      suggestions.push({
        label,
        kind: fn[i] ? K.Function : label.includes('::') ? K.Module : K.Variable,
        insertText: isFn ? `${label.replace(/[\\$}]/g, '\\$&')}($0)` : label,
        insertTextRules: isFn ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        // Then offer the function's argument names.
        command: isFn ? { id: 'editor.action.triggerSuggest', title: 'Arguments' } : undefined,
        range,
        sortText: `1${String(i).padStart(5, '0')}`,
        _fn: fn[i] ? label : undefined,
      });
    });
    return { suggestions };
  },
  async resolveCompletionItem(item: RItem) {
    if (item._arg && item._fn) {
      const args = await helpFor('args', item._fn);
      if (args) {
        for (let i = 0; i + 1 < args.length; i += 2) {
          if (args[i] === item._arg) {
            item.documentation = { value: `\`${item._arg}\` — argument of \`${item._fn}()\`\n\n${args[i + 1]}` };
            break;
          }
        }
      }
      const def = (await signatureOf(item._fn))?.params.find((p) => p.name === item._arg)?.def;
      item.detail = def ? `${item._arg} = ${def}  (default)` : item._arg;
    } else if (item._fn) {
      const { detail, doc } = await functionDoc(item._fn);
      if (detail) item.detail = detail;
      if (doc) item.documentation = { value: doc };
    }
    return item;
  },
};

const KEYWORDS = /^(if|else|for|while|repeat|function|return|in|next|break|TRUE|FALSE|NULL|NA|Inf|NaN)$/;

/** The R name (optionally pkg::name) under the cursor, if any. */
export function symbolAt(model: monaco.editor.ITextModel, position: monaco.IPosition): { name: string; range: monaco.Range } | null {
  const line = model.getLineContent(position.lineNumber);
  const re = /[A-Za-z.][\w.]*(?:::?:?[A-Za-z.][\w.]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const s = m.index + 1;
    const e = s + m[0].length;
    if (position.column < s || position.column > e) continue;
    if (/[$@]\s*$/.test(line.slice(0, m.index)) || KEYWORDS.test(m[0]) || /^\.?\d/.test(m[0])) return null;
    return { name: m[0], range: new monaco.Range(position.lineNumber, s, position.lineNumber, e) };
  }
  return null;
}

const hoverProvider: monaco.languages.HoverProvider = {
  async provideHover(model, position) {
    if (!isRCode(model, position.lineNumber)) return null;
    const sym = symbolAt(model, position);
    if (!sym) return null;
    const sig = await signatureOf(sym.name);
    if (!sig) return null;
    const help = await helpFor('summary', sym.name);
    const parts = [{ value: '```r\n' + signatureLabel(sym.name.replace(/^.*::/, ''), sig).label + '\n```' }];
    if (help && help.length >= 3) {
      parts.push({ value: `**${help[1]}**${help[0] ? ` — *${help[0]}*` : ''}` });
      if (help[2]) parts.push({ value: help[2] });
    }
    return { range: sym.range, contents: parts };
  },
};

// ---------------------------------------------------------------- outline

export interface OutlineItem {
  name: string;
  kind: 'section' | 'function' | 'heading' | 'chunk';
  line: number;
  /** Nesting for display: heading / section level, functions one deeper. */
  level: number;
}

const SECTION = /^\s*(#+)\s*(.*?)\s*(?:-{4,}|={4,}|#{4,})\s*$/;
const FUNCTION = /^\s*([A-Za-z.][\w.]*|`[^`]+`)\s*(?:<<?-|=)\s*(?:function\b|\\\()/;

function rOutline(region: RRegion, baseLevel: number): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = region.text.split('\n');
  const { lineDepth } = scanR(region.text);
  let level = baseLevel;
  lines.forEach((t, i) => {
    if (lineDepth[i] > 0) return;
    const sec = SECTION.exec(t);
    if (sec && sec[2]) {
      level = baseLevel + Math.min(sec[1].length, 4) - 1;
      out.push({ name: sec[2], kind: 'section', line: region.line + i, level });
      level++;
      return;
    }
    const fn = FUNCTION.exec(t);
    if (fn) out.push({ name: fn[1].replace(/^`|`$/g, ''), kind: 'function', line: region.line + i, level });
  });
  return out;
}

export function outline(model: monaco.editor.ITextModel): OutlineItem[] {
  const lang = model.getLanguageId();
  if (lang === 'r') return rOutline({ line: 1, text: model.getValue() }, 0);
  const out: OutlineItem[] = [];
  const n = model.getLineCount();
  let level = 0;
  let ln = 0;
  // Skip the YAML header.
  if (/^---\s*$/.test(model.getLineContent(1))) for (ln = 1; ln < n && !/^---\s*$/.test(model.getLineContent(ln + 1)); ln++);
  if (ln) ln++;
  for (ln++; ln <= n; ln++) {
    const t = model.getLineContent(ln);
    if (lang === 'quarto' && CHUNK_START.test(t)) {
      const start = ln;
      const lines: string[] = [];
      while (ln + 1 <= n && !/^\s*```+\s*$/.test(model.getLineContent(ln + 1))) lines.push(model.getLineContent(++ln));
      ln++;
      const label =
        /\{\s*[rR][\s,]+([\w.-]+)/.exec(t)?.[1] ?? lines.map((l) => /^#\|\s*label:\s*["']?([^"'\s]+)/.exec(l)?.[1]).find(Boolean);
      out.push({ name: label ? `${label}` : `R chunk`, kind: 'chunk', line: start, level });
      out.push(...rOutline({ line: start + 1, text: lines.join('\n') }, level + 1));
      continue;
    }
    if (FENCE.test(t)) {
      while (ln < n && !/^\s*```+\s*$/.test(model.getLineContent(++ln)));
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*(?:\{[^}]*\})?\s*#*\s*$/.exec(t);
    if (h) {
      level = h[1].length - 1;
      out.push({ name: h[2], kind: 'heading', line: ln, level });
      level++;
    }
  }
  // Normalise levels so the shallowest item starts at 0.
  const min = Math.min(...out.map((o) => o.level));
  return out.map((o) => ({ ...o, level: o.level - (Number.isFinite(min) ? min : 0) }));
}

const symbolProvider: monaco.languages.DocumentSymbolProvider = {
  provideDocumentSymbols(model) {
    const K = monaco.languages.SymbolKind;
    return outline(model).map((o) => {
      const range = new monaco.Range(o.line, 1, o.line, model.getLineMaxColumn(o.line));
      return {
        name: o.name,
        detail: '',
        kind: o.kind === 'function' ? K.Function : o.kind === 'chunk' ? K.Module : K.String,
        tags: [],
        range,
        selectionRange: range,
      };
    });
  },
};

// ---------------------------------------------------------------- formatting

export type StyleResult = { ok: true; text: string } | { ok: false; missing: boolean; message: string };

/** Format R code with styler. `scope: 'indention'` only re-indents. */
export async function styleCode(text: string, scope: 'tokens' | 'indention' = 'tokens'): Promise<StyleResult> {
  if (session.status !== 'ready') return { ok: false, missing: false, message: 'R is still starting' };
  if (!(await session.waitIdle(3000))) return { ok: false, missing: false, message: 'R is busy' };
  let res: string[];
  try {
    res = await session.strings(`.ide_style(${rString(text)}, ${rString(scope)})`);
  } catch (e) {
    return { ok: false, missing: false, message: String(e) };
  }
  const out = res[0];
  if (out === '\x02') return { ok: false, missing: true, message: 'styler is not installed' };
  if (typeof out === 'string' && out.startsWith('\x01')) return { ok: false, missing: false, message: out.slice(1).split('\n')[0] };
  return { ok: true, text: out ?? text };
}

// ---------------------------------------------------------------- definitions

export interface DefinitionHit {
  /** Workspace path, or null for an unsaved tab. */
  path: string | null;
  uri: monaco.Uri | null;
  line: number;
  column: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const defRe = (name: string) => new RegExp(`^(\\s*)(${escapeRe(name)}|\`${escapeRe(name)}\`)\\s*(?:<<?-|=)\\s*(?:function\\b|\\\\\\()`, 'm');

function findIn(text: string, name: string): { line: number; column: number } | null {
  const m = defRe(name).exec(text);
  if (!m) return null;
  const line = text.slice(0, m.index).split('\n').length;
  return { line, column: m[1].length + 1 };
}

/** Where a function is defined: the current file first, then open tabs, then the workspace. */
export async function findDefinitions(
  name: string,
  current: monaco.editor.ITextModel | null,
  openPaths: (uri: monaco.Uri) => string | null,
): Promise<DefinitionHit[]> {
  const hits: DefinitionHit[] = [];
  const seen = new Set<string>();
  const models = monaco.editor.getModels().filter((m) => m.getLanguageId() === 'r' || m.getLanguageId() === 'quarto');
  if (current) models.sort((a) => (a === current ? -1 : 0));
  for (const m of models) {
    const p = openPaths(m.uri);
    if (p) seen.add(p);
    const at = findIn(m.getValue(), name);
    if (at) hits.push({ path: p, uri: m.uri, ...at });
  }
  if (hits.some((h) => h.uri === current?.uri)) return hits;
  for (const node of fs.flattenTree(state.tree)) {
    if (node.kind !== 'file' || seen.has(node.path) || !/\.(r|qmd|rmd)$/i.test(node.name) || (node.size ?? 0) > 2_000_000) continue;
    try {
      const at = findIn(await cachedText(state.workspace, node), name);
      if (at) hits.push({ path: node.path, uri: null, ...at });
    } catch {
      /* unreadable */
    }
  }
  return hits;
}

// ---------------------------------------------------------------- registration

subs.push({ dispose: offSession });

// Settings switched: recheck (or clear) every open file.
subs.push({
  dispose: createRoot((dispose) => {
    createEffect(
      on(
        () => [settings.syntaxCheck, settings.lint],
        () => {
          for (const m of monaco.editor.getModels()) {
            scheduleCheck(m, 0);
            if (!settings.lint) monaco.editor.setModelMarkers(m, LINT_OWNER, []);
          }
        },
        { defer: true },
      ),
    );
    return dispose;
  }),
});
for (const lang of ['r', 'quarto']) {
  subs.push(
    monaco.languages.registerCompletionItemProvider(lang, rCompletions),
    monaco.languages.registerSignatureHelpProvider(lang, signatureProvider),
    monaco.languages.registerHoverProvider(lang, hoverProvider),
    monaco.languages.registerDocumentSymbolProvider(lang, symbolProvider),
  );
}
subs.push(monaco.languages.registerDocumentSymbolProvider('markdown', symbolProvider));
