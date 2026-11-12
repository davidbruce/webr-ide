import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { TopBar } from './components/TopBar';
import { PhoneTabs, Workbench } from './components/Workbench';
import { Modals } from './components/Modals';
import { PresenterView } from './components/Presenter';
import { StorageBanner, StorageInfo } from './components/StorageInfo';
import { PackageBrowser } from './components/PackageBrowser';
import { consoleApi } from './components/Console';
import { editor, initWorkspaces, openWorkspaceUI, setState, startR, state, restartR } from './lib/ide';
import { initStorage, requestPersistence } from './lib/opfs';
import { isDark, toast } from './lib/ui';

export function App() {
  const [fatal, setFatal] = createSignal<string | null>(null);

  createEffect(() => {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1d22' : '#e8ecf1');
  });

  onMount(async () => {
    // A failure shows a lasting banner (StorageBanner) with the reason.
    if ((await initStorage()) === 'opfs') void requestPersistence();
    try {
      const ws = await initWorkspaces();
      await openWorkspaceUI(ws);
    } catch (e) {
      setFatal(`Could not open browser storage: ${e}`);
      return;
    }
    await startR();
  });

  // Global shortcuts (Monaco handles its own when focused).
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void editor()?.saveActive();
    } else if (mod && e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      editor()?.newFile();
    } else if (e.ctrlKey && e.key === '2') {
      e.preventDefault();
      consoleApi?.focus();
    } else if (mod && e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      void restartR();
    } else if (e.key === 'Escape' && state.zoomed && !document.querySelector('.modal-backdrop, .menu-backdrop')) {
      setState('zoomed', null);
    }
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // iPad: shrink the app to the visual viewport so the on-screen keyboard
  // doesn't cover the console.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
      // On-screen keyboard up: the phone tab bar steps aside to save space.
      document.documentElement.classList.toggle('keyboard-open', window.innerHeight - vv.height > 120);
      if (vv.offsetTop) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
    onCleanup(() => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
    });
  }

  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    toast(String(e.reason?.message ?? e.reason), 'error');
  });

  return (
    <Show
      when={!fatal()}
      fallback={
        <div class="fatal">
          <h1>webR IDE can't start</h1>
          <p>{fatal()}</p>
        </div>
      }
    >
      <div class="app">
        <TopBar />
        <Workbench />
        <PhoneTabs />
        <Modals />
        <PresenterView />
        <StorageInfo />
        <StorageBanner />
        <PackageBrowser />
      </div>
    </Show>
  );
}
