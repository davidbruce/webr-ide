import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  state,
  setState,
  editor,
  isInstalling,
  switchWorkspace,
  createWorkspace,
  renameCurrentWorkspace,
  deleteWorkspace,
  saveEnvironmentImage,
  session,
} from '../lib/ide';
import * as fs from '../lib/opfs';
import { askText, confirmDialog, formatBytes, isDark, kbd, setThemePref, themePref, toast } from '../lib/ui';
import { Icon } from './Icon';
import { openStorageInfo } from './StorageInfo';
import { openShortcuts } from './Shortcuts';
import { openSettings } from '../lib/settings';
import { exportWorkspace, pickWorkspaceZip } from '../lib/workspace-zip';
import { resetLayout } from './Workbench';
import { EXAMPLES, EXAMPLE_GROUPS, Example } from '../lib/examples';
import { openPackageBrowser } from '../lib/pkg-actions';

const QUARTO_TEMPLATE = `---
title: "Untitled"
format: html
---

## Quarto

Run a chunk with the ▶ button on its first line, or press ⌘⇧↩ (Ctrl+Shift+Enter on Windows/Linux) inside it.

\`\`\`{r}
summary(cars)
\`\`\`

\`\`\`{r}
#| label: fig-cars
plot(cars)
\`\`\`
`;

const SLIDES_TEMPLATE = `---
title: "Untitled Presentation"
author: "Your Name"
format:
  revealjs:
    slide-number: true
---

## Hello

- Each \`##\` heading starts a new slide
- Press **Render** to build the slides, then **Present**

::: {.notes}
Speaker notes go here; they aren't shown on the slide.
:::

## A plot

\`\`\`{r}
#| echo: false
plot(cars)
\`\`\`

## Two columns {.smaller}

:::: {.columns}
::: {.column width="50%"}
\`\`\`{r}
summary(cars)
\`\`\`
:::
::: {.column width="50%"}
::: {.incremental}
- Points appear
- one at a time
:::
:::
::::
`;

