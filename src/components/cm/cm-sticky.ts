// Sticky scroll for the CodeMirror pane: the functions, sections, headings and
// chunks you're scrolled into stay pinned above the code (up to 5, as Monaco
// does), with their line numbers; tap one to go to it. Built from the same
// outline as Monaco's sticky scroll and the Outline menu (language.ts).
//
// Cost: the outline is rebuilt at most every 200 ms while typing (one linear
// pass); scrolling only filters it, once per animation frame.

import { highlightingFor, syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { outline, type OutlineItem } from '../../lib/language';
import type { monaco } from '../../lib/monaco';

const MAX_LINES = 5;
const REBUILD_MS = 200;

export function stickyScroll(getModel: () => monaco.editor.ITextModel | null): Extension {
  return ViewPlugin.fromClass(
    class {
      dom: HTMLDivElement;
      items: OutlineItem[] = [];
      builtFor = -1; // model version the outline is for
      builtAt = 0;
      rebuildTimer = 0;
      frame = 0;
      shown = '';
      onScroll = () => this.schedule();

      constructor(readonly view: EditorView) {
        this.dom = document.createElement('div');
        this.dom.className = 'cm-sticky';
        this.dom.hidden = true;
        this.dom.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's focus
        this.dom.addEventListener('click', (e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
          if (row) this.goTo(Number(row.dataset.line));
        });
        view.dom.appendChild(this.dom);
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
        this.schedule();
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule();
      }

      schedule() {
        if (!this.frame) this.frame = requestAnimationFrame(() => ((this.frame = 0), this.render()));
      }

      /** The outline for the document (rebuilt when it has changed, not more than every 200 ms). */
      outline(model: monaco.editor.ITextModel): OutlineItem[] {
        const version = model.getVersionId();
        if (version === this.builtFor) return this.items;
        const wait = this.builtAt + REBUILD_MS - performance.now();
        if (wait > 0 && this.builtFor !== -1) {
          clearTimeout(this.rebuildTimer);
          this.rebuildTimer = window.setTimeout(() => this.schedule(), wait);
          return this.items;
        }
        this.items = outline(model);
        this.builtFor = version;
        this.builtAt = performance.now();
        return this.items;
      }

      render() {
        const { view } = this;
        const model = getModel();
        const lang = model?.getLanguageId();
        if (!model || (lang !== 'r' && lang !== 'quarto')) return this.hide();
        const items = this.outline(model);
        if (!items.length) return this.hide();
        const doc = view.state.doc;
        const lh = view.defaultLineHeight;
        // The line under the top edge, below whatever is pinned (two passes:
        // pinning lines covers more of the code).
        let pinned: OutlineItem[] = [];
        for (let pass = 0; pass < 2; pass++) {
          const y = view.scrollDOM.getBoundingClientRect().top - view.documentTop + pinned.length * lh + 1;
          if (y <= 0 && pass === 0) return this.hide();
          const top = doc.lineAt(view.lineBlockAtHeight(Math.max(0, y)).from).number;
          pinned = items.filter((o) => o.line < top && o.end >= top && o.line <= doc.lines).slice(0, MAX_LINES);
        }
        if (!pinned.length) return this.hide();
        const gutterW = (view.dom.querySelector('.cm-gutters') as HTMLElement | null)?.offsetWidth ?? 0;
        const key = `${pinned.map((o) => o.line).join(',')}|${gutterW}|${view.scrollDOM.scrollLeft}|${doc.length}`;
        if (key === this.shown && !this.dom.hidden) return;
        this.shown = key;
        this.dom.style.top = `${view.scrollDOM.offsetTop}px`;
        this.dom.replaceChildren(...pinned.map((o) => this.row(o.line, gutterW, lh)));
        this.dom.hidden = false;
      }

      /** One pinned line: its number in the gutter, then its code with syntax colours. */
      row(lineNo: number, gutterW: number, lh: number): HTMLElement {
        const { state } = this.view;
        const line = state.doc.line(lineNo);
        const row = document.createElement('div');
        row.className = 'cm-sticky-line';
        row.dataset.line = String(lineNo);
        row.style.height = `${lh}px`;
        const num = document.createElement('span');
        num.className = 'cm-sticky-num';
        num.style.width = `${gutterW}px`;
        num.textContent = String(lineNo);
        const code = document.createElement('span');
        code.className = 'cm-sticky-code';
        code.style.transform = `translateX(${-this.view.scrollDOM.scrollLeft}px)`;
        let at = line.from;
        const text = (to: number, cls = '') => {
          if (to <= at) return;
          const s = document.createElement('span');
          if (cls) s.className = cls;
          s.textContent = state.sliceDoc(at, to);
          code.appendChild(s);
          at = to;
        };
        highlightTree(syntaxTree(state), { style: (tags) => highlightingFor(state, tags) }, (from, to, cls) => {
          text(Math.max(from, line.from));
          text(Math.min(to, line.to), cls);
        }, line.from, line.to);
        text(line.to);
        row.append(num, code);
        return row;
      }

      goTo(lineNo: number) {
        const line = this.view.state.doc.line(Math.min(lineNo, this.view.state.doc.lines));
        this.view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
        this.view.focus();
      }

      hide() {
        if (!this.dom.hidden) {
          this.dom.hidden = true;
          this.shown = '';
        }
      }

      destroy() {
        cancelAnimationFrame(this.frame);
        clearTimeout(this.rebuildTimer);
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        this.dom.remove();
      }
    },
  );
}
