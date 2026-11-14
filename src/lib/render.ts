// Render a Quarto / R Markdown document to a self-contained HTML page:
// knitr runs the code and litedown converts the Markdown (both in webR);
// here we add what Quarto's Pandoc filters would: callouts, tabsets,
// figure/table numbering and cross-references, a table of contents, code
// highlighting and maths. Everything is inlined so the page works offline.

import { createStore } from 'solid-js/store';
import { session } from './ide';
import { monaco } from './monaco';
import { base64, CORS_IMAGES, inlineDeps, MIME, parseManifest } from './html-page';

export interface PreviewState {
  /** Model URI of the rendered document. */
  doc: string | null;
  /** Workspace path of the document (null if untitled). */
  path: string | null;
  name: string;
  html: string;
  status: 'idle' | 'rendering' | 'done' | 'error';
  error: string;
  ms: number;
  /** Output format of the last render. */
  format: 'html' | 'revealjs';
  /** For slides: speaker notes and titles by slide ("h.v"), and the slide count. */
  deck: { notes: Record<string, string>; titles: Record<string, string>; total: number; title: string; vertical: boolean } | null;
}

const [preview, setPreview] = createStore<PreviewState>({ doc: null, path: null, name: '', html: '', status: 'idle', error: '', ms: 0, format: 'html', deck: null });
export { preview };

let renderSeq = 0;

/** Render `text` (run with `dir` as the working directory) into the preview. */
export async function renderDocument(opts: { doc: string; path: string | null; name: string; text: string; dir: string; dark: boolean }) {
  const seq = ++renderSeq;
  setPreview({ doc: opts.doc, path: opts.path, name: opts.name, status: 'rendering', error: '' });
  const t0 = performance.now();
  try {
    const parts = await session.renderDocument(opts.text, opts.dir);
    const { html, deck } = await buildPage(parts, opts.dir, opts.dark);
    if (seq !== renderSeq) return;
    setPreview({ html, deck, status: 'done', ms: performance.now() - t0, format: deck ? 'revealjs' : 'html' });
  } catch (e) {
    if (seq !== renderSeq) return;
    setPreview({ status: 'error', error: cleanError(String((e as Error)?.message ?? e)) });
  }
}

