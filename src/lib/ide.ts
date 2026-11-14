import { createSignal, batch } from 'solid-js';
import { createStore } from 'solid-js/store';
import * as fs from './opfs';
import { invalidateText } from './text-cache';
import { setBoot } from './boot';
import { RSession, HOME, rString } from './r-session';
import { choiceDialog, toast } from './ui';
import { setupPackages, captureInstalls, applyLibrary, libraryNeedsRestart } from './packages';
import { loadWorkspaceConfig, wsConfig, writeLibrary, setWorkspaceSetting, onLibraryWritten, type WorkspaceLibrary } from './workspace-config';
import { checkLockfile, hashText, setRenvCheck, buildLockfile, versionChanges, compareVersions } from './renv';
import { loadRepoIndex } from './pkg-index';
import { driveServiceWorker, setDriveScope, mountDrive, unmountDrive, selfTestDrive, driveWrite, onDriveChange } from './drive/client';

// ---------------------------------------------------------------- types

export interface EnvEntry {
  name: string;
  group: 'Data' | 'Values' | 'Functions';
  cls: string;
  value: string;
  size: string;
}

export interface PackageEntry {
  name: string;
  version: string;
  attached: boolean;
  user: boolean; // in the persistent user library (vs. bundled with webR)
}

export interface EditorApi {
  openFile(path: string, opts?: { grid?: boolean }): Promise<void>;
  /** A file in the app's own storage (not a workspace), e.g. the snippets. */
  openAppFile(appPath: string, name: string, text: string): Promise<void>;
  newFile(name?: string, content?: string): void;
  saveActive(): Promise<void>;
  saveAll(): Promise<void>;
  runSelection(): void;
  sourceActive(echo: boolean): Promise<void>;
  reloadIfOpen(path: string): Promise<void>;
  onRenamed(from: string, to: string): void;
  onDeleted(path: string): void;
  insertText(text: string): void;
  getOpenState(): { open: string[]; active: string | null };
  restoreOpenState(state: { open: string[]; active: string | null }): Promise<void>;
  closeAll(force?: boolean): Promise<boolean>;
  hasDirty(): boolean;
  layout(): void;
  /** Phone key bar: move, insert, tab, undo/redo or run, in the focused editor. */
  key?(action: KeyAction): void;
  /** Text of the current line before the cursor (for the R keyboard's suggestions). */
  beforeCursor?(): string | null;
  /** Show Monaco's own suggestion popup as you type (off while the R keyboard shows its own). */
  setQuickSuggest?(on: boolean): void;
  /** Render the active Quarto / R Markdown document into the Preview tab. */
  renderActive?(): void;
  /** Open a file and select a range in it (1-based lines and columns). */
  openAt?(path: string, line: number, column: number, endLine?: number, endColumn?: number): Promise<void>;
  /** Text of a file open in a tab (with unsaved edits), or null if it isn't open. */
  openText?(path: string): string | null;
  /** Edit a file open in a tab (undoable); false if it isn't open. */
  editOpen?(path: string, edits: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[]): boolean;
  /** Run an editor command by id (command palette, outline, shortcuts). */
  command?(id: string): void;
}

export type PaneId = 'script' | 'console' | 'env' | 'plots';

export interface DebugFrame {
  /** R's frame number (for sys.frame()). */
  index: number;
  call: string;
  /** Workspace path and line of the frame's current position, if known. */
  path: string | null;
  line: number | null;
}

export interface DebugState {
  /** Paused frames, outermost first. */
  stack: DebugFrame[];
  /** Selected frame (index into stack) for the Environment pane. */
  frame: number;
  /**
   * Where R is paused (the innermost frame's current line). path is null for
   * a function without a file (typed in the console); line is then counted
   * in R's source reference.
   */
  location: { path: string | null; line: number } | null;
}

export type KeyAction =
  | { type: 'move'; dir: 'left' | 'right' | 'up' | 'down' }
  | { type: 'text'; text: string; /** Put the cursor this many characters back (for pairs). */ back?: number }
  | { type: 'tab' | 'undo' | 'redo' | 'run' | 'backspace' | 'enter' }
  /** Typed as if from a keyboard (auto-closing brackets, indentation apply). */
  | { type: 'type'; text: string }
  /** Replace the `remove` characters before the cursor (a completion). */
  | { type: 'complete'; remove: number; text: string; back?: number };

// ---------------------------------------------------------------- phone layout

/** Tabs of the phone layout: one pane on screen at a time. */
export type PhoneTab = 'files' | PaneId;
const phoneQuery = window.matchMedia('(max-width: 600px), (max-height: 500px) and (pointer: coarse)');
const [phone, setPhone] = createSignal(phoneQuery.matches);
phoneQuery.addEventListener('change', () => setPhone(phoneQuery.matches));
/** True on phone-sized screens, where panes are shown one at a time. */
export { phone };

// Tall but narrow windows (an iPad in Split View or Slide Over): the script and
// console share the screen, one above the other, under one "Code" tab. The
// layout viewport's height doesn't change when the on-screen keyboard opens,
// so this doesn't flip while typing. Phones are never this wide and tall.
const isStacked = () => window.innerWidth >= 480 && window.innerHeight >= 640;
const [stackedRaw, setStackedRaw] = createSignal(isStacked());
window.addEventListener('resize', () => setStackedRaw(isStacked()));
/** Phone layout with the script and console stacked together. */
export const stacked = () => phone() && stackedRaw();

/**
 * True while a package is downloading/installing. Stays on briefly between
 * packages (dependencies install one after another) to avoid flicker.
 */
const [installingSignal, setInstallingSignalRaw] = createSignal(false);
export const isInstalling = installingSignal;
let installOffTimer: number | undefined;
let installShowTimer: number | undefined;
let installShownAt = 0;
/**
 * Show only for installs that take a noticeable time (cached downloads finish
 * in milliseconds and would just flash), and once shown, stay up long enough
 * to read.
 */
function setInstallingSignal(on: boolean) {
  if (on) {
    if (installingSignal() || installShowTimer) return;
    installShowTimer = window.setTimeout(() => {
      installShowTimer = undefined;
      installShownAt = performance.now();
      setInstallingSignalRaw(true);
    }, 150);
  } else {
    clearTimeout(installShowTimer);
    installShowTimer = undefined;
    if (!installingSignal()) return;
    const left = 400 - (performance.now() - installShownAt);
    if (left > 0) installOffTimer = window.setTimeout(() => setInstallingSignalRaw(false), left);
    else setInstallingSignalRaw(false);
  }
}

