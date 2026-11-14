// Workspace files between OPFS and R: the file tree, mounting the workspace
// as a drive (or copying it in and syncing back), file operations that keep
// both sides in step, and downloads.

import { reconcile } from 'solid-js/store';
import * as fs from './opfs';
import { invalidateText } from './text-cache';
import { rString } from './r-session';
import { toast } from './ui';
import { driveServiceWorker, setDriveScope, mountDrive, unmountDrive, selfTestDrive, driveWrite, onDriveChange } from './drive/client';
import { session, state, setState, editor, rRoot } from './ide-state';

// ---------------------------------------------------------------- file tree

export async function refreshTree() {
  if (!state.workspace) return;
  try {
    setState('tree', reconcile(await fs.listTree(state.workspace), { key: 'path' }));
  } catch (e) {
    console.warn(e);
  }
}

// ---------------------------------------------------------------- OPFS ⇄ webR file sync

/** Last-seen signature of every file/dir in the R copy of the workspace. */
let snapshot = new Map<string, string>(); // path → "f:<mtime size>" | "d:"
let syncChain: Promise<void> = Promise.resolve();

/** Forget R's copy of the workspace (switching workspaces, restarting R). */
export function resetSnapshot() {
  snapshot = new Map();
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = syncChain.then(fn, fn);
  syncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseSnapshot(flat: string[], into = new Map<string, string>()): Map<string, string> {
  for (let i = 0; i + 2 < flat.length; i += 3) into.set(flat[i], `${flat[i + 1]}:${flat[i + 2]}`);
  return into;
}

async function takeSnapshot(): Promise<Map<string, string>> {
  return parseSnapshot(await session.strings(`.ide_snapshot(${rString(rRoot())})`));
}

/**
 * Change R's copy of the workspace the way the IDE just changed OPFS, then
 * record R's state for those paths, so syncFromR doesn't copy them back. (In
 * the queue with syncFromR, so neither sees the other half-done.)
 */
function mirrorToR(op: () => Promise<void>, paths: { removed?: string[]; touched?: string[] }): Promise<void> {
  if (session.status !== 'ready' || state.fileMode !== 'mirror') return Promise.resolve();
  return serialize(async () => {
    try {
      await op();
    } catch (e) {
      console.warn('R copy of the workspace not updated', e);
    }
    for (const r of paths.removed ?? []) for (const k of [...snapshot.keys()]) if (k === r || k.startsWith(r + '/')) snapshot.delete(k);
    const touched = paths.touched ?? [];
    if (!touched.length) return;
    // The paths, their folders (created on the way) and everything below them.
    const withParents = new Set<string>();
    for (const p of touched) {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) withParents.add(parts.slice(0, i).join('/'));
    }
    try {
      parseSnapshot(await session.strings(`.ide_snapshot_under(${rString(rRoot())}, c(${[...withParents].map(rString).join(',')}))`), snapshot);
    } catch {
      /* the next sync compares in full */
    }
  });
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
      editor()?.onDeleted(path);
      changed = true;
    }
    snapshot = next;
    if (changed && ws === state.workspace) {
      await refreshTree();
      for (const p of changedFiles) await editor()?.reloadIfOpen(p);
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

/** R restarted: the old session's mounts went away with it. */
export function forgetDriveMount() {
  driveMounted = null;
}

export async function prepareDrive() {
  const reg = await driveServiceWorker();
  driveSwOk = !!reg;
  if (reg) setDriveScope(reg.scope);
}

/** Mount the workspace straight from OPFS. Returns false to fall back to copying. */
export async function tryMountDrive(ws: string, root: string): Promise<boolean> {
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

export async function detachDrive() {
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
  for (const p of c.deleted) if (visible(p)) editor()?.onDeleted(p);
  for (const p of c.changed) if (visible(p)) driveChanged.add(p);
  clearTimeout(driveRefreshTimer);
  driveRefreshTimer = window.setTimeout(async () => {
    const paths = [...driveChanged];
    driveChanged.clear();
    await refreshTree();
    for (const p of paths) await editor()?.reloadIfOpen(p);
  }, 150);
});

/** Give R the current workspace: mounted from OPFS if possible, else copied in. */
export async function loadWorkspaceIntoR(restoreImage: boolean): Promise<string> {
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
  await mirrorToR(
    async () => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const dir = fs.dirname(path);
      if (dir) await session.evalVoid(`.ide_mkdirs(${rString(`${rRoot(ws)}/${dir}`)})`);
      await session.webR.FS.writeFile(`${rRoot(ws)}/${path}`, bytes);
    },
    { touched: [path] },
  );
  await refreshTree();
}

export async function makeFolder(path: string) {
  await fs.mkdir(state.workspace, path);
  await mirrorToR(() => session.evalVoid(`.ide_mkdirs(${rString(`${rRoot()}/${path}`)})`), { touched: [path] });
  setState('expanded', path, true);
  await refreshTree();
}

export async function deletePath(path: string) {
  invalidateText(state.workspace, path);
  await fs.remove(state.workspace, path);
  await mirrorToR(() => session.evalVoid(`unlink(${rString(`${rRoot()}/${path}`)}, recursive = TRUE)`), { removed: [path] });
  editor()?.onDeleted(path);
  await refreshTree();
}

export async function renamePath(from: string, to: string) {
  invalidateText(state.workspace, from);
  await fs.rename(state.workspace, from, to);
  const dir = fs.dirname(to);
  await mirrorToR(
    () =>
      session.evalVoid(
        `${dir ? `.ide_mkdirs(${rString(`${rRoot()}/${dir}`)}); ` : ''}file.rename(${rString(`${rRoot()}/${from}`)}, ${rString(`${rRoot()}/${to}`)})`,
      ),
    { removed: [from], touched: [to] },
  );
  editor()?.onRenamed(from, to);
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
