// The debugger: following R's Browse[n]> prompt, the paused call stack and
// frame variables, step commands, debug-on-error and breakpoints.

import { batch } from 'solid-js';
import * as fs from './opfs';
import { rString } from './r-session';
import { session, state, setState, rRoot, rDisplayPath, showPane, scheduleIdeStateSave, type DebugFrame, type EnvEntry } from './ide-state';

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

export function noteDebugLocation(text: string) {
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

export function onPrompt(prompt: string) {
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