// ---------------------------------------------------------------- state

export const session = new RSession();

const [state, setState] = createStore({
  workspace: '',
  workspaces: [] as string[],
  tree: [] as fs.FileNode[],
  expanded: {} as Record<string, boolean>,
  selectedPath: '' as string,
  rStatus: 'starting' as 'starting' | 'ready' | 'error' | 'closed',
  rStatusDetail: '',
  /** R's working directory (getwd()), refreshed whenever R goes idle. */
  rWd: '',
  busy: true,
  env: [] as EnvEntry[],
  history: [] as string[],
  packages: [] as PackageEntry[],
  envTab: 'environment' as 'environment' | 'history',
  plotTab: 'plots' as 'plots' | 'output' | 'preview' | 'packages' | 'help',
  zoomed: null as PaneId | null,
  sidebarOpen: true,
  switching: false,
  /**
   * 'drive': R reads/writes the workspace in OPFS directly (no copy in R's memory).
   * 'mirror': compatibility mode — the workspace is copied into R and synced back.
   */
  fileMode: 'mirror' as 'drive' | 'mirror',
  /** R is running but the workspace isn't attached yet. */
  attaching: false,
  /** Package installs in progress (from markers emitted by webR's installer). */
  installs: { current: null as null | { pkg: string; version: string }, done: [] as string[] },
  /** Phone layout: the pane on screen, and tabs with output not yet seen. */
  phoneTab: 'script' as PhoneTab,
  phoneBadges: { console: false, plots: false } as Record<'console' | 'plots', boolean>,
  /** R is paused at a Browse[n]> prompt (debugging). */
  debug: null as null | DebugState,
  /** Variables of the selected paused frame. */
  debugEnv: [] as EnvEntry[],
  debugOnError: false,
  /** Breakpoints of the workspace: path → lines. */
  breakpoints: {} as Record<string, number[]>,
});

let stayOnPane = false;
/** Run something that submits code without switching the phone to the Console. */
export function withoutPaneSwitch(fn: () => void) {
  stayOnPane = true;
  try {
    fn();
  } finally {
    stayOnPane = false;
  }
}

/** Desktop layout hooks (layout.ts): bring back a minimized pane; mark new output. */
let desktopPane: { reveal(p: PaneId): void; output(p: PaneId): void } | null = null;
export function onDesktopPane(h: typeof desktopPane) {
  desktopPane = h;
}

/** Bring a pane on screen: on phones its tab; on larger screens, restore it if minimized. */
export function showPane(tab: PhoneTab) {
  if (stayOnPane) return;
  if (!phone()) {
    if (tab !== 'files') desktopPane?.reveal(tab);
    return;
  }
  // Stacked: the console is on screen with the script.
  if (stacked() && tab === 'console') tab = 'script';
  batch(() => {
    setState('phoneTab', tab);
    if (tab === 'console' || tab === 'plots') setState('phoneBadges', tab, false);
  });
}

// Only output that follows something the user ran counts (not R's banner).
let badgesArmed = false;
function badge(tab: 'console' | 'plots') {
  if (badgesArmed && !phone()) desktopPane?.output(tab);
  const visible = state.phoneTab === tab || (tab === 'console' && stacked() && state.phoneTab === 'script');
  if (badgesArmed && phone() && !visible && !state.phoneBadges[tab]) setState('phoneBadges', tab, true);
}
export { state, setState };

export const [view, setView] = createSignal<null | { title: string; data: Record<string, unknown[]> }>(null);

let editorApi: EditorApi | null = null;
export function registerEditor(api: EditorApi) {
  editorApi = api;
}
export function editor(): EditorApi | null {
  return editorApi;
}

export function rRoot(ws = state.workspace): string {
  return `${HOME}/${ws}`;
}

/** Workspace-relative path → R path written with ~ (as shown in the console). */
export function rDisplayPath(path: string): string {
  return `~/${state.workspace}/${path}`;
}

// ---------------------------------------------------------------- settings

const LS_LAST_WS = 'webr-ide:last-workspace';

// ---------------------------------------------------------------- R events → state

session.on((ev) => {
  switch (ev.type) {
    case 'busy':
      setState('busy', ev.busy);
      break;
    case 'idle':
      clearTimeout(installOffTimer);
      setInstallingSignal(false);
      if (state.installs.current || state.installs.done.length) setState('installs', { current: null, done: [] });
      onIdle();
      break;
    case 'install':
      clearTimeout(installOffTimer);
      if (ev.phase === 'start') setInstallingSignal(true);
      else installOffTimer = window.setTimeout(() => setInstallingSignal(false), 500);
      if (ev.phase === 'start') setState('installs', 'current', { pkg: ev.pkg, version: ev.version });
      else
        batch(() => {
          // The last package stays in `current` until the next starts (or R goes idle).
          if (!state.installs.done.includes(ev.pkg)) setState('installs', 'done', (d) => [...d, ev.pkg]);
        });
      break;
    case 'status':
      if (ev.status !== 'ready') {
        setInstallingSignal(false);
        setState('installs', { current: null, done: [] });
      }
      setState({ rStatus: ev.status, rStatusDetail: ev.detail ?? '' });
      break;
    case 'submitted':
      if (ev.history !== false) addHistory(ev.line);
      badgesArmed = true;
      // Code run from the editor, files, environment or history: show its output.
      showPane('console');
      break;
    case 'stdout':
      noteDebugLocation(ev.text);
      badge('console');
      break;
    case 'prompt':
      onPrompt(ev.prompt);
      break;
    case 'stderr':
      badge('console');
      break;
    case 'canvasNewPage':
      badge('plots');
      break;
    case 'view':
      setView({ title: ev.title, data: ev.data });
      break;
  }
});

let idleTimer: number | undefined;
function onIdle() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(async () => {
    if (!session.idle) return;
    await refreshWd();
    await refreshEnv();
    await syncFromR();
    await cacheNewPackages();
    if (state.plotTab === 'packages') await refreshPackages();
    scheduleAutosave();
  }, 60);
}

