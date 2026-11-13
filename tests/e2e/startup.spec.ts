import { test, expect } from './fixtures';
import { openApp, waitReady, consoleRows, writeFile, waitIdle } from './helpers';

test('shows start-up progress, then R runs code in the console', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('/');
  // The start-up card names each stage.
  const stages = new Set<string>();
  for (let i = 0; i < 400 && stages.size < 3; i++) {
    const t = await page.locator('.startup-card .startup-label').textContent({ timeout: 200 }).catch(() => null);
    if (t) stages.add(t.replace(/\s+/g, ' ').replace(/\d+\/\d+/, 'n/N').trim());
    if (await page.locator('.r-status.ok').count()) break;
    await page.waitForTimeout(100);
  }
  expect([...stages].some((s) => s.startsWith('Starting R'))).toBe(true);
  await waitReady(page);
  await expect(page.locator('.startup-card')).toHaveCount(0);

  await page.locator('.console-body').click();
  await page.keyboard.type('sum(1:10)\n');
  await expect.poll(() => consoleRows(page)).toContain('[1] 55');
});

test('error locations in the console open the file at that line', async ({ page }) => {
  await openApp(page);
  await writeFile(page, 'bad.R', 'a <- 1\nb <- 2 2\n');
  await writeFile(page, 'boom.R', 'f <- function() stop("kaboom")\nf()\n');

  await page.evaluate(() => window.__webrIde.session.submit('source("bad.R")'));
  await waitIdle(page);
  const parseRow = page.locator('.console-term .term-row', { hasText: /bad\.R:2:\d+/ }).last();
  await parseRow.click();
  await expect(page.locator('.editor-tab.active')).toContainText('bad.R');

  await page.evaluate(() => window.__webrIde.session.submit('source("boom.R")'));
  await waitIdle(page);
  const runtimeRow = page.locator('.console-term .term-row', { hasText: /\(from boom\.R#\d+\)/ }).last();
  await expect(runtimeRow).toBeVisible();
  await runtimeRow.click();
  await expect(page.locator('.editor-tab.active')).toContainText('boom.R');
});
