// The experimental CodeMirror 6 editor (Settings → Editor). The other specs
// use the default, Monaco.
import { test, expect } from './fixtures';
import { openApp, waitReady, consoleRows, readFile, workspace, waitIdle } from './helpers';
import type { Page } from '@playwright/test';

async function useCodeMirror(page: Page) {
  await page.addInitScript(() => {
    const s = JSON.parse(localStorage.getItem('webr-ide:settings') ?? '{}');
    localStorage.setItem('webr-ide:settings', JSON.stringify({ ...s, editorEngine: 'codemirror' }));
  });
}
const text = (page: Page) => page.evaluate(() => (document.querySelector('.cm-content') as HTMLElement | null)?.innerText.replace(/\n+$/, ''));

test('CodeMirror: run, completions with help, errors, snippets, save', async ({ page }) => {
  await useCodeMirror(page);
  await openApp(page);
  await page.evaluate(async () => {
    const { editor, ide } = (window as any).__webrIde;
    await editor().closeAll(true);
    await ide.writeWorkspaceFile('cm.R', 'x <- c(1, 2, 3)\nmean(x)\n');
    await editor().openFile('cm.R');
  });
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(page.locator('.monaco-editor')).toHaveCount(0);

  // ⌘↩ runs the line.
  await page.locator('.cm-line').first().click();
  await page.keyboard.press('Meta+Enter');
  await waitIdle(page);
  await expect.poll(async () => (await consoleRows(page)).join('\n')).toContain('> x <- c(1, 2, 3)');

  // Completions from R, with help beside them.
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('summ', { delay: 50 });
  await expect(page.locator('.cm-tooltip-autocomplete li').first()).toHaveText('summary');
  await expect(page.locator('.cm-completionInfo')).toContainText('Object Summaries');
  await page.keyboard.press('Escape');
  await page.keyboard.type('ary(x)');
  await expect(page.locator('.editor-tab.dirty')).toHaveCount(1);

  // A syntax error is underlined.
  await page.keyboard.press('Enter');
  await page.keyboard.type('y <- 5 6');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1, { timeout: 15_000 });
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0, { timeout: 15_000 });

  // A snippet, with Tab between its placeholders.
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('fun');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await page.keyboard.type('add');
  await page.keyboard.press('Escape'); // (close R's suggestions for "add")
  await page.keyboard.press('Tab');
  await page.keyboard.type('a, b');
  await page.keyboard.press('Tab');
  await page.keyboard.type('a + b');
  await expect.poll(() => text(page)).toContain('add <- function(a, b) {\n  a + b\n}');

  // The tab's document and the file stay in step.
  await page.keyboard.press('Meta+s');
  await expect(page.locator('.editor-tab.dirty')).toHaveCount(0);
  expect(await readFile(page, await workspace(page), 'cm.R')).toBe(await page.evaluate(() => (window as any).__webrIde.editor().openText('cm.R')));

  // Hover help.
  const box = (await page.locator('.cm-line', { hasText: 'mean(x)' }).boundingBox())!;
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await expect(page.locator('.cm-tooltip-hover')).toContainText('Arithmetic Mean');

  // Command palette and find.
  await page.keyboard.press('Meta+Shift+p');
  await page.keyboard.type('reformat');
  await expect(page.locator('.palette-item')).toHaveText([/Reformat Code \(styler\)/]);
  await page.keyboard.press('Escape');
  await page.locator('button[title="Find / Replace"]').click();
  await expect(page.locator('.cm-search')).toBeVisible();
});