async function cacheNewPackages() {
  try {
    const added = await captureInstalls(session);
    if (added.length) {
      const names = added.map((p) => `${p.name} ${p.version}`);
      toast(`Saved ${added.length === 1 ? names[0] : `${added.length} packages`} for offline use`);
    }
  } catch (e) {
    console.warn('package caching failed', e);
  }
}

async function initPackages() {
  const { mounted, failed, missing } = await setupPackages(session, state.workspace);
  if (mounted) console.info(`mounted ${mounted} cached packages`);
  if (failed.length) toast(`Couldn't restore cached packages: ${failed.join(', ')} — reinstall them`, 'warn', 7000);
  if (missing.length && wsConfig.library.mode === 'workspace')
    toast(`This workspace's library lists ${missing.join(', ')}, which aren't saved in this browser — install them to use them`, 'warn', 9000);
}

// Keep <workspace>/.RData in step with the global environment so a reload
// (or iPadOS evicting the tab) restores it, the way RStudio restores sessions.
let autosaveTimer: number | undefined;
let savedEnvSig: string | null = null;
const envSignature = () => JSON.stringify(state.env.map((e) => [e.name, e.cls, e.value, e.size]));

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    if (!session.idle || state.switching) return;
    const sig = envSignature();
    if (sig === savedEnvSig) return;
    if (await saveEnvironmentImage(true, { auto: true })) savedEnvSig = sig;
  }, 2500);
}

// ---------------------------------------------------------------- environment / packages

export async function refreshWd() {
  if (session.status !== 'ready') return;
  try {
    const [wd] = await session.strings('getwd()');
    if (wd !== undefined && wd !== state.rWd) setState('rWd', wd);
  } catch {
    /* keep the last one */
  }
}

/** R's working directory as shown in the console header: ~ for R's home. */
export function wdDisplay(wd = state.rWd): string {
  return wd === HOME ? '~' : wd.startsWith(HOME + '/') ? `~${wd.slice(HOME.length)}` : wd;
}

/** The working directory is inside the open workspace (files there are saved). */
export function wdInWorkspace(wd = state.rWd): boolean {
  const root = rRoot();
  return wd === root || wd.startsWith(root + '/');
}

export async function refreshEnv() {
  if (session.status !== 'ready') return;
  try {
    const flat = await session.strings('.ide_env()');
    const out: EnvEntry[] = [];
    for (let i = 0; i + 4 < flat.length; i += 5) {
      out.push({ name: flat[i], group: flat[i + 1] as EnvEntry['group'], cls: flat[i + 2], value: flat[i + 3], size: flat[i + 4] });
    }
    setState('env', out);
  } catch (e) {
    console.warn('env refresh failed', e);
  }
}

// ---------------------------------------------------------------- debugging

