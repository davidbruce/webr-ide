// Package libraries and renv. These install from repo.r-wasm.org: @network.
import { test, expect } from './fixtures';
import { openApp, R, waitIdle, waitReady, workspace, makeWorkspace, readFile, closeAll, newFile } from './helpers';

/** Install with webR from the console and wait (and let the IDE cache it). */
async function install(page: import('@playwright/test').Page, pkg: string) {
  await page.evaluate((p) => window.__webrIde.session.submit(`webr::install("${p}")`), pkg);
  await waitIdle(page);
  await page.waitForTimeout(2500); // the idle hook stores the archive
}

const linked = (page: import('@playwright/test').Page) => R(page, 'paste(sort(list.files("/webr-ide/library")), collapse = ",")').then((r) => r[0]);

test('@network a workspace library links cached packages without downloading, and switches restart only when needed', async ({ page }) => {
  const starts: number[] = [];
  page.on('console', (m) => /mounted \d+ cached packages/.test(m.text()) && starts.push(Date.now()));
  await openApp(page);
  const shared = await workspace(page);
  await install(page, 'R6');
  await install(page, 'DBI');

  await makeWorkspace(page, 'Own', { 'script.R': '' });
  await page.evaluate(() => window.__webrIde.ide.setLibraryMode('workspace'));
  await waitReady(page);
  expect(await linked(page)).toBe('');

  const tgz: string[] = [];
  page.on('request', (r) => r.url().endsWith('.tgz') && tgz.push(r.url()));
  await install(page, 'R6');
  expect(tgz).toEqual([]); // linked from the cache
  expect(await linked(page)).toBe('R6');
  expect(JSON.parse(await readFile(page, 'Own', '.ide/library.json'))).toEqual({ mode: 'workspace', packages: { R6: expect.any(String) } });
  await R(page, '{library(R6); "1"}');

  // To the shared library: R6 is loaded at the same version, so no restart.
  let before = starts.length;
  await page.evaluate((w) => window.__webrIde.ide.switchWorkspace(w), shared);
  await waitReady(page);
  expect(starts.length).toBe(before);
  expect(await linked(page)).toBe('DBI,R6');

  // DBI is loaded but not in Own's library: switching back restarts R.
  await R(page, '{loadNamespace("DBI"); "1"}');
  before = starts.length;
  await page.evaluate(() => window.__webrIde.ide.switchWorkspace('Own'));
  await waitReady(page);
  expect(starts.length).toBe(before + 1);
  expect(await linked(page)).toBe('R6');
});

const LOCK = {
  R: { Version: '4.3.2', Repositories: [{ Name: 'CRAN', URL: 'https://cloud.r-project.org' }] },
  Packages: {
    renv: { Package: 'renv', Version: '1.0.3', Source: 'Repository', Repository: 'CRAN', Hash: 'abc' },
    R6: { Package: 'R6', Version: '2.5.0', Source: 'Repository', Repository: 'CRAN', Hash: 'pinned' },
    mypkg: { Package: 'mypkg', Version: '0.1.0', Source: 'GitHub', RemoteType: 'github' },
    limma: { Package: 'limma', Version: '3.56.0', Source: 'Bioconductor' },
    RSQLite: { Package: 'RSQLite', Version: '2.3.1', Source: 'Repository', Repository: 'CRAN' },
  },
};

test('@network renv.lock is checked against webR and installed into the workspace', async ({ page }) => {
  await openApp(page);
  await makeWorkspace(page, 'Renv', { 'renv.lock': JSON.stringify(LOCK, null, 2) });
  const dialog = page.locator('.dialog.renv');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.renv-verdict')).toContainText('Partly compatible');
  await expect(dialog.locator('.renv-group')).toHaveText([/Not available for webR \(2\)/, /doesn't work in the browser \(1\)/, /Newer version in webR \(1\)/]);
  await expect(dialog).toContainText('Locked for R 4.3.2');
  await dialog.locator('.btn.primary').click();
  await waitReady(page);
  await waitIdle(page);
  await page.waitForTimeout(2500);
  const lib = JSON.parse(await readFile(page, 'Renv', '.ide/library.json'));
  expect(lib.mode).toBe('workspace');
  expect(Object.keys(lib.packages)).toContain('R6');

  // Checked once: reopening doesn't ask again.
  await page.evaluate(() => window.__webrIde.ide.switchWorkspace('Default'));
  await waitReady(page);
  await page.evaluate(() => window.__webrIde.ide.switchWorkspace('Renv'));
  await waitReady(page);
  await page.waitForTimeout(2000);
  await expect(dialog).toHaveCount(0);

  // Writing renv.lock back asks before changing the pinned R6 version.
  await page.keyboard.press('Meta+Comma');
  await page.locator('.dialog.settings .btn', { hasText: 'Write now' }).click();
  const prompt = page.locator('.dialog', { hasText: 'renv.lock pins other versions' });
  await expect(prompt).toContainText('R6: 2.5.0 →');
  await prompt.locator('.btn', { hasText: 'Keep Locked Versions' }).click();
  await page.waitForTimeout(1500);
  let written = JSON.parse(await readFile(page, 'Renv', 'renv.lock'));
  expect(written.R.Version).toBe('4.3.2');
  expect(written.Packages.R6).toMatchObject({ Version: '2.5.0', Hash: 'pinned' });
  expect(Object.keys(written.Packages)).toEqual(expect.arrayContaining(['renv', 'mypkg', 'limma']));

  await page.locator('.segmented[aria-label="renv.lock versions"] button', { hasText: 'Ask' }).click();
  await page.locator('.dialog.settings .btn', { hasText: 'Write now' }).click();
  await prompt.locator('.btn', { hasText: "Use webR's Versions" }).click();
  await page.waitForTimeout(1500);
  written = JSON.parse(await readFile(page, 'Renv', 'renv.lock'));
  expect(written.Packages.R6.Version).not.toBe('2.5.0');
  expect(written.Packages.R6.Hash).toBeUndefined();
});

test('@network reformat with styler, installed on request into the tools library', async ({ page }) => {
  test.slow();
  await openApp(page);
  await closeAll(page);
  await newFile(page, 'fmt.R', 'f<-function(x,y){\nif(x>y){x}else{y}\n}\n');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Meta+Shift+KeyA');
  await page.locator('.dialog', { hasText: 'Install styler?' }).locator('.btn.primary').click();
  await expect
    .poll(() => page.$$eval('.monaco-editor .view-line', (l) => l.map((x) => (x.textContent ?? '').replace(/\u00a0/g, ' '))), { timeout: 600_000 })
    .toEqual(['f <- function(x, y) {', '  if (x > y) {', '    x', '  } else {', '    y', '  }', '}', '']);
  // An IDE tool: not in the workspace's library.
  expect(await linked(page)).not.toContain('styler');
  expect((await R(page, 'paste(list.files("/webr-ide/tools"), collapse = ",")'))[0]).toContain('styler');
});
