import { test, expect } from './fixtures';
import { openApp, consoleRows, waitIdle } from './helpers';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (window as any).__webrIde.editor().closeAll(true));
});

const pane = (page: Page, label: string) => page.locator(`.quadrants .quadrant[aria-label="${label}"]`);
const height = (page: Page, label: string) => pane(page, label).evaluate((e) => e.getBoundingClientRect().height);
const width = (page: Page, label: string) => pane(page, label).evaluate((e) => e.getBoundingClientRect().width);
async function layoutMenu(page: Page, label: string, item: string) {
  await pane(page, label).locator('.pane-menu-btn').click();
  await page.locator(`.pane-menu .${item}`).click();
}

test('minimize a pane to its header; the other pane in the column takes the height', async ({ page }) => {
  const before = await height(page, 'Plots');
  await pane(page, 'Environment').locator('.pane-min').click();
  await expect(pane(page, 'Environment')).toHaveClass(/minimized/);
  expect(await height(page, 'Environment')).toBeLessThan(45);
  expect(await height(page, 'Plots')).toBeGreaterThan(before + 200);
  // A tab of the minimized pane brings it back.
  await pane(page, 'Environment').locator('.pane-tab', { hasText: 'History' }).click();
  await expect(pane(page, 'Environment')).not.toHaveClass(/minimized/);
  await expect(pane(page, 'Environment').locator('.pane-tab.active')).toHaveText('History');
});

test('expand vertically and horizontally', async ({ page }) => {
  // Vertically: Plots fills the right column; Environment is minimized.
  await layoutMenu(page, 'Plots', 'lm-expand-v');
  await expect(pane(page, 'Environment')).toHaveClass(/minimized/);
  await expect(pane(page, 'Source')).not.toHaveClass(/minimized/);
  // Horizontally: the left column becomes a strip, Plots fills the width.
  await layoutMenu(page, 'Plots', 'lm-expand-h');
  await expect(page.locator('.column-strip .strip-label')).toHaveText(['Source', 'Console']);
  expect(await width(page, 'Plots')).toBeGreaterThan(900);
  await page.locator('.strip-btn', { hasText: 'Source' }).click();
  await expect(page.locator('.column-strip')).toHaveCount(0);
  await expect(pane(page, 'Console')).toHaveClass(/minimized/);
  await layoutMenu(page, 'Source', 'lm-show-all');
  for (const p of ['Source', 'Console', 'Environment', 'Plots']) await expect(pane(page, p)).not.toHaveClass(/minimized/);
});

test('the script takes the space; there is always a pane; output is flagged', async ({ page }) => {
  const w = await width(page, 'Source');
  await pane(page, 'Environment').locator('.pane-min').click();
  await pane(page, 'Plots').locator('.pane-min').click();
  await expect(page.locator('.column-strip.right .strip-label')).toHaveText(['Environment', 'Plots']);
  expect(await width(page, 'Source')).toBeGreaterThan(w + 300);

  // A plot while Plots is minimized: a dot on its strip button.
  await page.evaluate(() => (window as any).__webrIde.session.submit('plot(1:3)'));
  await waitIdle(page);
  await expect(page.locator('.strip-btn', { hasText: 'Plots' }).locator('.pane-badge')).toBeVisible();

  // Minimizing the last panes brings the script back.
  await pane(page, 'Console').locator('.pane-min').click();
  await pane(page, 'Source').locator('.pane-min').click();
  await expect(pane(page, 'Source')).not.toHaveClass(/minimized/);

  // Running code brings the console back.
  await page.evaluate(() => (window as any).__webrIde.session.submit('1 + 1'));
  await waitIdle(page);
  await expect(pane(page, 'Console')).not.toHaveClass(/minimized/);

  // Kept across a reload.
  await page.reload();
  await expect(page.locator('.column-strip.right')).toBeVisible({ timeout: 120_000 });
});

test('a pane opens in its own window and comes back', async ({ page }) => {
  await pane(page, 'Plots').locator('.pane-menu-btn').click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.pane-menu .lm-popout').click()]);
  await expect(pane(page, 'Plots')).toHaveClass(/hidden/);
  // The window shows the app's address, not about:blank.
  expect(popup.url()).toMatch(/\/popout\.html\?pane=plots$/);
  await expect(popup.locator('.popout-root .pane-tab.active')).toHaveText('Plots');
  await page.evaluate(() => (window as any).__webrIde.session.submit('hist(rnorm(50))'));
  await waitIdle(page);
  await expect(popup.locator('canvas.plot-canvas').first()).toBeVisible();
  // Clicks work in the new window.
  await popup.locator('.pane-tab', { hasText: 'Help' }).click();
  await expect(popup.locator('.pane-tab.active')).toHaveText('Help');
  // Closing the window puts the pane back.
  await popup.close();
  await expect(pane(page, 'Plots')).not.toHaveClass(/hidden/);
  await expect(pane(page, 'Plots').locator('.pane-tab.active')).toHaveText('Help');

  // The console works from its own window too, and keeps what it showed.
  await page.evaluate(() => (window as any).__webrIde.session.submit('cat("before\\n")'));
  await waitIdle(page);
  await pane(page, 'Console').locator('.pane-menu-btn').click();
  const [con] = await Promise.all([page.waitForEvent('popup'), page.locator('.pane-menu .lm-popout').click()]);
  await expect(con.locator('.console-term .term-row', { hasText: 'before' }).first()).toBeVisible();
  await con.locator('.console-term').click();
  await con.keyboard.type('6 * 7');
  await con.keyboard.press('Enter');
  await expect.poll(async () => (await con.$$eval('.console-term .term-row', (r) => r.map((x) => (x.textContent ?? '').trim()))).join('\n')).toContain('[1] 42');
  await con.locator('.pane-return').click();
  await expect(pane(page, 'Console')).not.toHaveClass(/hidden/);
  expect((await consoleRows(page)).join('\n')).toContain('[1] 42');
});
