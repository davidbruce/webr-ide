import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { state, setState, refreshEnv, strOf, session, saveEnvironmentImage, clearHistory, editor, EnvEntry } from '../lib/ide';
import { confirmDialog, modKey } from '../lib/ui';
import { Icon } from './Icon';
import { PaneHeader } from './Pane';
import { consoleApi } from './Console';

export function EnvPane() {
  return (
    <div class="pane">
      <PaneHeader
        pane="env"
        tabs={[
          { id: 'environment', label: 'Environment' },
          { id: 'history', label: 'History' },
        ]}
        active={state.envTab}
        onTab={(id) => setState('envTab', id as 'environment' | 'history')}
      />
      <Show when={state.envTab === 'environment'} fallback={<HistoryView />}>
        <EnvironmentView />
      </Show>
    </div>
  );
}

function EnvironmentView() {
  const [filter, setFilter] = createSignal('');
  const [expanded, setExpanded] = createSignal<Record<string, string[] | undefined>>({});

  const groups = createMemo(() => {
    const f = filter().toLowerCase();
    const items = state.env.filter((e) => !f || e.name.toLowerCase().includes(f));
    return (['Data', 'Values', 'Functions'] as const)
      .map((g) => ({ group: g, items: items.filter((e) => e.group === g) }))
      .filter((g) => g.items.length);
  });

  // Refresh any expanded str() views when the environment changes.
  createEffect(
    on(
      () => state.env,
      async () => {
        const cur = expanded();
        const names = Object.keys(cur).filter((k) => cur[k]);
        if (!names.length) return;
        const next: Record<string, string[] | undefined> = {};
        for (const n of names) if (state.env.some((e) => e.name === n)) next[n] = await strOf(n);
        setExpanded(next);
      },
      { defer: true },
    ),
  );

  async function toggle(e: EnvEntry) {
    const cur = expanded();
    if (cur[e.name]) setExpanded({ ...cur, [e.name]: undefined });
    else setExpanded({ ...cur, [e.name]: await strOf(e.name) });
  }

  async function clearEnv() {
    if (!state.env.length) return;
    if (await confirmDialog('Clear Environment', 'Remove all objects from the global environment?', { okLabel: 'Clear', danger: true })) {
      session.submit('rm(list = ls())');
    }
  }

  return (
    <>
      <div class="pane-toolbar">
        <button class="tb-btn" title="Save environment to .RData" onClick={() => void saveEnvironmentImage()} disabled={state.rStatus !== 'ready'}>
          <Icon name="save" />
        </button>
        <button class="tb-btn" title="Clear all objects" onClick={clearEnv} disabled={!state.env.length}>
          <Icon name="broom" />
        </button>
        <span class="tb-sep" />
        <span class="env-scope">Global Environment</span>
        <span class="tb-spacer" />
        <div class="search-box small">
          <Icon name="search" size={13} />
          <input type="search" placeholder="Filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <button class="tb-btn" title="Refresh" onClick={() => void refreshEnv()} disabled={!session.idle && state.busy}>
          <Icon name="refresh" />
        </button>
      </div>
      <div class="pane-body scroll">
        <Show
          when={state.env.length}
          fallback={<div class="empty-note">{state.rStatus === 'ready' ? 'Environment is empty' : 'Waiting for R…'}</div>}
        >
          <table class="env-table">
            <colgroup>
              <col style={{ width: '38%' }} />
              <col />
            </colgroup>
            <For each={groups()}>
              {(g) => (
                <tbody>
                  <tr class="env-group">
                    <th colSpan={2}>{g.group}</th>
                  </tr>
                  <For each={g.items}>
                    {(e) => (
                      <>
                        <tr class="env-row" classList={{ open: !!expanded()[e.name] }}>
                          <td class="env-name">
                            <Show when={e.group !== 'Functions'} fallback={<span class="chev-space" />}>
                              <button class="chev-btn" onClick={() => void toggle(e)} aria-label={`Show structure of ${e.name}`}>
                                <Icon name={expanded()[e.name] ? 'chevron-down' : 'chevron'} size={12} />
                              </button>
                            </Show>
                            <span title={`${e.name} — ${e.cls} (${e.size})`}>{e.name}</span>
                          </td>
                          <td class="env-value">
                            <span class="env-value-text" title={e.value}>
                              {e.value}
                            </span>
                            <Show when={e.group === 'Data'}>
                              <button class="tb-btn tiny" title={`View ${e.name}`} onClick={() => session.submit(`View(${e.name})`)}>
                                <Icon name="table" size={14} />
                              </button>
                            </Show>
                          </td>
                        </tr>
                        <Show when={expanded()[e.name]}>
                          <tr class="env-str">
                            <td colSpan={2}>
                              <pre>{expanded()[e.name]!.join('\n')}</pre>
                            </td>
                          </tr>
                        </Show>
                      </>
                    )}
                  </For>
                </tbody>
              )}
            </For>
          </table>
        </Show>
      </div>
    </>
  );
}

