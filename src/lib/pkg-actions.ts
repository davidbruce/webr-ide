// Install / update / remove actions shared by the Packages tab and the package browser.
import { createSignal } from 'solid-js';
import { session } from './ide-state';
import { refreshPackages } from './env-refresh';
import { restartR } from './workspaces';
import { loadedAmong, removeCached } from './packages';
import { rString } from './r-session';
import { confirmDialog, toast } from './ui';
import { wsConfig } from './workspace-config';

/** Package names with an install/update in flight. */
const [installing, setInstalling] = createSignal<Set<string>>(new Set());
export { installing };

function track(names: string[]) {
  setInstalling((s) => new Set([...s, ...names]));
  const off = session.on((ev) => {
    if (ev.type !== 'idle') return;
    off();
    setInstalling((s) => {
      const next = new Set(s);
      names.forEach((n) => next.delete(n));
      return next;
    });
    void refreshPackages();
  });
}

export function installPackages(names: string[]) {
  if (!names.length) return;
  if (session.status !== 'ready') return toast('R is still starting…', 'warn');
  track(names);
  session.submit(`webr::install(c(${names.map(rString).join(', ')}))`);
}

/** Replace installed packages with the repository's current versions. */
export async function updatePackages(names: string[]) {
  if (!names.length || !(await session.waitIdle(3000))) return;
  const loaded = await loadedAmong(session, names);
  if (loaded.length) {
    const ok = await confirmDialog(
      'Restart R to update',
      `${loaded.join(', ')} ${loaded.length === 1 ? 'is' : 'are'} loaded in this session. Restart R, then install the new version${names.length === 1 ? '' : 's'}?`,
      { okLabel: 'Restart & Update' },
    );
    if (!ok) return;
    await restartR();
    if (!(await session.waitIdle(15000))) return;
  }
  for (const n of names) await session.strings(`as.character(.ide_pkg_drop(${rString(n)}))`);
  installPackages(names);
}

export async function removePackage(name: string, version?: string): Promise<boolean> {
  const own = wsConfig.library.mode === 'workspace';
  const what = `${name}${version ? ` ${version}` : ''}`;
  const ok = await confirmDialog('Remove package', own ? `Remove ${what} from this workspace's library? It stays saved for other workspaces.` : `Remove ${what} from the saved package library?`, {
    okLabel: 'Remove',
    danger: true,
  });
  if (!ok) return false;
  const pending = await removeCached(session, [name]);
  toast(pending.length ? `${name} removed — it stays loaded until R restarts` : `${name} removed`);
  await refreshPackages();
  return true;
}

// ---------------------------------------------------------------- browser modal state

export const [browser, setBrowser] = createSignal<null | { tab: 'browse' | 'installed' | 'updates'; query: string }>(null);

export function openPackageBrowser(query = '', tab: 'browse' | 'installed' | 'updates' = 'browse') {
  setBrowser({ tab, query });
}
