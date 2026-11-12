// Quarto `format: revealjs`: turn the rendered document into reveal.js
// slides, following Quarto's conventions:
//   - `#` headings make section slides, `##` headings start slides,
//     `---` starts an untitled slide; with navigation-mode: vertical, each
//     `#` section becomes a vertical stack of its `##` slides
//   - heading attributes style the slide: {.smaller} {.scrollable}
//     {background-color="..."} {background-image="..."} {transition="..."}
//     {auto-animate=true}
//   - ::: {.incremental} / {.nonincremental}, ::: {.fragment},
//     :::: {.columns} with ::: {.column width="40%"}, ::: {.notes},
//     .absolute with top/left/right/bottom/width/height
//   - options under format: revealjs: theme, transition, slide-number,
//     incremental, smaller, scrollable, controls, progress, center, footer,
//     logo, width, height, margin, loop, navigation-mode, chalkboard
// Styling comes from Quarto's own themes, compiled from its Sass sources
// (src/lib/quarto-themes, scripts/build-quarto-themes.py), with their fonts
// bundled. reveal.js, theme and fonts are inlined so the page works offline.
//
// The page talks to whoever embeds it (preview, presenter view, audience
// window) with reveal.js's postMessage API, plus "ide-board" messages that
// keep pen drawings in sync. Loaded on demand (not in the main bundle).

import revealJs from 'reveal.js/dist/reveal.js?raw';
import revealCss from 'reveal.js/dist/reveal.css?raw';
import { CORS_IMAGES, escapeScript } from './html-page';
import { themeFontCss } from './slide-fonts';

