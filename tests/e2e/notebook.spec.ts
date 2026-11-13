import { test, expect } from './fixtures';
import { openApp, closeAll, R } from './helpers';

const DOC = `---
title: "Test"
---

## Intro

Some *text* here.

\`\`\`{r}
#| label: setup
x <- 1:10
summary(x)
message("hello from message")
\`\`\`

\`\`\`{r cars}
plot(cars)
cat("after plot\\n")
\`\`\`

\`\`\`{r}
data.frame(a = 1:3, b = letters[1:3])
warning("careful")
stop("boom")
\`\`\`

The mean is \`r mean(1:10)\`.
`;

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await closeAll(page);
  await page.evaluate((doc) => window.__webrIde.editor().newFile('test.qmd', doc), DOC);
  await expect(page.locator('.nb-bar-btn.play').first()).toBeVisible();
});

test('chunks run inline: text, messages, plots, tables, errors', async ({ page }) => {
  await page.locator('.pane-toolbar button', { hasText: 'Run All' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.nb-zone .nb-out').length === 3 && !document.querySelector('.nb-out.stale'), null, {
    timeout: 120_000,
  });
  const outs = page.locator('.nb-zone .nb-out');
  await expect(outs.nth(0)).toContainText('Min.');
  await expect(outs.nth(0)).toContainText('hello from message');
  await expect(outs.nth(1).locator('img')).toHaveCount(1);
  await expect(outs.nth(1)).toContainText('after plot');
  await expect(outs.nth(2)).toContainText('3 rows');
  await expect(outs.nth(2)).toContainText('careful');
  await expect(outs.nth(2)).toContainText('boom');
  // Objects land in the shared session.
  expect(await R(page, 'paste(get0("x", globalenv()), collapse = ",")')).toEqual(['1,2,3,4,5,6,7,8,9,10']);
});

test('output can move to the Output tab', async ({ page }) => {
  await page.locator('.nb-bar-btn.play').first().click();
  await expect(page.locator('.nb-zone .nb-ok')).toHaveCount(1);
  await page.locator('.view-toggle button', { hasText: 'Pane' }).click();
  await expect(page.locator('.nb-zone')).toHaveCount(0);
  await expect(page.locator('.pane-tab.active', { hasText: 'Output' })).toBeVisible();
  await page.locator('.view-toggle button', { hasText: 'Inline' }).click();
});

test('renders the document to HTML in the Preview tab', async ({ page }) => {
  await page.locator('.pane-toolbar button', { hasText: 'Render' }).click();
  await expect(page.locator('.pane-tab.active', { hasText: 'Preview' })).toBeVisible();
  const frame = page.frameLocator('.preview-frame, iframe').first();
  await expect(frame.locator('h1, .title').first()).toContainText('Test', { timeout: 120_000 });
  await expect(frame.locator('body')).toContainText('The mean is 5.5');
  await expect(frame.locator('img').first()).toBeVisible();
});
