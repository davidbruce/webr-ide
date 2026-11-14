// Formatting R code with styler: reformat or reindent the selection, script
// or Quarto chunk, applying only the lines that changed.

import { monaco } from '../../lib/monaco';
import { session } from '../../lib/ide';
import { rString } from '../../lib/r-session';
import { confirmDialog, toast } from '../../lib/ui';
import { rRegions, styleCode } from '../../lib/language';
import { PKG_TOOLS } from '../../lib/packages';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';

/** Replace lines from..to with `text`, editing only the lines that differ. */
export function replaceLines(ed: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, from: number, to: number, text: string): boolean {
  const oldL = model.getLinesContent().slice(from - 1, to);
  const newL = text.split('\n');
  let a = 0;
  while (a < oldL.length && a < newL.length && oldL[a] === newL[a]) a++;
  let b = 0;
  while (b < oldL.length - a && b < newL.length - a && oldL[oldL.length - 1 - b] === newL[newL.length - 1 - b]) b++;
  if (a === oldL.length && a === newL.length) return false;
  const s = from + a;
  const e = to - b;
  const mid = newL.slice(a, newL.length - b);
  let range: monaco.Range;
  let txt: string;
  if (e < s) {
    // Only new lines: insert them before line s.
    range = s > model.getLineCount() ? new monaco.Range(e, model.getLineMaxColumn(e), e, model.getLineMaxColumn(e)) : new monaco.Range(s, 1, s, 1);
    txt = s > model.getLineCount() ? '\n' + mid.join('\n') : mid.join('\n') + '\n';
  } else if (!mid.length) {
    // Only removed lines.
    range = s > 1 ? new monaco.Range(s - 1, model.getLineMaxColumn(s - 1), e, model.getLineMaxColumn(e)) : new monaco.Range(s, 1, e + 1, 1);
    txt = '';
  } else {
    range = new monaco.Range(s, 1, e, model.getLineMaxColumn(e));
    txt = mid.join('\n');
  }
  ed.pushUndoStop();
  ed.executeEdits('format', [{ range, text: txt }]);
  ed.pushUndoStop();
  return true;
}

export function createFormatter(view: EditorView, tc: TabsCtx) {
  const { inGrid } = tc;

  /** Format the selection, or the whole script / chunk, with styler. */
  async function formatCode(scope: 'tokens' | 'indention', retried = false) {
    const model = view.ed?.getModel();
    const sel = view.ed?.getSelection();
    if (!model || !sel || inGrid()) return;
    const region = rRegions(model).find((r) => sel.startLineNumber >= r.line && sel.startLineNumber < r.line + r.text.split('\n').length);
    if (!region) return toast(model.getLanguageId() === 'quarto' ? 'Put the cursor in an R chunk to format it' : 'Only R code can be formatted', 'warn');
    const regionEnd = region.line + region.text.split('\n').length - 1;
    let from = region.line;
    let to = regionEnd;
    if (!sel.isEmpty()) {
      from = Math.max(from, sel.startLineNumber);
      to = Math.min(to, sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber);
    }
    const version = model.getVersionId();
    let res;
    let text: string;
    if (scope === 'indention') {
      // Re-indent the whole script or chunk (indentation depends on what
      // surrounds the selection), then keep only the selected lines.
      res = await styleCode(region.text, 'indention');
      if (res.ok) {
        const out = res.text.split('\n');
        // styler drops trailing blank lines: put them back so lines still match up.
        while (out.length < regionEnd - region.line + 1 && !model.getLineContent(region.line + out.length).trim()) out.push('');
        if (out.length === regionEnd - region.line + 1) text = out.slice(from - region.line, to - region.line + 1).join('\n');
        else {
          from = region.line;
          to = regionEnd;
          text = res.text;
        }
      }
    } else {
      const lines = model.getLinesContent().slice(from - 1, to);
      const indent = lines.filter((l) => l.trim()).reduce<string | null>((m, l) => {
        const ws = /^\s*/.exec(l)![0];
        return m === null || ws.length < m.length ? ws : m;
      }, null) ?? '';
      res = await styleCode(lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n'));
      if (res.ok) {
        // styler drops trailing blank lines (a file's final newline): keep them.
        const out = res.text.replace(/\n+$/, '').split('\n').map((l) => (l ? indent + l : l));
        const trailing = lines.length - (lines.findLastIndex((l) => l.trim()) + 1);
        text = [...out, ...Array(trailing).fill('')].join('\n');
      }
    }
    if (!res.ok) {
      if (res.missing && !retried) {
        const ok = await confirmDialog(
          'Install styler?',
          'Formatting R code uses the styler package. Install it now? It downloads once and is saved for offline use.',
          { okLabel: 'Install' },
        );
        if (!ok) return;
        // Into the IDE's tools library, not the workspace's.
        session.submit(`webr::install("styler", lib = ${rString(PKG_TOOLS)})`);
        await new Promise((r) => setTimeout(r, 50));
        if (await session.waitIdle(10 * 60_000)) return formatCode(scope, true);
        return;
      }
      return toast(`Couldn't format: ${res.message}`, 'error', 7000);
    }
    if (model.isDisposed() || model.getVersionId() !== version) return toast('The code changed while formatting — try again', 'warn');
    if (!replaceLines(view.ed, model, from, to, text!)) toast(scope === 'indention' ? 'Indentation is already tidy' : 'Already formatted');
  }

  return { formatCode };
}
