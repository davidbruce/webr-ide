import { WebR, ChannelType } from 'webr';
import { R_HELPERS } from './r-helpers';
import { R_NOTEBOOK } from './r-notebook';
import { R_INTEL } from './r-intel';
import { setBoot } from './boot';
import { WEBR_BASE_URL, mountBaseLibrary } from './webr-runtime';

export type SessionEvent =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'echo'; prompt: string; line: string; /** Run without showing the input. */ hidden?: boolean }
  | { type: 'prompt'; prompt: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'idle' }
  | { type: 'canvasNewPage' }
  | { type: 'canvasImage'; image: ImageBitmap }
  | { type: 'pager'; title: string; text: string }
  | { type: 'view'; title: string; data: Record<string, unknown[]> }
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'submitted'; line: string }
  | { type: 'install'; phase: 'start' | 'end'; pkg: string; version: string };

export interface ChunkResult {
  items: { type: 'stdout' | 'message' | 'warning' | 'error' | 'plot' | 'table' | 'widget'; text: string }[];
  images: ImageBitmap[];
}

export type SessionStatus ='starting' | 'ready' | 'error' | 'closed';

type Listener = (ev: SessionEvent) => void;

export const HOME = '/home/web_user';

/**
 * Wraps a webR instance as an interactive R console:
 *  - a queue of input lines that are fed to R one prompt at a time
 *  - output/plot/pager events forwarded to listeners
 *  - an "idle" event when R returns to a top-level prompt with nothing queued
 */
const QUIET = '\u0001quiet\u0001';

