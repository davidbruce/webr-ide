import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import solid from 'vite-plugin-solid';
import { VitePWA } from 'vite-plugin-pwa';

// webR uses SharedArrayBuffer (for interrupts and blocking input) when the
// page is cross-origin isolated. These headers enable that in dev/preview;
// in production the service worker adds them when the host can't.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  // WebKit also wants this on worker scripts started from inside other workers.
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---------------------------------------------------------------------------
// Self-host the webR runtime (R.wasm, worker, base-library images) from
// /webr/<version>/ so the service worker can cache it for offline use.
const WEBR_DIST = path.resolve('node_modules/webr/dist');
const WEBR_VERSION: string = JSON.parse(fs.readFileSync('node_modules/webr/package.json', 'utf8')).version;
const WEBR_PREFIX = `webr/${WEBR_VERSION}/`;
const WEBR_FILES = ['R.js', 'R.wasm', 'webr-worker.js', 'libRblas.so', 'libRlapack.so'];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** Filesystem images (`<path>.data.gz` + `.js.metadata`) and loose files in webR's vfs. */
function vfsManifest() {
  const root = path.join(WEBR_DIST, 'vfs');
  const files = walk(root).map((f) => '/' + path.relative(root, f).split(path.sep).join('/'));
  const images = files.filter((f) => f.endsWith('.js.metadata')).map((f) => f.slice(0, -'.js.metadata'.length));
  const loose = files.filter((f) => !f.endsWith('.js.metadata') && !/\.data(\.gz)?$/.test(f));
  return { version: WEBR_VERSION, images, files: loose };
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
  '.ttf': 'font/ttf', '.pem': 'text/plain', '.conf': 'text/plain',
};

function webrRuntime(): Plugin {
  return {
    name: 'webr-runtime',
    configureServer(server) {
      // Vite's `server.headers` aren't applied to 304 Not Modified responses,
      // and WebKit then blocks revalidated worker scripts under COEP.
      server.middlewares.use((_req, res, next) => {
        Object.entries(crossOriginIsolation).forEach(([k, v]) => res.setHeader(k, v));
        next();
      });
      // Development service worker (workspace drive only), bundled on request.
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/dev-sw.js') return next();
        try {
          const out = await esbuild({ entryPoints: ['src/sw-dev.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Service-Worker-Allowed', '/');
          res.end(out.outputFiles[0].text);
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const prefix = '/' + WEBR_PREFIX;
        if (!url.startsWith(prefix)) return next();
        const rel = decodeURIComponent(url.slice(prefix.length));
        Object.entries(crossOriginIsolation).forEach(([k, v]) => res.setHeader(k, v));
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (rel === 'vfs-manifest.json') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(vfsManifest()));
        }
        const file = path.join(WEBR_DIST, rel);
        if (!file.startsWith(WEBR_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const f of WEBR_FILES) {
        this.emitFile({ type: 'asset', fileName: WEBR_PREFIX + f, source: fs.readFileSync(path.join(WEBR_DIST, f)) });
      }
      for (const f of walk(path.join(WEBR_DIST, 'vfs'))) {
        const rel = path.relative(WEBR_DIST, f).split(path.sep).join('/');
        this.emitFile({ type: 'asset', fileName: WEBR_PREFIX + rel, source: fs.readFileSync(f) });
      }
      this.emitFile({ type: 'asset', fileName: WEBR_PREFIX + 'vfs-manifest.json', source: JSON.stringify(vfsManifest()) });
    },
  };
}

export default defineConfig({
  // Relative base so the same build works at a domain root or under a subpath
  // (e.g. GitHub Pages project sites at https://<user>.github.io/<repo>/).
  base: './',
  define: { __WEBR_PREFIX__: JSON.stringify(WEBR_PREFIX) },
  plugins: [
    solid(),
    webrRuntime(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'webR IDE',
        short_name: 'webR IDE',
        description: 'An RStudio-style R environment that runs entirely in your browser.',
        theme_color: '#2b5b84',
        background_color: '#f3f4f6',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ttf,woff2,wasm}'],
        // The webR runtime (~50 MB) is cached at runtime instead of on install.
        globIgnores: ['webr/**'],
        maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
