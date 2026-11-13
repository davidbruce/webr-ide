import { test, expect } from './fixtures';
import { openApp, closeAll, newFile, lines, waitIdle } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });

const activeTab = (page: import('@playwright/test').Page) => page.locator('.phone-tab.active').textContent();

test('phone layout: one pane at a time, running code shows the console', async ({ page }) => {
  await openApp(page, { rKeyboard: false });
  await closeAll(page);
  await newFile(page, 'p.R', 'x <- 1:3\nplot(x)\n');
  expect(await activeTab(page)).toContain('Script');
  await page.locator('.pane-toolbar button', { hasText: 'Source' }).tap();
  await waitIdle(page);
  await expect.poll(() => activeTab(page)).toContain('Console');
  // The plot made the Plots tab show a badge.
  await expect(page.locator('.phone-tab', { hasText: 'Plots' }).locator('.phone-badge')).toBeVisible();
  await page.locator('.phone-tab', { hasText: 'Files' }).tap();
  await expect(page.locator('.sidebar')).toBeVisible();
  // Tablet width: no phone tabs.
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(page.locator('.phone-tabs')).toHaveCount(0);
});

test('phone: outline popover and find in files', async ({ page }) => {
  await openApp(page, { rKeyboard: false });
  await closeAll(page);
  await newFile(page, 'o.R', '# Load ----\nx <- 1\n# Model ----\nfit <- function(d) lm(y ~ x, d)\n');
  await page.locator('button[title^="Outline"]').tap();
  await expect(page.locator('.outline-item')).toHaveCount(3);
  await page.locator('.outline-item').nth(1).tap();
  await page.locator('.phone-tab', { hasText: 'Files' }).tap();
  await page.locator('.sidebar .pane-tab', { hasText: 'Search' }).tap();
  await page.locator('.search-panel input[type=search]').fill('fit');
  await page.locator('.search-match').first().tap();
  await expect.poll(() => activeTab(page)).toContain('Script');
});

test('R keyboard types fast, accurately, and keeps focus', async ({ page }) => {
  await openApp(page, { rKeyboard: true });
  await closeAll(page);
  await newFile(page, 'fast.R', '');
  const first = page.locator('.monaco-editor .view-line').first();
  const b = (await first.boundingBox())!;
  await page.touchscreen.tap(b.x + 30, b.y + b.height / 2);
  await expect(page.locator('.rk')).toBeVisible();
  await page.evaluate(() => {
    (window as any).__blurs = 0;
    document.addEventListener('focusout', (e) => (e.target as Element).closest?.('.monaco-editor') && (window as any).__blurs++, true);
  });
  const centres: Record<string, [number, number]> = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.rk-keys .rk-key')].map((k) => {
        const f = k.querySelector('.rk-face')!.getBoundingClientRect();
        return [k.getAttribute('aria-label'), [f.x + f.width / 2, f.y + f.height / 2]];
      }),
    ),
  );
  const phrase = 'the quick brown fox jumps over the lazy dog';
  for (const ch of phrase) {
    const [x, y] = centres[ch === ' ' ? 'Space (drag to move the cursor)' : ch];
    // Fingers land a little below the key's middle; that still counts.
    await page.touchscreen.tap(x, y + 12);
  }
  await expect.poll(async () => (await lines(page))[0]).toBe(phrase);
  expect(await page.evaluate(() => (window as any).__blurs)).toBe(0);
  await expect(page.locator('.rk')).toBeVisible();
});

test.describe('iPad split view (tall and narrow)', () => {
  test.use({ viewport: { width: 592, height: 834 }, hasTouch: true, deviceScaleFactor: 2 });

  test('script and console are stacked under one Code tab', async ({ page }) => {
    await openApp(page, { rKeyboard: false });
    await closeAll(page);
    await newFile(page, 's.R', 'x <- 1:3\nprint(x)\n');
    await expect(page.locator('.workbench.stacked')).toHaveCount(1);
    // (While the editor has focus the key bar replaces the tabs.)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator('.phone-tab')).toHaveText(['Files', 'Code', 'Environment', 'Plots']);
    await expect(page.locator('.quadrant[aria-label="Source"]')).toBeVisible();
    await expect(page.locator('.quadrant[aria-label="Console"]')).toBeVisible();
    const h = await page.locator('.quadrant[aria-label="Console"]').evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBeGreaterThan(200);
    // Running code keeps the Code tab (the console is already on screen).
    await page.locator('.pane-toolbar button', { hasText: 'Source' }).tap();
    await waitIdle(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator('.phone-tab.active')).toHaveText('Code');
    await expect(page.locator('.console-term .term-row', { hasText: '[1] 1 2 3' })).toBeVisible();
    // Environment is still a tab of its own.
    await page.locator('.phone-tab', { hasText: 'Environment' }).tap();
    await expect(page.locator('.quadrant[aria-label="Console"]')).toBeHidden();
  });
});