/** A file R names (absolute, ~/ws/…, relative or bare) → its workspace path. */
export function workspacePathOf(file: string): string | null {
  const files = fs.flattenTree(state.tree).filter((n) => n.kind === 'file');
  for (const pre of [`~/${state.workspace}/`, `${rRoot()}/`]) {
    if (file.startsWith(pre)) {
      const p = file.slice(pre.length);
      return files.some((n) => n.path === p) ? p : null;
    }
  }
  const exact = files.find((n) => n.path === file.replace(/^\.\//, ''));
  return exact?.path ?? files.find((n) => n.name === file.split('/').pop())?.path ?? null;
}

const BROWSE = /^Browse\[\d+\]> $/;
// R's "debug at file.R#12: …" while stepping ("debug at #2: …" for code
// without a file), and "file.R#12" when a breakpoint is hit.
const DEBUG_AT = /^debug at (\S*?)#(\d+):/m;
const BREAK_AT = /^(\S+?\.[A-Za-z]+)#(\d+)$/m;
let pendingLocation: { path: string | null; line: number } | null = null;
/** Paused inside a breakpoint's tracing code (one step from the real line). */
let atTracer = false;
let tracerLocation: { path: string | null; line: number } | null = null;

function noteDebugLocation(text: string) {
  const m = DEBUG_AT.exec(text);
  if (m) {
    pendingLocation = { path: m[1] ? workspacePathOf(m[1]) : null, line: Number(m[2]) };
    return;
  }
  const b = BREAK_AT.exec(text);
  if (b) {
    pendingLocation = { path: workspacePathOf(b[1]), line: Number(b[2]) };
    atTracer = true;
  }
}

function onPrompt(prompt: string) {
  if (BROWSE.test(prompt)) void enterDebug();
  else if (state.debug) {
    batch(() => {
      setState('debug', null);
      setState('debugEnv', []);
    });
    pendingLocation = null;
    tracerLocation = null;
    atTracer = false;
  }
}

/** R paused: load the call stack and the innermost frame's variables. */
async function enterDebug() {
  // A breakpoint stops inside R's tracing code: step quietly onto the line
  // itself, so Step Into and Next act on it straight away.
  if (atTracer) {
    atTracer = false;
    tracerLocation = pendingLocation;
    pendingLocation = null;
    session.submit('n', { quiet: true });
    return;
  }
  let stack: DebugFrame[] = [];
  try {
    const flat = await session.strings('.ide_debug_stack()');
    for (let i = 0; i + 3 < flat.length; i += 4)
      stack.push({ index: Number(flat[i]), call: flat[i + 1], path: flat[i + 2] ? workspacePathOf(flat[i + 2]) : null, line: flat[i + 3] ? Number(flat[i + 3]) : null });
  } catch (e) {
    console.warn('debug stack', e);
  }
  const location = pendingLocation ?? tracerLocation ?? state.debug?.location ?? null;
  pendingLocation = null;
  tracerLocation = null;
  if (stack.length && location) stack[stack.length - 1] = { ...stack[stack.length - 1], path: location.path, line: location.line };
  setState('debug', { stack, frame: Math.max(0, stack.length - 1), location });
  await loadDebugFrame(Math.max(0, stack.length - 1));
  showPane('console');
}

/** Show paused frame `i`'s variables in the Environment pane. */
export async function loadDebugFrame(i: number) {
  if (!state.debug) return;
  setState('debug', 'frame', i);
  const frame = state.debug.stack[i];
  if (!frame) return setState('debugEnv', []);
  try {
    const flat = await session.strings(`.ide_debug_env(${frame.index}L)`);
    const out: EnvEntry[] = [];
    for (let k = 0; k + 4 < flat.length; k += 5) out.push({ name: flat[k], group: flat[k + 1] as EnvEntry['group'], cls: flat[k + 2], value: flat[k + 3], size: flat[k + 4] });
    setState('debugEnv', out);
  } catch (e) {
    console.warn('debug frame', e);
  }
}

export type DebugCommand = 'next' | 'step' | 'finish' | 'continue' | 'stop';
const DEBUG_KEYS: Record<DebugCommand, string> = { next: 'n', step: 's', finish: 'f', continue: 'c', stop: 'Q' };

/** Step / continue / stop while paused (sent to the browser prompt, not to history). */
export function debugCommand(cmd: DebugCommand) {
  if (!state.debug) return;
  session.submit(DEBUG_KEYS[cmd], { history: false });
}

/** Pause where an error happens ("Debug on error"). */
export async function setDebugOnError(on: boolean) {
  setState('debugOnError', on);
  if (session.status === 'ready') await session.evalVoid(`.ide_debug_on_error(${on ? 'TRUE' : 'FALSE'})`).catch(() => {});
}

/** Set (or clear) a file's breakpoints; they take effect when the file is sourced. */
export function setBreakpoints(path: string, lines: number[]) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (sorted.length) setState('breakpoints', path, sorted);
  // (Setting a key to undefined removes it; returning a smaller object would merge.)
  else setState('breakpoints', path, undefined!);
  scheduleIdeStateSave();
}

/**
 * Apply a file's breakpoints to functions already defined from it (an earlier
 * Source), so adding or removing one takes effect without sourcing again.
 * R can be asked while idle or paused.
 */
export async function applyBreakpoints(path: string) {
  if (session.status !== 'ready' || (!session.idle && !state.debug)) return;
  const lines = state.breakpoints[path] ?? [];
  await session.evalVoid(`.ide_apply_breakpoints(${rString(rDisplayPath(path))}, c(${lines.join(',')}))`).catch((e) => console.warn('breakpoints', e));
}

export async function strOf(name: string): Promise<string[]> {
  // Paused: the selected frame's variable (R can be asked while it waits).
  const frame = state.debug?.stack[state.debug.frame];
  if (frame) return session.strings(`.ide_str(${rString(name)}, ${frame.index}L)`).catch((e) => [String(e)]);
  if (!session.idle) return ['(R is busy)'];
  try {
    return await session.strings(`.ide_str(${rString(name)})`);
  } catch (e) {
    return [String(e)];
  }
}

export async function refreshPackages() {
  if (!session.idle) return;
  try {
    const flat = await session.strings('.ide_packages()');
    const out: PackageEntry[] = [];
    for (let i = 0; i + 3 < flat.length; i += 4)
      out.push({ name: flat[i], version: flat[i + 1], attached: flat[i + 2] === '1', user: flat[i + 3] === '1' });
    setState('packages', out);
  } catch (e) {
    console.warn('packages refresh failed', e);
  }
}

/** R completions for the text before the cursor; `fn` marks functions. */
export async function completions(line: string): Promise<{ token: string; items: string[]; fn: boolean[] }> {
  // R can also be asked while paused in the debugger.
  if (!state.debug && !(await session.waitIdle(1500))) return { token: '', items: [], fn: [] };
  try {
    const all = await session.strings(`.ide_complete(${rString(line)})`);
    const res = all.slice(1);
    const fn = res.map((s) => s.endsWith('\x1f('));
    const items = res.map((s, i) => (fn[i] ? s.slice(0, -2) : s));
    const token = all[0] ?? '';
    // Paused: the frame's own variables first (R completes from the global environment).
    if (state.debug && /^[A-Za-z.][\w.]*$/.test(token)) {
      const locals = state.debugEnv.map((e) => e.name).filter((n) => n.startsWith(token) && !items.includes(n));
      return { token, items: [...locals, ...items], fn: [...locals.map((n) => state.debugEnv.find((e) => e.name === n)?.group === 'Functions'), ...fn] };
    }
    return { token, items, fn };
  } catch {
    return { token: '', items: [], fn: [] };
  }
}

// ---------------------------------------------------------------- history

let historySaveTimer: number | undefined;
function addHistory(code: string) {
  const lines = code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim());
  if (!lines.length) return;
  setState('history', (h) => {
    const next = [...h];
    for (const l of lines) if (next[next.length - 1] !== l) next.push(l);
    return next.length > 2000 ? next.slice(-2000) : next;
  });
  clearTimeout(historySaveTimer);
  const ws = state.workspace;
  historySaveTimer = window.setTimeout(() => {
    if (ws === state.workspace) void fs.writeFile(ws, `${fs.IDE_DIR}/history.txt`, state.history.join('\n'));
  }, 800);
}

export function clearHistory() {
  setState('history', []);
  void fs.writeFile(state.workspace, `${fs.IDE_DIR}/history.txt`, '');
}

// ---------------------------------------------------------------- file tree

export async function refreshTree() {
  if (!state.workspace) return;
  try {
    setState('tree', await fs.listTree(state.workspace));
  } catch (e) {
    console.warn(e);
  }
}

// ---------------------------------------------------------------- OPFS ⇄ webR file sync

/** Last-seen signature of every file/dir in the R copy of the workspace. */
let snapshot = new Map<string, string>(); // path → "f:<mtime size>" | "d:"
let syncChain: Promise<void> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = syncChain.then(fn, fn);
  syncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function takeSnapshot(): Promise<Map<string, string>> {
  const flat = await session.strings(`.ide_snapshot(${rString(rRoot())})`);
  const m = new Map<string, string>();
  for (let i = 0; i + 2 < flat.length; i += 3) m.set(flat[i], `${flat[i + 1]}:${flat[i + 2]}`);
  return m;
}

