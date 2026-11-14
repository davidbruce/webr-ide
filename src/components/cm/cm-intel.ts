// R code intelligence in the CodeMirror pane: the same providers the Monaco
// pane uses (language.ts, snippets.ts), adapted to CodeMirror — completions
// with their help, hover help, the signature hint while typing a call, and the
// R checks' underlines (read from the Monaco markers on each document's model).

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, showTooltip, type Tooltip, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { autocompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { monaco } from '../../lib/monaco';
import { rProviders } from '../../lib/language';
import { snippetCompletions, resolveR } from '../../lib/snippets';
import { settings } from '../../lib/settings';
import { desktopEditing } from '../../lib/input-mode';
import type { CmEditor } from './cm-editor';

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as monaco.CancellationToken;

// ---------------------------------------------------------------- markdown (help texts)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
/** The little Markdown the R help texts use: code blocks, `code`, **bold**, *italic*, paragraphs. */
export function markdownToHtml(md: string): string {
  return md
    .split(/(```[a-z]*\n[\s\S]*?\n```)/)
    .map((part) => {
      const code = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(part);
      if (code) return `<pre class="cm-help-code">${esc(code[1])}</pre>`;
      return part
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${inline(p)}</p>`)
        .join('');
    })
    .join('');
}
const mdValue = (d: string | monaco.IMarkdownString | undefined) => (typeof d === 'string' ? d : d?.value ?? '');

function helpDom(parts: string[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cm-help';
  el.innerHTML = parts.map(markdownToHtml).join('');
  return el;
}

// ---------------------------------------------------------------- completions

const KIND: Partial<Record<monaco.languages.CompletionItemKind, string>> = {};
{
  const K = monaco.languages.CompletionItemKind;
  Object.assign(KIND, {
    [K.Function]: 'function',
    [K.Method]: 'method',
    [K.Variable]: 'variable',
    [K.Field]: 'property',
    [K.Property]: 'property',
    [K.Keyword]: 'keyword',
    [K.Module]: 'namespace',
    [K.Constant]: 'constant',
    [K.Value]: 'constant',
    [K.Snippet]: 'snippet',
    [K.File]: 'text',
    [K.Folder]: 'text',
  });
}

/** TextMate/Monaco snippet text → CodeMirror's template (they mostly agree). */
function toCmSnippet(body: string): string {
  return body.replace(/\$(\d+)/g, '${$1}').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
}

const TRIGGERS = new Set(['$', '@', ':', '(', ',', ' ']);

/** A CodeMirror completion source from a Monaco completion provider. */
function sourceFrom(ed: CmEditor, provider: monaco.languages.CompletionItemProvider) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const model = ed.getModel();
    if (!model) return null;
    const ch = ctx.state.sliceDoc(ctx.pos - 1, ctx.pos);
    const word = ctx.matchBefore(/[\w.]*/);
    const trig = !ctx.explicit && TRIGGERS.has(ch) ? ch : undefined;
    if (!ctx.explicit && !trig && !word?.text) return null;
    const position = ed.positionAt(ctx.pos);
    const context: monaco.languages.CompletionContext = trig
      ? { triggerKind: monaco.languages.CompletionTriggerKind.TriggerCharacter, triggerCharacter: trig }
      : { triggerKind: monaco.languages.CompletionTriggerKind.Invoke };
    const list = await provider.provideCompletionItems(model, position, context, token);
    if (!list || ctx.aborted || model.isDisposed()) return null;
    const items = [...list.suggestions].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
    if (!items.length) return null;
    const r = items[0].range as monaco.IRange;
    const from = 'startLineNumber' in r ? ed.offsetOf({ lineNumber: r.startLineNumber, column: r.startColumn }) : (word?.from ?? ctx.pos);
    const options: Completion[] = items.map((item, i) => {
      const label = typeof item.label === 'string' ? item.label : item.label.label;
      const description = typeof item.label === 'string' ? undefined : item.label.description;
      const text = item.insertText;
      const isSnippet = !!(item.insertTextRules && item.insertTextRules & monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
      return {
        label,
        detail: description,
        type: KIND[item.kind] ?? 'text',
        // Keep the provider's order (CodeMirror then ranks by how well the typed text matches).
        boost: item.preselect ? 99 : Math.max(-98, 40 - i),
        apply: isSnippet
          ? (view, completion, f, t) => {
              void resolveR(text).then((body) => snippet(toCmSnippet(body))(view, completion, f, t));
            }
          : text,
        info: async () => {
          const res = (await provider.resolveCompletionItem?.(item, token)) ?? item;
          const parts = [res.detail ? '`' + res.detail + '`' : '', mdValue(res.documentation)].filter(Boolean);
          return parts.length ? helpDom(parts) : null;
        },
      };
    });
    return { from, options, validFor: /^[\w.]*$/ };
  };
}

// ---------------------------------------------------------------- hover help

function hover(ed: CmEditor) {
  return hoverTooltip(async (_view, pos): Promise<Tooltip | null> => {
    const model = ed.getModel();
    if (!model || !settings.hoverHelp) return null;
    const res = await rProviders.hover.provideHover(model, ed.positionAt(pos), token);
    if (!res?.contents.length) return null;
    const r = res.range;
    return {
      pos: r ? ed.offsetOf({ lineNumber: r.startLineNumber, column: r.startColumn }) : pos,
      end: r ? ed.offsetOf({ lineNumber: r.endLineNumber, column: r.endColumn }) : pos,
      above: true,
      create: () => ({ dom: helpDom(res.contents.map(mdValue)) }),
    };
  });
}

// ---------------------------------------------------------------- signature hint

interface Sig {
  pos: number;
  label: string;
  active: [number, number] | null;
}
const setSig = StateEffect.define<Sig | null>();
const sigField = StateField.define<Sig | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setSig)) return e.value;
    return v && tr.docChanged ? { ...v, pos: tr.changes.mapPos(v.pos) } : v;
  },
  provide: (f) =>
    showTooltip.from(f, (s): Tooltip | null =>
      s
        ? {
            pos: s.pos,
            above: true,
            create: () => {
              const dom = document.createElement('div');
              dom.className = 'cm-sig';
              const [a, b] = s.active ?? [0, 0];
              dom.innerHTML = s.active ? `${esc(s.label.slice(0, a))}<b>${esc(s.label.slice(a, b))}</b>${esc(s.label.slice(b))}` : esc(s.label);
              return { dom };
            },
          }
        : null,
    ),
});

/** While typing a call on a touch screen: its arguments, the current one in bold (as in Monaco). */
function signatureHint(ed: CmEditor): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer = 0;
      seq = 0;
      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet) return;
        clearTimeout(this.timer);
        const show = !desktopEditing() && u.view.hasFocus;
        if (!show) {
          if (u.state.field(sigField)) queueMicrotask(() => u.view.dispatch({ effects: setSig.of(null) }));
          return;
        }
        this.timer = window.setTimeout(() => void this.ask(u.view), 150);
      }
      async ask(view: EditorView) {
        const model = ed.getModel();
        if (!model) return;
        const my = ++this.seq;
        const pos = view.state.selection.main.head;
        const res = await rProviders.signature.provideSignatureHelp(model, ed.positionAt(pos), token, {
          triggerKind: monaco.languages.SignatureHelpTriggerKind.ContentChange,
          isRetrigger: false,
        });
        if (my !== this.seq) return;
        const sig = res?.value.signatures[0];
        const p = sig && res!.value.activeParameter >= 0 ? sig.parameters[res!.value.activeParameter]?.label : null;
        view.dispatch({ effects: setSig.of(sig ? { pos, label: sig.label, active: Array.isArray(p) ? (p as [number, number]) : null } : null) });
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  return [sigField, plugin];
}

// ---------------------------------------------------------------- R check underlines

const SEVERITY: Record<number, Diagnostic['severity']> = {
  [monaco.MarkerSeverity.Error]: 'error',
  [monaco.MarkerSeverity.Warning]: 'warning',
  [monaco.MarkerSeverity.Info]: 'info',
  [monaco.MarkerSeverity.Hint]: 'hint',
};

/** Show the active document's markers (syntax errors, problems) as CodeMirror diagnostics. */
export function syncDiagnostics(ed: CmEditor): monaco.IDisposable {
  const apply = () => {
    const model = ed.getModel();
    if (!model) return;
    const diags: Diagnostic[] = monaco.editor.getModelMarkers({ resource: model.uri }).map((m) => {
      const from = ed.offsetOf({ lineNumber: m.startLineNumber, column: m.startColumn });
      return {
        from,
        to: Math.max(from, ed.offsetOf({ lineNumber: m.endLineNumber, column: m.endColumn })),
        severity: SEVERITY[m.severity] ?? 'info',
        message: m.message,
      };
    });
    ed.view.dispatch(setDiagnostics(ed.view.state, diags));
  };
  const a = monaco.editor.onDidChangeMarkers((uris) => {
    const model = ed.getModel();
    if (model && uris.some((u) => u.toString() === model.uri.toString())) apply();
  });
  const b = ed.onDidChangeModel(apply);
  return { dispose: () => (a.dispose(), b.dispose()) };
}

/** Completions (R, then snippets), hover help and the signature hint. */
export function rIntelligence(ed: CmEditor, opts: { activateOnTyping: boolean }): Extension {
  return [
    autocompletion({
      override: [sourceFrom(ed, rProviders.completion), sourceFrom(ed, snippetCompletions)],
      activateOnTyping: opts.activateOnTyping,
      icons: true,
    }),
    hover(ed),
    signatureHint(ed),
  ];
}
