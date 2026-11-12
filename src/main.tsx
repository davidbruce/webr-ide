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
  registerSW({ immediate: true });

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
  void import('./lib/ide').then(({ session }) => ((window as any).__webrIde = { session }));
}
render(() => <App />, document.getElementById('root')!);