/** Copy files R created/changed/deleted in its workspace dir back to OPFS. */
export function syncFromR(opts: { force?: boolean } = {}): Promise<void> {
  return serialize(async () => {
    if (session.status !== 'ready' || !state.workspace || (state.switching && !opts.force)) return;
    if (state.fileMode === 'drive') return; // R works on OPFS directly; nothing to copy back
    const ws = state.workspace;
    let next: Map<string, string>;
    try {
      next = await takeSnapshot();
    } catch {
      return;
    }
    let changed = false;
    const changedFiles: string[] = [];
    // created/modified
    for (const [path, sig] of next) {
      if (snapshot.get(path) === sig) continue;
      try {
        if (sig.startsWith('d:')) {
          await fs.mkdir(ws, path);
        } else {
          const data = await session.webR.FS.readFile(`${rRoot(ws)}/${path}`);
          await fs.writeFile(ws, path, data);
          changedFiles.push(path);
        }
        changed = true;
      } catch (e) {
        console.warn('sync from R failed for', path, e);
      }
    }
    // deleted (deepest first)
    const removed = [...snapshot.keys()].filter((p) => !next.has(p)).sort((a, b) => b.length - a.length);
    for (const path of removed) {
      try {
        await fs.remove(ws, path);
      } catch {
        /* already gone */
      }
      editorApi?.onDeleted(path);
      changed = true;
    }
    snapshot = next;
    if (changed && ws === state.workspace) {
      await refreshTree();
      for (const p of changedFiles) await editorApi?.reloadIfOpen(p);
    }
  });
}

// ---------------------------------------------------------------- workspace drive

/** Service worker able to serve the drive (set at startup). */
let driveSwOk = false;
/** Result of this R session's drive self-test: null = not run yet. */
let driveUsable: boolean | null = null;
/** Mountpoint currently mounted as a drive in R, if any. */
let driveMounted: string | null = null;

async function prepareDrive() {
  const reg = await driveServiceWorker();
  driveSwOk = !!reg;
  if (reg) setDriveScope(reg.scope);
}

/** Mount the workspace straight from OPFS. Returns false to fall back to copying. */
async function tryMountDrive(ws: string, root: string): Promise<boolean> {
  // The drive reads OPFS directly; without working storage the page keeps
  // files in memory, so R must use the copied (mirror) workspace instead.
  if (fs.isMemoryMode() || !driveSwOk || driveUsable === false || session.status !== 'ready') return false;
  try {
    await session.evalVoid(`.ide_mkdirs(${rString(root)})`);
    await mountDrive(session.webR, ws, root);
  } catch (e) {
    console.warn('drive mount failed', e);
    driveUsable = false;
    toast('Using compatibility file mode (workspace copied into R)', 'warn', 5000);
    return false;
  }
  if (driveUsable === null) {
    try {
      await selfTestDrive(session.webR, root);
      driveUsable = true;
    } catch (e) {
      console.warn('drive self-test failed', e);
      await unmountDrive(session.webR, root).catch(() => {});
      driveUsable = false;
      toast(`Using compatibility file mode — ${e}`, 'warn', 7000);
      return false;
    }
  }
  driveMounted = root;
  return true;
}

async function detachDrive() {
  if (!driveMounted) return;
  const m = driveMounted;
  driveMounted = null;
  await unmountDrive(session.webR, m).catch((e) => console.warn('unmount failed', e));
}

// Files R created, changed or deleted (drive mode) → Files pane and editor.
let driveRefreshTimer: number | undefined;
const driveChanged = new Set<string>();
onDriveChange((c) => {
  if (c.ws !== state.workspace) return;
  const visible = (p: string) => p && !p.startsWith(fs.IDE_DIR + '/') && p !== fs.IDE_DIR;
  for (const p of c.deleted) if (visible(p)) editorApi?.onDeleted(p);
  for (const p of c.changed) if (visible(p)) driveChanged.add(p);
  clearTimeout(driveRefreshTimer);
  driveRefreshTimer = window.setTimeout(async () => {
    const paths = [...driveChanged];
    driveChanged.clear();
    await refreshTree();
    for (const p of paths) await editorApi?.reloadIfOpen(p);
  }, 150);
});

/** Give R the current workspace: mounted from OPFS if possible, else copied in. */
async function loadWorkspaceIntoR(restoreImage: boolean): Promise<string> {
  const ws = state.workspace;
  const root = rRoot(ws);
  if (await tryMountDrive(ws, root)) {
    setState('fileMode', 'drive');
    snapshot = new Map();
    if (restoreImage) return (await session.strings(`.ide_open_ws(${rString(root)})`))[0] ?? '';
    await session.evalVoid(`setwd(${rString(root)})`);
    return '';
  }
  setState('fileMode', 'mirror');
  const nodes = fs.flattenTree(await fs.listTree(ws));
  const dirs = [root, ...nodes.filter((n) => n.kind === 'directory').map((n) => `${root}/${n.path}`)];
  await session.evalVoid(`.ide_mkdirs(c(${dirs.map(rString).join(',')}))`);
  for (const n of nodes) {
    if (n.kind !== 'file') continue;
    try {
      await session.webR.FS.writeFile(`${root}/${n.path}`, await fs.readFile(ws, n.path));
    } catch (e) {
      console.warn('could not load into R:', n.path, e);
    }
  }
  let restored = '';
  if (restoreImage) {
    restored = (await session.strings(`.ide_open_ws(${rString(root)})`))[0] ?? '';
  } else {
    await session.evalVoid(`setwd(${rString(root)})`);
  }
  snapshot = await takeSnapshot();
  return restored;
}

/** Write a file from the IDE into both OPFS and R. */
export async function writeWorkspaceFile(path: string, data: Uint8Array | string): Promise<void> {
  const ws = state.workspace;
  invalidateText(ws, path);
  if (state.fileMode === 'drive' && driveMounted) {
    // Through the service worker, so it waits if R is part-way through reading the file.
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    try {
      await driveWrite(ws, path, bytes);
    } catch (e) {
      console.warn('drive write failed, writing directly', e);
      await fs.writeFile(ws, path, data);
    }
    await refreshTree();
    return;
  }
  await fs.writeFile(ws, path, data);
  if (session.status === 'ready') {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    try {
      const dir = fs.dirname(path);
      if (dir) await session.evalVoid(`.ide_mkdirs(${rString(`${rRoot(ws)}/${dir}`)})`);
      await session.webR.FS.writeFile(`${rRoot(ws)}/${path}`, bytes);
    } catch (e) {
      console.warn('write to R failed', e);
    }
  }
  await syncFromR();
  await refreshTree();
}

export async function makeFolder(path: string) {
  await fs.mkdir(state.workspace, path);
  if (session.status === 'ready' && state.fileMode === 'mirror') await session.evalVoid(`.ide_mkdirs(${rString(`${rRoot()}/${path}`)})`).catch(() => {});
  setState('expanded', path, true);
  await syncFromR();
  await refreshTree();
}

