// Help pane: R help pages as HTML (see r-help.ts), with back/forward history
// and links between pages, package indexes, examples and vignettes.
import { batch, createSignal } from 'solid-js';
import { session, setState, showPane } from './ide';
import { rString } from './r-session';
import { toast } from './ui';

export type HelpPage =
  | { kind: 'html'; title: string; html: string; pkg: string; topic: string; scroll?: number }
  | { kind: 'text'; title: string; text: string; scroll?: number }
  | { kind: 'doc'; title: string; html: string; pkg: string; scroll?: number };

const MAX_HISTORY = 50;
const [page, setPage] = createSignal<HelpPage | null>(null);
const [back, setBack] = createSignal<HelpPage[]>([]);
const [forward, setForward] = createSignal<HelpPage[]>([]);
export { page as helpPage };
export const canGoBack = () => back().length > 0;
export const canGoForward = () => forward().length > 0;

/** The help pane's scroll position, saved with the page when leaving it. */
let scrollOf: () => number = () => 0;
export function trackHelpScroll(fn: () => number) {
  scrollOf = fn;
}

function show(next: HelpPage) {
  const cur = page();
  batch(() => {
    if (cur) setBack((b) => [...b.slice(-(MAX_HISTORY - 1)), { ...cur, scroll: scrollOf() }]);
    setForward([]);
    setPage(next);
    setState('plotTab', 'help');
  });
  showPane('plots');
}

export function helpBack() {
  const b = back();
  const cur = page();
  if (!b.length) return;
  batch(() => {
    if (cur) setForward((f) => [{ ...cur, scroll: scrollOf() }, ...f]);
    setBack(b.slice(0, -1));
    setPage(b[b.length - 1]);
  });
}

export function helpForward() {
  const [next, ...rest] = forward();
  const cur = page();
  if (!next) return;
  batch(() => {
    if (cur) setBack((b) => [...b, { ...cur, scroll: scrollOf() }]);
    setForward(rest);
    setPage(next);
  });
}

function ready(): boolean {
  if (session.status === 'ready') return true;
  toast('R is still starting…', 'warn');
  return false;
}

async function fetchPage(code: string): Promise<void> {
  if (!ready()) return;
  try {
    const [title, html, pkg, topic] = await session.strings(code);
    if (html === undefined) return;
    show({ kind: 'html', title, html, pkg, topic });
  } catch (e) {
    toast(`Help failed: ${e instanceof Error ? e.message : e}`, 'error');
  }
}

/** Help for a topic (optionally in a given package), in the Help pane. */
export function openHelp(topic: string, pkg = ''): Promise<void> {
  return fetchPage(`.ide_help_html(${rString(topic)}, ${rString(pkg)})`);
}

/** A package's description, vignettes and help pages. */
export function openHelpIndex(pkg: string): Promise<void> {
  return fetchPage(`.ide_help_index(${rString(pkg)})`);
}

/** A vignette or other document from a package's doc folder. */
export async function openHelpFile(path: string, title = path.split('/').pop() ?? path): Promise<void> {
  if (!ready()) return;
  let bytes: Uint8Array;
  try {
    bytes = await session.readFile(path);
  } catch {
    return toast(`Can't read ${path}`, 'error');
  }
  if (/\.pdf$/i.test(path)) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const w = window.open(url, '_blank');
    if (!w) toast('Allow pop-ups to open PDF documents', 'warn');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const html = new TextDecoder().decode(bytes);
  const pkg = path.match(/\/([^/]+)\/doc\/[^/]+$/)?.[1] ?? '';
  if (/\.html?$/i.test(path)) show({ kind: 'doc', title, html: await prepareDoc(html), pkg });
  else show({ kind: 'text', title, text: html });
}

/**
 * A vignette's HTML, ready for the sandboxed frame: MathJax (from a CDN, which
 * the app's cross-origin isolation blocks) is removed and its maths typeset
 * with the bundled KaTeX instead.
 */
async function prepareDoc(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scripts = [...doc.querySelectorAll('script')].filter((s) => /mathjax/i.test(s.src) || /MathJax/.test(s.textContent ?? ''));
  if (!scripts.length) return html;
  scripts.forEach((s) => s.remove());
  const { maths } = await import('./render');
  await maths(doc.body);
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

/** Run a help page's examples in the console. */
export function runExamples(topic: string, pkg: string) {
  session.submit(`example(${rString(topic)}${pkg ? `, package = ${rString(pkg)}` : ''})`);
}

/** Follow a link in a help page. Returns false for links the browser should handle. */
export function followHelpLink(href: string, from: HelpPage | null): boolean {
  const pkgHere = from?.kind === 'html' ? from.pkg : '';
  if (href.startsWith('ide-file:')) {
    void openHelpFile(decodeURIComponent(href.slice('ide-file:'.length)));
    return true;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    window.open(href, '_blank', 'noopener');
    return true;
  }
  let m = href.match(/^(?:\.\.\/\.\.\/([^/]+)\/|\.\.\/)?help\/([^#?]+)/);
  if (m) {
    void openHelp(decodeURIComponent(m[2]), m[1] ? decodeURIComponent(m[1]) : pkgHere);
    return true;
  }
  m = href.match(/^\.\.\/Example\/([^#?]+)/);
  if (m) {
    runExamples(decodeURIComponent(m[1]), pkgHere);
    return true;
  }
  // Package index, DESCRIPTION, doc folder: all go to the package's index page.
  m = href.match(/^(?:\.\.\/\.\.\/([^/]+)\/)?(?:html\/|doc\/|\.\.\/)?(00Index\.html|DESCRIPTION|index\.html)/);
  if (m) {
    const pkg = m[1] ? decodeURIComponent(m[1]) : pkgHere;
    if (pkg) void openHelpIndex(pkg);
    return true;
  }
  if (href.startsWith('#')) return false;
  toast("That link isn't available here", 'warn');
  return true;
}

// Pages R sends itself (?topic, help(package = ), vignette(), file.show()).
session.on((ev) => {
  if (ev.type === 'help') show({ kind: 'html', ...ev.page });
  else if (ev.type === 'helpFile') void openHelpFile(ev.path, ev.title);
  else if (ev.type === 'pager') show({ kind: 'text', title: ev.title, text: ev.text });
});
