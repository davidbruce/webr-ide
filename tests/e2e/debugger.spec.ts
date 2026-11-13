import { test, expect } from './fixtures';
import { openApp, closeAll, writeFile, R, waitIdle } from './helpers';

const CODE = 'g <- function(a) {\n  b <- a * 10\n  b + 1\n}\nf <- function(x) {\n  y <- x + 1\n  z <- g(y)\n  z\n}\nres <- f(1)\n';

const debugState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const s = window.__webrIde.ide.state;
    return s.debug ? { stack: s.debug.stack.map((f: any) => f.call), line: s.debug.stack[s.debug.frame]?.line, vars: s.debugEnv.map((e: any) => e.name).join(',') } : null;
  });

/** Click the breakpoint margin of a line (found by its line number: Monaco reuses line elements). */
async function clickMargin(page: import('@playwright/test').Page, line: number) {
  const l = (await page.locator('.monaco-editor .line-numbers', { hasText: new RegExp(`^${line}$`) }).boundingBox())!;
  const margin = (await page.locator('.monaco-editor .glyph-margin').first().boundingBox())!;
  await page.mouse.click(margin.x + margin.width / 2, l.y + l.height / 2);
}

test('breakpoints pause sourced code; step, inspect and continue', async ({ page }) => {
  await openApp(page);
  await closeAll(page);
  await writeFile(page, 'dbg.R', CODE);
  await page.evaluate(() => window.__webrIde.editor().openFile('dbg.R'));
  await clickMargin(page, 7);
  await clickMargin(page, 10); // outside a function: shown as inactive
  await expect(page.locator('.bp-dot')).toHaveCount(2);
  await expect(page.locator('.bp-dot.inactive')).toHaveCount(1);

  await page.locator('.pane-toolbar button', { hasText: 'Source' }).click();
  await expect.poll(() => debugState(page)).toEqual({ stack: ['f(1)'], line: 7, vars: 'x,y' });
  await expect(page.locator('.r-status')).toHaveText('Debugging');
  await expect(page.locator('.monaco-editor .debug-line')).toHaveCount(1);
  await expect(page.locator('.env-frame')).toContainText('f(1)');

  // One step: the IDE already stepped out of R's breakpoint code.
  await page.keyboard.press('F10');
  await expect.poll(() => debugState(page)).toEqual({ stack: ['f(1)'], line: 8, vars: 'x,y,z' });
  // Stepping isn't recorded in History.
  expect(await page.evaluate(() => window.__webrIde.ide.state.history.includes('n'))).toBe(false);

  await page.locator('.debug-bar button[title^="Continue"]').click();
  await expect.poll(() => debugState(page)).toBeNull();
  await waitIdle(page);
  expect(await R(page, 'as.character(res)')).toEqual(['21']);
  // Breakpoints are saved with the workspace.
  const ws = await page.evaluate(() => window.__webrIde.ide.state.workspace);
  const saved = JSON.parse(await page.evaluate((w) => window.__webrIde.fs.readText(w, '.ide/state.json'), ws));
  expect(saved.breakpoints).toEqual({ 'dbg.R': [7, 10] });
});

