// Shared helpers for the end-to-end tests. The dev server exposes
// window.__webrIde = { session, editor, ide, fs } (see src/main.tsx).
import { expect } from './fixtures';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __webrIde: any;
  }
}

/** Wait until R is ready and nothing is starting, switching or attaching. */
export async function waitReady(page: Page, timeout = 180_000) {
  await page.waitForFunction(
    () => {
      const w = window.__webrIde;
      return (
        !!w &&
        document.querySelector('.r-status')?.className.includes('ok') &&
        !document.querySelector('.startup-card') &&
        !w.ide.state.switching &&
        !w.ide.state.attaching
      );
    },
    null,
    { timeout },
  );
}

/** Open the app in this test's fresh browser storage and wait for R. */
export async function openApp(page: Page, opts: { rKeyboard?: boolean } = {}) {
  if (opts.rKeyboard !== undefined) {
    const on = opts.rKeyboard ? '1' : '0';
    await page.addInitScript((v) => localStorage.setItem('webr-ide:r-keyboard', v), on);
  }
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('/');
  await waitReady(page);
}

/** Evaluate R and return a character vector. */
export function R(page: Page, code: string): Promise<string[]> {
  return page.evaluate((c) => window.__webrIde.session.strings(c), code);
}

/** Wait for R to finish what the console is running. */
export async function waitIdle(page: Page, timeout = 300_000) {
  await page.waitForFunction(() => window.__webrIde.session.idle, null, { timeout });
}

export async function closeAll(page: Page) {
  await page.evaluate(() => window.__webrIde.editor().closeAll(true));
}

/** A new editor tab with this content. */
export async function newFile(page: Page, name: string, content: string) {
  await page.evaluate(([n, c]) => window.__webrIde.editor().newFile(n, c), [name, content]);
  await page.waitForTimeout(300);
}

/** Write a workspace file (folders are created) and refresh the file tree. */
export async function writeFile(page: Page, path: string, text: string) {
  await page.evaluate(
    async ([p, t]) => {
      const i = window.__webrIde.ide;
      if (p.includes('/')) await i.makeFolder(p.slice(0, p.lastIndexOf('/'))).catch(() => {});
      await i.writeWorkspaceFile(p, t);
      await i.refreshTree();
    },
    [path, text],
  );
}

export function readFile(page: Page, ws: string, path: string): Promise<string> {
  return page.evaluate(([w, p]) => window.__webrIde.fs.readText(w, p), [ws, path]);
}

export function workspace(page: Page): Promise<string> {
  return page.evaluate(() => window.__webrIde.ide.state.workspace);
}

/** Text of the visible editor lines. */
export function lines(page: Page): Promise<string[]> {
  return page.$$eval('.monaco-editor .view-line', (ls) => ls.map((l) => (l.textContent ?? '').replace(/ /g, ' ')));
}

/** Click in editor line `i` (0-based), `x` pixels from its left. */
export async function clickLine(page: Page, i: number, x = 30) {
  const line = page.locator('.monaco-editor .view-line').nth(i);
  const b = (await line.boundingBox())!;
  await page.mouse.click(b.x + x, b.y + b.height / 2);
}

/** Console rows (trimmed, non-empty). */
export function consoleRows(page: Page): Promise<string[]> {
  return page.$$eval('.console-term .term-row', (r) => r.map((x) => (x.textContent ?? '').trim()).filter(Boolean));
}

/** Labels of the open suggestion list. */
export function suggestions(page: Page): Promise<string[]> {
  return page.$$eval('.suggest-widget.visible .monaco-list-row .label-name', (r) => r.map((x) => x.textContent ?? ''));
}

/** Hover the first marker of a kind and return its message. */
export async function markerMessage(page: Page, kind: 'error' | 'warning', nth = 0): Promise<string> {
  const el = page.locator(`.monaco-editor .squiggly-${kind}`).nth(nth);
  const b = (await el.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const hover = page.locator('.monaco-hover .hover-row').first();
  await expect(hover).toBeVisible();
  const text = (await hover.textContent()) ?? '';
  await page.mouse.move(2, 600);
  return text;
}

/** Make a workspace with these files and switch to it. */
export async function makeWorkspace(page: Page, name: string, files: Record<string, string>) {
  await page.evaluate(
    async ([n, f]) => {
      const { ide, fs } = window.__webrIde;
      await fs.createWorkspace(n);
      for (const [p, t] of Object.entries(f as Record<string, string>)) await fs.writeFile(n, p, t);
      await ide.refreshWorkspaces();
      await ide.switchWorkspace(n);
    },
    [name, files] as const,
  );
  await waitReady(page);
}
