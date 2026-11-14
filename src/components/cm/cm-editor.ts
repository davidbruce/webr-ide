// CodeMirror 6 behind the subset of Monaco's editor interface that the shared
// editor modules (tabs, run, format, navigation, outline) use, so the
// experimental CodeMirror pane reuses them unchanged.
//
// Documents stay Monaco text models (no Monaco editor is created): tabs,
// saving, dirty state, the R checks and markers, outline, formatting and
// notebooks all work on models. Each model gets a CodeMirror EditorState (its
// own undo history); edits made in CodeMirror are applied to the model, and
// edits made to the model elsewhere (formatting, reload, find-and-replace in
// files) are applied to CodeMirror.

import { EditorState, EditorSelection, type Extension, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { Decoration } from '@codemirror/view';
import { monaco } from '../../lib/monaco';
import { decoField, gutters, setDecos, specOf, collDecos, zoneDeco, widgetDeco, hintDeco } from './cm-decorations';

type Model = monaco.editor.ITextModel;
type Listener<T = void> = (e: T) => void;

/** What saveViewState() returns: the selection and scroll position. */
interface CmViewState {
  anchor: number;
  head: number;
  scrollTop: number;
}

export class CmEditor {
  readonly view: EditorView;
  private model: Model | null = null;
  private readonly states = new WeakMap<Model, EditorState>();
  private modelSub: monaco.IDisposable | null = null;
  /** Applying an edit to the other side: don't echo it back. */
  private syncing = false;
  private readonly onModel = new Set<Listener>();
  private readonly onContent = new Set<Listener>();
  private readonly onCursor = new Set<Listener>();
  private readonly actions = new Map<string, () => void>();
  /** Palette labels of named actions. */
  readonly labels = new Map<string, string>();

  constructor(
    host: HTMLElement,
    /** Extensions for a document (by its model's language); called once per model. */
    private readonly extensionsFor: (model: Model | null) => Extension,
  ) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: EditorState.readOnly.of(true) }),
      dispatchTransactions: (trs, view) => {
        view.update(trs);
        this.afterTransactions(trs);
      },
    });
    this.addAction('actions.find', () => openSearchPanel(this.view));
  }

  // ---------------------------------------------------------------- models

  getModel(): Model | null {
    return this.model && !this.model.isDisposed() ? this.model : null;
  }

  setModel(model: Model | null) {
    if (this.model && !this.model.isDisposed()) this.states.set(this.model, this.view.state);
    this.modelSub?.dispose();
    this.modelSub = null;
    this.model = model;
    if (!model) {
      this.view.setState(EditorState.create({ doc: '', extensions: [EditorState.readOnly.of(true), this.extensionsFor(null)] }));
    } else {
      let st = this.states.get(model);
      if (!st) st = EditorState.create({ doc: model.getValue(), extensions: this.extensionsFor(model) });
      this.view.setState(st);
      // Edited elsewhere while in a background tab: catch up (undoably).
      this.pullFromModel();
      // Like Monaco: decorations and view zones belong to the shown model;
      // content widgets stay (and are placed in the new document).
      this.zones.clear();
      this.redraw((set) => set.update({ filter: () => false }));
      this.placeWidgets();
      this.refreshHints();
      this.modelSub = model.onDidChangeContent(() => {
        if (!this.syncing) this.pullFromModel();
      });
    }
    this.onModel.forEach((f) => f());
  }

  /** Rebuild a model's state, e.g. when its language changes (keeps the text). */
  resetState(model: Model) {
    this.states.delete(model);
    if (this.model === model) {
      this.model = null;
      this.setModel(model);
    }
  }

  /** CodeMirror → model, for each transaction that changed the document. */
  private afterTransactions(trs: readonly Transaction[]) {
    const model = this.getModel();
    let docChanged = false;
    let selChanged = false;
    for (const tr of trs) {
      if (tr.selection) selChanged = true;
      if (!tr.docChanged) continue;
      docChanged = true;
      if (!model || this.syncing) continue;
      const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const s = model.getPositionAt(fromA);
        const e = model.getPositionAt(toA);
        edits.push({ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: inserted.toString() });
      });
      this.syncing = true;
      try {
        model.applyEdits(edits); // one batch, in the document's coordinates before the change
      } finally {
        this.syncing = false;
      }
    }
    if (docChanged) this.onContent.forEach((f) => f());
    if (selChanged || docChanged) this.onCursor.forEach((f) => f());
  }

  /** Model → CodeMirror: replace the part that differs (one undoable change). */
  private pullFromModel() {
    const model = this.getModel();
    if (!model) return;
    const next = model.getValue();
    const cur = this.view.state.doc.toString();
    if (next === cur) return;
    let a = 0;
    const max = Math.min(next.length, cur.length);
    while (a < max && next.charCodeAt(a) === cur.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && next.charCodeAt(next.length - 1 - b) === cur.charCodeAt(cur.length - 1 - b)) b++;
    this.syncing = true;
    try {
      this.view.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } });
    } finally {
      this.syncing = false;
    }
  }

  // ---------------------------------------------------------------- positions (1-based, as Monaco)

  offsetOf(p: monaco.IPosition): number {
    const doc = this.view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, p.lineNumber)));
    return Math.min(line.to, line.from + Math.max(0, p.column - 1));
  }

  positionAt(offset: number): monaco.Position {
    const line = this.view.state.doc.lineAt(offset);
    return new monaco.Position(line.number, offset - line.from + 1);
  }

  getPosition(): monaco.Position | null {
    return this.getModel() ? this.positionAt(this.view.state.selection.main.head) : null;
  }

  getSelection(): monaco.Selection | null {
    if (!this.getModel()) return null;
    const { anchor, head } = this.view.state.selection.main;
    const a = this.positionAt(anchor);
    const h = this.positionAt(head);
    return new monaco.Selection(a.lineNumber, a.column, h.lineNumber, h.column);
  }

  setPosition(p: monaco.IPosition) {
    const o = this.offsetOf(p);
    this.view.dispatch({ selection: EditorSelection.cursor(o) });
  }

  setSelection(r: monaco.IRange | monaco.ISelection) {
    const start = 'selectionStartLineNumber' in r ? { lineNumber: r.selectionStartLineNumber, column: r.selectionStartColumn } : { lineNumber: r.startLineNumber, column: r.startColumn };
    const end = 'positionLineNumber' in r ? { lineNumber: r.positionLineNumber, column: r.positionColumn } : { lineNumber: r.endLineNumber, column: r.endColumn };
    this.view.dispatch({ selection: EditorSelection.range(this.offsetOf(start), this.offsetOf(end)) });
  }

  // ---------------------------------------------------------------- edits

  /** Monaco-style edits (1-based ranges), as one undoable change. */
  executeEdits(_source: string, edits: { range: monaco.IRange; text: string | null; forceMoveMarkers?: boolean }[]): boolean {
    if (!this.getModel() || this.view.state.readOnly) return false;
    const changes = edits.map((e) => ({
      from: this.offsetOf({ lineNumber: e.range.startLineNumber, column: e.range.startColumn }),
      to: this.offsetOf({ lineNumber: e.range.endLineNumber, column: e.range.endColumn }),
      insert: e.text ?? '',
    }));
    const set = this.view.state.changes(changes);
    // The cursor ends after the last edit (as Monaco does for typing-like edits).
    const last = changes.reduce((m, c) => (c.from >= m.from ? c : m), changes[0]);
    const head = last ? set.mapPos(last.from, 1) : this.view.state.selection.main.head;
    this.view.dispatch({ changes: set, selection: EditorSelection.cursor(head), scrollIntoView: true, userEvent: 'input' });
    return true;
  }

  pushUndoStop() {
    /* each dispatch above is its own undo step */
  }

  // ---------------------------------------------------------------- focus, scrolling, view state

  focus() {
    this.view.focus();
  }

  hasTextFocus() {
    return this.view.hasFocus;
  }

  private reveal(offset: number, y: 'center' | 'start' | 'nearest') {
    this.view.dispatch({ effects: EditorView.scrollIntoView(offset, { y }) });
  }

  revealLineInCenterIfOutsideViewport(line: number) {
    this.reveal(this.offsetOf({ lineNumber: line, column: 1 }), 'nearest');
  }

  revealLineNearTop(line: number) {
    this.reveal(this.offsetOf({ lineNumber: line, column: 1 }), 'start');
  }

  revealRangeInCenterIfOutsideViewport(r: monaco.IRange) {
    this.reveal(this.offsetOf({ lineNumber: r.startLineNumber, column: r.startColumn }), 'center');
  }

  revealPositionInCenterIfOutsideViewport(p: monaco.IPosition) {
    this.reveal(this.offsetOf(p), 'center');
  }

  saveViewState(): CmViewState {
    const { anchor, head } = this.view.state.selection.main;
    return { anchor, head, scrollTop: this.view.scrollDOM.scrollTop };
  }

  restoreViewState(s: CmViewState | null) {
    if (!s) return;
    const len = this.view.state.doc.length;
    this.view.dispatch({ selection: EditorSelection.range(Math.min(s.anchor, len), Math.min(s.head, len)) });
    requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = s.scrollTop));
  }

  layout() {
    this.view.requestMeasure();
  }

  // ---------------------------------------------------------------- events and actions

  private sub<T>(set: Set<Listener<T>>, f: Listener<T>): monaco.IDisposable {
    set.add(f);
    return { dispose: () => set.delete(f) };
  }
  onDidChangeModel(f: Listener) {
    return this.sub(this.onModel, f);
  }
  onDidChangeModelContent(f: Listener) {
    return this.sub(this.onContent, f);
  }
  onDidChangeCursorSelection(f: Listener) {
    return this.sub(this.onCursor, f);
  }

  /** Named commands, for the toolbar, command palette and EditorApi.command. */
  addAction(id: string, run: () => void, label?: string) {
    this.actions.set(id, run);
    if (label) this.labels.set(id, label);
  }
  getAction(id: string): { run(): void } | null {
    const run = this.actions.get(id);
    return run ? { run } : null;
  }
  /** Monaco's trigger(): only the command palette is asked for this way. */
  trigger(_source: string, id: string) {
    this.actions.get(id === 'editor.action.quickCommand' ? 'r.palette' : id)?.();
  }

  // ---------------------------------------------------------------- decorations (cm-decorations.ts)

  /** Extensions every document's state needs for the decorations and gutters. */
  extension() {
    return [
      decoField,
      gutters((type, line) => {
        const e = { target: { type, position: new monaco.Position(line, 1) } } as unknown as monaco.editor.IEditorMouseEvent;
        this.onMouse.forEach((f) => f(e));
      }),
    ];
  }

  private redraw(fn: Parameters<typeof setDecos.of>[0]) {
    if (!this.getModel()) return;
    this.view.dispatch({ effects: setDecos.of(fn) });
  }

  private collSeq = 0;
  private groupSeq = 0;
  /** Monaco's decorations collection: set() replaces, getRanges() reads where they are now. */
  createDecorationsCollection(): monaco.editor.IEditorDecorationsCollection {
    const coll = ++this.collSeq;
    const mine = (d: Decoration) => {
      const sp = specOf(d);
      return sp.kind === 'coll' && sp.coll === coll;
    };
    const ranges = (): monaco.Range[] => {
      const groups = new Map<number, { from: number; to: number }>();
      const doc = this.view.state.doc;
      this.view.state.field(decoField).between(0, doc.length, (from, to, d) => {
        const sp = specOf(d);
        if (sp.kind !== 'coll' || sp.coll !== coll) return;
        const g = groups.get(sp.group);
        if (!g) groups.set(sp.group, { from, to });
        else (g.from = Math.min(g.from, from)), (g.to = Math.max(g.to, to));
      });
      return [...groups.values()].map(({ from, to }) => {
        const a = this.positionAt(from);
        const b = this.positionAt(to);
        return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
      });
    };
    const api = {
      set: (decos: readonly monaco.editor.IModelDeltaDecoration[]) => {
        this.redraw((set, state) =>
          set.update({ filter: (_f, _t, d) => !mine(d), add: decos.flatMap((d) => collDecos(state, coll, ++this.groupSeq, d)), sort: true }),
        );
        return [];
      },
      clear: () => this.redraw((set) => set.update({ filter: (_f, _t, d) => !mine(d) })),
      getRanges: ranges,
      get length() {
        return ranges().length;
      },
    };
    return api as unknown as monaco.editor.IEditorDecorationsCollection;
  }

  // View zones: blocks between lines (notebook output).
  private zones = new Map<string, monaco.editor.IViewZone>();
  private zoneSeq = 0;
  changeViewZones(cb: (acc: monaco.editor.IViewZoneChangeAccessor) => void) {
    const touched = new Set<string>();
    const removed = new Set<string>();
    cb({
      addZone: (z) => {
        const id = `z${++this.zoneSeq}`;
        this.zones.set(id, z);
        touched.add(id);
        return id;
      },
      removeZone: (id) => {
        this.zones.delete(id);
        removed.add(id);
      },
      layoutZone: (id) => {
        if (this.zones.has(id)) touched.add(id);
      },
    });
    const isZone = (d: Decoration, ids: Set<string>) => {
      const sp = specOf(d);
      return sp.kind === 'zone' && ids.has(sp.id);
    };
    const all = new Set([...touched, ...removed]);
    if (all.size)
      this.redraw((set, state) =>
        set.update({
          filter: (_f, _t, d) => !isZone(d, all),
          add: [...touched].filter((id) => this.zones.has(id)).map((id) => zoneDeco(state, id, this.zones.get(id)!.afterLineNumber, this.zones.get(id)!.domNode)),
          sort: true,
        }),
      );
    // Heights come from the DOM; let CodeMirror measure again.
    this.view.requestMeasure();
  }

  // Content widgets (notebook run buttons on a chunk's first line).
  private widgets = new Map<string, monaco.editor.IContentWidget>();
  addContentWidget(w: monaco.editor.IContentWidget) {
    this.widgets.set(w.getId(), w);
    this.placeWidgets([w.getId()]);
  }
  layoutContentWidget(w: monaco.editor.IContentWidget) {
    this.placeWidgets([w.getId()]);
  }
  removeContentWidget(w: monaco.editor.IContentWidget) {
    this.widgets.delete(w.getId());
    const id = w.getId();
    this.redraw((set) => set.update({ filter: (_f, _t, d) => !(specOf(d).kind === 'widget' && (specOf(d) as { id: string }).id === id) }));
  }
  private placeWidgets(ids = [...this.widgets.keys()]) {
    const want = new Set(ids);
    this.redraw((set, state) =>
      set.update({
        filter: (_f, _t, d) => !(specOf(d).kind === 'widget' && want.has((specOf(d) as { id: string }).id)),
        add: ids.flatMap((id) => {
          const w = this.widgets.get(id);
          const pos = w?.getPosition()?.position;
          return w && pos ? [widgetDeco(state, id, pos, w.getDomNode())] : [];
        }),
        sort: true,
      }),
    );
  }

  // Inlay hints (the notebook's inline `r` values).
  private hints: { provider: monaco.languages.InlayHintsProvider } | null = null;
  useInlayHints(provider: monaco.languages.InlayHintsProvider, onChange: monaco.IEvent<void>) {
    this.hints = { provider };
    onChange(() => this.refreshHints());
  }
  private async refreshHints() {
    const model = this.getModel();
    if (!this.hints || !model) return;
    const range = model.getFullModelRange();
    const res = await this.hints.provider.provideInlayHints(model, range, { isCancellationRequested: false } as monaco.CancellationToken);
    if (model !== this.getModel()) return;
    const list = res?.hints ?? [];
    this.redraw((set) =>
      set.update({
        filter: (_f, _t, d) => specOf(d).kind !== 'hint',
        add: list.map((h) => hintDeco(this.offsetOf(h.position), typeof h.label === 'string' ? h.label : h.label.map((p) => p.label).join(''), typeof h.tooltip === 'string' ? h.tooltip : (h.tooltip?.value ?? ''))),
        sort: true,
      }),
    );
  }

  // Layout.
  getLayoutInfo() {
    const gutterW = (this.view.dom.querySelector('.cm-gutters') as HTMLElement | null)?.offsetWidth ?? 0;
    return { contentWidth: Math.max(0, this.view.scrollDOM.clientWidth - gutterW), verticalScrollbarWidth: 0 } as monaco.editor.EditorLayoutInfo;
  }
  private readonly onLayout = new Set<Listener>();
  private layoutObserver = new ResizeObserver(() => this.onLayout.forEach((f) => f()));
  onDidLayoutChange(f: Listener) {
    if (this.onLayout.size === 0) this.layoutObserver.observe(this.view.scrollDOM);
    return this.sub(this.onLayout, f);
  }

  private readonly onMouse = new Set<Listener<monaco.editor.IEditorMouseEvent>>();
  /** Only gutter clicks (glyph margin, line numbers) are reported. */
  onMouseDown(f: Listener<monaco.editor.IEditorMouseEvent>) {
    return this.sub(this.onMouse as Set<Listener<unknown>>, f as Listener<unknown>);
  }

  dispose() {
    this.modelSub?.dispose();
    this.layoutObserver.disconnect();
    this.view.destroy();
  }

  /** For the shared modules, which are typed against Monaco's editor. */
  asMonaco(): monaco.editor.IStandaloneCodeEditor {
    return this as unknown as monaco.editor.IStandaloneCodeEditor;
  }
}
