import { createEffect, getOwner, onCleanup, onMount, runWithOwner, Show } from 'solid-js';
import { settings } from '../lib/settings';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import { session, state, completions, restartR, rDisplayPath, rRoot, editor } from '../lib/ide';
import { flattenTree } from '../lib/opfs';
import { Icon } from './Icon';
import { confirmDialog, kbd } from '../lib/ui';
import { PaneHeader } from './Pane';

const BLUE = '\x1b[38;2;37;99;235m';
const BLUE_DARK = '\x1b[38;2;125;170;255m';
const RED = '\x1b[38;2;200;40;40m';
const RED_DARK = '\x1b[38;2;255;120;120m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const UNDERLINE = '\x1b[4m';
const NO_UNDERLINE = '\x1b[24m';

// Places in R error messages: "(from test.R#12)" (runtime errors in source()d
// files) and "test.R:3:5:" (parse errors).
const LOC_FROM = /\(from ([^()#\s]+)#(\d+)\)/;
const LOC_PARSE = /((?:~|\/)?[^\s:"'()]*\.(?:[Rr]|[qQRr]md)):(\d+):(\d+)/;
const LOCATIONS = new RegExp(`${LOC_FROM.source}|${LOC_PARSE.source}`, 'g');

/** A file named in an R message → workspace path, line, column. */
function resolveLocation(text: string): { path: string; line: number; column: number } | null {
  const m = LOC_FROM.exec(text) ?? LOC_PARSE.exec(text);
  if (!m) return null;
  const file = m[1];
  const line = Number(m[2]);
  const column = Number(m[3] ?? 1) || 1;
  const files = flattenTree(state.tree).filter((n) => n.kind === 'file');
  for (const pre of [`~/${state.workspace}/`, `${rRoot()}/`]) {
    if (file.startsWith(pre)) {
      const p = file.slice(pre.length);
      return files.some((n) => n.path === p) ? { path: p, line, column } : null;
    }
  }
  const exact = files.find((n) => n.path === file.replace(/^\.\//, ''));
  const byName = files.filter((n) => n.name === file.split('/').pop());
  const hit = exact ?? byName[0];
  return hit ? { path: hit.path, line, column } : null;
}

export let consoleApi: { focus(): void; clear(): void; insert(text: string): void; /** Feed keystrokes as if typed (e.g. from the phone key bar). */ input(data: string): void; /** Input line before the cursor. */ beforeCursor(): string } | null = null;

export function ConsolePane() {
  let host!: HTMLDivElement;
  let term: WTerm | null = null;
  const owner = getOwner();

  // ---- line editor state
  let prompt: string | null = null; // visible prompt, null while R is busy
  let buf = '';
  let cur = 0;
  let drawnRow = 0; // row of the cursor within the drawn edit line
  let histIdx = -1; // -1 = editing a fresh line
  let draft = '';
  let pendingOutput = '';
  let flushQueued = false;

  const dark = () => document.documentElement.dataset.theme === 'dark';
  const inputColor = () => (dark() ? BLUE_DARK : BLUE);
  const errColor = () => (dark() ? RED_DARK : RED);

  const write = (s: string) => term?.write(s);
  const nl = (s: string) => s.replace(/\r?\n/g, '\r\n');

  /**
   * Columns R should format output for. While the console is hidden (e.g.
   * another tab on a phone) the terminal can't measure itself, so estimate
   * from the window width and the console font.
   */
  function cols() {
    if (host && host.clientWidth === 0) {
      const ctx = document.createElement('canvas').getContext('2d');
      const style = getComputedStyle(host);
      const size = parseFloat(style.getPropertyValue('--term-font-size')) || 13;
      if (ctx) ctx.font = `${size}px ${style.getPropertyValue('--term-font-family') || 'monospace'}`;
      const ch = ctx?.measureText('0').width || size * 0.6;
      return Math.max(20, Math.floor((window.innerWidth - 28) / ch));
    }
    return Math.max(10, term?.cols ?? 80);
  }

  /** Erase the currently drawn edit line (may span several rows). */
  function eraseLine() {
    if (prompt === null) return;
    let s = '';
    if (drawnRow > 0) s += `\x1b[${drawnRow}A`;
    s += '\r\x1b[J';
    write(s);
    drawnRow = 0;
  }

  function drawLine() {
    if (prompt === null) return;
    const c = cols();
    let s = prompt + inputColor() + buf + RESET;
    const total = prompt.length + buf.length;
    let endRow = Math.floor(total / c);
    if (total > 0 && total % c === 0) s += '\r\n';
    else if (total === 0) endRow = 0;
    const pos = prompt.length + cur;
    const tRow = Math.floor(pos / c);
    const tCol = pos % c;
    if (endRow > tRow) s += `\x1b[${endRow - tRow}A`;
    s += '\r';
    if (tCol > 0) s += `\x1b[${tCol}C`;
    write(s);
    drawnRow = tRow;
  }

  function redraw() {
    eraseLine();
    drawLine();
  }

  /** Write R output above the edit line. Batched per animation frame. */
  function output(text: string) {
    pendingOutput += text;
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      const out = pendingOutput;
      pendingOutput = '';
      if (!out) return;
      const visible = prompt !== null;
      if (visible) eraseLine();
      write(out);
      if (visible) drawLine();
    });
  }

  function flushNow() {
    if (pendingOutput) {
      const out = pendingOutput;
      pendingOutput = '';
      write(out);
    }
  }

  function submit() {
    const line = buf;
    if (prompt !== null) eraseLine();
    buf = '';
    cur = 0;
    histIdx = -1;
    draft = '';
    if (session.status !== 'ready') {
      write(`${prompt ?? ''}${inputColor()}${line}${RESET}\r\n`);
      return;
    }
    prompt = null; // hidden until R prompts again
    session.submit(line);
  }

  function setBuf(text: string, cursor = text.length) {
    buf = text;
    cur = Math.max(0, Math.min(cursor, text.length));
    redraw();
  }

  function insert(text: string) {
    buf = buf.slice(0, cur) + text + buf.slice(cur);
    cur += text.length;
    redraw();
  }

  function historyMove(dir: -1 | 1) {
    const h = state.history;
    if (!h.length) return;
    if (histIdx === -1) {
      if (dir === 1) return;
      draft = buf;
      histIdx = h.length - 1;
    } else {
      histIdx += dir;
      if (histIdx >= h.length) {
        histIdx = -1;
        setBuf(draft);
        return;
      }
      histIdx = Math.max(0, histIdx);
    }
    setBuf(h[histIdx]);
  }

  function wordLeft() {
    let i = cur;
    while (i > 0 && !/\w/.test(buf[i - 1])) i--;
    while (i > 0 && /[\w.]/.test(buf[i - 1])) i--;
    return i;
  }
  function wordRight() {
    let i = cur;
    while (i < buf.length && !/\w/.test(buf[i])) i++;
    while (i < buf.length && /[\w.]/.test(buf[i])) i++;
    return i;
  }

  async function complete() {
    if (prompt === null) return;
    const before = buf.slice(0, cur);
    const { token, items } = await completions(before);
    if (!items.length) return;
    const common = items.reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    if (common.length > token.length) {
      insert(common.slice(token.length));
      return;
    }
    if (items.length === 1) return;
    // Show the candidates in columns, then redraw the edit line.
    const shown = items.slice(0, 200);
    const w = Math.min(40, Math.max(...shown.map((s) => s.length)) + 2);
    const per = Math.max(1, Math.floor(cols() / w));
    let s = '\r\n';
    shown.forEach((it, i) => {
      s += DIM + it.padEnd(w) + RESET;
      if ((i + 1) % per === 0) s += '\r\n';
    });
    if (shown.length % per !== 0) s += '\r\n';
    if (items.length > shown.length) s += `${DIM}… ${items.length - shown.length} more${RESET}\r\n`;
    // Move to the end of the edit line before printing.
    const c = cols();
    const endRow = Math.floor((prompt.length + buf.length) / c);
    if (endRow > drawnRow) write(`\x1b[${endRow - drawnRow}B`);
    write(s);
    drawnRow = 0;
    drawLine();
  }

  function handlePaste(data: string) {
    const text = (buf.slice(0, cur) + data + buf.slice(cur)).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const last = lines.pop()!;
    if (prompt !== null) eraseLine();
    buf = last;
    cur = last.length;
    if (lines.length && session.status === 'ready') {
      prompt = null;
      session.submit(lines.join('\n'));
    } else redraw();
  }

  function onData(data: string) {
    // Multi-character input containing newlines is a paste.
    if (data.length > 1 && /[\r\n]/.test(data.replace(/[\r\n]+$/, ''))) {
      handlePaste(data);
      return;
    }
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        const m = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z]|[bf]|\x7f)/.exec(data.slice(i));
        if (m) {
          handleEscape(m[1]);
          i += m[0].length;
          continue;
        }
        i++;
        continue;
      }
      i++;
      switch (ch) {
        case '\r':
        case '\n':
          submit();
          break;
        case '\x7f':
        case '\b':
          if (cur > 0) {
            buf = buf.slice(0, cur - 1) + buf.slice(cur);
            cur--;
            redraw();
          }
          break;
        case '\t':
          void complete();
          break;
        case '\x03': // Ctrl+C
          if (prompt === null || state.busy) session.interrupt();
          else {
            eraseLine();
            write(`${prompt}${inputColor()}${buf}${RESET}^C\r\n`);
            buf = '';
            cur = 0;
            histIdx = -1;
            drawLine();
          }
          break;
        case '\x0c': // Ctrl+L
          clear();
          break;
        case '\x01':
          cur = 0;
          redraw();
          break;
        case '\x05':
          cur = buf.length;
          redraw();
          break;
        case '\x02':
          if (cur > 0) cur--, redraw();
          break;
        case '\x06':
          if (cur < buf.length) cur++, redraw();
          break;
        case '\x15': // Ctrl+U
          buf = buf.slice(cur);
          cur = 0;
          redraw();
          break;
        case '\x0b': // Ctrl+K
          buf = buf.slice(0, cur);
          redraw();
          break;
        case '\x17': {
          // Ctrl+W
          const j = wordLeft();
          buf = buf.slice(0, j) + buf.slice(cur);
          cur = j;
          redraw();
          break;
        }
        case '\x10':
          historyMove(-1);
          break;
        case '\x0e':
          historyMove(1);
          break;
        default:
          if (ch >= ' ') {
            // Collect a run of printable characters.
            let j = i;
            while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f' && data[j] !== '\x1b') j++;
            insert(data.slice(i - 1, j));
            i = j;
          }
      }
    }
  }

  function handleEscape(seq: string) {
    const mod = /;(\d)/.exec(seq)?.[1];
    const wordMod = mod === '3' || mod === '5' || mod === '9';
    const key = seq[seq.length - 1];
    if (seq === 'b') return (cur = wordLeft()), redraw();
    if (seq === 'f') return (cur = wordRight()), redraw();
    if (seq === '\x7f') {
      const j = wordLeft();
      buf = buf.slice(0, j) + buf.slice(cur);
      cur = j;
      return redraw();
    }
    if (seq === '[3~') {
      if (cur < buf.length) buf = buf.slice(0, cur) + buf.slice(cur + 1);
      return redraw();
    }
    if (seq === '[1~' || seq === '[7~') return (cur = 0), redraw();
    if (seq === '[4~' || seq === '[8~') return (cur = buf.length), redraw();
    switch (key) {
      case 'A':
        return historyMove(-1);
      case 'B':
        return historyMove(1);
      case 'C':
        cur = wordMod ? wordRight() : Math.min(buf.length, cur + 1);
        return redraw();
      case 'D':
        cur = wordMod ? wordLeft() : Math.max(0, cur - 1);
        return redraw();
      case 'H':
        cur = 0;
        return redraw();
      case 'F':
        cur = buf.length;
        return redraw();
    }
  }

  function clear() {
    flushNow();
    write('\x1b[2J\x1b[3J\x1b[H');
    drawnRow = 0;
    drawLine();
  }

  // Keep R's width in step while hidden (e.g. a phone rotating).
  const onWinResize = () => {
    if (host?.clientWidth === 0 && session.status === 'ready') session.evalVoid(`.ide_set_width(${cols()})`).catch(() => {});
  };
  window.addEventListener('resize', onWinResize);
  onCleanup(() => window.removeEventListener('resize', onWinResize));

  onMount(async () => {
    term = new WTerm(host, {
      cursorBlink: true,
      scrollbackLines: 5000,
      onData,
      onResize: (c) => {
        if (session.status === 'ready') session.evalVoid(`.ide_set_width(${c})`).catch(() => {});
      },
    });
    await term.init();
    write(`${DIM}Starting webR… (R runs entirely in your browser)${RESET}\r\n`);

    const off = session.on((ev) => {
      switch (ev.type) {
        case 'stdout':
          output(nl(ev.text) + '\r\n');
          break;
        case 'stderr':
          // Package download notices are informational, not errors.
          if (/^Downloading webR package: /.test(ev.text)) output(DIM + nl(ev.text) + RESET + '\r\n');
          else output(errColor() + nl(ev.text).replace(LOCATIONS, (l) => UNDERLINE + l + NO_UNDERLINE) + RESET + '\r\n');
          break;
        case 'echo':
          flushNow();
          if (prompt !== null) eraseLine();
          prompt = null;
          write(`${ev.prompt}${inputColor()}${nl(ev.line)}${RESET}\r\n`);
          break;
        case 'prompt':
          flushNow();
          prompt = ev.prompt;
          drawnRow = 0;
          drawLine();
          break;
        case 'status':
          if (ev.status === 'ready') {
            write(
              `${DIM}${session.versionR ? `R ${session.versionR} · ` : ''}webR ${session.webR?.version ?? ''}` +
                `${session.isolated ? '' : ' · limited mode (no interrupt)'}${RESET}\r\n` +
                `${DIM}Type R code below. Tab completes, ↑/↓ browse history, Ctrl+C interrupts, Ctrl+L clears.${RESET}\r\n\r\n`,
            );
            session.evalVoid(`.ide_set_width(${cols()})`).catch(() => {});
          } else if (ev.status === 'error') {
            write(`${errColor()}webR failed to start: ${ev.detail}${RESET}\r\n`);
          } else if (ev.status === 'starting') {
            prompt = null;
          }
          break;
      }
    });
    runWithOwner(owner, () => onCleanup(off));

    consoleApi = {
      focus: () => term?.focus(),
      clear,
      insert: (text) => {
        if (prompt !== null) setBuf(text);
        else buf = text;
        term?.focus();
      },
      input: (data) => onData(data),
      beforeCursor: () => buf.slice(0, cur),
    };
  });

  onCleanup(() => term?.destroy?.());

  // Font size from Settings.
  createEffect(() => {
    const size = settings.consoleFontSize;
    host.style.setProperty('--term-font-size', `${size}px`);
    host.style.setProperty('--term-row-height', `${Math.round(size * 1.38)}px`);
    requestAnimationFrame(() => {
      try {
        term?.fit();
      } catch {
        /* not ready */
      }
    });
  });

  async function onRestart() {
    if (await confirmDialog('Restart R', 'Restart the R session? Unsaved objects in the environment will be lost.', { okLabel: 'Restart', danger: true })) {
      write(`\r\n${DIM}Restarting R…${RESET}\r\n`);
      prompt = null;
      await restartR();
    }
  }

  return (
    <div class="pane">
      <PaneHeader
        pane="console"
        tabs={[{ id: 'console', label: 'Console', icon: 'to-console' }]}
        active="console"
        info={
          <span class="pane-path" title="Working directory">
            {state.workspace ? rDisplayPath('').replace(/\/$/, '') : ''}
          </span>
        }
        actions={
          <>
            <Show when={state.busy && state.rStatus === 'ready'}>
              <button class="tb-btn danger" onClick={() => session.interrupt()} title="Interrupt R (Ctrl+C)">
                <Icon name="stop" />
              </button>
            </Show>
            <button class="tb-btn" onClick={() => (clear(), term?.focus())} title={`Clear console (Ctrl+L)`}>
              <Icon name="broom" />
            </button>
            <button class="tb-btn" onClick={onRestart} title={`Restart R (${kbd('mod+shift+F10')})`}>
              <Icon name="power" />
            </button>
          </>
        }
      />
      <div
        class="pane-body console-body"
        onClick={(e) => {
          // A file location in an error message: open it at that line.
          const row = (e.target as Element).closest?.('.term-row');
          if (row && !window.getSelection()?.toString()) {
            // Neighbouring rows too: a long message wraps across rows.
            const [a, b, c] = [row.previousElementSibling, row, row.nextElementSibling].map((r) => r?.textContent ?? '');
            const all = a + b + c;
            const hit = [...all.matchAll(LOCATIONS)].find((m) => m.index < a.length + b.length && m.index + m[0].length > a.length);
            const loc = hit ? resolveLocation(hit[0]) : null;
            if (loc && editor()?.openAt) {
              void editor()!.openAt!(loc.path, loc.line, loc.column);
              return;
            }
          }
          term?.focus();
        }}
      >
        <div ref={host} class="console-term" />
      </div>
    </div>
  );
}
