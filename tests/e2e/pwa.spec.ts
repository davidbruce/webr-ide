// Run with `npm run test:pwa` (production build + vite preview).
import { test, expect } from './fixtures';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SW = fileURLToPath(new URL('../../dist/sw.js', import.meta.url));

async function ready(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => document.querySelector('.r-status')?.className.includes('ok') && !document.querySelector('.startup-card'), null, {
    timeout: 240_000,
  });
}

test('after one visit, the app starts and runs R offline', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.waitForTimeout(3000); // let the service worker cache the runtime
  await context.setOffline(true);
  await page.reload();
  await ready(page);
  await page.locator('.console-body').click();
  await page.keyboard.type('sum(1:10)\n');
  await expect(page.locator('.console-term .term-row', { hasText: '[1] 55' })).toBeVisible();
  await context.setOffline(false);
});

test('a new version shows a banner, and Reload switches to it', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.waitForTimeout(2000);
  const original = readFileSync(SW, 'utf8');
  try {
    writeFileSync(SW, original + '\n// next version\n');
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    const banner = page.locator('.update-banner');
    await expect(banner).toContainText('A new version of webR IDE is ready');
    await Promise.all([page.waitForEvent('framenavigated'), banner.locator('.btn.primary').click()]);
    await ready(page);
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);
  } finally {
    writeFileSync(SW, original);
  }
});

test('offline, a pane still opens in its own window (popout.html from the service worker)', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);
  await page.waitForTimeout(3000);
  await context.setOffline(true);
  await page.reload();
  await ready(page);
  await page.locator('.quadrant[aria-label="Plots"] .pane-menu-btn').click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.pane-menu .lm-popout').click()]);
  expect(popup.url()).toMatch(/\/popout\.html\?pane=plots$/);
  await expect(popup.locator('.popout-root .pane-tab.active')).toHaveText('Plots');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await popup.close();
  await expect(page.locator('.quadrant[aria-label="Plots"]')).not.toHaveClass(/hidden/);
  await context.setOffline(false);
});
