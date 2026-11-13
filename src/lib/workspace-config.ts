// Per-workspace configuration, stored in the workspace (so it travels with a
// zip export):
//   .ide/settings.json   overrides of user settings, and start-up options
//   .ide/library.json    which packages the workspace uses
import { createStore, reconcile } from 'solid-js/store';
import * as fs from './opfs';

export interface WorkspaceSettings {
  /** Overrides the user's tab width for this workspace. */
  tabSize?: 2 | 4;
  /** Run the workspace's .Rprofile when it opens (default on). */
  runRprofile?: boolean;
  /** Hash of the renv.lock last checked, so it's only checked again when it changes. */
  renvChecked?: string;
  /** Rewrite renv.lock whenever this workspace's own library changes. */
  renvSync?: boolean;
  /**
   * When the workspace's versions differ from those pinned in renv.lock:
   * 'update' the pins to webR's, 'keep' the pins, or ask (unset).
   */
  renvVersions?: 'update' | 'keep';
}

export interface WorkspaceLibrary {
  /**
   * 'shared': every cached package (the default).
   * 'workspace': only the packages listed here, at these versions — like an
   * renv project library. Packages are still stored once in the shared cache.
   */
  mode: 'shared' | 'workspace';
  packages: Record<string, string>;
}

const SETTINGS = `${fs.IDE_DIR}/settings.json`;
const LIBRARY = `${fs.IDE_DIR}/library.json`;

const [wsConfig, setWsConfig] = createStore({
  workspace: '',
  settings: {} as WorkspaceSettings,
  library: { mode: 'shared', packages: {} } as WorkspaceLibrary,
});
export { wsConfig };

async function readJson<T>(ws: string, path: string, fallback: T): Promise<T> {
  try {
    return { ...fallback, ...JSON.parse(await fs.readText(ws, path)) };
  } catch {
    return fallback;
  }
}

export function readLibrary(ws: string): Promise<WorkspaceLibrary> {
  return readJson<WorkspaceLibrary>(ws, LIBRARY, { mode: 'shared', packages: {} });
}

/** Load the configuration of the workspace being opened. */
export async function loadWorkspaceConfig(ws: string) {
  const [settings, library] = await Promise.all([readJson<WorkspaceSettings>(ws, SETTINGS, {}), readLibrary(ws)]);
  setWsConfig('workspace', ws);
  setWsConfig('settings', reconcile(settings));
  setWsConfig('library', reconcile(library));
}

export async function setWorkspaceSetting<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K] | undefined) {
  const ws = wsConfig.workspace;
  if (!ws) return;
  const next = { ...wsConfig.settings, [key]: value };
  if (value === undefined) delete next[key];
  // Set the key itself (setting the object would merge, keeping a removed key).
  setWsConfig('settings', key, value as never);
  await fs.writeFile(ws, SETTINGS, JSON.stringify(next, null, 1));
}

const libraryListeners = new Set<(ws: string) => void>();
/** Called after a workspace's library list is written (e.g. to update renv.lock). */
export function onLibraryWritten(fn: (ws: string) => void) {
  libraryListeners.add(fn);
}

export async function writeLibrary(ws: string, library: WorkspaceLibrary) {
  if (ws === wsConfig.workspace) setWsConfig('library', reconcile({ mode: library.mode, packages: { ...library.packages } }));
  await fs.writeFile(ws, LIBRARY, JSON.stringify(library, null, 1));
  for (const fn of libraryListeners) fn(ws);
}

/** Every package version used by a workspace with its own library: "name@version". */
export async function referencedVersions(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ws of await fs.listWorkspaces()) {
    const lib = await readLibrary(ws);
    if (lib.mode !== 'workspace') continue;
    for (const [n, v] of Object.entries(lib.packages)) out.add(`${n}@${v}`);
  }
  return out;
}
