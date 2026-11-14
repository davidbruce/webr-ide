// The editor's tab strip (in the pane header): one tab per open file, with
// close buttons, a dirty dot and the New R script button.

import { For } from 'solid-js';
import { isTabularName } from '../../lib/monaco';
import { Icon } from '../Icon';
import type { TabsCtx } from './tabs';

export function EditorTabs(p: { tabs: TabsCtx }) {
  const { tabs, activate, closeTab, newFile } = p.tabs;
  return (
    <div class="editor-tabs" role="tablist">
      <For each={tabs.list}>
        {(t) => (
          <div
            class="editor-tab"
            classList={{ active: tabs.active === t.key, dirty: t.dirty }}
            role="tab"
            aria-selected={tabs.active === t.key}
            title={t.path ?? t.name}
            onClick={() => activate(t.key)}
            onAuxClick={(e) => e.button === 1 && void closeTab(t.key)}
          >
            <Icon
              name={t.language === 'r' ? 'r' : isTabularName(t.name) ? 'table' : 'file'}
              size={14}
              class={t.language === 'r' ? 'r-icon' : isTabularName(t.name) ? 'table-icon' : ''}
            />
            <span class="editor-tab-name">{t.name}</span>
            <button
              class="editor-tab-close"
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(t.key);
              }}
            >
              <span class="dirty-dot" />
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </For>
      <button class="editor-tab-new" title="New R script" onClick={() => newFile()}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
