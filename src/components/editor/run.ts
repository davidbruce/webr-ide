// Sending editor code to R: run the line / selection, run all, source the
// script (with breakpoints via debugSource), render a Quarto document, and
// import a CSV tab as a data frame.

import { monaco, statementEnd, extOf, inRChunk } from '../../lib/monaco';
import { renderDocument } from '../../lib/render';
import { rRoot, showPane, session, state, rDisplayPath, setState } from '../../lib/ide';
import * as fs from '../../lib/opfs';
import { rString } from '../../lib/r-session';
import { isDark, toast } from '../../lib/ui';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';

export type RunCtx = ReturnType<typeof createRun>;

export function createRun(view: EditorView, tc: TabsCtx) {
  const { models, activeTab, save } = tc;

  function submitCode(code: string) {
    if (!code.trim()) return;
    if (session.status !== 'ready') {
      toast('R is still starting…', 'warn');
      return;
    }
    session.submit(code);
  }

  function runSelection() {
    const model = view.ed?.getModel();
    const sel = view.ed?.getSelection();
    if (!model || !sel) return;
    if (!sel.isEmpty()) {
      submitCode(model.getValueInRange(sel));
      return;
    }
    // In Quarto / R Markdown, only lines inside R chunks are code; on other
    // lines, ⌘↩ / Ctrl+Enter evaluates inline `r` code.
    if (model.getLanguageId() === 'quarto' && !inRChunk(model, sel.startLineNumber)) {
      view.notebook?.runInlineAtCursor();
      return;
    }
    const n = model.getLineCount();
    let start = sel.startLineNumber;
    // On a blank/comment line, RStudio runs the next statement.
    while (start < n && /^\s*(#.*)?$/.test(model.getLineContent(start))) start++;
    const end = statementEnd(model, start);
    const code = model.getValueInRange(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)));
    submitCode(code);
    let next = end + 1;
    while (next < n && /^\s*$/.test(model.getLineContent(next))) next++;
    if (next <= n) {
      view.ed.setPosition({ lineNumber: next, column: 1 });
      view.ed.revealLineInCenterIfOutsideViewport(next);
    } else {
      view.ed.setPosition({ lineNumber: end, column: model.getLineMaxColumn(end) });
    }
  }

  function runAll() {
    const model = view.ed?.getModel();
    if (model) submitCode(model.getValue());
  }

  async function sourceActive(echo: boolean) {
    const tab = activeTab();
    if (!tab) return;
    if (tab.language !== 'r') {
      toast('Only R scripts can be sourced', 'warn');
      return;
    }
    if (!tab.path) {
      runAll();
      return;
    }
    if (tab.dirty && !(await save(tab.key))) return;
    const file = rString(rDisplayPath(tab.path));
    const bps = state.breakpoints[tab.path] ?? [];
    if (bps.length && session.status === 'ready') {
      // debugSource() sets the breakpoints in each function as it's defined.
      await session.evalVoid(`.ide_set_breakpoints(${file}, c(${bps.join(',')}))`).catch(() => {});
      submitCode(`debugSource(${file}${echo ? ', echo = TRUE' : ''})`);
    } else submitCode(`source(${file}${echo ? ', echo = TRUE' : ''})`);
  }

  function renderActive() {
    const tab = activeTab();
    const model = tab && models.get(tab.key);
    if (!tab || !model || tab.language !== 'quarto') {
      toast('Open a Quarto (.qmd) or R Markdown (.Rmd) document to render it', 'warn');
      return;
    }
    if (state.rStatus !== 'ready') {
      toast('R is still starting…', 'warn');
      return;
    }
    const dir = tab.path && fs.dirname(tab.path) ? `${rRoot()}/${fs.dirname(tab.path)}` : rRoot();
    setState('plotTab', 'preview');
    showPane('plots');
    void renderDocument({ doc: model.uri.toString(), path: tab.path, name: tab.name, text: model.getValue(), dir, dark: isDark() });
  }

  function importToR() {
    const t = activeTab();
    if (!t?.path) return;
    const stem = t.name.replace(/\.[^.]+$/, '').replace(/[^\w.]/g, '_');
    const name = /^[A-Za-z.]/.test(stem) ? stem : `data_${stem}`;
    const ext = extOf(t.name);
    const path = rString(rDisplayPath(t.path));
    const call = ext === 'tsv' || ext === 'tab' ? `read.delim(${path})` : ext === 'psv' ? `read.delim(${path}, sep = "|")` : `read.csv(${path})`;
    submitCode(`${name} <- ${call}`);
  }

  return { runSelection, sourceActive, renderActive, importToR };
}
