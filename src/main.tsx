import { render } from 'solid-js/web';
import './styles.css';
import { App } from './App';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) {
    // Dev: a small worker that only serves the workspace drive to webR.
    await navigator.serviceWorker.register('/dev-sw.js', { scope: '/' }).catch((e) => console.warn('dev service worker', e));
    return;
  }
  const { registerSW } = await import('virtual:pwa-register');
  const { setUpdateReady } = await import('./lib/app-update');
  const update = registerSW({
    immediate: true,
    // A new version is installed and waiting: offer to reload into it.
    onNeedRefresh: () =>
      setUpdateReady(async () => {
        // Reload once the new version has taken over (or after 3 s regardless).
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        setTimeout(() => location.reload(), 3000);
        await update(true);
      }),
    // Look for a new version every hour while the app stays open.
    onRegisteredSW: (_url, reg) => reg && setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000),
  });

  // The service worker adds the COOP/COEP headers webR needs for
  // SharedArrayBuffer. If this page load wasn't controlled by it yet (first
  // visit), reload once it takes control so R gets interrupt support.
  if (!crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
    navigator.serviceWorker.ready.then(() => {
      const reload = () => {
        if (!crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
          sessionStorage.setItem('coi-reloaded', '1');
          location.reload();
        }
      };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    });
  }
}

void registerServiceWorker();

// Dev-only handle for debugging and automated tests.
if (import.meta.env.DEV) {
  void import('./lib/ide').then((ide) => ((window as any).__webrIde = { session: ide.session, editor: ide.editor, ide }));
}
render(() => <App />, document.getElementById('root')!);
