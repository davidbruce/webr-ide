import { test, expect } from './fixtures';
import { openApp, closeAll, newFile, lines, clickLine, consoleRows, waitIdle, makeWorkspace } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await closeAll(page);
});

const submit = (page: import('@playwright/test').Page, code: string) =>
  page.evaluate((c) => (window as any).__webrIde.session.submit(c), code);

test('help pages are HTML with links, history, package index and examples', async ({ page }) => {
  await submit(page, '?lm');
  const help = page.locator('.help-html');
  await expect(help.locator('h2')).toHaveText('Fitting Linear Models');
  // Examples and usage are coloured like the editor.
  await expect(help.locator('.help-code pre span[class^="mtk"]').first()).toBeVisible();

  await help.locator('a', { hasText: /^glm$/ }).first().click();
  await expect(help.locator('h2')).toHaveText('Fitting Generalized Linear Models');
  await page.locator('button[title="Back"]').click();
  await expect(help.locator('h2')).toHaveText('Fitting Linear Models');
  await page.locator('button[title="Forward"]').click();
  await expect(help.locator('h2')).toHaveText('Fitting Generalized Linear Models');

  // The package name leads to its index.
  await page.locator('.help-pkg').click();
  await expect(help.locator('h2')).toContainText('stats: The R Stats Package');
  await help.locator('.help-index a', { hasText: /^median$/ }).click();
  await expect(help.locator('h2')).toHaveText('Median Value');

  // Maths is typeset (KaTeX, as MathML).
  await submit(page, '?Normal');
  await expect(help.locator('.help-math math').first()).toBeAttached();
  await expect(help.locator('.help-math.display math').first()).toBeAttached();
  await expect(help.locator('code.reqn')).toHaveCount(0);

  // A topic in several packages lists them.
  await submit(page, '?plot');
  await expect(help.locator('.help-choices a')).toHaveText(['graphics::plot', 'base::plot']);

  // Run examples sends example() to the console.
  await submit(page, 'help("rev")');
  await expect(help.locator('h2')).toHaveText('Reverse Elements');
  await help.locator('.help-run').click();
  await waitIdle(page);
  await expect.poll(async () => (await consoleRows(page)).join('\n')).toContain('rev> ');

  // The search box, and help(package = ).
  await page.locator('.help-search input').fill('stats::sd');
  await page.locator('.help-search input').press('Enter');
  await expect(help.locator('h2')).toHaveText('Standard Deviation');
  await submit(page, 'help(package = "utils")');
  await expect(help.locator('h2')).toContainText('utils: The R Utils Package');
});

test('F1 in the editor opens help without printing to the console', async ({ page }) => {
  await newFile(page, 'h.R', 'x <- median(1:3)\n');
  const before = (await consoleRows(page)).length;
  await clickLine(page, 0, 80);
  await page.keyboard.press('F1');
  await expect(page.locator('.help-html h2')).toHaveText('Median Value');
  expect((await consoleRows(page)).length).toBe(before);
});

test('snippets expand with Tab; your own snippets apply in every workspace', async ({ page }) => {
  await newFile(page, 's.R', '');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('fun');
  await page.keyboard.press('Tab');
  await page.keyboard.type('add');
  await page.keyboard.press('Tab');
  await page.keyboard.type('a, b');
  await page.keyboard.press('Tab');
  await page.keyboard.type('a + b');
  await expect.poll(() => lines(page)).toEqual(['add <- function(a, b) {', '  a + b', '}']);
  await page.keyboard.press('Escape');

  // Tab after a word that isn't a snippet still indents.
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await lines(page))[3]).toBe('x ');

  // Add one in the snippets file (app storage, shared by all workspaces) and save it.
  await page.keyboard.press('Meta+Shift+P');
  await page.keyboard.type('Edit Code Snippets');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-tab.active')).toContainText('r.snippets');
  await page.keyboard.press('Meta+ArrowDown');
  await page.evaluate(() => (window as any).__webrIde.editor().insertText('\nsnippet hi\n\tcat("hi ${1:you}\\n")\n'));
  await page.keyboard.press('Meta+s');
  await expect(page.locator('.editor-tab.active')).not.toHaveClass(/dirty/);
  expect(await page.evaluate(() => (window as any).__webrIde.fs.exists((window as any).__webrIde.ide.state.workspace, '.ide/r.snippets'))).toBe(false);

  // Another workspace has it too.
  await closeAll(page);
  await makeWorkspace(page, 'Other', { 'o.R': '' });
  await newFile(page, 'o2.R', '');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('hi');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await lines(page))[0]).toBe('cat("hi you\\n")');
});

test('a vignette opens in the Help pane, its MathJax maths typeset with KaTeX', async ({ page }) => {
  // A vignette as rmarkdown builds one: MathJax from a CDN, maths in \( \).
  await submit(
    page,
    'dir.create("/tmp/vpkg/doc", recursive = TRUE); writeLines(\'<html><head><script src="https://mathjax.rstudio.com/latest/MathJax.js"></script></head><body><h1>Guide</h1><p><span class="math inline">\\\\(x^2\\\\)</span></p></body></html>\', "/tmp/vpkg/doc/guide.html"); print(structure(list(Dir = "/tmp/vpkg", PDF = "guide.html", Topic = "guide", Title = "Guide"), class = "vignette"))',
  );
  const frame = page.frameLocator('.help-doc');
  await expect(frame.locator('h1')).toHaveText('Guide');
  await expect(frame.locator('math')).toHaveCount(1);
  await expect(frame.locator('script')).toHaveCount(0);
});

test('@network vignettes of an installed package', async ({ page }) => {
  await submit(page, 'webr::install("glue")');
  await waitIdle(page);
  await submit(page, 'help(package = "glue")');
  const help = page.locator('.help-html');
  await expect(help.locator('a[href^="ide-file:"]')).not.toHaveCount(0);
  await help.locator('a[href^="ide-file:"]', { hasText: 'Introduction to glue' }).click();
  await expect(page.frameLocator('.help-doc').locator('h1').first()).toHaveText('Introduction to glue');
  // Back to the package's index from the toolbar.
  await page.locator('.help-pkg').click();
  await expect(help.locator('h2')).toContainText('glue');
  await submit(page, 'vignette("glue", package = "glue")');
  await expect(page.frameLocator('.help-doc').locator('h1').first()).toHaveText('Introduction to glue');
});
