// renv.lock actions: checking a workspace's lockfile, writing one for desktop
// R, and keeping it in step with the workspace's own library.

import * as fs from './opfs';
import { choiceDialog, toast } from './ui';
import { wsConfig, setWorkspaceSetting, onLibraryWritten } from './workspace-config';
import { checkLockfile, hashText, setRenvCheck, buildLockfile, versionChanges, compareVersions } from './renv';
import { loadRepoIndex } from './pkg-index';
import { session, state, editor } from './ide-state';
import { writeWorkspaceFile, refreshTree } from './file-sync';

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
  await editor()?.reloadIfOpen('renv.lock');
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
