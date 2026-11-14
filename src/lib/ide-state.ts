// Shared IDE state: the Solid store and its types, the R session, the editor
// registry, workspace path helpers, phone/stacked layout signals, showing panes
// and output badges, and saving the IDE's per-workspace state (open tabs,
// breakpoints). The bottom layer: imports no other IDE module.

import { createSignal, batch } from 'solid-js';
import { createStore } from 'solid-js/store';
import * as fs from './opfs';
import { RSession, HOME } from './r-session';

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
  /** Bumped each time a workspace is opened (not when the open one is renamed). */
  workspaceOpens: 0,
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
/** Output from here on counts towards badges (something was run). */
export function armBadges() {
  badgesArmed = true;
}
/** Mark new output in a pane that isn't on screen. */
export function badge(tab: 'console' | 'plots') {
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

/** R's working directory as shown in the console header: ~ for R's home. */
export function wdDisplay(wd = state.rWd): string {
  return wd === HOME ? '~' : wd.startsWith(HOME + '/') ? `~${wd.slice(HOME.length)}` : wd;
}

/** The working directory is inside the open workspace (files there are saved). */
export function wdInWorkspace(wd = state.rWd): boolean {
  const root = rRoot();
  return wd === root || wd.startsWith(root + '/');
}

// ---------------------------------------------------------------- IDE state (open tabs, breakpoints)

export async function saveIdeState() {
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

export async function loadIdeState(ws: string): Promise<{ open: string[]; active: string | null; breakpoints?: Record<string, number[]> } | null> {
  try {
    return JSON.parse(await fs.readText(ws, `${fs.IDE_DIR}/state.json`));
  } catch {
    return null;
  }
}