test('CodeMirror: Quarto chunk output, run buttons and inline values', async ({ page }) => {
  await useCodeMirror(page);
  await openApp(page);
  await page.evaluate(async () => {
    const { editor, ide } = (window as any).__webrIde;
    await editor().closeAll(true);
    await ide.writeWorkspaceFile('nb.qmd', '---\ntitle: T\n---\n\nThe answer is `r 6*7`.\n\n```{r}\nx <- 1:5\nprint(x)\nplot(x)\n```\n\nMore text.\n\n```{r}\nsummary(x)\n```\n');
    await editor().openFile('nb.qmd');
  });
  await expect(page.locator('.cm-editor .nb-bar-btn.play')).toHaveCount(2);
  await expect(page.locator('.cm-line.nb-chunk-line')).toHaveCount(8);
  await page.locator('.cm-editor .nb-bar-btn.play').first().click();
  await expect(page.locator('.cm-editor .nb-zone')).toHaveCount(1);
  await expect(page.locator('.cm-editor .nb-zone').first()).toContainText('[1] 1 2 3 4 5');
  await expect(page.locator('.cm-editor .nb-zone img, .cm-editor .nb-zone canvas').first()).toBeVisible();
  await page.locator('.pane-toolbar button', { hasText: 'Run All' }).click();
  await expect(page.locator('.cm-editor .nb-zone')).toHaveCount(2);
  await expect(page.locator('.cm-inlay-hint')).toHaveText(' = 42');
  // An output stays under its chunk while lines are added above it.
  await page.locator('.cm-line', { hasText: 'More text.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nAnother line');
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.cm-editor .nb-zone')[1]?.previousElementSibling?.textContent)).toBe('```');
});

test('CodeMirror: breakpoints, pausing, and undo back to the saved text', async ({ page }) => {
  await useCodeMirror(page);
  await openApp(page);
  await page.evaluate(async () => {
    const { editor, ide } = (window as any).__webrIde;
    await editor().closeAll(true);
    ide.setBreakpoints('dbg.R', []);
    await ide.writeWorkspaceFile('dbg.R', 'g <- function(a) {\n  b <- a * 10\n  b + 1\n}\nf <- function(x) {\n  y <- x + 1\n  z <- g(y)\n  z\n}\n');
    await editor().openFile('dbg.R');
  });
  const line = (n: number) => page.locator('.cm-line').nth(n - 1);
  const b = (await line(7).boundingBox())!;
  const g = (await page.locator('.cm-glyph-gutter').boundingBox())!;
  await page.mouse.click(g.x + g.width / 2, b.y + b.height / 2);
  await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).__webrIde.ide.state.breakpoints['dbg.R']))).toBe('[7]');
  await expect(page.locator('.cm-editor .bp-dot')).toHaveCount(1);

  // Undoing an edit back to the saved text clears the unsaved mark.
  await line(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' # note');
  await expect(page.locator('.editor-tab.dirty')).toHaveCount(1);
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.editor-tab.dirty')).toHaveCount(0);

  await page.locator('.pane-toolbar button', { hasText: 'Source' }).click();
  await expect.poll(async () => (await consoleRows(page)).join('\n')).toContain('debugSource(');
  await waitIdle(page);
  await page.evaluate(() => (window as any).__webrIde.session.submit('f(1)'));
  await expect.poll(() => page.evaluate(() => (window as any).__webrIde.ide.state.debug?.stack.at(-1)?.line ?? null)).toBe(7);
  await expect(page.locator('.cm-line.debug-line')).toHaveText('  z <- g(y)');
  await expect(page.locator('.cm-editor .debug-arrow')).toHaveCount(1);
  await page.locator('.debug-bar button[title^="Stop"]').click();
  await expect(page.locator('.cm-line.debug-line')).toHaveCount(0);
});

test('CodeMirror: sticky scroll and rainbow brackets', async ({ page }) => {
  await useCodeMirror(page);
  await openApp(page);
  const body = Array.from({ length: 40 }, (_, i) => `    y${i} <- list(a = c(${i}, "(x"), b = x[[${i}]])  # (note`).join('\n');
  await page.evaluate(async (body) => {
    const { editor, ide } = (window as any).__webrIde;
    await editor().closeAll(true);
    await ide.writeWorkspaceFile('st.R', `# Data ----\nx <- 1\n\nf <- function(x) {\n  if (x > 0) {\n${body}\n  }\n}\nbad <- 1)\n`);
    await editor().openFile('st.R');
  }, body);
  // Depth colours; brackets in the string and the comment are skipped.
  const classes = () => page.evaluate(() => [...document.querySelectorAll('.cm-line')][5].innerHTML.match(/cm-rb-\w+/g));
  await expect.poll(classes).toEqual(['cm-rb-2', 'cm-rb-0', 'cm-rb-0', 'cm-rb-0', 'cm-rb-1', 'cm-rb-1', 'cm-rb-0', 'cm-rb-2']);
  await page.locator('.cm-content').hover();
  await page.mouse.wheel(0, 500);
  await expect(page.locator('.cm-sticky-line')).toHaveText(['1# Data ----', '4f <- function(x) {']);
  await page.locator('.cm-sticky-line').nth(1).click();
  await expect(page.locator('.cm-activeLine')).toHaveText('f <- function(x) {');
  await page.locator('.cm-content').hover();
  await page.mouse.wheel(0, 5000);
  await expect(page.locator('.cm-rb-bad')).toHaveCount(1);
});

test('CodeMirror: switching editors in Settings keeps the open files', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const { editor, ide } = (window as any).__webrIde;
    await editor().closeAll(true);
    await ide.writeWorkspaceFile('keep.R', 'kept <- TRUE\n');
    await editor().openFile('keep.R');
  });
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await page.keyboard.press('Meta+,');
  await Promise.all([page.waitForEvent('load'), page.locator('.settings button', { hasText: 'CodeMirror' }).click()]);
  await waitReady(page);
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(page.locator('.editor-tab.active')).toContainText('keep.R');
  await expect.poll(() => text(page)).toBe('kept <- TRUE');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });

  test('CodeMirror: the R keyboard types into it without the system keyboard', async ({ page }) => {
    await useCodeMirror(page);
    await openApp(page, { rKeyboard: true });
    await page.evaluate(async () => {
      const { editor } = (window as any).__webrIde;
      await editor().closeAll(true);
      editor().newFile('fast.R', '');
    });
    const b = (await page.locator('.cm-line').first().boundingBox())!;
    await page.touchscreen.tap(b.x + 30, b.y + b.height / 2);
    await expect(page.locator('.rk')).toBeVisible();
    expect(await page.locator('.cm-content').getAttribute('inputmode')).toBe('none');
    const centres: Record<string, [number, number]> = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.rk-keys .rk-key')].map((k) => {
          const f = k.querySelector('.rk-face')!.getBoundingClientRect();
          return [k.getAttribute('aria-label'), [f.x + f.width / 2, f.y + f.height / 2]];
        }),
      ),
    );
    for (const ch of 'the quick brown fox') await page.touchscreen.tap(...(centres[ch === ' ' ? 'Space (drag to move the cursor)' : ch] as [number, number]));
    await expect.poll(() => text(page)).toBe('the quick brown fox');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'))).toBe(true);
    // The key bar's "(" closes the bracket, as typing does.
    await page.evaluate(() => (window as any).__webrIde.editor().key({ type: 'type', text: '(' }));
    await expect.poll(() => text(page)).toBe('the quick brown fox()');
  });
});
