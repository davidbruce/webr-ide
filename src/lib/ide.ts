import { createSignal, batch } from 'solid-js';
import { createStore } from 'solid-js/store';
import * as fs from './opfs';
import { invalidateText } from './text-cache';
import { setBoot } from './boot';
import { RSession, HOME, rString } from './r-session';
import { toast } from './ui';
import { setupPackages, captureInstalls } from './packages';
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
  busy: true,
  env: [] as EnvEntry[],
  history: [] as string[],
  packages: [] as PackageEntry[],
  help: null as null | { title: string; text: string },
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

/** On phones, bring a pane on screen (no-op on larger screens). */
export function showPane(tab: PhoneTab) {
  if (!phone() || stayOnPane) return;
  batch(() => {
    setState('phoneTab', tab);
    if (tab === 'console' || tab === 'plots') setState('phoneBadges', tab, false);
  });
}

// Only output that follows something the user ran counts (not R's banner).
let badgesArmed = false;
function badge(tab: 'console' | 'plots') {
  if (badgesArmed && phone() && state.phoneTab !== tab && !state.phoneBadges[tab]) setState('phoneBadges', tab, true);
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
      addHistory(ev.line);
      badgesArmed = true;
      // Code run from the editor, files, environment or history: show its output.
      showPane('console');
      break;
    case 'stdout':
    case 'stderr':
      badge('console');
      break;
    case 'canvasNewPage':
      badge('plots');
      break;
    case 'pager':
      batch(() => {
        setState('help', { title: ev.title, text: ev.text });
        setState('plotTab', 'help');
      });
      showPane('plots');
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
  const { mounted, failed } = await setupPackages(session);
  if (mounted) console.info(`mounted ${mounted} cached packages`);
  if (failed.length) toast(`Couldn't restore cached packages: ${failed.join(', ')} — reinstall them`, 'warn', 7000);
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

export async function strOf(name: string): Promise<string[]> {
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
  if (!(await session.waitIdle(1500))) return { token: '', items: [], fn: [] };
  try {
    const all = await session.strings(`.ide_complete(${rString(line)})`);
    const res = all.slice(1);
    const fn = res.map((s) => s.endsWith('\x1f('));
    const items = res.map((s, i) => (fn[i] ? s.slice(0, -2) : s));
    return { token: all[0] ?? '', items, fn };
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
    await fs.writeFile(state.workspace, `${fs.IDE_DIR}/state.json`, JSON.stringify(editorApi.getOpenState()));
  } catch (e) {
    console.warn(e);
  }
}

let stateSaveTimer: number | undefined;
export function scheduleIdeStateSave() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = window.setTimeout(saveIdeState, 500);
}

async function loadIdeState(ws: string): Promise<{ open: string[]; active: string | null } | null> {
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
  await refreshTree();
  setState('history', await loadHistory(ws));
  const ide = await loadIdeState(ws);
  if (ide && editorApi) await editorApi.restoreOpenState(ide);
}

export async function attachWorkspaceToR(restoreImage: boolean) {
  if (session.status !== 'ready') return;
  setState('attaching', true);
  try {
    const restored = await loadWorkspaceIntoR(restoreImage);
    if (restored === 'restored') toast('Restored environment from .RData');
    await refreshEnv();
    savedEnvSig = envSignature();
  } catch (e) {
    toast(`Failed to load workspace into R: ${e}`, 'error');
  } finally {
    setState('attaching', false);
  }
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
  await attachWorkspaceToR(true);
  await refreshWorkspaces();
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
  setState('env', []);
  try {
    await syncFromR();
  } catch {
    /* ignore */
  }
  snapshot = new Map();
  driveMounted = null; // the old session's mounts go away with it
  setState('fileMode', 'mirror');
  try {
    await session.restart(plotSize, initPackages);
    await session.setPlotSize(plotSize.width, plotSize.height);
    setBoot({ label: 'Opening your workspace' });
    await attachWorkspaceToR(false);
    toast('R session restarted');
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
