import { test, expect } from './fixtures';
import { openApp, closeAll, newFile, lines, clickLine, suggestions, markerMessage, writeFile, R, waitIdle } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await closeAll(page);
});

test('syntax errors are underlined, and an unclosed bracket is named', async ({ page }) => {
  await newFile(page, 'a.R', 'x <- 1\ny <- 5 6\n');
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(1);
  expect(await markerMessage(page, 'error')).toContain('unexpected numeric constant');

  await newFile(page, 'b.R', 'z <- list(a = 1,\n  b = 2\n\nprint(z)\n');
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(1, { timeout: 30_000 });
  expect(await markerMessage(page, 'error')).toContain("the '(' on line 1 is still open");
});

test('argument suggestions come back after a comma, without used arguments', async ({ page }) => {
  await newFile(page, 'c.R', '');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('lm(', { delay: 40 });
  await expect.poll(() => suggestions(page)).toContain('formula =');
  // The details panel beside the list carries the argument's help (desktop).
  await expect(page.locator('.suggest-details-container')).toContainText('argument of');
  await page.keyboard.press('Escape');

  await page.keyboard.type('y ~ x, weights = w, ', { delay: 30 });
  await expect.poll(() => suggestions(page)).toContain('data =');
  expect(await suggestions(page)).not.toContain('weights =');
  // The next positional argument is preselected.
  await expect(page.locator('.suggest-widget.visible .monaco-list-row.focused')).toContainText('data');
  await page.keyboard.press('Escape');

  // Functions that take "..." first (c, list, paste) don't pop up after commas.
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('c(1, ', { delay: 40 });
  await page.waitForTimeout(1500);
  await expect(page.locator('.suggest-widget.visible')).toHaveCount(0);
});

test('problems: unknown functions, bad arguments, unused variables', async ({ page }) => {
  await newFile(page, 'lint.R', 'm <- mena(1:3)\ns <- sd(1:3, foo = 1)\nf <- function(a) {\n  unused <- 5\n  a\n}\nd <- subset(mtcars, mpg > 20)\n');
  // codetools may download the first time.
  await expect(page.locator('.monaco-editor .squiggly-warning')).toHaveCount(3, { timeout: 60_000 });
  const messages = [await markerMessage(page, 'warning', 0), await markerMessage(page, 'warning', 1), await markerMessage(page, 'warning', 2)];
  expect(messages.join('\n')).toContain("Unknown function 'mena'");
  expect(messages.join('\n')).toContain('sd(): unused argument (foo = 1)');
  expect(messages.join('\n')).toContain("'unused' is assigned but never used");
});

test('outline lists sections and functions and jumps to them', async ({ page }) => {
  await newFile(page, 'o.R', '# Load ----\nx <- 1\n\n# Model ----\nfit <- function(d) lm(y ~ x, d)\n');
  await page.locator('button[title^="Outline"]').click();
  await expect(page.locator('.outline-item')).toHaveText([/Load\s*1/, /Model\s*4/, /fit\s*5/]);
  await page.locator('.outline-item').nth(2).click();
  await expect(page.locator('.outline-menu')).toHaveCount(0);
});

test('F2 goes to a function defined in another file; F1 opens help', async ({ page }) => {
  await writeFile(page, 'lib/helpers.R', '# Helpers\nsquare <- function(x) x^2\n');
  await newFile(page, 'main.R', 'y <- square(4)\nmean(1:3)\n');
  await clickLine(page, 0, 60);
  await page.keyboard.press('F2');
  await expect(page.locator('.editor-tab.active')).toContainText('helpers.R');

  await page.locator('.editor-tab', { hasText: 'main.R' }).click();
  await clickLine(page, 1, 12);
  await page.keyboard.press('F1');
  await expect(page.locator('.pane-tab.active', { hasText: 'Help' })).toBeVisible();
});

test('⌘/ toggles comments, ⌘⌥R sources a script', async ({ page }) => {
  await writeFile(page, 'run.R', 'ra_x <- 41\nra_x <- ra_x + 1\n');
  await page.evaluate(() => window.__webrIde.editor().openFile('run.R'));
  await clickLine(page, 0);
  await page.keyboard.press('Meta+Slash');
  await expect.poll(async () => (await lines(page))[0]).toBe('# ra_x <- 41');
  await page.keyboard.press('Meta+Slash');
  await expect.poll(async () => (await lines(page))[0]).toBe('ra_x <- 41');

  // Scripts have Run and Source, no Run All.
  await expect(page.locator('.pane-toolbar .tb-btn.labeled', { hasText: 'Run All' })).toHaveCount(0);
  await page.keyboard.press('Meta+s');
  await page.keyboard.press('Meta+Alt+KeyR');
  await waitIdle(page);
  await expect.poll(() => R(page, 'as.character(get0("ra_x", globalenv()))')).toEqual(['42']);
});

test('command palette and shortcut list open', async ({ page }) => {
  await newFile(page, 'p.R', 'x <- 1\n');
  await page.locator('button[title^="Command palette"]').click();
  await page.keyboard.type('outline');
  await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText('Document Outline');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Shift+KeyK');
  await expect(page.locator('.dialog.shortcuts')).toBeVisible();
});

test('find in files, and replace in open and closed files', async ({ page }) => {
  await writeFile(page, 'lib/helpers.R', 'square <- function(x) x^2\n');
  await writeFile(page, 'use.R', 'y <- square(4)\n');
  await writeFile(page, 'data.csv', 'a,square\n1,2\n');
  await page.evaluate(() => window.__webrIde.editor().openFile('use.R'));
  await page.locator('.sidebar .pane-tab', { hasText: 'Search' }).click();
  await page.locator('.search-panel input[type=search]').fill('square');
  // Data files are left out unless asked for.
  await expect(page.locator('.search-count')).toHaveText('2 in 2 files');
  await page.locator('button[title^="Include data files"]').click();
  await expect(page.locator('.search-count')).toHaveText('3 in 3 files');
  await page.locator('button[title^="Include data files"]').click();

  await page.locator('.search-form button[title="Replace"]').click();
  await page.locator('.search-panel input[placeholder^="Replace"]').fill('sq');
  await page.locator('.search-form button', { hasText: 'All' }).click();
  await page.locator('.dialog .btn.danger').click();
  await expect(page.locator('.search-count')).toHaveText('0 in 0 files');
  // The open tab was edited in place (unsaved); the closed file on disk.
  await expect(page.locator('.editor-tab.dirty')).toContainText('use.R');
  const ws = await page.evaluate(() => window.__webrIde.ide.state.workspace);
  expect(await page.evaluate(([w]) => window.__webrIde.fs.readText(w, 'lib/helpers.R'), [ws])).toBe('sq <- function(x) x^2\n');
});