const THEMES = import.meta.glob('./quarto-themes/*.css', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
// reveal.js's names for Quarto's default and dark themes.
const ALIASES: Record<string, string> = { white: 'default', black: 'dark' };
const DARK = new Set(['dark', 'blood', 'dracula', 'league', 'moon', 'night']);

export interface SlideMeta {
  title: string;
  subtitle: string;
  authors: string[];
  date: string;
  /** Scalar options from `format: revealjs:`. */
  options: Record<string, string>;
  deps: string;
  tokenCss: string;
  pageJs: string;
}

export interface SlideDeck {
  html: string;
  /** Speaker notes (sanitized HTML) by slide, keyed "h.v". */
  notes: Record<string, string>;
  /** Slide titles by slide, keyed "h.v". */
  titles: Record<string, string>;
  total: number;
  /** navigation-mode: vertical (stacks under `#` sections). */
  vertical: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const truthy = (v: string | undefined) => v === 'true' || v === 'yes';

export async function slidesPage(root: HTMLElement, meta: SlideMeta): Promise<SlideDeck> {
  const doc = root.ownerDocument;
  const o = meta.options;
  const asked = ALIASES[o.theme ?? 'default'] ?? o.theme ?? 'default';
  const themeName = THEMES[`./quarto-themes/${asked}.css`] ? asked : 'default';
  const themeCss = await THEMES[`./quarto-themes/${themeName}.css`]();
  const fontCss = await themeFontCss(themeName);
  const dark = DARK.has(themeName);
  const vertical = o['navigation-mode'] === 'vertical' || o['navigation-mode'] === 'grid';

  const logo = root.querySelector('img.slide-logo');
  logo?.remove();
  quartoMarkup(root, doc);

  // Split into slides.
  type Slide = { el: HTMLElement; level: number };
  const slides: Slide[] = [];
  let cur: HTMLElement | null = null;
  const start = (heading?: Element) => {
    cur = doc.createElement('section');
    const level = heading?.tagName === 'H1' ? 1 : 2;
    slides.push({ el: cur, level });
    if (!heading) return;
    if (level === 1) cur.classList.add('title-slide', 'center');
    if (heading.id) {
      cur.id = heading.id;
      heading.removeAttribute('id');
    }
    for (const c of Array.from(heading.classList)) if (c !== 'unnumbered' && c !== 'unlisted') cur.classList.add(c);
    heading.removeAttribute('class');
    for (const a of Array.from(heading.attributes)) {
      const name = a.name.replace(/^data-/, '');
      if (/^(background|transition|auto-animate|visibility)/.test(name)) {
        cur.setAttribute(`data-${name}`, a.value);
        heading.removeAttribute(a.name);
      }
    }
    if (heading.textContent?.trim()) cur.appendChild(heading);
  };
  for (const node of Array.from(root.childNodes)) {
    if (node instanceof Element && (node.tagName === 'H1' || node.tagName === 'H2')) start(node);
    else if (node instanceof Element && node.tagName === 'HR') start();
    else {
      if (!cur) {
        if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
        start();
      }
      cur!.appendChild(node);
    }
  }

  for (const { el: s } of slides) {
    for (const n of Array.from(s.querySelectorAll('div.notes'))) {
      const aside = doc.createElement('aside');
      aside.className = 'notes';
      aside.append(...Array.from(n.childNodes));
      n.replaceWith(aside);
    }
    for (const c of Array.from(s.querySelectorAll('div.column[width]'))) {
      (c as HTMLElement).style.flex = `0 0 ${c.getAttribute('width')}`;
      c.removeAttribute('width');
    }
    // .absolute: position in slide pixels (numbers) or any CSS length.
    for (const a of Array.from(s.querySelectorAll('.absolute'))) {
      const st = (a as HTMLElement).style;
      st.position = 'absolute';
      for (const k of ['top', 'left', 'right', 'bottom', 'width', 'height'] as const) {
        const v = a.getAttribute(k);
        if (v == null) continue;
        st[k] = /^-?[\d.]+$/.test(v) ? `${v}px` : v;
        a.removeAttribute(k);
      }
    }
    const lists = truthy(o.incremental) ? Array.from(s.querySelectorAll('ul, ol')) : Array.from(s.querySelectorAll('.incremental ul, .incremental ol'));
    for (const list of lists) {
      if (list.closest('.nonincremental')) continue;
      for (const li of Array.from(list.children)) if (li.tagName === 'LI') li.classList.add('fragment');
    }
    if (truthy(o.smaller)) s.classList.add('smaller');
    if (truthy(o.scrollable)) s.classList.add('scrollable');
  }

  // Title slide.
  const all: Slide[] = [];
  if (meta.title) {
    const t = doc.createElement('section');
    t.id = 'title-slide';
    t.className = 'quarto-title-block center';
    t.innerHTML = `<h1 class="title">${esc(meta.title)}</h1>${meta.subtitle ? `<p class="subtitle">${esc(meta.subtitle)}</p>` : ''}${
      meta.authors.length
        ? `<div class="quarto-title-authors">${meta.authors.map((a) => `<div class="quarto-title-author"><div class="quarto-title-author-name">${esc(a)}</div></div>`).join('')}</div>`
        : ''
    }${meta.date ? `<p class="date">${esc(meta.date)}</p>` : ''}`;
    all.push({ el: t, level: 0 });
  }
  all.push(...slides);

  // Horizontal slides, or vertical stacks under each `#` section.
  const top: HTMLElement[][] = [];
  for (const s of all) {
    if (!vertical || s.level !== 2 || !top.length || top[top.length - 1][0].dataset.stack !== '1') {
      top.push([s.el]);
      if (vertical && s.level === 1) s.el.dataset.stack = '1';
    } else top[top.length - 1].push(s.el);
  }
  const notes: Record<string, string> = {};
  const titles: Record<string, string> = {};
  let total = 0;
  const html = top
    .map((group, h) => {
      group.forEach((el, v) => {
        total++;
        const key = `${h}.${v}`;
        titles[key] = el.querySelector('h1, h2')?.textContent?.trim() ?? '';
        const n = Array.from(el.querySelectorAll('aside.notes')).map((a) => sanitize(a.innerHTML)).join('');
        if (n) notes[key] = n;
        delete el.dataset.stack;
      });
      return group.length > 1 ? `<section>${group.map((el) => el.outerHTML).join('\n')}</section>` : group[0].outerHTML;
    })
    .join('\n');

  const footer = o.footer ? `<div class="footer footer-default">${esc(o.footer)}</div>` : '';
  const num = (v: string | undefined, d: number) => (v && !isNaN(Number(v)) ? Number(v) : d);
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : truthy(v));
  const config = {
    hash: false,
    history: false,
    respondToHashChanges: false,
    postMessage: true,
    postMessageEvents: true,
    controls: bool(o.controls, true),
    progress: bool(o.progress, true),
    slideNumber: o['slide-number'] === undefined || o['slide-number'] === 'false' ? false : o['slide-number'] === 'true' ? true : o['slide-number'],
    transition: o.transition ?? 'none',
    backgroundTransition: o['background-transition'] ?? 'none',
    center: bool(o.center, false),
    loop: bool(o.loop, false),
    width: num(o.width, 1050),
    height: num(o.height, 700),
    margin: num(o.margin, 0.1),
    navigationMode: vertical ? 'default' : 'linear',
    autoAnimate: true,
    // Always slides: reveal.js otherwise switches narrow frames (the preview
    // pane, the presenter's "next" view) to its scrolling mobile layout.
    scrollActivationWidth: null,
    controlsTutorial: false,
    pdfSeparateFragments: false,
  };
  const board = { enabled: o.chalkboard !== undefined && o.chalkboard !== 'false', width: config.width, height: config.height, dark };

  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || 'Slides')}</title>
