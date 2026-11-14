// The IDE's R event dispatch (session events → state, the after-command
// pass) and the package-install indicator. Also the barrel: re-exports the
// IDE modules, so components import everything from here. Lower modules import
// the specific module they need, never this one.

import { createSignal, batch } from 'solid-js';
import { captureInstalls } from './packages';
import { toast } from './ui';
import { session, state, setState, setView, showPane, badge, armBadges } from './ide-state';
import { addHistory } from './history';
import { noteDebugLocation, onPrompt } from './debugger';
import { refreshWd, refreshEnv, refreshPackages } from './env-refresh';
import { syncFromR } from './file-sync';
import { scheduleAutosave } from './workspaces';

export * from './ide-state';
export * from './history';
export * from './debugger';
export * from './env-refresh';
export * from './file-sync';
export * from './renv-actions';
export * from './workspaces';

// ---------------------------------------------------------------- install indicator

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
      armBadges();
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

// After each command: working directory, environment, files R wrote, new
// packages. One pass at a time; a command finishing during a pass runs one more.
let idleTimer: number | undefined;
let idlePass: Promise<void> | null = null;
let idleAgain = false;
function onIdle() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (idlePass) {
      idleAgain = true;
      return;
    }
    idlePass = (async () => {
      do {
        idleAgain = false;
        if (!session.idle) return;
        await refreshWd();
        await refreshEnv();
        await syncFromR();
        await cacheNewPackages();
        if (state.plotTab === 'packages') await refreshPackages();
        scheduleAutosave();
      } while (idleAgain);
    })().finally(() => (idlePass = null));
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
