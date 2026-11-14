// The spreadsheet grid for a CSV / TSV tab: loads the saved file (or the
// tab's unsaved text) into a FileSource for the DataGrid, or explains that
// the file is too large to preview.

import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import { GRID_MAX, type monaco } from '../../lib/monaco';
import { FileSource } from '../../lib/grid/source';
import { DataGrid } from '../DataGrid';
import { formatBytes } from '../../lib/ui';
import { downloadPath, state } from '../../lib/ide';
import * as fs from '../../lib/opfs';
import { Icon } from '../Icon';
import type { Tab } from './tabs';

/** Grid for one tab: builds a FileSource from the saved file (or unsaved text). */
export function GridView(p: { tab: Tab; models: Map<string, monaco.editor.ITextModel> }) {
  const [src, setSrc] = createSignal<FileSource | null>(null);
  const [blocked, setBlocked] = createSignal<number | null>(null);
  let loads = 0;
  createEffect(
    on(
      () => [p.tab.fileVersion, p.tab.path] as const,
      async () => {
        const run = ++loads; // a newer load (e.g. save, then reload) supersedes this one
        src()?.dispose();
        setSrc(null);
        const model = p.models.get(p.tab.key);
        let blob: Blob;
        if (model && (p.tab.dirty || !p.tab.path)) blob = new Blob([model.getValue()], { type: 'text/csv' });
        else if (p.tab.path) blob = await fs.readFileObject(state.workspace, p.tab.path);
        else return;
        if (run !== loads) return;
        if (blob.size > GRID_MAX) {
          setBlocked(blob.size);
          return;
        }
        setBlocked(null);
        setSrc(new FileSource(blob, p.tab.name));
      },
    ),
  );
  onCleanup(() => src()?.dispose());
  return (
    <div class="grid-host">
      <Show when={blocked() !== null}>
        <div class="grid-blocked">
          <Icon name="table" size={36} />
          <h3>This file is too large to preview</h3>
          <p>
            {p.tab.name} is {formatBytes(blocked()!)}. The grid viewer handles files up to {formatBytes(GRID_MAX)}. Download it and open it in a
            desktop app such as Numbers, Excel or a dedicated CSV viewer — or load just the columns you need in R.
          </p>
          <Show when={p.tab.path}>
            <button class="btn primary" onClick={() => void downloadPath(p.tab.path!)}>
              Download {p.tab.name}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={src()} keyed>
        {(source) => <DataGrid source={source} />}
      </Show>
    </div>
  );
}
