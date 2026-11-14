// Rainbow brackets for the CodeMirror pane, like Monaco's bracket pair
// colouring: ( [ { and their partners coloured by depth (three colours in
// turn), brackets in strings and comments left alone, and a closing bracket
// with nothing to close in red.
//
// Cost: only the visible lines are coloured. The depth at the start of each
// line is cached; an edit invalidates the cache from the edited line on, and
// it's rebuilt only as far as the screen needs.

import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
/** Syntax nodes whose brackets don't count. */
const NOT_CODE = /^(string|comment|.*String|.*Comment|CodeInfo|URL|LinkLabel)$/;
const marks = [0, 1, 2].map((i) => Decoration.mark({ class: `cm-rb-${i}` }));
const bad = Decoration.mark({ class: 'cm-rb-bad' });

/** [from, to) ranges of strings and comments between `from` and `to`, in order. */
function skipRanges(state: EditorState, from: number, to: number): number[] {
  const out: number[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (NOT_CODE.test(n.type.name)) {
        out.push(n.from, n.to);
        return false;
      }
    },
  });
  return out;
}

/**
 * Walk `from`..`to` keeping a bracket depth, calling `onBracket` for each
 * bracket in code and `onLine` at each line break. Returns the depth at `to`.
 */
function walk(
  state: EditorState,
  from: number,
  to: number,
  depth: number,
  onBracket?: (pos: number, depth: number, closing: boolean) => void,
  onLine?: (depthAfter: number) => void,
): number {
  const skip = skipRanges(state, from, to);
  let k = 0;
  const text = state.sliceDoc(from, to);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      onLine?.(depth);
      continue;
    }
    if (!OPEN.has(c) && !CLOSE.has(c)) continue;
    const pos = from + i;
    while (k < skip.length && skip[k + 1] <= pos) k += 2;
    if (k < skip.length && skip[k] <= pos) continue;
    if (OPEN.has(c)) {
      onBracket?.(pos, depth, false);
      depth++;
    } else {
      depth--;
      onBracket?.(pos, depth, true);
      if (depth < 0) depth = 0;
    }
  }
  return depth;
}

export function rainbowBrackets(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** Depth at the start of line n is lineDepth[n - 1], known for lines up to `known`. */
      lineDepth: number[] = [0];
      known = 1;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate) {
        if (u.docChanged) {
          let first = Infinity;
          u.changes.iterChangedRanges((fromA) => (first = Math.min(first, fromA)));
          // Lines up to the first edited one keep their depth.
          this.known = Math.min(this.known, u.startState.doc.lineAt(first).number);
          this.lineDepth.length = this.known;
        }
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
      }

      /** Depth at the start of a line (extends the cache up to it). */
      depthAt(state: EditorState, lineNo: number): number {
        const doc = state.doc;
        while (this.known < lineNo) {
          // Up to 500 lines at a time: one walk (and one pass over the syntax tree) each.
          const upto = Math.min(lineNo, this.known + 500);
          const from = doc.line(this.known).from;
          const to = doc.line(upto).from;
          let n = this.known;
          walk(state, from, to, this.lineDepth[this.known - 1], undefined, (d) => (this.lineDepth[n++] = d));
          this.known = upto;
        }
        return this.lineDepth[lineNo - 1];
      }

      build(view: EditorView): DecorationSet {
        const { state } = view;
        const b = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          const line = state.doc.lineAt(from);
          walk(state, line.from, to, this.depthAt(state, line.number), (pos, d, closing) => {
            b.add(pos, pos + 1, closing && d < 0 ? bad : marks[d % 3]);
          });
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
