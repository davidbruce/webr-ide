import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { TopBar } from './components/TopBar';
import { PhoneTabs, Workbench } from './components/Workbench';
import { Modals } from './components/Modals';
import { PresenterView } from './components/Presenter';
import { StorageBanner, StorageInfo } from './components/StorageInfo';
import { Shortcuts } from './components/Shortcuts';
import { StartupCard } from './components/StartupCard';
import { UpdateBanner } from './components/UpdateBanner';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { RenvDialog } from './components/RenvDialog';
import { openSettings } from './lib/settings';
import { PackageBrowser } from './components/PackageBrowser';
import { consoleApi } from './components/Console';
import { editor, initWorkspaces, openWorkspaceUI, setState, startR, state, restartR, debugCommand } from './lib/ide';
import { initStorage, requestPersistence } from './lib/opfs';
import { isDark, toast } from './lib/ui';

export function App() {
  const [fatal, setFatal] = createSignal<string | null>(null);

  createEffect(() => {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // Browser / status bar colour: the top bar's.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1d22' : '#eef1f5');
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

  // Debugger keys (RStudio's), wherever focus is, while R is paused.
  const onDebugKey = (e: KeyboardEvent) => {
    if (!state.debug) return;
    const cmd =
      e.key === 'F10' && !e.shiftKey
        ? 'next'
        : e.shiftKey && e.key === 'F4'
          ? 'step'
          : e.shiftKey && e.key === 'F6'
            ? 'finish'
            : e.shiftKey && e.key === 'F5'
              ? 'continue'
              : e.shiftKey && e.key === 'F8'
                ? 'stop'
                : null;
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    debugCommand(cmd);
  };
  window.addEventListener('keydown', onDebugKey, true);
  onCleanup(() => window.removeEventListener('keydown', onDebugKey, true));

  // Global shortcuts (Monaco handles its own when focused).
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void editor()?.saveActive();
    } else if (mod && e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      editor()?.newFile();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      openSettings();
    } else if (e.ctrlKey && e.key === '2') {
      e.preventDefault();
      consoleApi?.focus();
    } else if (mod && e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      void restartR();
    } else if (e.key === 'Escape') {
      // A menu is open: Esc closes it (the topmost), as clicking outside does.
      const menus = document.querySelectorAll<HTMLElement>('.menu-backdrop');
      if (menus.length) {
        e.preventDefault();
        menus[menus.length - 1].click();
      } else if (state.zoomed && !document.querySelector('.modal-backdrop, .palette-backdrop')) {
        setState('zoomed', null);
      }
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

  const onRejection = (e: PromiseRejectionEvent) => {
    console.error(e.reason);
    toast(String(e.reason?.message ?? e.reason), 'error');
  };
  window.addEventListener('unhandledrejection', onRejection);
  onCleanup(() => window.removeEventListener('unhandledrejection', onRejection));

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
        <Shortcuts />
        <PresenterView />
        <StorageInfo />
        <StorageBanner />
        <PackageBrowser />
        <StartupCard />
        <UpdateBanner />
        <SettingsDialog />
        <CommandPalette />
        <RenvDialog />
      </div>
    </Show>
  );
}
