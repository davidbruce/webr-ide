// Turn HTML produced in R (widgets, rendered documents) plus its htmltools
// dependencies into a self-contained page: scripts and stylesheets are read
// from R's file system and inlined, as are the images/fonts CSS refers to.
// Such pages work offline and inside a sandboxed iframe.

import { session } from './ide';

export interface Manifest {
  body: string;
  head: string;
  height: number | null;
  /** Dependencies in load order. */
  deps: { kind: 'js' | 'css' | 'jsurl' | 'cssurl' | 'head'; value: string }[];
}

export function parseManifest(text: string): Manifest {
  const m: Manifest = { body: '', head: '', height: null, deps: [] };
  if (!text) return m;
  for (const rec of text.split('\x1e')) {
    const i = rec.indexOf('\x1f');
    if (i < 0) continue;
    const key = rec.slice(0, i);
    const value = rec.slice(i + 1);
    if (key === 'body') m.body = value;
    else if (key === 'height') m.height = Number(value) > 0 ? Number(value) : null;
    else if (key === 'head') {
      if (m.deps.length) m.deps.push({ kind: 'head', value });
      else m.head = value;
    } else if (key === 'js' || key === 'css' || key === 'jsurl' || key === 'cssurl') m.deps.push({ kind: key, value });
  }
  return m;
}

const files = new Map<string, Promise<Uint8Array | null>>();
/** Read a file from R's file system (cached: package files don't change). */
export function readR(path: string): Promise<Uint8Array | null> {
  let p = files.get(path);
  if (!p) {
    p = session.webR.FS.readFile(path).catch(() => null) as Promise<Uint8Array | null>;
    files.set(path, p);
    void p.then((b) => b === null && files.delete(path));
  }
  return p;
}

export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', css: 'text/css',
};

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function resolve(dir: string, rel: string): string {
  const parts = dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function inlineCss(css: string, path: string): Promise<string> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const refs = new Map<string, string>();
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const ref = m[2].trim();
    if (/^(data:|https?:|\/\/|#|about:)/i.test(ref)) continue;
    const clean = ref.split(/[?#]/)[0];
    if (refs.has(ref)) continue;
    const bytes = await readR(resolve(dir, clean));
    const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
    if (bytes) refs.set(ref, `data:${MIME[ext] ?? 'application/octet-stream'};base64,${base64(bytes)}`);
  }
  if (!refs.size) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, _q, ref) => (refs.has(ref.trim()) ? `url("${refs.get(ref.trim())}")` : all));
}

export const escapeScript = (js: string) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const decoder = new TextDecoder();

/** The dependencies as inline <script>/<style> tags, in order. */
export async function inlineDeps(m: Manifest): Promise<string> {
  const out: string[] = [];
  for (const d of m.deps) {
    if (d.kind === 'head') out.push(d.value);
    else if (d.kind === 'jsurl') out.push(`<script src="${d.value}"></script>`);
    else if (d.kind === 'cssurl') out.push(`<link rel="stylesheet" href="${d.value}">`);
    else {
      const bytes = await readR(d.value);
      if (!bytes) {
        console.warn('missing dependency file', d.value);
        continue;
      }
      const text = decoder.decode(bytes);
      if (d.kind === 'js') out.push(`<script>${escapeScript(text)}</script>`);
      else out.push(`<style>${(await inlineCss(text, d.value)).replace(/<\/style/gi, '<\\/style')}</style>`);
    }
  }
  return out.join('\n');
}

/**
 * The IDE is cross-origin isolated (webR needs it), and so are these pages:
 * images from other sites only load as CORS requests. Map tiles (OpenStreetMap
 * etc.) allow that, so ask Leaflet for CORS tiles and switch any other external
 * images to CORS mode as they appear.
 */
export const CORS_IMAGES = `<script>
(function () {
  function fix(img) {
    if (img.crossOrigin == null && /^https?:/i.test(img.getAttribute('src') || '')) {
      img.crossOrigin = 'anonymous';
      if (img.src) img.src = img.src;
    }
  }
  if (window.L && L.TileLayer) L.TileLayer.mergeOptions({ crossOrigin: 'anonymous' });
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      r.addedNodes.forEach(function (n) {
        if (n.tagName === 'IMG') fix(n);
        else if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('img'), fix);
      });
      if (r.type === 'attributes' && r.target.tagName === 'IMG') fix(r.target);
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
})();
</script>`;

/** A complete page showing one widget, filling the frame. */
export async function widgetPage(m: Manifest): Promise<string> {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;height:100%;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px}body>:not(script){max-width:100%}</style>
${m.head}
${await inlineDeps(m)}
${CORS_IMAGES}
</head><body>${m.body}</body></html>`;
}