<style>${fontCss}</style>
<style>${revealCss}</style>
<style>${themeCss}</style>
<style>${SLIDE_CSS}\n${meta.tokenCss}</style>
${meta.deps}
${CORS_IMAGES}
</head><body>
<div class="reveal quarto-light${dark ? ' quarto-dark' : ''}" data-navigation-mode="${config.navigationMode}"><div class="slides">
${html}
</div>${footer}${logo ? logo.outerHTML : ''}</div>
<script>${escapeScript(revealJs)}</script>
<script>
Reveal.initialize(${JSON.stringify(config)});
// Widgets on hidden slides were laid out at zero size; let them re-measure.
var resizing = false;
Reveal.on('slidechanged', function () {
  if (resizing) return;
  resizing = true;
  try { window.dispatchEvent(new Event('resize')); } finally { resizing = false; }
});
${BOARD_JS.replace('__BOARD__', JSON.stringify(board))}
${meta.pageJs}
</script>
</body></html>`;
  return { html: page, notes, titles, total, vertical };
}

/** Use the HTML structure Quarto's theme CSS expects for callouts and code. */
function quartoMarkup(root: HTMLElement, doc: Document) {
  for (const box of Array.from(root.querySelectorAll('div.callout'))) {
    const type = Array.from(box.classList).find((c) => /^callout-(note|tip|warning|important|caution)$/.test(c)) ?? 'callout-note';
    const title = box.querySelector('.callout-header')?.textContent?.trim() ?? '';
    const body = box.querySelector('.callout-body');
    const q = doc.createElement('div');
    q.className = `callout ${type} callout-titled callout-style-default`;
    q.innerHTML = `<div class="callout-body"><div class="callout-title"><div class="callout-icon-container"><i class="callout-icon"></i></div><p><strong>${esc(title)}</strong></p></div><div class="callout-content"></div></div>`;
    q.querySelector('.callout-content')!.append(...Array.from(body?.childNodes ?? []));
    box.replaceWith(q);
  }
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const code = pre.querySelector('code');
    const wrap = doc.createElement('div');
    if (pre.classList.contains('cell-output')) {
      pre.classList.remove('cell-output');
      wrap.className = 'cell-output cell-output-stdout';
    } else {
      const lang = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1] ?? '';
      wrap.className = 'sourceCode';
      pre.className = `sourceCode ${lang}`.trim();
      code?.classList.add('sourceCode');
      if (lang) code?.classList.add(lang);
    }
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
  }
}

const ALLOWED = new Set(['P', 'UL', 'OL', 'LI', 'EM', 'STRONG', 'B', 'I', 'CODE', 'PRE', 'A', 'BR', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'SPAN', 'MATH']);
/** Notes are shown in the IDE itself, so keep only harmless formatting. */
function sanitize(html: string): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (!ALLOWED.has(child.tagName) && !child.closest('math')) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(child.tagName)) child.remove();
        else {
          walk(child);
          child.replaceWith(...Array.from(child.childNodes));
        }
        continue;
      }
      for (const a of Array.from(child.attributes)) {
        const keep = (child.tagName === 'A' && a.name === 'href' && /^(https?:|#)/i.test(a.value)) || child.closest('math');
        if (!keep || a.name.startsWith('on')) child.removeAttribute(a.name);
      }
      walk(child);
    }
  };
  walk(d.body.firstElementChild!);
  return d.body.firstElementChild!.innerHTML;
}

// Pen drawings over the slides (Quarto's "chalkboard"): C draws on the
// slide, B opens a blank board, Delete clears, Esc stops. An Apple Pencil
// draws without switching modes. Strokes are kept per slide in slide
// coordinates, and shared with other views through the embedding page.
const BOARD_JS = `
(function () {
  var opts = __BOARD__;
  var slidesEl = document.querySelector('.reveal .slides');
  var canvas = document.createElement('canvas');
  canvas.className = 'ide-board';
  canvas.width = opts.width * 2; canvas.height = opts.height * 2;
  canvas.style.width = opts.width + 'px'; canvas.style.height = opts.height + 'px';
  slidesEl.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  var strokes = {}, mode = null, color = opts.dark ? '#ffd166' : '#e63946', drawing = null;
  var COLORS = opts.dark ? ['#ffd166', '#06d6a0', '#4cc9f0', '#ffffff'] : ['#e63946', '#1d6fd8', '#2a9d50', '#111111'];
  function key() { var s = Reveal.getIndices(); return (mode === 'board' ? 'board:' : '') + s.h + '.' + (s.v || 0); }
  function redraw() {
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, opts.width, opts.height);
    if (mode === 'board') { ctx.fillStyle = opts.dark ? '#1e2a24' : '#f7f7f2'; ctx.fillRect(0, 0, opts.width, opts.height); }
    (strokes[key()] || []).forEach(draw);
  }
  function draw(s) {
    ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    s.p.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    if (s.p.length === 1) ctx.lineTo(s.p[0][0] + 0.1, s.p[0][1]);
    ctx.stroke();
  }
  function send(msg) { if (window.parent !== window) window.parent.postMessage(JSON.stringify(Object.assign({ namespace: 'ide-board' }, msg)), '*'); }
  function setMode(m, quiet) {
    mode = m;
    document.body.classList.toggle('ide-drawing', !!m);
    canvas.classList.toggle('active', !!m);
    toolbar.hidden = !m;
    redraw();
    if (!quiet) send({ op: 'mode', mode: m });
  }
  function point(e) {
    var r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * opts.width / r.width, (e.clientY - r.top) * opts.height / r.height];
  }
  function begin(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = { c: color, w: e.pointerType === 'pen' ? 2 + 3 * (e.pressure || 0.5) : 3, p: [point(e)] };
    draw(drawing);
  }
  canvas.addEventListener('pointerdown', function (e) { if (mode) begin(e); });
  canvas.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    drawing.p.push(point(e));
    redraw(); draw(drawing);
  });
  function end() {
    if (!drawing) return;
    var k = key();
    (strokes[k] = strokes[k] || []).push(drawing);
    send({ op: 'stroke', key: k, stroke: drawing });
    drawing = null;
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // Pencil on a slide that isn't in draw mode: catch it at the slide level.
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'pen' && !mode && !e.target.closest('.ide-board-tools, .controls, a, button')) {
      setMode('slide');
      e.stopPropagation();
      begin(e);
    }
  }, true);
  function clear(quiet) { var k = key(); delete strokes[k]; redraw(); if (!quiet) send({ op: 'clear', key: k }); }

  var toolbar = document.createElement('div');
  toolbar.className = 'ide-board-tools';
  toolbar.hidden = true;
  toolbar.innerHTML = COLORS.map(function (c) { return '<button class="swatch" data-c="' + c + '" style="background:' + c + '" aria-label="Pen colour"></button>'; }).join('') +
    '<button data-act="clear" title="Clear (Delete)">Clear</button><button data-act="board" title="Blank board (B)">Board</button><button data-act="close" title="Stop drawing (Esc)">Done</button>';
  document.querySelector('.reveal').appendChild(toolbar);
  toolbar.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.c) { color = b.dataset.c; Array.prototype.forEach.call(toolbar.querySelectorAll('.swatch'), function (s) { s.classList.toggle('on', s === b); }); }
    else if (b.dataset.act === 'clear') clear();
    else if (b.dataset.act === 'board') setMode(mode === 'board' ? 'slide' : 'board');
    else setMode(null);
  });
  toolbar.querySelector('.swatch').classList.add('on');

  if (opts.enabled) {
    var pen = document.createElement('button');
    pen.className = 'ide-board-toggle';
    pen.title = 'Draw on slides (C) · blank board (B)';
    pen.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    pen.addEventListener('click', function () { setMode(mode ? null : 'slide'); });
    document.querySelector('.reveal').appendChild(pen);
  }
  Reveal.addKeyBinding({ keyCode: 67, key: 'C', description: 'Draw on the slide' }, function () { setMode(mode === 'slide' ? null : 'slide'); });
  Reveal.addKeyBinding({ keyCode: 66, key: 'B', description: 'Blank board' }, function () { setMode(mode === 'board' ? null : 'board'); });
  document.addEventListener('keydown', function (e) {
    if (!mode) return;
    if (e.key === 'Escape') { setMode(null); e.stopPropagation(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { clear(); e.preventDefault(); }
  }, true);
  Reveal.on('slidechanged', function () { drawing = null; redraw(); });
  window.addEventListener('message', function (e) {
    if (typeof e.data !== 'string' || e.data.indexOf('"ide-board"') < 0) return;
    var m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.namespace !== 'ide-board') return;
    if (m.op === 'stroke') { (strokes[m.key] = strokes[m.key] || []).push(m.stroke); redraw(); }
    else if (m.op === 'clear') { delete strokes[m.key]; redraw(); }
    else if (m.op === 'mode') setMode(m.mode, true);
  });
})();
`;

const SLIDE_CSS = `
.reveal .slides section { height: 100%; }
.reveal .slides section.title-slide.center, .reveal .slides section.quarto-title-block { display: flex !important; flex-direction: column; justify-content: center; }
.reveal .slides > section.stack { display: block; }
.reveal .quarto-title-authors { display: flex; justify-content: center; gap: 0.5em 2em; flex-wrap: wrap; }
.reveal .quarto-title-author-name { font-size: 0.85em; }
.reveal #title-slide .date { font-size: 0.7em; opacity: 0.75; }
.reveal .slides section.scrollable { overflow-y: auto !important; overflow-x: hidden; }
.reveal .columns { display: flex; }
.reveal .column { flex: 1; min-width: 0; }
.reveal aside.notes { display: none; }
.reveal img, .reveal video { max-width: 100%; }
.reveal figure { margin: 0.3em 0; text-align: center; }
.reveal figure img { width: auto !important; max-height: 500px; }
.reveal figcaption, .reveal .table-caption { font-size: 0.55em; opacity: 0.75; }
.reveal .xref-label { font-weight: 600; }
.reveal div.cell-output pre { margin-top: 0.2em; }
.reveal .tabset-nav { display: flex; gap: 2px; border-bottom: 1px solid currentColor; font-size: 0.6em; }
.reveal .tabset-nav button { font: inherit; color: inherit; opacity: 0.6; padding: 0.3em 0.8em; border: 0; background: none; cursor: pointer; }
.reveal .tabset-nav button.active { opacity: 1; font-weight: 600; }
.reveal details.code-fold > summary { font-size: 0.55em; opacity: 0.7; cursor: pointer; }
.reveal math[display="block"] { margin: 0.5em 0; }
.reveal .footer { position: absolute; bottom: 12px; left: 0; right: 0; text-align: center; font-size: 18px; pointer-events: none; z-index: 10; }
.reveal .slide-logo { position: absolute; bottom: 8px; right: 12px; max-height: 44px; max-width: 160px; z-index: 10; }
.reveal .html-widget { max-width: 100%; }
.ide-board { position: absolute; left: 0; top: 0; z-index: 30; pointer-events: none; touch-action: none; }
.ide-board.active { pointer-events: auto; cursor: crosshair; }
.ide-board-tools { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 40; display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-radius: 10px; background: rgba(30, 34, 40, 0.85); font: 14px -apple-system, BlinkMacSystemFont, sans-serif; }
.ide-board-tools[hidden] { display: none; }
.ide-board-tools button { border: 0; border-radius: 6px; padding: 6px 10px; background: rgba(255, 255, 255, 0.12); color: #fff; font: inherit; cursor: pointer; }
.ide-board-tools .swatch { width: 26px; height: 26px; padding: 0; border-radius: 50%; border: 2px solid transparent; }
.ide-board-tools .swatch.on { border-color: #fff; }
.ide-board-toggle { position: absolute; left: 12px; bottom: 12px; z-index: 35; width: 40px; height: 40px; border: 0; border-radius: 50%; background: rgba(127, 127, 127, 0.18); color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
body.ide-drawing .reveal .controls { opacity: 0.3; }
`;