const cleanError = (msg: string) => msg.replace(/^Error:\s*/, '').trim();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function buildPage(parts: string[], dir: string, dark: boolean): Promise<{ html: string; deck: PreviewState['deck'] }> {
  const [title, subtitle, authors, date, toc, tocTitle, body, manifest, abstract, to, optionText] = parts;
  const options: Record<string, string> = {};
  for (const rec of (optionText ?? '').split('\x1e')) {
    const i = rec.indexOf('\x1f');
    if (i > 0) options[rec.slice(0, i)] = rec.slice(i + 1);
  }
  const slides = to === 'revealjs';
  const deps = manifest ? await inlineDeps(parseManifest(manifest)) : '';
  const doc = new DOMParser().parseFromString(`<main id="root">${body ?? ''}</main>`, 'text/html');
  const root = doc.getElementById('root')!;
  if (slides && options.logo) {
    // Inlined with the other images below, then moved into the slide frame.
    const img = doc.createElement('img');
    img.className = 'slide-logo';
    img.alt = '';
    img.setAttribute('src', options.logo);
    root.appendChild(img);
  }
  await inlineImages(root, dir);
  markOutputs(root);
  callouts(root, doc);
  tabsets(root, doc);
  crossrefs(root);
  await highlight(root);
  await maths(root);
  const people = (authors ?? '').split('\x1f').filter(Boolean);
  if (slides) {
    const { slidesPage } = await import('./slides');
    const d = await slidesPage(root, { title, subtitle, authors: people, date, options, deps, tokenCss: tokenCss(), pageJs: PAGE_JS });
    return { html: d.html, deck: { notes: d.notes, titles: d.titles, total: d.total, title: title || 'Slides', vertical: d.vertical } };
  }
  const nav = toc ? tocHtml(root, tocTitle || 'Contents') : '';
  const header =
    title || subtitle || people.length || date
      ? `<header class="title-block">${title ? `<h1 class="title">${esc(title)}</h1>` : ''}${
          subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''
        }${people.length || date ? `<div class="byline">${people.map((a) => `<span>${esc(a)}</span>`).join('')}${date ? `<span class="date">${esc(date)}</span>` : ''}</div>` : ''}${
          abstract ? `<div class="abstract"><div class="abstract-title">Abstract</div><p>${esc(abstract)}</p></div>` : ''
        }</header>`
      : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Document')}</title>
<style>${PAGE_CSS}\n${tokenCss()}</style>
${deps}
${CORS_IMAGES}
</head><body class="${dark ? 'dark' : ''}${nav ? ' has-toc' : ''}">
<div class="page">${nav}<div class="content">${header}${root.innerHTML}</div></div>
<script>${PAGE_JS}</script>
</body></html>`;
  return { html, deck: null };
}

/** Images referenced by relative path (e.g. ![](images/a.png)) become data URIs. */
async function inlineImages(root: HTMLElement, dir: string) {
  for (const img of Array.from(root.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src')!;
    if (/^(data:|https?:|\/\/|blob:)/i.test(src)) continue;
    const path = src.startsWith('/') ? src : `${dir}/${decodeURIComponent(src.split(/[?#]/)[0])}`;
    try {
      const bytes = await session.webR.FS.readFile(path);
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      img.setAttribute('src', `data:${MIME[ext] ?? 'application/octet-stream'};base64,${base64(bytes)}`);
    } catch {
      /* leave it */
    }
  }
}

/** Code blocks without a language are chunk output. */
function markOutputs(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const code = pre.querySelector('code');
    if (!code || /language-/.test(code.className)) {
      pre.classList.add('sourceCode');
      continue;
    }
    // knitr writes each message separately; show consecutive output as one block.
    const prev = pre.previousElementSibling;
    const prevCode = prev?.matches('pre.cell-output') ? prev.querySelector('code') : null;
    if (prevCode) {
      prevCode.textContent = `${(prevCode.textContent ?? '').replace(/\n$/, '')}\n${code.textContent ?? ''}`;
      pre.remove();
    } else pre.classList.add('cell-output');
  }
}

const CALLOUT_TITLES: Record<string, string> = { note: 'Note', tip: 'Tip', warning: 'Warning', important: 'Important', caution: 'Caution' };

function callouts(root: HTMLElement, doc: Document) {
  for (const div of Array.from(root.querySelectorAll('div'))) {
    const type = Array.from(div.classList).map((c) => /^callout-(note|tip|warning|important|caution)$/.exec(c)?.[1]).find(Boolean);
    if (!type) continue;
    let title = div.getAttribute('title') ?? '';
    const first = div.firstElementChild;
    if (!title && first && /^H[1-6]$/.test(first.tagName)) {
      title = first.textContent ?? '';
      first.remove();
    }
    const box = doc.createElement('div');
    box.className = `callout callout-${type}`;
    const head = doc.createElement('div');
    head.className = 'callout-header';
    head.innerHTML = `<span class="callout-icon" aria-hidden="true"></span><span>${esc(title || CALLOUT_TITLES[type])}</span>`;
    const body = doc.createElement('div');
    body.className = 'callout-body';
    while (div.firstChild) body.appendChild(div.firstChild);
    box.append(head, body);
    div.replaceWith(box);
  }
}

function tabsets(root: HTMLElement, doc: Document) {
  for (const set of Array.from(root.querySelectorAll('div.panel-tabset'))) {
    const heading = Array.from(set.children).find((c) => /^H[1-6]$/.test(c.tagName));
    if (!heading) continue;
    const level = heading.tagName;
    const tabs: { title: string; nodes: Node[] }[] = [];
    for (const node of Array.from(set.childNodes)) {
      if (node instanceof Element && node.tagName === level) tabs.push({ title: node.textContent ?? '', nodes: [] });
      else if (tabs.length) tabs[tabs.length - 1].nodes.push(node);
    }
    const box = doc.createElement('div');
    box.className = 'tabset';
    const nav = doc.createElement('div');
    nav.className = 'tabset-nav';
    nav.setAttribute('role', 'tablist');
    box.appendChild(nav);
    tabs.forEach((t, i) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = t.title;
      b.setAttribute('role', 'tab');
      if (i === 0) b.className = 'active';
      nav.appendChild(b);
      const panel = doc.createElement('div');
      panel.className = 'tabset-panel';
      panel.setAttribute('role', 'tabpanel');
      if (i > 0) panel.hidden = true;
      panel.append(...t.nodes);
      box.appendChild(panel);
    });
    set.replaceWith(box);
  }
}

function crossrefs(root: HTMLElement) {
  const labels = new Map<string, string>();
  Array.from(root.querySelectorAll('figure[id^="fig-"]')).forEach((fig, i) => {
    labels.set(fig.id, `Figure ${i + 1}`);
    const cap = fig.querySelector('figcaption');
    if (cap) cap.innerHTML = `<span class="xref-label">Figure ${i + 1}:</span> ${cap.innerHTML}`;
  });
  Array.from(root.querySelectorAll('.quarto-table[id^="tbl-"]')).forEach((t, i) => {
    labels.set(t.id, `Table ${i + 1}`);
    const cap = t.querySelector('.table-caption');
    if (cap) cap.innerHTML = `<span class="xref-label">Table ${i + 1}:</span> ${cap.innerHTML}`;
  });
  for (const h of Array.from(root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))) {
    const num = h.querySelector('.section-number')?.textContent?.trim();
    labels.set(h.id, num ? `Section ${num}` : (h.textContent ?? '').trim());
  }
  for (const a of Array.from(root.querySelectorAll('a[href^="#"]'))) {
    const text = (a.textContent ?? '').trim();
    if (!text.startsWith('@')) continue;
    const id = text.slice(1);
    const label = labels.get(id);
    if (label) {
      a.textContent = label;
      a.setAttribute('href', `#${id}`);
      a.classList.add('xref');
    } else {
      a.textContent = `?@${id}`;
      a.classList.add('xref-missing');
    }
  }
}