export async function deletePath(path: string) {
  invalidateText(state.workspace, path);
  await fs.remove(state.workspace, path);
  if (session.status === 'ready' && state.fileMode === 'mirror')
    await session.evalVoid(`unlink(${rString(`${rRoot()}/${path}`)}, recursive = TRUE)`).catch(() => {});
  editorApi?.onDeleted(path);
  await syncFromR();
  await refreshTree();
}

export async function renamePath(from: string, to: string) {
  invalidateText(state.workspace, from);
  await fs.rename(state.workspace, from, to);
  if (session.status === 'ready' && state.fileMode === 'mirror') {
    const dir = fs.dirname(to);
    await session
      .evalVoid(
        `${dir ? `.ide_mkdirs(${rString(`${rRoot()}/${dir}`)}); ` : ''}file.rename(${rString(`${rRoot()}/${from}`)}, ${rString(`${rRoot()}/${to}`)})`,
      )
      .catch(() => {});
  }
  editorApi?.onRenamed(from, to);
  await syncFromR();
  await refreshTree();
}

export async function downloadPath(path: string) {
  const file = await fs.readFileObject(state.workspace, path);
  downloadBlob(file, fs.basename(path));
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- workspaces

const SAMPLE_SCRIPT = `# Welcome to webR IDE
# Run the current line or selection with Cmd+Enter (or the Run button).
# Source the whole file with Cmd+Shift+Enter.

summary(mtcars)

fit <- lm(mpg ~ wt, data = mtcars)
coef(fit)

plot(mtcars$wt, mtcars$mpg,
     pch = 19, col = "steelblue",
     xlab = "Weight (1000 lbs)", ylab = "Miles per gallon",
     main = "Fuel economy vs. weight")
abline(fit, col = "firebrick", lwd = 2)

hist(rnorm(1000), breaks = 30, col = "grey80", main = "Normal sample")

write.csv(head(mtcars), "mtcars_head.csv")
`;

async function saveIdeState() {
  if (!state.workspace || !editorApi || state.switching) return;
  try {
    await fs.writeFile(state.workspace, `${fs.IDE_DIR}/state.json`, JSON.stringify({ ...editorApi.getOpenState(), breakpoints: state.breakpoints }));
  } catch (e) {
    console.warn(e);
  }
}

let stateSaveTimer: number | undefined;
export function scheduleIdeStateSave() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = window.setTimeout(saveIdeState, 500);
}

async function loadIdeState(ws: string): Promise<{ open: string[]; active: string | null; breakpoints?: Record<string, number[]> } | null> {
  try {
    return JSON.parse(await fs.readText(ws, `${fs.IDE_DIR}/state.json`));
  } catch {
    return null;
  }
}

