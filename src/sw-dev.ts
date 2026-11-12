/// <reference lib="webworker" />
// Development service worker: only serves the workspace drive (the dev server
// already sends isolation headers, and nothing is cached). Bundled on the fly
// by vite.config.ts and served at /dev-sw.js.
import { handleDriveFetch } from './lib/drive/server';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  handleDriveFetch(e);
});