async function highlight(root: HTMLElement) {
  for (const code of Array.from(root.querySelectorAll('pre > code[class*="language-"]'))) {
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1]?.toLowerCase() ?? '';
    const id = lang === 'r' ? 'r' : monaco.languages.getLanguages().find((l) => l.id === lang || l.aliases?.some((a) => a.toLowerCase() === lang))?.id;
    if (!id) continue;
    try {
      const html = await monaco.editor.colorize((code.textContent ?? '').replace(/\n$/, ''), id, { tabSize: 2 });
      code.innerHTML = html.replace(/<br\/?>/g, '\n').replace(/^<div[^>]*>|<\/div>$/g, '');
    } catch {
      /* leave plain */
    }
  }
}

/** Monaco's token colours for the current theme, for highlighted code. */
function tokenCss(): string {
  const rules: string[] = [];
  for (const style of Array.from(document.querySelectorAll('style'))) {
    const text = style.textContent ?? '';
    if (!text.includes('.mtk1')) continue;
    for (const m of text.matchAll(/\.mtk[\w-]*\s*\{[^}]*\}/g)) rules.push(m[0]);
  }
  return rules.join('\n');
}

export async function maths(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (/\\\(|\\\[|\$\$/.test(t.data) && !t.parentElement?.closest('pre, code, script, style')) nodes.push(t);
  }
  if (!nodes.length) return;
  const katex = (await import('katex')).default;
  for (const t of nodes) {
    const html = esc(t.data).replace(/\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g, (all, d1, d2, inl) => {
      const tex = (d1 ?? d2 ?? inl).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      try {
        return katex.renderToString(tex, { displayMode: inl === undefined, output: 'mathml', throwOnError: false });
      } catch {
        return all;
      }
    });
    const span = root.ownerDocument.createElement('span');
    span.innerHTML = html;
    t.replaceWith(...Array.from(span.childNodes));
  }
}

function tocHtml(root: HTMLElement, title: string): string {
  const items = Array.from(root.querySelectorAll('h1[id], h2[id], h3[id]'))
    .map((h) => `<li class="toc-${h.tagName.toLowerCase()}"><a href="#${esc(h.id)}">${esc((h.textContent ?? '').trim())}</a></li>`)
    .join('');
  return items ? `<nav class="toc"><div class="toc-title">${esc(title)}</div><ul>${items}</ul></nav>` : '';
}

export const PAGE_JS = `
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('.tabset-nav button');
  if (b) {
    var set = b.closest('.tabset');
    var buttons = Array.prototype.slice.call(set.querySelectorAll(':scope > .tabset-nav > button'));
    var panels = set.querySelectorAll(':scope > .tabset-panel');
    var i = buttons.indexOf(b);
    buttons.forEach(function (x, j) { x.classList.toggle('active', j === i); });
    Array.prototype.forEach.call(panels, function (p, j) { p.hidden = j !== i; });
    window.dispatchEvent(new Event('resize'));
    return;
  }
  var a = e.target.closest && e.target.closest('a[href]');
  if (a) {
    var href = a.getAttribute('href');
    if (href.charAt(0) === '#') {
      var el = document.getElementById(decodeURIComponent(href.slice(1)));
      if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth' }); }
    } else {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  }
});
`;

const PAGE_CSS = `
:root { color-scheme: light; --fg: #212529; --muted: #6c757d; --bg: #fff; --code-bg: #f6f8fa; --border: #dee2e6; --link: #2780e3; }
body.dark { color-scheme: dark; --fg: #dee2e6; --muted: #9aa4ad; --bg: #1d2127; --code-bg: #262b33; --border: #3a414b; --link: #6ea8fe; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
.page { max-width: 820px; margin: 0 auto; padding: 24px 20px 64px; }
body.has-toc .page { max-width: 1100px; display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 40px; }
body.has-toc .toc { order: 2; position: sticky; top: 16px; align-self: start; max-height: calc(100vh - 32px); overflow: auto; }
@media (max-width: 900px) { body.has-toc .page { display: block; } body.has-toc .toc { position: static; margin-bottom: 24px; } }
.content { min-width: 0; }
a { color: var(--link); }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 600; }
h1 { font-size: 2rem; } h2 { font-size: 1.6rem; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); } h3 { font-size: 1.3rem; }
.title-block { margin-bottom: 2rem; }
.title-block .title { font-size: 2.4rem; margin: 0.5rem 0 0.25rem; border: 0; }
.subtitle { font-size: 1.25rem; color: var(--muted); margin: 0 0 0.75rem; }
.byline { display: flex; flex-wrap: wrap; gap: 4px 20px; color: var(--muted); font-size: 0.95rem; }
.abstract { margin-top: 1.25rem; }
.abstract-title { font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
pre { background: var(--code-bg); border-radius: 6px; padding: 12px 14px; overflow: auto; font-size: 0.85rem; line-height: 1.45; }
code { font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace; font-size: 0.875em; }
:not(pre) > code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
pre code { background: none; padding: 0; font-size: inherit; }
pre.cell-output { background: transparent; border: 0; border-left: 3px solid var(--border); border-radius: 0; padding: 4px 14px; margin-top: -0.4rem; }
img { max-width: 100%; height: auto; }
figure { margin: 1.25rem 0; text-align: center; }
figcaption, .table-caption { color: var(--muted); font-size: 0.9rem; margin-top: 0.4rem; }
.table-caption { margin: 0 0 0.4rem; }
.xref-label { font-weight: 600; }
.xref-missing { color: #d63939; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; display: block; overflow-x: auto; max-width: 100%; }
th, td { padding: 6px 12px; border-bottom: 1px solid var(--border); text-align: left; }
thead th { border-bottom: 2px solid var(--border); }
blockquote { margin: 1rem 0; padding: 0 1rem; color: var(--muted); border-left: 4px solid var(--border); }
hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
details.code-fold > summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; margin: 0.5rem 0; }
.callout { margin: 1.25rem 0; border: 1px solid var(--border); border-left: 5px solid var(--c); border-radius: 6px; overflow: hidden; }
.callout-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-weight: 600; font-size: 0.95rem; background: color-mix(in srgb, var(--c) 12%, transparent); }
.callout-icon { width: 16px; height: 16px; border-radius: 50%; background: var(--c); flex: none; }
.callout-body { padding: 4px 14px; }
.callout-note { --c: #0d6efd; } .callout-tip { --c: #198754; } .callout-warning { --c: #ffc107; } .callout-important { --c: #dc3545; } .callout-caution { --c: #fd7e14; }
.tabset { margin: 1.25rem 0; }
.tabset-nav { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--border); }
.tabset-nav button { font: inherit; font-size: 0.95rem; padding: 6px 14px; border: 1px solid transparent; border-bottom: 0; border-radius: 6px 6px 0 0; background: none; color: var(--link); cursor: pointer; margin-bottom: -1px; }
.tabset-nav button.active { color: var(--fg); border-color: var(--border); background: var(--bg); }
.tabset-panel { padding: 8px 0; }
.toc { font-size: 0.9rem; }
.toc-title { font-weight: 600; margin-bottom: 6px; }
.toc ul { list-style: none; margin: 0; padding: 0 0 0 10px; border-left: 1px solid var(--border); }
.toc li { margin: 3px 0; } .toc .toc-h3 { padding-left: 12px; }
.toc a { color: var(--muted); text-decoration: none; } .toc a:hover { color: var(--link); }
math[display="block"] { margin: 1rem 0; overflow-x: auto; }
.html-widget { max-width: 100%; }
`;
