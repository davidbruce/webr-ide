// Every test gets a fresh persistent WebKit profile and clean site storage.
//
// - Persistent: WebKit only offers the origin-private file system (where
//   workspaces live) to persistent profiles; an ordinary test context falls
//   back to memory.
// - Clean: WebKit keeps that file system per origin, shared between
//   profiles, so each test first wipes it (and localStorage, caches and
//   service workers) from a blank page on the same origin. Tests therefore
//   run one at a time (workers: 1).
import { test as base, webkit, type BrowserContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESET_PATH = '__test-reset';

async function wipeOrigin() {
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as any).keys()) await root.removeEntry(name, { recursive: true });
  localStorage.clear();
  sessionStorage.clear();
  for (const k of await caches.keys()) await caches.delete(k);
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
}

export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ viewport, hasTouch, isMobile, deviceScaleFactor, baseURL, acceptDownloads }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'webr-ide-test-'));
    const context = await webkit.launchPersistentContext(dir, { viewport, hasTouch, isMobile, deviceScaleFactor, baseURL, acceptDownloads });
    // A blank page on the app's origin, to wipe storage before the app starts.
    await context.route(`**/${RESET_PATH}`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>reset</title>' }));
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(RESET_PATH);
    await page.evaluate(wipeOrigin);
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

export { expect } from '@playwright/test';