export class RSession {
  webR!: WebR;
  status: SessionStatus = 'starting';
  versionR = '';
  isolated = false;
  private listeners = new Set<Listener>();
  private queue: string[] = [];
  private atPrompt = false;
  private currentPrompt = '> ';
  private generation = 0;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: SessionEvent) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (e) {
        console.error(e);
      }
    }
  }

  get idle(): boolean {
    return this.status === 'ready' && this.atPrompt && this.queue.length === 0 && this.currentPrompt === '> ';
  }

  /** Resolve true once R is idle at a top-level prompt, or false after `ms`. */
  waitIdle(ms: number): Promise<boolean> {
    if (this.idle) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => (off(), resolve(false)), ms);
      const off = this.on((ev) => {
        if (ev.type === 'idle') {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
  }

  get prompt(): string {
    return this.currentPrompt;
  }

  /** `onInit` runs after webR boots but before the session is marked ready. */
  async start(plotSize: { width: number; height: number }, onInit?: () => Promise<void>): Promise<void> {
    const gen = ++this.generation;
    this.status = 'starting';
    this.atPrompt = false;
    this.queue = [];
    this.emit({ type: 'status', status: 'starting' });
    this.emit({ type: 'busy', busy: true });
    this.isolated = globalThis.crossOriginIsolated === true;
    try {
      this.webR = new WebR({
        interactive: true,
        // Self-hosted runtime; base-library images are mounted below instead of
        // being lazily fetched with sync XHRs (which can't work offline).
        baseUrl: WEBR_BASE_URL,
        createLazyFilesystem: false,
        channelType: this.isolated ? ChannelType.SharedArrayBuffer : ChannelType.PostMessage,
        REnv: { R_HOME: '/usr/lib/R', R_ENABLE_JIT: '0', COLORTERM: 'truecolor' },
      });
      setBoot({ label: 'Starting R' });
      await this.webR.init();
      if (gen !== this.generation) return;
      this.versionR = this.webR.versionR;
      const base = await mountBaseLibrary(this.webR);
      if (base.failed.length) console.warn('base library: some parts failed to load', base.failed);
      await this.webR.evalRVoid(R_HELPERS);
      await this.webR.evalRVoid(R_NOTEBOOK);
      await this.webR.evalRVoid(R_INTEL);
      await this.setPlotSize(plotSize.width, plotSize.height);
      setBoot({ label: 'Setting up the R session' });
      if (onInit) {
        try {
          await onInit();
        } catch (e) {
          console.warn('session init hook failed', e);
        }
      }
      if (gen !== this.generation) return;
      this.status = 'ready';
      this.emit({ type: 'status', status: 'ready' });
      void this.readLoop(gen);
    } catch (err) {
      this.status = 'error';
      this.emit({ type: 'status', status: 'error', detail: String(err) });
      throw err;
    }
  }

  async restart(plotSize: { width: number; height: number }, onInit?: () => Promise<void>): Promise<void> {
    try {
      this.webR?.close();
    } catch {
      /* ignore */
    }
    this.status = 'closed';
    await this.start(plotSize, onInit);
  }

  private async readLoop(gen: number) {
    for (;;) {
      let msg: any;
      try {
        msg = await this.webR.read();
      } catch {
        return;
      }
      if (gen !== this.generation) return;
      switch (msg.type) {
        case 'stdout':
          this.emit({ type: 'stdout', text: msg.data });
          break;
        case 'stderr': {
          const text: string = msg.data;
          if (text.startsWith('\x1fIDE\x1f')) {
            const [, , what, pkg, version] = text.trimEnd().split('\x1f'); // ['', 'IDE', what, pkg, version]
            if (what === 'install-start' || what === 'install-end')
              this.emit({ type: 'install', phase: what === 'install-start' ? 'start' : 'end', pkg, version });
            break;
          }
          this.emit({ type: 'stderr', text });
          break;
        }
        case 'prompt':
          this.onPrompt(msg.data as string);
          break;
        case 'canvas':
          if (msg.data.event === 'canvasNewPage') this.emit({ type: 'canvasNewPage' });
          else if (msg.data.event === 'canvasImage') this.emit({ type: 'canvasImage', image: msg.data.image });
          break;
        case 'pager':
          void this.handlePager(msg.data);
          break;
        case 'view':
          {
            // Columns arrive as WebRDataJsAtomic objects: { type, names, values }.
            const data: Record<string, unknown[]> = {};
            for (const [k, v] of Object.entries(msg.data.data ?? {})) {
              data[k] = Array.isArray(v) ? v : ((v as any)?.values ?? []);
            }
            this.emit({ type: 'view', title: msg.data.title, data });
          }
          break;
        case 'browse':
          try {
            window.open(msg.data.url, '_blank', 'noopener');
          } catch {
            /* ignore */
          }
          break;
        case 'closed':
          this.status = 'closed';
          this.emit({ type: 'status', status: 'closed' });
          return;
      }
    }
  }

  private onPrompt(prompt: string) {
    this.currentPrompt = prompt;
    this.atPrompt = true;
    if (this.queue.length) {
      this.sendNext();
      return;
    }
    this.emit({ type: 'busy', busy: false });
    this.emit({ type: 'prompt', prompt });
    if (prompt === '> ') this.emit({ type: 'idle' });
  }

  private sendNext() {
    // Blank lines at a top-level prompt do nothing in R; skip them so running
    // a whole script doesn't fill the console with empty prompts.
    while (this.currentPrompt === '> ' && this.queue.length > 1 && this.queue[0].trim() === '') this.queue.shift();
    let line = this.queue.shift()!;
    // Quiet lines (start-up code such as .Rprofile) run without an echo.
    const quiet = line.startsWith(QUIET);
    if (quiet) line = line.slice(QUIET.length);
    this.atPrompt = false;
    this.emit({ type: 'busy', busy: true });
    // Quiet: the console just clears its prompt line.
    this.emit({ type: 'echo', prompt: this.currentPrompt, line, hidden: quiet });
    this.webR.writeConsole(line);
  }

  /**
   * Queue one or more lines of R input, as if typed at the console.
   * `quiet`: no echo and no history (code the IDE runs itself); its output
   * and errors still show in the console.
   */
  submit(code: string, opts: { quiet?: boolean } = {}) {
    if (this.status !== 'ready') return;
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    // Drop a single trailing empty line caused by a final newline.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    this.queue.push(...(opts.quiet ? lines.map((l) => QUIET + l) : lines));
    if (!opts.quiet) this.emit({ type: 'submitted', line: code });
    if (this.atPrompt) this.sendNext();
  }

  interrupt() {
    this.queue = [];
    try {
      this.webR.interrupt();
    } catch {
      /* ignore */
    }
  }

  clearQueue() {
    this.queue = [];
  }

  async setPlotSize(width: number, height: number) {
    const w = Math.max(200, Math.round(width));
    const h = Math.max(150, Math.round(height));
    try {
      await this.webR.evalRVoid(`.ide_set_device(${w}, ${h})`);
    } catch {
      /* ignore */
    }
  }

  private async handlePager(data: { path: string; title: string; header: string; deleteFile: boolean }) {
    try {
      const bytes = await this.webR.FS.readFile(data.path);
      // R's text help uses backspace overstrike for bold/underline.
      const text = new TextDecoder().decode(bytes).replace(/.\x08/g, '');
      this.emit({ type: 'pager', title: data.title || data.header || 'Help', text });
      if (data.deleteFile) await this.webR.FS.unlink(data.path);
    } catch (e) {
      console.warn('pager failed', e);
    }
  }

  /** Re-render the most recent plot at a new size (for the expanded view). */
  async renderLatestPlot(width: number, height: number): Promise<ImageBitmap | null> {
    if (!this.idle) return null;
    if (!(await this.webR.evalRBoolean('.ide_record()'))) return null;
    const shelter = await new this.webR.Shelter();
    try {
      const res = await shelter.captureR('grDevices::replayPlot(get(".ide_rec", envir = as.environment("tools:ide")))', {
        captureGraphics: { width: Math.round(width), height: Math.round(height), bg: 'white' },
        captureConditions: false,
      });
      return (res.images[res.images.length - 1] as ImageBitmap) ?? null;
    } catch (e) {
      console.warn('re-render failed', e);
      return null;
    } finally {
      void shelter.purge();
    }
  }

  /**
   * Run a notebook chunk outside the console and return its output in order.
   * Plots are captured at `width`×`height` CSS pixels (rendered at 2×).
   * Chunks run one at a time; R also finishes any console work first.
   */
  runChunk(code: string, opts: { width: number; height: number; chars: number }): Promise<ChunkResult> {
    return this.queued(async () => {
      const shelter = await new this.webR.Shelter();
      try {
        const res = await shelter.captureR(`.ide_chunk(${rString(code)}, ${Math.round(opts.chars)}L)`, {
          captureGraphics: { width: Math.round(opts.width), height: Math.round(opts.height), bg: 'white' },
          // stdout is captured by .ide_chunk itself; stderr (incl. the package
          // installer's progress markers) keeps flowing to the console.
          captureStreams: false,
          captureConditions: false,
        });
        const flat = await strings(res.result);
        const items: ChunkResult['items'] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) items.push({ type: flat[i] as ChunkResult['items'][number]['type'], text: flat[i + 1] });
        return { items, images: res.images as ImageBitmap[] };
      } finally {
        void shelter.purge();
      }
    });
  }

  /** Evaluate an inline `r` expression: [ok, text]. */
  inlineValue(code: string): Promise<{ ok: boolean; text: string }> {
    return this.queued(async () => {
      const r = await this.webR.evalRString(`.ide_inline(${rString(code)})`);
      const [kind, ...rest] = r.split('\x1f');
      return { ok: kind === 'ok', text: rest.join(' ') };
    });
  }

  /** Knit a Quarto / R Markdown document (run in `dir`) and convert it to HTML. */
  renderDocument(text: string, dir: string): Promise<string[]> {
    return this.queued(async () => {
      const shelter = await new this.webR.Shelter();
      try {
        const res = await shelter.captureR(`.ide_render(${rString(text)}, ${rString(dir)})`, {
          captureGraphics: false,
          captureStreams: false,
          captureConditions: false,
        });
        return await strings(res.result);
      } finally {
        void shelter.purge();
      }
    });
  }

  /**
   * Run notebook work outside the console, one job at a time (R also
   * finishes any console work first), reporting busy/idle like the console.
   */
  private queued<T>(job: () => Promise<T>): Promise<T> {
    const run = this.jobTail.then(async () => {
      if (this.status !== 'ready') throw new Error('R is not running');
      const gen = this.generation;
      this.emit({ type: 'busy', busy: true });
      try {
        return await job();
      } finally {
        if (gen === this.generation && this.status === 'ready') {
          this.emit({ type: 'busy', busy: !this.atPrompt });
          if (this.idle) this.emit({ type: 'idle' });
        }
      }
    });
    this.jobTail = run.catch(() => {});
    return run;
  }
  private jobTail: Promise<unknown> = Promise.resolve();

  // ---------- helpers that query R without touching the console ----------

  async strings(code: string): Promise<string[]> {
    return (await this.webR.evalRRaw(code, 'string[]')) ?? [];
  }

  async evalVoid(code: string): Promise<void> {
    await this.webR.evalRVoid(code);
  }
}

async function strings(obj: unknown): Promise<string[]> {
  const arr = (await (obj as { toArray(): Promise<(string | null)[]> }).toArray()) ?? [];
  return arr.map((s) => s ?? '');
}

/** Quote a JS string as an R string literal. */
export function rString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
