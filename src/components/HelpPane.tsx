import { createEffect, createSignal, on, onMount, Show } from 'solid-js';
import { monaco } from '../lib/monaco';
import { session } from '../lib/ide';
import { rString } from '../lib/r-session';
import {
  helpPage,
  canGoBack,
  canGoForward,
  helpBack,
  helpForward,
  openHelp,
  openHelpIndex,
  followHelpLink,
  trackHelpScroll,
  type HelpPage,
} from '../lib/help';
import { toast } from '../lib/ui';
import { Icon } from './Icon';
import './HelpPane.css';

const DROP = 'script, style, link, meta, iframe, object, embed, form, input, button, textarea, select, base';

/** The body of an Rd2HTML page, made safe to put in the IDE's document. */
function cleanHelpHtml(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = (doc.querySelector('main') ?? doc.body) as HTMLElement;
  root.querySelectorAll(DROP).forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) {
        el.removeAttribute(a.name);
      }
    }
  });
  // "lm {stats}   R Documentation" header table.
  const head = root.querySelector('table:first-child');
  if (head && /R Documentation/.test(head.textContent ?? '')) head.classList.add('help-head');
  root.querySelectorAll('a[href^="../Example/"]').forEach((a) => {
    a.classList.add('help-run');
    a.textContent = '▶ Run examples';
  });
  const out = document.createElement('div');
  out.append(...[...root.childNodes].map((n) => document.importNode(n, true)));
  return out;
}

/** R syntax colours (Monaco's tokenizer) and a Copy button for code blocks. */
function decorateCode(root: HTMLElement) {
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code') ?? pre;
    const text = code.textContent ?? '';
    if (code.classList.contains('language-R')) {
      void monaco.editor.colorize(text.replace(/\n$/, ''), 'r', { tabSize: 2 }).then((html) => {
        code.innerHTML = html;
      });
    }
    const wrap = document.createElement('div');
    wrap.className = 'help-code';
    wrap.dataset.code = text.replace(/\n$/, '');
    pre.replaceWith(wrap);
    wrap.append(pre);
    const copy = document.createElement('button');
    copy.className = 'help-copy';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.dataset.copy = '1';
    wrap.append(copy);
  });
}

// R's own help uses these macros with KaTeX (doc/html/katex-config.js).
const MACROS = { '\\R': '\\textsf{R}', '\\mbox': '\\text', '\\code': '\\texttt' };

/** Rd maths (\eqn, \deqn → <code class="reqn">) typeset with KaTeX as MathML. */
async function typesetMaths(root: HTMLElement) {
  const els = [...root.querySelectorAll<HTMLElement>('code.reqn')];
  if (!els.length) return;
  const katex = (await import('katex')).default;
  for (const el of els) {
    const tex = el.textContent ?? '';
    // \deqn: alone in a centred paragraph.
    const p = el.parentElement;
    const display = !!p && p.tagName === 'P' && p.style.textAlign === 'center' && p.textContent?.trim() === tex.trim();
    const span = document.createElement('span');
    span.className = display ? 'help-math display' : 'help-math';
    try {
      span.innerHTML = katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false, macros: { ...MACROS } });
    } catch {
      continue;
    }
    span.title = tex;
    el.replaceWith(span);
  }
}

export function HelpPane() {
  const [topic, setTopic] = createSignal('');
  let body!: HTMLDivElement;
  let content!: HTMLDivElement;
  onMount(() => trackHelpScroll(() => body?.scrollTop ?? 0));

  createEffect(
    on(helpPage, (p) => {
      if (!content) return;
      content.replaceChildren();
      if (p?.kind === 'html') {
        const el = cleanHelpHtml(p.html);
        decorateCode(el);
        void typesetMaths(el);
        content.append(el);
      }
      queueMicrotask(() => body && (body.scrollTop = p?.scroll ?? 0));
    }),
  );

  function search(e: Event) {
    e.preventDefault();
    const t = topic().trim();
    if (!t) return;
    if (t.startsWith('??')) {
      session.submit(`help.search(${rString(t.slice(2).trim())})`);
      return;
    }
    const m = t.match(/^([\w.]+):::?(.+)$/);
    void (m ? openHelp(m[2], m[1]) : openHelp(t.replace(/^\?/, '')));
  }

  function onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLButtonElement>('button[data-copy]');
    if (copy) {
      const text = copy.parentElement?.dataset.code ?? '';
      void navigator.clipboard.writeText(text).then(
        () => toast('Copied'),
        () => toast("Couldn't copy", 'warn'),
      );
      return;
    }
    const a = target.closest('a');
    const href = a?.getAttribute('href');
    if (!a || href == null) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      content.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    followHelpLink(href, helpPage());
  }

  const pkg = () => {
    const p = helpPage();
    return p?.kind === 'html' || p?.kind === 'doc' ? p.pkg : '';
  };

  return (
    <>
      <div class="pane-toolbar">
        <button class="icon-btn" title="Back" disabled={!canGoBack()} onClick={helpBack}>
          <Icon name="left" size={15} />
        </button>
        <button class="icon-btn" title="Forward" disabled={!canGoForward()} onClick={helpForward}>
          <Icon name="right" size={15} />
        </button>
        <form class="install-form help-search" onSubmit={search}>
          <div class="search-box">
            <Icon name="search" size={13} />
            <input
              type="search"
              placeholder="Help topic, e.g. lm"
              value={topic()}
              onInput={(e) => setTopic(e.currentTarget.value)}
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              enterkeyhint="search"
            />
          </div>
        </form>
        <span class="tb-spacer" />
        <Show when={pkg()}>
          <button class="link help-pkg" title={`Index of package ${pkg()}`} onClick={() => void openHelpIndex(pkg())}>
            {pkg()}
          </button>
        </Show>
      </div>
      <div class="pane-body scroll help-body" ref={body} onClick={onClick}>
        <Show when={helpPage()} fallback={<HelpStart />}>
          {(p) => <PageView page={p()} />}
        </Show>
        <div class="help-html" ref={content} hidden={helpPage()?.kind !== 'html'} />
      </div>
    </>
  );
}

function PageView(props: { page: HelpPage }) {
  return (
    <>
      <Show when={props.page.kind === 'text' && props.page}>{(p) => <pre class="help-text">{(p() as { text: string }).text}</pre>}</Show>
      <Show when={props.page.kind === 'doc' && props.page}>
        {(p) => <iframe class="help-doc" title={p().title} sandbox="allow-scripts allow-popups" srcdoc={(p() as { html: string }).html} />}
      </Show>
    </>
  );
}

function HelpStart() {
  const start = (t: string, p = '') => (e: MouseEvent) => {
    e.preventDefault();
    void openHelp(t, p);
  };
  return (
    <div class="empty-note help-start">
      <p>Search for a topic above, run <code>?topic</code> in the console, or press F1 on a function in the editor.</p>
      <p>
        Packages:{' '}
        {['base', 'stats', 'utils', 'graphics'].map((p) => (
          <>
            <a href="#" onClick={(e) => (e.preventDefault(), e.stopPropagation(), void openHelpIndex(p))}>
              {p}
            </a>{' '}
          </>
        ))}
      </p>
      <p>
        Try <a href="#" onClick={(e) => (e.stopPropagation(), start('lm')(e))}>lm</a>,{' '}
        <a href="#" onClick={(e) => (e.stopPropagation(), start('data.frame')(e))}>data.frame</a> or{' '}
        <a href="#" onClick={(e) => (e.stopPropagation(), start('Syntax')(e))}>Syntax</a>.
      </p>
    </div>
  );
}