test('step into from a breakpoint, hover values, completions, and live breakpoint changes', async ({ page }) => {
  await openApp(page);
  await closeAll(page);
  await writeFile(page, 'dbg.R', CODE);
  await page.evaluate(() => window.__webrIde.editor().openFile('dbg.R'));
  await clickMargin(page, 7);
  await page.locator('.pane-toolbar button', { hasText: 'Source' }).click();
  await expect.poll(() => debugState(page)).toMatchObject({ stack: ['f(1)'], line: 7 });

  // Hovering y shows its value in the paused frame.
  const y = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => (l.textContent ?? '').replace(/\u00a0/g, ' ').includes('z <- g(y)'))!;
    const span = [...line.querySelectorAll('span span')].find((e) => e.textContent === 'y')!;
    const r = span.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(y.x, y.y);
  await expect(page.locator('.monaco-hover', { hasText: 'num 2' })).toBeVisible();
  await page.mouse.move(2, 700);

  // Completions include the frame's variables.
  expect((await page.evaluate(() => window.__webrIde.ide.completions('y'))).items[0]).toBe('y');

  // The first Step Into enters g().
  await page.keyboard.press('Shift+F4');
  await expect.poll(() => debugState(page)).toMatchObject({ stack: ['f(1)', 'g(y)'], vars: 'a' });
  await page.keyboard.press('Shift+F8');
  await expect.poll(() => debugState(page)).toBeNull();

  // Without sourcing again: drop line 7, add line 3 (inside g).
  await clickMargin(page, 7);
  await clickMargin(page, 3);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__webrIde.session.submit('f(2)'));
  await expect.poll(() => debugState(page)).toMatchObject({ stack: ['f(2)', 'g(y)'], line: 3, vars: 'a,b' });
  await page.keyboard.press('Shift+F5');
  await expect.poll(() => debugState(page)).toBeNull();
  // And with no breakpoints left, it runs straight through.
  await clickMargin(page, 3);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__webrIde.session.submit('r2 <- f(3)'));
  await waitIdle(page);
  expect(await R(page, 'as.character(r2)')).toEqual(['41']);
});

test('a function typed in the console is shown read-only while paused', async ({ page }) => {
  await openApp(page);
  await closeAll(page);
  await page.evaluate(() => window.__webrIde.session.submit('h <- function(v) {\n  w <- v * 2\n  w + 1\n}'));
  await waitIdle(page);
  await page.evaluate(() => window.__webrIde.session.submit('debugonce(h); h(3)'));
  await expect.poll(() => debugState(page)).toMatchObject({ stack: ['h(3)'] });
  await page.keyboard.press('F10');
  await expect(page.locator('.editor-tab.active')).toContainText('h()');
  await expect(page.locator('.monaco-editor .debug-line')).toHaveCount(1);
  await page.keyboard.press('Shift+F5');
  await expect.poll(() => debugState(page)).toBeNull();
  await expect(page.locator('.editor-tab', { hasText: 'h()' })).toHaveCount(0);
});

test('debug on error pauses in the function that failed', async ({ page }) => {
  await openApp(page);
  await page.locator('button[title^="Debug on error"]').click();
  await page.evaluate(() => window.__webrIde.session.submit('h <- function(v) { w <- v * 2; stop("bad") }; h(3)'));
  await expect.poll(() => debugState(page)).toMatchObject({ stack: ['h(3)'], vars: 'v,w' });
  await page.locator('.debug-bar button[title^="Stop"]').click();
  await expect.poll(() => debugState(page)).toBeNull();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  test('the debug bar fits, and tapping a line number sets a breakpoint', async ({ page }) => {
    await openApp(page, { rKeyboard: false });
    await closeAll(page);
    await writeFile(page, 'dbg.R', CODE);
    await page.evaluate(() => window.__webrIde.editor().openFile('dbg.R'));
    // Tap the line number of line 7.
    const line = (await page.locator('.monaco-editor .line-numbers', { hasText: /^7$/ }).boundingBox())!;
    const gutter = (await page.locator('.monaco-editor .margin').first().boundingBox())!;
    await page.touchscreen.tap(gutter.x + gutter.width / 2, line.y + line.height / 2);
    await expect(page.locator('.bp-line-number')).toHaveCount(1);
    await page.locator('.pane-toolbar button[title^="Source"]').tap();
    await expect.poll(() => debugState(page)).toMatchObject({ line: 7 });
    await page.locator('.phone-tab', { hasText: 'Console' }).tap().catch(() => {});
    // Debug buttons above the bottom bar, wherever you are.
    await expect(page.locator('.keybar.debug-keys')).toBeVisible();
    const bar = page.locator('.debug-bar');
    await expect(bar).toBeVisible();
    const b = (await bar.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    await bar.locator('button[title^="Continue"]').tap();
    await expect.poll(() => debugState(page)).toBeNull();
  });
});
