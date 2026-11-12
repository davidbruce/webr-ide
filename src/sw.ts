/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL, addPlugins } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { clientsClaim } from 'workbox-core';
import { handleDriveFetch } from './lib/drive/server';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: any };

// Workspace drive for webR (R reads/writes OPFS directly). Registered before
// Workbox's routes so its requests are answered here first.
self.addEventListener('fetch', (e) => {
  handleDriveFetch(e);
});

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

/** Add cross-origin isolation headers so webR can use SharedArrayBuffer on any static host. */
function isolate(res: Response): Response {
  if (res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Every precached app file (HTML, JS, workers) is served with isolation headers.
addPlugins([{ handlerWillRespond: async ({ response }) => isolate(response) }]);
precacheAndRoute(self.__WB_MANIFEST);

// App shell for navigations (offline-capable).
const shell = createHandlerBoundToURL('index.html');
registerRoute(new NavigationRoute(async (opts) => isolate(await shell(opts))));

// Self-hosted webR runtime (R.wasm, worker, base-library images) under
// /webr/<version>/: versioned paths, so cache-first is safe and lets R start
// offline after the first run. Responses get isolation headers too.
const webrRuntime = new CacheFirst({
  cacheName: 'webr-runtime-self',
  plugins: [
    new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    { cacheWillUpdate: async ({ response }) => (response.ok ? response : null) },
  ],
});
registerRoute(
  ({ url }) => url.origin === self.location.origin && /\/webr\/[^/]+\//.test(url.pathname),
  async (opts) => isolate(await webrRuntime.handle(opts)),
);

// Old CDN-hosted runtime caches from earlier versions of the app.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('webr-runtime'));
});

// Package repository index: network-first so update checks see new versions,
// with the cached copy as an offline fallback. Package .tgz files are not cached
// here; the IDE stores them (versioned) in OPFS instead.
registerRoute(
  ({ url }) => url.hostname === 'repo.r-wasm.org' && !url.pathname.endsWith('.tgz'),
  new NetworkFirst({
    cacheName: 'webr-repo-index',
    networkTimeoutSeconds: 6,
    plugins: [new ExpirationPlugin({ maxEntries: 50 })],
  }),
);
