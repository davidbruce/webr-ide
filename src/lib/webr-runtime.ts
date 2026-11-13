// Self-hosted webR runtime + base library.
//
// webR's default "lazy" filesystem fetches parts of the base library
// (help pages, translations, the tz database, the `parallel` package, …) on
// first use with synchronous XHRs from its worker. Service workers can't
// answer those, so R couldn't start offline. Instead we run webR without the
// lazy filesystem and mount every base-library image ourselves at startup,
// using ordinary async fetches that the service worker caches.

import type { WebR } from 'webr';
import { setBoot, bootProgress } from './boot';

/** URL of the self-hosted runtime, e.g. https://host/app/webr/0.6.1/ */
export const WEBR_BASE_URL = new URL(__WEBR_PREFIX__, document.baseURI).href;

interface VfsManifest {
  version: string;
  images: string[]; // e.g. /usr/lib/R/library/parallel  (→ .data.gz + .js.metadata)
  files: string[]; // loose files, e.g. /etc/ssl/cert.pem
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

/**
 * Decompress a `.data.gz` image. Some hosts serve `.gz` files with
 * `Content-Encoding: gzip`, in which case the browser has already
 * decompressed them — so only gunzip data that still starts with the gzip
 * magic bytes.
 */
async function gunzip(res: Response): Promise<ArrayBuffer> {
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/** Run async jobs with bounded concurrency. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Mount webR's base-library images and copy loose files into its filesystem. */
export async function mountBaseLibrary(webR: WebR): Promise<{ mounted: number; failed: string[] }> {
  const manifest: VfsManifest = await (await fetchOk(`${WEBR_BASE_URL}vfs-manifest.json`)).json();
  const vfs = `${WEBR_BASE_URL}vfs`;
  const failed: string[] = [];
  // Loose files inside an image's mountpoint are already in the image (and the
  // mount is read-only), so skip them.
  manifest.files = manifest.files.filter((f) => !manifest.images.some((p) => f.startsWith(p + '/')));

  const dirs = new Set<string>();
  for (const p of manifest.images) dirs.add(p);
  for (const f of manifest.files) dirs.add(f.slice(0, f.lastIndexOf('/')) || '/');
  await mkdirs(webR, [...dirs]);

  // Download + decompress in parallel; mounts go through the worker one at a time.
  setBoot({ label: "Loading R's base library", done: 0, total: manifest.images.length });
  let fetched = 0;
  const images = await pool(manifest.images, 6, async (p) => {
    try {
      const [metaRes, dataRes] = await Promise.all([fetchOk(`${vfs}${p}.js.metadata`), fetchOk(`${vfs}${p}.data.gz`)]);
      const metadata = await metaRes.json();
      const data = await gunzip(dataRes);
      bootProgress(++fetched, manifest.images.length);
      return { p, metadata, data };
    } catch (e) {
      console.warn('base library image failed:', p, e);
      failed.push(p);
      return null;
    }
  });
  let mounted = 0;
  for (const img of images) {
    if (!img) continue;
    try {
      // The data is already decompressed here.
      const metadata = { ...img.metadata, gzip: false };
      await webR.FS.mount('WORKERFS', { packages: [{ blob: new Blob([img.data]), metadata }] } as any, img.p);
      mounted++;
    } catch (e) {
      console.warn('mount failed:', img.p, e);
      failed.push(img.p);
    }
  }

  await pool(manifest.files, 6, async (f) => {
    try {
      const data = new Uint8Array(await (await fetchOk(`${vfs}${f}`)).arrayBuffer());
      await webR.FS.writeFile(f, data);
    } catch (e) {
      console.warn('base file failed:', f, e);
      failed.push(f);
    }
  });
  return { mounted, failed };
}

async function mkdirs(webR: WebR, dirs: string[]) {
  const made = new Set<string>();
  for (const d of dirs.sort()) {
    let cur = '';
    for (const seg of d.split('/').filter(Boolean)) {
      cur += '/' + seg;
      if (made.has(cur)) continue;
      made.add(cur);
      try {
        await webR.FS.mkdir(cur);
      } catch {
        /* exists */
      }
    }
  }
}