export function TopBar() {
  const [wsMenu, setWsMenu] = createSignal(false);
  const [newMenu, setNewMenu] = createSignal(false);
  const [exMenu, setExMenu] = createSignal(false);
  let exBtn!: HTMLButtonElement;

  function openExample(ex: Example) {
    setExMenu(false);
    const slug = ex.pkg.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    editor()?.newFile(`${slug}-example.R`, ex.code);
  }
  const statusLabel_ = { works: 'Works', partial: 'Partly works', unsupported: 'Not in browser' } as const;
  const [storage, setStorage] = createSignal('');
  let wsBtn!: HTMLButtonElement;
  let newBtn!: HTMLButtonElement;

  async function openWsMenu() {
    setWsMenu(true);
    const est = await fs.storageEstimate();
    const persisted = await navigator.storage.persisted?.().catch(() => false);
    setStorage(est ? `${formatBytes(est.usage)} used of ${formatBytes(est.quota)}${persisted ? ' · persistent' : ''}` : '');
  }

  async function newWorkspace() {
    setWsMenu(false);
    const name = await askText('New Workspace', '', { okLabel: 'Create', message: 'Workspaces keep their own files, history and saved environment.' });
    if (!name) return;
    if (!fs.validName(name)) return toast('Use letters, numbers, spaces, dots, dashes or underscores', 'error');
    if (state.workspaces.includes(name)) return toast(`Workspace "${name}" already exists`, 'error');
    await createWorkspace(name);
  }

  async function renameWorkspace() {
    setWsMenu(false);
    const name = await askText('Rename Workspace', state.workspace, { okLabel: 'Rename' });
    if (!name || name === state.workspace) return;
    if (!fs.validName(name)) return toast('Invalid workspace name', 'error');
    if (state.workspaces.includes(name)) return toast(`Workspace "${name}" already exists`, 'error');
    try {
      await renameCurrentWorkspace(name);
    } catch (e) {
      toast(`Rename failed: ${e}`, 'error');
    }
  }

  async function removeWorkspace() {
    setWsMenu(false);
    const name = state.workspace;
    if (
      await confirmDialog('Delete Workspace', `Permanently delete the workspace "${name}" and all of its files? This cannot be undone.`, {
        okLabel: 'Delete',
        danger: true,
      })
    ) {
      await deleteWorkspace(name);
      toast(`Deleted workspace "${name}"`);
    }
  }

  const statusLabel = () => {
    if (state.switching) return 'Switching…';
    if (state.attaching) return 'Opening workspace…';
    if (isInstalling()) return `Installing ${state.installs.current?.pkg ?? ''}…`;
    if (state.rStatus === 'starting') return 'Starting R…';
    if (state.rStatus === 'error') return 'R failed';
    if (state.rStatus === 'closed') return 'R stopped';
    return state.busy ? 'Running' : 'Ready';
  };
  const statusKind = () =>
    state.rStatus === 'error' || state.rStatus === 'closed' ? 'error' : state.rStatus === 'starting' || state.busy || state.switching || state.attaching ? 'busy' : 'ok';

  const newItems: { label: string; name: string; content: string }[] = [
    { label: 'R Script', name: 'Untitled.R', content: '' },
    { label: 'Quarto Document', name: 'Untitled.qmd', content: QUARTO_TEMPLATE },
    { label: 'Quarto Presentation', name: 'Slides.qmd', content: SLIDES_TEMPLATE },
    { label: 'Text File', name: 'Untitled.txt', content: '' },
    { label: 'CSV File', name: 'Untitled.csv', content: '' },
  ];

  return (
    <header class="topbar">
      <button
        class="tb-btn sidebar-toggle"
        classList={{ active: state.sidebarOpen }}
        title="Toggle file sidebar"
        aria-pressed={state.sidebarOpen}
        onClick={() => setState('sidebarOpen', !state.sidebarOpen)}
      >
        <Icon name="sidebar" size={18} />
      </button>
      <div class="brand">
        <span class="brand-logo">R</span>
        <span class="brand-name">webR IDE</span>
      </div>
      <span class="tb-sep" />
      <button ref={newBtn} class="tb-btn labeled" title="New file" onClick={() => setNewMenu(true)}>
        <Icon name="file-plus" />
        <span class="hide-narrow">New</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <button class="tb-btn" title={`Save (${kbd('mod+S')})`} onClick={() => void editor()?.saveActive()}>
        <Icon name="save" />
      </button>
      <button class="tb-btn labeled hide-narrow" title="Save all open files" onClick={() => void editor()?.saveAll()}>
        <span>Save All</span>
      </button>
      <button ref={exBtn} class="tb-btn labeled" title="Tidyverse example scripts" onClick={() => setExMenu(true)}>
        <Icon name="book" />
        <span class="hide-narrow">Examples</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <button class="tb-btn labeled" title="Find and install packages" onClick={() => openPackageBrowser()}>
        <Icon name="box" />
        <span class="hide-narrow">Packages</span>
      </button>
      <span class="tb-spacer" />
      <div class={`r-status ${statusKind()}`} title={session.isolated ? 'Cross-origin isolated: interrupts enabled' : 'Interrupts unavailable (not cross-origin isolated)'}>
        <span class="dot" />
        <span>{statusLabel()}</span>
      </div>
      <button
        class="tb-btn"
        title={`Theme: ${themePref()}`}
        onClick={() => setThemePref(themePref() === 'light' ? 'dark' : themePref() === 'dark' ? 'system' : 'light')}
      >
        <Icon name={themePref() === 'system' ? 'grid' : isDark() ? 'moon' : 'sun'} size={17} />
      </button>
      <button ref={wsBtn} class="ws-btn" onClick={openWsMenu} title="Workspaces" disabled={state.switching}>
        <Icon name="box" size={16} />
        <span class="ws-name">{state.workspace || '…'}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      <Show when={newMenu()}>
        <Portal>
          <div class="menu-backdrop" onClick={() => setNewMenu(false)}>
            <div
              class="menu"
              style={{ left: `${newBtn.getBoundingClientRect().left}px`, top: `${newBtn.getBoundingClientRect().bottom + 4}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <For each={newItems}>
                {(it) => (
                  <button
                    class="menu-item"
                    onClick={() => {
                      setNewMenu(false);
                      editor()?.newFile(it.name === 'Untitled.R' ? undefined : it.name, it.content);
                    }}
                  >
                    <Icon name={it.label.startsWith('R') ? 'r' : 'file'} /> {it.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Portal>
      </Show>

      <Show when={exMenu()}>
        <Portal>
          <div class="menu-backdrop" onClick={() => setExMenu(false)}>
            <div
              class="menu examples-menu"
              style={{
                left: `${Math.min(exBtn.getBoundingClientRect().left, window.innerWidth - 380)}px`,
                top: `${exBtn.getBoundingClientRect().bottom + 4}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="examples-intro">Opens a runnable script in a new tab. Packages install on first run.</div>
              <div class="menu-scroll examples-scroll">
                <For each={EXAMPLE_GROUPS}>
                  {(group) => (
                    <>
                      <div class="menu-title">{group}</div>
                      <For each={EXAMPLES.filter((e) => e.group === group)}>
                        {(ex) => (
                          <button class="menu-item example-item" onClick={() => openExample(ex)} title={ex.note ?? ex.summary}>
                            <span class={`status-dot ${ex.status}`} aria-label={statusLabel_[ex.status]} />
                            <span class="example-text">
                              <span class="example-pkg">{ex.pkg}</span>
                              <span class="example-summary">{ex.note ?? ex.summary}</span>
                            </span>
                          </button>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
              <div class="menu-foot examples-legend">
                <span><span class="status-dot works" /> Works</span>
                <span><span class="status-dot partial" /> Partly</span>
                <span><span class="status-dot unsupported" /> Not in browser</span>
              </div>
            </div>
          </div>
        </Portal>
      </Show>

      <Show when={wsMenu()}>
        <Portal>
          <div class="menu-backdrop" onClick={() => setWsMenu(false)}>
            <div
              class="menu ws-menu"
              style={{ right: `${Math.max(8, window.innerWidth - wsBtn.getBoundingClientRect().right)}px`, top: `${wsBtn.getBoundingClientRect().bottom + 4}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="menu-title">Workspaces</div>
              <div class="menu-scroll">
                <For each={state.workspaces}>
                  {(ws) => (
                    <button
                      class="menu-item"
                      classList={{ current: ws === state.workspace }}
                      onClick={() => {
                        setWsMenu(false);
                        void switchWorkspace(ws);
                      }}
                    >
                      <span class="menu-check">{ws === state.workspace ? <Icon name="check" size={14} /> : null}</span>
                      {ws}
                    </button>
                  )}
                </For>
              </div>
              <div class="menu-sep" />
              <button class="menu-item" onClick={newWorkspace}>
                <Icon name="plus" /> New Workspace…
              </button>
              <button class="menu-item" onClick={renameWorkspace}>
                <Icon name="edit" /> Rename Workspace…
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  void exportWorkspace();
                }}
              >
                <Icon name="download" /> Export as .zip
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  pickWorkspaceZip();
                }}
              >
                <Icon name="upload" /> Import from .zip…
              </button>
              <button class="menu-item danger" onClick={removeWorkspace}>
                <Icon name="trash" /> Delete Workspace…
              </button>
              <div class="menu-sep" />
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  void saveEnvironmentImage();
                }}
              >
                <Icon name="save" /> Save Environment (.RData)
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  resetLayout();
                }}
              >
                <Icon name="grid" /> Reset Pane Layout
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  openShortcuts();
                }}
              >
                <Icon name="keyboard" /> Keyboard Shortcuts
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  openSettings();
                }}
              >
                <Icon name="grid" /> Settings…
              </button>
              <button
                class="menu-item"
                onClick={() => {
                  setWsMenu(false);
                  openStorageInfo();
                }}
              >
                <Icon name="box" /> Storage Details…
              </button>
              <Show when={storage()}>
                <div class="menu-foot">{storage()}</div>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </header>
  );
}