async function loadHistory(ws: string): Promise<string[]> {
  try {
    return (await fs.readText(ws, `${fs.IDE_DIR}/history.txt`)).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function refreshWorkspaces() {
  setState('workspaces', await fs.listWorkspaces());
}

/** First run: pick the last-used workspace, creating "Default" with a sample script if needed. */
export async function initWorkspaces(): Promise<string> {
  await refreshWorkspaces();
  if (!state.workspaces.length) {
    await fs.createWorkspace('Default');
    await fs.writeFile('Default', 'analysis.R', SAMPLE_SCRIPT);
    await fs.writeFile('Default', `${fs.IDE_DIR}/state.json`, JSON.stringify({ open: ['analysis.R'], active: 'analysis.R' }));
    await refreshWorkspaces();
  }
  const last = localStorage.getItem(LS_LAST_WS);
  return last && state.workspaces.includes(last) ? last : state.workspaces[0];
}

/** Open a workspace in the UI (files, tabs, history). R side is handled by attachWorkspaceToR. */
export async function openWorkspaceUI(ws: string) {
  batch(() => {
    setState('workspace', ws);
    setState('selectedPath', '');
    setState('expanded', {});
    setState('env', []);
  });
  localStorage.setItem(LS_LAST_WS, ws);
  document.title = `${ws} — webR IDE`;
  await loadWorkspaceConfig(ws);
  await refreshTree();
  setState('history', await loadHistory(ws));
  const ide = await loadIdeState(ws);
  setState('breakpoints', ide?.breakpoints ?? {});
  if (ide && editorApi) await editorApi.restoreOpenState(ide);
}

export async function attachWorkspaceToR(restoreImage: boolean) {
  if (session.status !== 'ready') return;
  setState('attaching', true);
  try {
    const restored = await loadWorkspaceIntoR(restoreImage);
    if (restored === 'restored') toast('Restored environment from .RData');
    if (state.debugOnError) await session.evalVoid('.ide_debug_on_error(TRUE)').catch(() => {});
    runRprofile();
    await refreshWd();
    await refreshEnv();
    savedEnvSig = envSignature();
    void checkRenv({ auto: true });
  } catch (e) {
    toast(`Failed to load workspace into R: ${e}`, 'error');
  } finally {
    setState('attaching', false);
  }
}

/**
 * Run the workspace's .Rprofile (and .First(), if it defines one), as R does
 * at start-up. Runs in the console without an echo, so its output and errors
 * show there. Unlike R, this happens after .RData is restored.
 */
function runRprofile() {
  if (wsConfig.settings.runRprofile === false) return;
  if (!state.tree.some((n) => n.kind === 'file' && n.path === '.Rprofile')) return;
  session.submit('.ide_run_rprofile()', { quiet: true });
}

/**
 * Check the workspace's renv.lock against what webR can install and show the
 * result. `auto`: only if this version of the lockfile hasn't been checked.
 */
export async function checkRenv(opts: { auto?: boolean } = {}) {
  const ws = state.workspace;
  if (!state.tree.some((n) => n.kind === 'file' && n.path === 'renv.lock')) {
    if (!opts.auto) toast('This workspace has no renv.lock', 'warn');
    return;
  }
  let text: string;
  try {
    text = await fs.readText(ws, 'renv.lock');
  } catch {
    return;
  }
  if (opts.auto && wsConfig.settings.renvChecked === (await hashText(text))) return;
  const builtin = new Map<string, string>();
  if (session.status === 'ready' && (await session.waitIdle(5000))) {
    const flat = await session.strings('.ide_builtin_pkgs()').catch(() => [] as string[]);
    for (let i = 0; i + 1 < flat.length; i += 2) builtin.set(flat[i], flat[i + 1]);
  }
  const rv = session.versionR ? session.versionR.split('.').slice(0, 2).join('.') : '4.6';
  try {
    setRenvCheck(await checkLockfile(text, rv, builtin));
  } catch (e) {
    toast(`Couldn't read renv.lock: ${e}`, 'error');
  }
}

/**
 * Write renv.lock for desktop R (renv::restore()). Packages: the workspace's
 * own library, or with the shared library, the packages loaded now.
 */
export async function writeRenvLock(opts: { quiet?: boolean } = {}) {
  const ws = state.workspace;
  if (!ws) return;
  let packages: Record<string, string> = {};
  if (wsConfig.library.mode === 'workspace') packages = { ...wsConfig.library.packages };
  else if (session.status === 'ready' && (await session.waitIdle(5000))) {
    const flat = await session.strings('.ide_pkg_snapshot()');
    for (let i = 0; i + 1 < flat.length; i += 2) packages[flat[i]] = flat[i + 1];
  }
  const builtin = new Set<string>();
  if (session.status === 'ready' && session.idle) {
    const flat = await session.strings('.ide_builtin_pkgs()').catch(() => [] as string[]);
    for (let i = 0; i < flat.length; i += 2) builtin.add(flat[i]);
  }
  const rVersion = session.versionR || '4.6.0';
  const index = await loadRepoIndex(rVersion.split('.').slice(0, 2).join('.')).catch(() => null);
  const existing = await fs.readText(ws, 'renv.lock').catch(() => null);
  // Pinned versions that would change: ask (once per workspace) before rewriting them.
  const changes = versionChanges(existing, packages);
  let keepLocked = false;
  if (changes.length) {
    let choice = wsConfig.settings.renvVersions;
    if (!choice) {
      const shown = changes.slice(0, 8).map((c) => `• ${c.name}: ${c.locked} → ${c.webr}${compareVersions(c.webr, c.locked) < 0 ? ' (older)' : ''}`);
      if (changes.length > 8) shown.push(`• …and ${changes.length - 8} more`);
      const r = await choiceDialog(
        'renv.lock pins other versions',
        `This workspace uses different versions than renv.lock pins. webR only has the current build of each package.\n\n${shown.join('\n')}\n\n` +
          `Use webR's versions: desktop R will get the versions that ran here.\nKeep locked versions: those entries stay as they are; new packages are still added.\n\nYour choice is remembered for this workspace (Settings → This workspace).`,
        "Use webR's Versions",
        { label: 'Keep Locked Versions', value: 'keep' },
      );
      if (r === null) return;
      choice = r === 'keep' ? 'keep' : 'update';
      await setWorkspaceSetting('renvVersions', choice);
    }
    keepLocked = choice === 'keep';
  }
  const text = buildLockfile(existing, packages, { rVersion, index, builtin, keepLocked });
  if (text === existing) {
    if (!opts.quiet) toast('renv.lock is already up to date');
    return;
  }
  await writeWorkspaceFile('renv.lock', text);
  // Written here, so no need to check it on the next open.
  await setWorkspaceSetting('renvChecked', await hashText(text));
  await refreshTree();
  await editorApi?.reloadIfOpen('renv.lock');
  if (!opts.quiet) {
    const n = Object.keys(packages).length;
    const pinned = keepLocked && changes.length ? ` (${changes.length} kept at locked versions)` : '';
    toast(
      wsConfig.library.mode === 'workspace'
        ? `Wrote renv.lock (${n} packages${pinned}) — run renv::restore() in desktop R`
        : `Wrote renv.lock with the ${n} packages loaded now${pinned} — run renv::restore() in desktop R`,
      'info',
      6000,
    );
  }
}

// Keep renv.lock in step with a workspace's own library, if asked to.
onLibraryWritten((ws) => {
  if (ws === state.workspace && wsConfig.settings.renvSync && wsConfig.library.mode === 'workspace') void writeRenvLock({ quiet: true });
});

/** Mark the lockfile as checked (the dialog was answered). */
export async function markRenvChecked(hash: string) {
  await setWorkspaceSetting('renvChecked', hash);
}

/** Automatic saves skip environments larger than this (manual saves don't). */
const AUTOSAVE_MAX_BYTES = 100 * 1024 * 1024;
let autosaveCapWarned = '';

/** Save the global environment to <workspace>/.RData. */
export async function saveEnvironmentImage(silent = false, opts: { auto?: boolean } = {}): Promise<boolean> {
  if (!session.idle) {
    if (!silent) toast('R is busy — try again when the current command finishes', 'warn');
    return false;
  }
  try {
    const cap = opts.auto ? String(AUTOSAVE_MAX_BYTES) : 'Inf';
    const result = (await session.strings(`.ide_save_image(${rString(rRoot())}, ${cap})`))[0] ?? '';
    if (result.startsWith('skipped:')) {
      const mb = Math.round(Number(result.slice(8)) / 1048576);
      if (autosaveCapWarned !== state.workspace) {
        autosaveCapWarned = state.workspace;
        toast(`Environment is ${mb} MB, so it isn't saved automatically (limit 100 MB). Use Save Environment to keep it.`, 'warn', 8000);
      }
      return false;
    }
    await syncFromR({ force: true });
    if (!silent) toast('Environment saved to .RData');
    return true;
  } catch (e) {
    if (!silent) toast(`Could not save environment: ${e}`, 'error');
    return false;
  }
}

export async function switchWorkspace(ws: string, opts: { saveImage?: boolean } = {}) {
  if (ws === state.workspace || state.switching) return;
  if (session.status === 'ready' && !session.idle) {
    toast('R is busy — interrupt it before switching workspaces', 'warn');
    return;
  }
  // Remember open tabs before closing them.
  if (state.workspace) await saveIdeState();
  setState('switching', true); // also suppresses tab-state saves while tabs close
  if (editorApi && !(await editorApi.closeAll())) {
    setState('switching', false);
    return;
  }
  try {
    if (session.status === 'ready' && state.workspace) {
      if (opts.saveImage !== false) await saveEnvironmentImage(true, { auto: true });
      await syncFromR({ force: true });
      if (state.fileMode === 'drive') {
        // The mounted folder is the user's files: detach, never delete.
        await session.evalVoid('.ide_detach_ws()').catch(() => {});
        await detachDrive();
      } else {
        await session.evalVoid(`.ide_clear_ws(${rString(rRoot())})`).catch(() => {});
      }
    }
    snapshot = new Map();
    clearTimeout(autosaveTimer);
    await openWorkspaceUI(ws);
  } finally {
    setState('switching', false);
  }
  scheduleIdeStateSave();
  // A fresh R for the new workspace (as RStudio does when it opens another
  // project): nothing carries over, not attached packages or data, options(),
  // environment variables or traced functions. The restart also applies the
  // workspace's package library and restores its .RData.
  if (session.status === 'ready') await restartSession({ switching: true });
  else await attachWorkspaceToR(true);
  await refreshWorkspaces();
}

/** Point the session's library at `lib`; false if R has to restart for it. */
async function useLibrary(lib: WorkspaceLibrary): Promise<boolean> {
  if (await libraryNeedsRestart(session, lib)) return false;
  return applyLibrary(session, lib);
}

/**
 * Give the current workspace its own package library (starting with the
 * packages loaded now), or go back to the shared one.
 */
export async function setLibraryMode(mode: WorkspaceLibrary['mode'], start?: Record<string, string>) {
  const ws = state.workspace;
  if (!ws || (wsConfig.library.mode === mode && !start)) return;
  if (session.status === 'ready' && !session.idle) return toast('R is busy — try again when it finishes', 'warn');
  let packages: Record<string, string> = start ?? {};
  if (mode === 'workspace' && session.status === 'ready' && !start) {
    const flat = await session.strings('.ide_pkg_snapshot()');
    for (let i = 0; i + 1 < flat.length; i += 2) packages[flat[i]] = flat[i + 1];
  }
  const lib: WorkspaceLibrary = { mode, packages: mode === 'workspace' ? packages : wsConfig.library.packages };
  await writeLibrary(ws, lib);
  if (session.status !== 'ready') return;
  if (await useLibrary(lib)) {
    toast(mode === 'workspace' ? `"${ws}" now has its own library (${Object.keys(packages).length} packages)` : `"${ws}" uses the shared library`);
    await refreshPackages();
  } else {
    toast('Restarting R to switch libraries…');
    await saveEnvironmentImage(true, { auto: true });
    await restartSession({ switching: true });
  }
}

export async function createWorkspace(name: string, template = true) {
  await fs.createWorkspace(name);
  if (template) await fs.writeFile(name, 'script.R', '# New workspace\n\n');
  await fs.writeFile(name, `${fs.IDE_DIR}/state.json`, JSON.stringify({ open: template ? ['script.R'] : [], active: 'script.R' }));
  await refreshWorkspaces();
  await switchWorkspace(name);
}

export async function renameCurrentWorkspace(to: string) {
  const from = state.workspace;
  if (!session.idle && session.status === 'ready') {
    toast('R is busy', 'warn');
    return;
  }
  await saveIdeState();
  await syncFromR();
  const drive = state.fileMode === 'drive' && session.status === 'ready';
  if (drive) {
    await session.evalVoid(`setwd(${rString(HOME)})`);
    await detachDrive();
  } else if (session.status === 'ready') {
    // Move the R copy too, so the session keeps running.
    await session.evalVoid(`setwd(${rString(HOME)}); file.rename(${rString(rRoot(from))}, ${rString(rRoot(to))}); setwd(${rString(rRoot(to))})`);
  }
  await fs.renameWorkspace(from, to);
  setState('workspace', to);
  if (drive) {
    if (await tryMountDrive(to, rRoot(to))) await session.evalVoid(`setwd(${rString(rRoot(to))})`);
    else {
      setState('fileMode', 'mirror');
      await attachWorkspaceToR(false);
    }
  }
  localStorage.setItem(LS_LAST_WS, to);
  document.title = `${to} — webR IDE`;
  await refreshWorkspaces();
  await refreshTree();
}

export async function deleteWorkspace(name: string) {
  if (name === state.workspace) {
    const other = state.workspaces.find((w) => w !== name);
    if (!other) {
      await fs.createWorkspace('Default');
      await refreshWorkspaces();
      await switchWorkspace('Default', { saveImage: false });
    } else {
      await switchWorkspace(other, { saveImage: false });
    }
    if (state.workspace === name) return; // switch cancelled
  }
  await fs.deleteWorkspace(name);
  await refreshWorkspaces();
}

// ---------------------------------------------------------------- R lifecycle

export let plotSize = { width: 560, height: 420 };
export function setPlotSizeHint(w: number, h: number) {
  plotSize = { width: w, height: h };
}

export async function startR() {
  try {
    // The drive service worker must control the page before webR's worker starts.
    setBoot({ label: 'Preparing' });
    await prepareDrive();
    await session.start(plotSize, initPackages);
    await session.setPlotSize(plotSize.width, plotSize.height);
    setBoot({ label: 'Opening your workspace' });
    await attachWorkspaceToR(true);
  } catch (e) {
    toast(`webR failed to start: ${e}`, 'error');
  } finally {
    setBoot(null);
  }
}

export async function restartR() {
  await restartSession();
  toast('R session restarted');
}

/**
 * Restart R and reattach the workspace. `switching`: called part-way through
 * a workspace switch, when R doesn't hold the new workspace's files yet (so
 * there's nothing to sync back) and its saved environment should be restored.
 */
async function restartSession(opts: { switching?: boolean } = {}) {
  setState('env', []);
  if (!opts.switching) {
    try {
      await syncFromR();
    } catch {
      /* ignore */
    }
  }
  snapshot = new Map();
  driveMounted = null; // the old session's mounts go away with it
  setState('fileMode', 'mirror');
  try {
    await session.restart(plotSize, initPackages);
    await session.setPlotSize(plotSize.width, plotSize.height);
    setBoot({ label: 'Opening your workspace' });
    await attachWorkspaceToR(!!opts.switching);
  } catch (e) {
    toast(`Restart failed: ${e}`, 'error');
  } finally {
    setBoot(null);
  }
}

// Save the environment when the app is backgrounded (iPad app switching).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void saveIdeState();
    if (session.idle && state.env.length) void saveEnvironmentImage(true, { auto: true });
  }
});
