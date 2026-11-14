// Command history: recording submitted lines, clearing, and loading/saving
// <workspace>/.ide/history.txt.

import * as fs from './opfs';
import { state, setState } from './ide-state';

let historySaveTimer: number | undefined;
export function addHistory(code: string) {
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

export async function loadHistory(ws: string): Promise<string[]> {
  try {
    return (await fs.readText(ws, `${fs.IDE_DIR}/history.txt`)).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
