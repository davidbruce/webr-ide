import { test, expect } from './fixtures';
import { openApp, closeAll, newFile, clickLine, lines, consoleRows, R, waitReady, writeFile, workspace, makeWorkspace } from './helpers';

test.use({ acceptDownloads: true });

test('settings change fonts, wrapping and theme, and persist', async ({ page }) => {
  await openApp(page);
  await closeAll(page);
  await newFile(page, 's.R', 'x <- 1\n');
  await page.keyboard.press('Meta+Comma');
  await expect(page.locator('.dialog.settings')).toBeVisible();
  const larger = (what: string) => page.locator(`.stepper[aria-label="${what}"] button[aria-label^="Larger"]`);
  await larger('editor font size').click();
  await larger('editor font size').click();
  await larger('console font size').click();
  await page.locator('button[aria-label="Wrap long lines"]').click();
  await page.locator('.segmented[aria-label="Theme"] button', { hasText: 'Dark' }).click();
  await page.locator('.dialog.settings .btn.primary').click();

  await expect(page.locator('.monaco-editor .view-line').first()).toHaveCSS('font-size', '16px');
  await expect(page.locator('.console-term')).toHaveAttribute('style', /--term-font-size: 14px/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const saved = JSON.parse((await page.evaluate(() => localStorage.getItem('webr-ide:settings'))) ?? '{}');
  expect(saved).toMatchObject({ editorFontSize: 16, consoleFontSize: 14, wordWrap: true });
});

test('a workspace can override the tab width', async ({ page }) => {
  await openApp(page);
  await closeAll(page);
  await page.keyboard.press('Meta+Comma');
  await page.locator('.segmented[aria-label="Workspace tab width"] button', { hasText: /^4$/ }).click();
  await page.locator('.dialog.settings .btn.primary').click();
  await newFile(page, 't.R', 'f <- function() {\nx\n}\n');
  await clickLine(page, 1, 2);
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await lines(page))[1]).toBe('    x');
  const ws = await workspace(page);
  expect(JSON.parse(await page.evaluate((w) => window.__webrIde.fs.readText(w, '.ide/settings.json'), ws))).toEqual({ tabSize: 4 });

  await page.keyboard.press('Meta+Comma');
  await page.locator('.segmented[aria-label="Workspace tab width"] button', { hasText: 'Default' }).click();
  await page.locator('.dialog.settings .btn.primary').click();
  await clickLine(page, 1, 2);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await lines(page))[1]).toBe('  x');
});

test('.Rprofile runs quietly on open, with .First(), skipping renv activation', async ({ page }) => {
  await openApp(page);
  await makeWorkspace(page, 'Profiled', {
    '.Rprofile': 'source("renv/activate.R")\nx_from_profile <- 42\nmessage("profile message")\n.First <- function() cat("first ran\\n")\n',
    'renv/activate.R': 'stop("renv bootstrap would run here")\n',
  });
  await expect.poll(() => consoleRows(page)).toContain('first ran');
  const rows = await consoleRows(page);
  expect(rows).toContain('profile message');
  expect(rows.some((r) => r.includes('Skipped renv activation'))).toBe(true);
  expect(rows.some((r) => r.includes('bootstrap would run'))).toBe(false);
  expect(rows.some((r) => r.includes('ide_run_rprofile'))).toBe(false);
  expect(await R(page, 'as.character(x_from_profile)')).toEqual(['42']);
  expect(await page.evaluate(() => window.__webrIde.ide.state.history.some((h: string) => h.includes('rprofile')))).toBe(false);
});

test('a workspace exports to .zip and imports back as a new workspace', async ({ page }) => {
  await openApp(page);
  await writeFile(page, 'data/notes.txt', 'hello\n');
  await R(page, '{zip_obj <- 1:3; "1"}');
  const ws = await workspace(page);
  const list = (w: string) =>
    page.evaluate(async (w) => {
      const fs = window.__webrIde.fs;
      return fs.flattenTree(await fs.listTree(w)).map((n: any) => n.path).sort();
    }, w);
  await page.locator('.ws-btn').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.menu-item', { hasText: 'Export as .zip' }).click()]);
  const zipPath = test.info().outputPath('ws.zip');
  await download.saveAs(zipPath);
  expect(download.suggestedFilename()).toBe(`${ws}.zip`);
  const exported = await list(ws);

  await page.locator('.ws-btn').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu-item', { hasText: 'Import from .zip' }).click()]);
  await chooser.setFiles(zipPath);
  await page.locator('.dialog input').fill('Imported');
  await page.locator('.dialog .btn.primary').click();
  await page.waitForFunction(() => window.__webrIde.ide.state.workspace === 'Imported');
  await waitReady(page);

  // Everything that was in the workspace when it was exported.
  expect(await list('Imported')).toEqual(exported);
  expect(await R(page, 'paste(get0("zip_obj", globalenv()), collapse = ",")')).toEqual(['1,2,3']);
});
