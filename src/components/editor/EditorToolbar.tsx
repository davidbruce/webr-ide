// The editor pane's toolbar: save, find, outline and palette; the text/grid
// toggle and Import for CSV tabs; chunk and render controls for Quarto; Run
// and Source for R scripts.

import { Show } from 'solid-js';
import { TEXT_VIEW_MAX, softFocus } from '../../lib/monaco';
import { preview } from '../../lib/render';
import { nb, setOutputMode, stopChunks, anyRunning, runsFor, inlinesFor } from '../../lib/notebook';
import { formatBytes, kbd } from '../../lib/ui';
import { isInstalling, state, setState } from '../../lib/ide';
import { Icon } from '../Icon';
import { palette } from './keybindings';
import type { EditorView } from './view';
import type { TabsCtx } from './tabs';
import type { RunCtx } from './run';
import type { OutlineCtx } from './OutlineMenu';

export function EditorToolbar(p: { view: EditorView; tabs: TabsCtx; run: RunCtx; outline: OutlineCtx }) {
  const view = p.view;
  const { activeTab, isR, isNb, isTabular, inGrid, setMode, saveActive } = p.tabs;
  const { runSelection, sourceActive, renderActive, importToR } = p.run;
  const { openOutline } = p.outline;
  return (
    <div class="pane-toolbar">
      <button class="tb-btn" title={`Save (${kbd('mod+S')})`} disabled={!activeTab() || activeTab()!.gridOnly} onClick={() => void saveActive()}>
        <Icon name="save" />
      </button>
      <button class="tb-btn" title="Find / Replace" disabled={!activeTab() || inGrid()} onClick={() => view.ed.getAction('actions.find')?.run()}>
        <Icon name="search" />
      </button>
      <button
        ref={p.outline.setButton}
        class="tb-btn"
        title={`Outline: sections, functions and headings (${kbd('mod+shift+O')})`}
        disabled={!activeTab() || inGrid() || !['r', 'quarto', 'markdown'].includes(activeTab()!.language)}
        onClick={openOutline}
      >
        <Icon name="outline" />
      </button>
      <button class="tb-btn" title={`Command palette (${kbd('mod+shift+P')})`} disabled={!activeTab() || inGrid()} onClick={() => palette(view.ed)}>
        <Icon name="command" />
      </button>
      <Show when={isTabular()}>
        <span class="tb-sep" />
        <div class="view-toggle" role="group" aria-label="View as">
          <button
            class="tb-btn labeled"
            classList={{ active: !inGrid() }}
            disabled={activeTab()!.gridOnly}
            title={activeTab()!.gridOnly ? `Too large for the text editor (over ${formatBytes(TEXT_VIEW_MAX)})` : 'Edit as text'}
            onClick={() => setMode('text')}
          >
            <Icon name="file" />
            <span>Text</span>
          </button>
          <button class="tb-btn labeled" classList={{ active: inGrid() }} title="View as a spreadsheet grid" onClick={() => setMode('grid')}>
            <Icon name="table" />
            <span>Grid</span>
          </button>
        </div>
        <button
          class="tb-btn labeled"
          disabled={!activeTab()!.path || state.rStatus !== 'ready'}
          title="Import into R as a data frame"
          onClick={importToR}
        >
          <Icon name="to-console" />
          <span>Import to R</span>
        </button>
      </Show>
      <Show when={isNb()}>
        <span class="tb-sep" />
        <button class="tb-btn" title={`Insert an R chunk (${kbd('mod+alt+I')})`} onClick={() => view.notebook?.insertChunk()}>
          <Icon name="plus" />
        </button>
        <div class="view-toggle" role="group" aria-label="Chunk output">
          <button
            class="tb-btn labeled"
            classList={{ active: nb.mode === 'inline' }}
            title="Show chunk output under each chunk"
            onClick={() => setOutputMode('inline')}
          >
            <span>Inline</span>
          </button>
          <button
            class="tb-btn labeled"
            classList={{ active: nb.mode === 'pane' }}
            title="Show chunk output in the Output tab"
            onClick={() => {
              setOutputMode('pane');
              setState('plotTab', 'output');
            }}
          >
            <span>Pane</span>
          </button>
        </div>
        <button class="tb-btn" title="Clear all chunk output" disabled={!runsFor(nb.activeDoc).length && !inlinesFor(nb.activeDoc).length} onClick={() => view.notebook?.clear()}>
          <Icon name="broom" />
        </button>
      </Show>
      <span class="tb-sep" />
      <span class="tb-spacer" />
      <Show when={isNb()}>
        <Show when={anyRunning()}>
          <button class="tb-btn labeled danger" title="Stop running chunks" onClick={stopChunks}>
            <Icon name="stop" />
            <span>Stop</span>
          </button>
        </Show>
        <button
          class="tb-btn labeled"
          disabled={state.rStatus !== 'ready' || isInstalling() || preview.status === 'rendering'}
          title={`Render to HTML in the Preview tab (${kbd('mod+shift+K')})`}
          onClick={renderActive}
        >
          <Icon name="book" />
          <span>Render</span>
        </button>
        <button
          class="tb-btn labeled run"
          disabled={state.rStatus !== 'ready' || isInstalling()}
          title={`Run the chunk at the cursor (${kbd('mod+shift+enter')})`}
          onClick={() => view.notebook?.runAtCursor()}
        >
          <Icon name="play" />
          <span>Run Chunk</span>
        </button>
        <button
          class="tb-btn labeled run"
          disabled={state.rStatus !== 'ready' || isInstalling()}
          title={`Run every R chunk (${kbd('mod+alt+R')})`}
          onClick={() => view.notebook?.runAll()}
        >
          <Icon name="run-all" />
          <span>Run All</span>
        </button>
      </Show>
      <Show when={!isTabular() && !isNb()}>
      <button
        class="tb-btn labeled run"
        disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
        title={`Run the current line or selection (${kbd('mod+enter')})`}
        onClick={() => {
          runSelection();
          softFocus(view.ed);
        }}
      >
        <Icon name="play" />
        <span>Run</span>
      </button>
      <button
        class="tb-btn labeled"
        disabled={!activeTab() || !isR() || state.rStatus !== 'ready' || isInstalling()}
        title={`Source the file (${kbd('mod+shift+S')}) — long-press or ${kbd('mod+shift+enter')} to echo`}
        onClick={(e) => void sourceActive(e.shiftKey || e.altKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          void sourceActive(true);
        }}
      >
        <Icon name="source" />
        <span>Source</span>
      </button>
      </Show>
    </div>
  );
}