const touchUI = window.matchMedia('(hover: none)').matches;

function HistoryView() {
  const [filter, setFilter] = createSignal('');
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  let scroller!: HTMLDivElement;

  const items = createMemo(() => {
    const f = filter().toLowerCase();
    return state.history.map((cmd, i) => ({ cmd, i })).filter((x) => !f || x.cmd.toLowerCase().includes(f));
  });

  createEffect(
    on(
      () => state.history.length,
      () => queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight)),
    ),
  );

  const selectedText = () =>
    [...selected()]
      .sort((a, b) => a - b)
      .map((i) => state.history[i])
      .filter((x) => x !== undefined)
      .join('\n');

  function toggle(i: number, additive: boolean) {
    const s = new Set(additive ? selected() : []);
    if (s.has(i) && additive) s.delete(i);
    else s.add(i);
    setSelected(s);
  }

  return (
    <>
      <div class="pane-toolbar">
        <button
          class="tb-btn labeled"
          disabled={!selected().size}
          title="Send to console (Enter)"
          onClick={() => consoleApi?.insert(selectedText())}
        >
          <Icon name="to-console" />
          <span>To Console</span>
        </button>
        <button
          class="tb-btn labeled"
          disabled={!selected().size}
          title="Insert into the script"
          onClick={() => editor()?.insertText(selectedText() + '\n')}
        >
          <Icon name="to-source" />
          <span>To Source</span>
        </button>
        <button
          class="tb-btn"
          disabled={!selected().size || state.rStatus !== 'ready'}
          title="Run selected commands"
          onClick={() => session.submit(selectedText())}
        >
          <Icon name="play" />
        </button>
        <span class="tb-spacer" />
        <div class="search-box small">
          <Icon name="search" size={13} />
          <input type="search" placeholder="Filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <button
          class="tb-btn"
          title="Clear history"
          disabled={!state.history.length}
          onClick={async () => {
            if (await confirmDialog('Clear History', 'Remove all entries from the command history?', { okLabel: 'Clear', danger: true })) {
              clearHistory();
              setSelected(new Set<number>());
            }
          }}
        >
          <Icon name="broom" />
        </button>
      </div>
      <div class="pane-body scroll" ref={scroller}>
        <Show when={state.history.length} fallback={<div class="empty-note">No commands yet</div>}>
          <ul class="history-list">
            <For each={items()}>
              {(x) => (
                <li
                  classList={{ selected: selected().has(x.i) }}
                  onClick={(e) => toggle(x.i, e.metaKey || e.ctrlKey || e.shiftKey || touchUI)}
                  onDblClick={() => consoleApi?.insert(x.cmd)}
                  title={`Double-click to send to console · ${modKey}-click to multi-select`}
                >
                  {x.cmd}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </>
  );
}

