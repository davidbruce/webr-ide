// The document outline: sections, functions, chunks and headings of the
// active file in a popover under the toolbar's Outline button.

import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { monaco, softFocus } from '../../lib/monaco';
import { outline, type OutlineItem } from '../../lib/language';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';
import './OutlineMenu.css';

export type OutlineCtx = ReturnType<typeof createOutline>;

/** Outline popover state. `setButton` is the toolbar button's ref (the popover opens under it). */
export function createOutline(view: EditorView, tc: TabsCtx) {
  const { inGrid } = tc;
  const [outlineMenu, setOutlineMenu] = createSignal<null | { items: OutlineItem[]; current: number; x: number; y: number }>(null);
  let outlineBtn!: HTMLButtonElement;

  function openOutline() {
    const model = view.ed?.getModel();
    if (!model || inGrid()) return;
    const items = outline(model);
    const line = view.ed.getPosition()?.lineNumber ?? 1;
    let current = -1;
    items.forEach((it, i) => it.line <= line && (current = i));
    const r = outlineBtn.getBoundingClientRect();
    setOutlineMenu({ items, current, x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 4 });
    queueMicrotask(() => document.querySelector('.outline-menu .menu-item.current')?.scrollIntoView({ block: 'center' }));
  }

  function goToLine(line: number) {
    setOutlineMenu(null);
    view.ed.setPosition({ lineNumber: line, column: 1 });
    view.ed.revealLineNearTop(line, monaco.editor.ScrollType.Smooth);
    softFocus(view.ed);
  }

  return {
    outlineMenu,
    setOutlineMenu,
    openOutline,
    goToLine,
    setButton: (el: HTMLButtonElement) => (outlineBtn = el),
  };
}

export function OutlineMenu(p: { outline: OutlineCtx; isNb: () => boolean }) {
  const { outlineMenu, setOutlineMenu, goToLine } = p.outline;
  const isNb = p.isNb;
  return (
    <Show when={outlineMenu()}>
      {(m) => (
        <Portal>
          <div class="menu-backdrop" onClick={() => setOutlineMenu(null)}>
            <div class="menu outline-menu" style={{ left: `${Math.max(8, m().x)}px`, top: `${m().y}px` }} onClick={(e) => e.stopPropagation()}>
              <div class="menu-title">Outline</div>
              <div class="menu-scroll">
                <Show
                  when={m().items.length}
                  fallback={
                    <div class="outline-empty">
                      Nothing here yet. Add a section with <code># Section ----</code>
                      {isNb() ? ' or a heading with ## Heading' : ''}, or define a function.
                    </div>
                  }
                >
                  <For each={m().items}>
                    {(it, i) => (
                      <button
                        class="menu-item outline-item"
                        classList={{ current: i() === m().current, [it.kind]: true }}
                        style={{ 'padding-left': `${10 + it.level * 14}px` }}
                        onClick={() => goToLine(it.line)}
                      >
                        <span class="outline-kind">{it.kind === 'function' ? 'ƒ' : it.kind === 'chunk' ? '{r}' : '#'}</span>
                        <span class="outline-name">{it.name}</span>
                        <span class="outline-line">{it.line}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
