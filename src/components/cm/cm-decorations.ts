// Monaco-style decorations for the CodeMirror pane, so the shared debugger
// and notebook code can use them unchanged: decoration collections (line
// classes, gutter markers, line-number classes), view zones (blocks between
// lines: notebook output), content widgets (notebook run buttons) and inlay
// hints (inline `r` values). Everything lives in one DecorationSet per
// document, which CodeMirror moves along with edits.

import { StateEffect, StateField, RangeSet, type EditorState, type Range, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, lineNumbers, lineNumberMarkers, type DecorationSet } from '@codemirror/view';
import { monaco } from '../../lib/monaco';

/** What a decoration carries (CodeMirror keeps it as the decoration's spec). */
export type Spec =
  | { kind: 'coll'; coll: number; group: number; opts: monaco.editor.IModelDecorationOptions }
  | { kind: 'zone'; id: string }
  | { kind: 'widget'; id: string }
  | { kind: 'hint' };

export const setDecos = StateEffect.define<(set: DecorationSet, state: EditorState) => DecorationSet>();

export const decoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDecos)) set = e.value(set, tr.state);
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const specOf = (d: Decoration) => d.spec as Spec;

/** A DOM node that already exists (owned by the caller), shown as a widget. */
export class NodeWidget extends WidgetType {
  constructor(
    readonly node: HTMLElement,
    readonly block: boolean,
  ) {
    super();
  }
  eq(other: NodeWidget) {
    return other.node === this.node;
  }
  toDOM() {
    if (this.block) return this.node;
    // Inline: a zero-width anchor the node is positioned from.
    const wrap = document.createElement('span');
    wrap.className = 'cm-node-widget';
    wrap.appendChild(this.node);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class HintWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly tooltip: string,
  ) {
    super();
  }
  eq(o: HintWidget) {
    return o.label === this.label && o.tooltip === this.tooltip;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-inlay-hint';
    s.textContent = this.label;
    if (this.tooltip) s.title = this.tooltip;
    return s;
  }
}

/** Line decorations for one Monaco decoration (one per line of a whole-line range). */
export function collDecos(state: EditorState, coll: number, group: number, d: monaco.editor.IModelDeltaDecoration): Range<Decoration>[] {
  const doc = state.doc;
  const r = d.range;
  const first = Math.max(1, Math.min(doc.lines, r.startLineNumber));
  const last = Math.max(first, Math.min(doc.lines, r.endLineNumber));
  const spec: Spec = { kind: 'coll', coll, group, opts: d.options };
  const out: Range<Decoration>[] = [];
  if (d.options.isWholeLine || !d.options.inlineClassName) {
    for (let l = first; l <= last; l++) {
      out.push(Decoration.line({ ...spec, class: d.options.className ?? undefined }).range(doc.line(l).from));
    }
  } else {
    const from = doc.line(first).from + Math.max(0, r.startColumn - 1);
    const to = doc.line(last).from + Math.max(0, r.endColumn - 1);
    if (to > from) out.push(Decoration.mark({ ...spec, class: d.options.inlineClassName ?? undefined }).range(from, Math.min(to, doc.length)));
  }
  return out;
}

export function zoneDeco(state: EditorState, id: string, afterLine: number, node: HTMLElement): Range<Decoration> {
  const doc = state.doc;
  const at = afterLine < 1 ? 0 : doc.line(Math.min(doc.lines, afterLine)).to;
  return Decoration.widget({ kind: 'zone', id, widget: new NodeWidget(node, true), block: true, side: afterLine < 1 ? -1 : 1 } as never).range(at);
}

export function widgetDeco(state: EditorState, id: string, pos: monaco.IPosition, node: HTMLElement): Range<Decoration> {
  const doc = state.doc;
  const line = doc.line(Math.max(1, Math.min(doc.lines, pos.lineNumber)));
  const at = Math.min(line.to, line.from + Math.max(0, pos.column - 1));
  return Decoration.widget({ kind: 'widget', id, widget: new NodeWidget(node, false), side: -1 } as never).range(at);
}

export function hintDeco(at: number, label: string, tooltip: string): Range<Decoration> {
  return Decoration.widget({ kind: 'hint', widget: new HintWidget(label, tooltip), side: 1 } as never).range(at);
}

// ---------------------------------------------------------------- gutters

class ClassMarker extends GutterMarker {
  constructor(
    readonly cls: string,
    readonly title = '',
  ) {
    super();
    this.elementClass = '';
  }
  eq(o: ClassMarker) {
    return o.cls === this.cls && o.title === this.title;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = this.cls;
    if (this.title) el.title = this.title;
    return el;
  }
}
class LineNumberClass extends GutterMarker {
  constructor(cls: string) {
    super();
    this.elementClass = cls;
  }
}

const hoverText = (m: monaco.editor.IModelDecorationOptions['glyphMarginHoverMessage']) =>
  !m ? '' : Array.isArray(m) ? m.map((x) => x.value).join('\n') : (m as monaco.IMarkdownString).value;

/** Gutter markers from the decorations' glyphMarginClassName / lineNumberClassName. */
function markersOf(state: EditorState, which: 'glyph' | 'number') {
  const out: Range<GutterMarker>[] = [];
  const seen = new Set<string>();
  state.field(decoField).between(0, state.doc.length, (from, _to, d) => {
    const s = specOf(d);
    if (s.kind !== 'coll') return;
    const cls = which === 'glyph' ? s.opts.glyphMarginClassName : s.opts.lineNumberClassName;
    if (!cls) return;
    const key = `${from}:${cls}`;
    if (seen.has(key)) return; // (one per line, not one per line of a range)
    seen.add(key);
    out.push((which === 'glyph' ? new ClassMarker(cls, hoverText(s.opts.glyphMarginHoverMessage)) : new LineNumberClass(cls)).range(from));
  });
  return RangeSet.of(out, true);
}

/**
 * The glyph margin (breakpoint dots, the paused-line arrow) and line numbers,
 * reporting clicks the way Monaco's onMouseDown does.
 */
export function gutters(onClick: (type: monaco.editor.MouseTargetType, line: number) => void): Extension {
  const T = monaco.editor.MouseTargetType;
  const click = (type: monaco.editor.MouseTargetType) => (view: EditorView, block: { from: number }) => {
    onClick(type, view.state.doc.lineAt(block.from).number);
    return false;
  };
  return [
    gutter({
      class: 'cm-glyph-gutter',
      markers: (view) => markersOf(view.state, 'glyph'),
      initialSpacer: () => new ClassMarker('cm-glyph-spacer'),
      domEventHandlers: { mousedown: click(T.GUTTER_GLYPH_MARGIN) },
    }),
    lineNumbers({ domEventHandlers: { mousedown: click(T.GUTTER_LINE_NUMBERS) } }),
    lineNumberMarkers.compute([decoField], (state) => markersOf(state, 'number')),
  ];
}
