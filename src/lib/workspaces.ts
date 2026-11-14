// Workspaces and the R session's lifecycle: listing, opening, attaching to R,
// switching, creating, renaming and deleting workspaces; package library mode;
// autosaving the environment to .RData; starting and restarting R.

import { batch } from 'solid-js';
import * as fs from './opfs';
import { setBoot } from './boot';
import { HOME, rString } from './r-session';
import { toast } from './ui';
import { setupPackages, applyLibrary, libraryNeedsRestart } from './packages';
import { loadWorkspaceConfig, wsConfig, writeLibrary, type WorkspaceLibrary } from './workspace-config';
import { session, state, setState, editor, rRoot, saveIdeState, loadIdeState, scheduleIdeStateSave } from './ide-state';
import { loadHistory } from './history';
import { refreshWd, refreshEnv, refreshPackages } from './env-refresh';
import { syncFromR, refreshTree, loadWorkspaceIntoR, prepareDrive, tryMountDrive, detachDrive, resetSnapshot, forgetDriveMount } from './file-sync';
import { checkRenv } from './renv-actions';

// ---------------------------------------------------------------- settings

const LS_LAST_WS = 'webr-ide:last-workspace';

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

export function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    if (!session.idle || state.switching) return;
    const sig = envSignature();
    if (sig === savedEnvSig) return;
    if (await saveEnvironmentImage(true, { auto: true })) savedEnvSig = sig;
  }, 2500);
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
    setState('workspaceOpens', (n) => n + 1);
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
  const ed = editor();
  if (ide && ed) await ed.restoreOpenState(ide);
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
  const ed = editor();
  if (ed && !(await ed.closeAll())) {
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
    resetSnapshot();
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
  // Like a switch: no autosave, sync or state save may write to either name meanwhile.
  clearTimeout(autosaveTimer);
  setState('switching', true);
  try {
    await moveWorkspace(from, to);
  } finally {
    setState('switching', false);
  }
  localStorage.setItem(LS_LAST_WS, to);
  document.title = `${to} — webR IDE`;
  await refreshWorkspaces();
  await refreshTree();
}

async function moveWorkspace(from: string, to: string) {
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
  resetSnapshot();
  forgetDriveMount(); // the old session's mounts go away with it
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
