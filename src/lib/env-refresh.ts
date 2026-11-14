// Asking R for what the panes show: working directory, environment,
// packages, and completions.

import { reconcile } from 'solid-js/store';
import { rString } from './r-session';
import { session, state, setState, type EnvEntry, type PackageEntry } from './ide-state';

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

export async function refreshEnv() {
  if (session.status !== 'ready') return;
  try {
    const flat = await session.strings('.ide_env()');
    const out: EnvEntry[] = [];
    for (let i = 0; i + 4 < flat.length; i += 5) {
      out.push({ name: flat[i], group: flat[i + 1] as EnvEntry['group'], cls: flat[i + 2], value: flat[i + 3], size: flat[i + 4] });
    }
    // Keyed by name: unchanged objects keep their rows in the Environment pane.
    setState('env', reconcile(out, { key: 'name' }));
  } catch (e) {
    console.warn('env refresh failed', e);
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
