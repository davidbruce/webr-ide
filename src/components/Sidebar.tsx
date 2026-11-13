import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import * as fs from '../lib/opfs';
import {
  state,
  setState,
  refreshTree,
  editor,
  makeFolder,
  deletePath,
  renamePath,
  downloadPath,
  writeWorkspaceFile,
  session,
  rDisplayPath,
} from '../lib/ide';
import { rString } from '../lib/r-session';
import { askText, confirmDialog, formatBytes, setImageView, toast } from '../lib/ui';
import { extOf, IMAGE_EXT, isBinaryName, isTabularName } from '../lib/monaco';
import { Icon } from './Icon';
import { SearchPanel, sidebarMode, setSidebarMode } from './SearchPanel';

interface MenuState {
  node: fs.FileNode;
  x: number;
  y: number;
}

export function Sidebar() {
  let uploadInput!: HTMLInputElement;
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [dragOver, setDragOver] = createSignal(false);

  function targetFolder(): string {
    const p = state.selectedPath;
    if (!p) return '';
    const node = fs.flattenTree(state.tree).find((n) => n.path === p);
    if (!node) return '';
    return node.kind === 'directory' ? node.path : fs.dirname(node.path);
  }

  const withFolder = (name: string) => {
    const f = targetFolder();
    return f ? `${f}/${name}` : name;
  };

  async function openNode(n: fs.FileNode) {
    setState('selectedPath', n.path);
    if (n.kind === 'directory') {
      setState('expanded', n.path, !state.expanded[n.path]);
      return;
    }
    const ext = extOf(n.name);
    if (IMAGE_EXT.has(ext)) {
      const file = await fs.readFileObject(state.workspace, n.path);
      setImageView({ title: n.name, url: URL.createObjectURL(file) });
      return;
    }
    if (isBinaryName(n.name)) {
      if (n.name === '.RData' || ext === 'rdata' || ext === 'rda') {
        if (await confirmDialog('Load R data', `Load "${n.name}" into the global environment?`, { okLabel: 'Load' }))
          session.submit(`load(${rString(rDisplayPath(n.path))})`);
      } else if (ext === 'rds') {
        const obj = fs.basename(n.name).replace(/\.rds$/i, '').replace(/[^\w.]/g, '_');
        session.submit(`${/^[A-Za-z.]/.test(obj) ? obj : 'x'} <- readRDS(${rString(rDisplayPath(n.path))})`);
      } else {
        await downloadPath(n.path);
      }
      return;
    }
    // Large tabular files open in the virtualized grid; the editor decides.
    if (!isTabularName(n.name) && (n.size ?? 0) > 5 * 1024 * 1024) {
      if (!(await confirmDialog('Large file', `"${n.name}" is ${formatBytes(n.size)}. Open it in the editor anyway?`, { okLabel: 'Open' })))
        return;
    }
    await editor()?.openFile(n.path);
    if (window.matchMedia('(max-width: 1000px)').matches) setState('sidebarOpen', false);
  }

  async function newFile() {
    const name = await askText('New File', withFolder('untitled.R'), { okLabel: 'Create', selectStem: true });
    if (!name) return;
    const path = fs.splitPath(name).join('/');
    if (await fs.exists(state.workspace, path)) return toast(`"${path}" already exists`, 'error');
    await writeWorkspaceFile(path, '');
    const dir = fs.dirname(path);
    if (dir) setState('expanded', dir, true);
    await editor()?.openFile(path);
  }

  async function newFolder() {
    const name = await askText('New Folder', withFolder('folder'), { okLabel: 'Create', selectStem: true });
    if (!name) return;
    await makeFolder(fs.splitPath(name).join('/'));
  }

  async function uploadFiles(files: FileList | File[]) {
    const folder = targetFolder();
    let n = 0;
    for (const f of Array.from(files)) {
      const path = folder ? `${folder}/${f.name}` : f.name;
      if (await fs.exists(state.workspace, path)) {
        if (!(await confirmDialog('Replace file', `"${path}" already exists. Replace it?`, { okLabel: 'Replace', danger: true }))) continue;
      }
      await writeWorkspaceFile(path, new Uint8Array(await f.arrayBuffer()));
      await editor()?.reloadIfOpen(path);
      n++;
    }
    if (n) toast(`Uploaded ${n} file${n === 1 ? '' : 's'}`);
  }

  async function rename(n: fs.FileNode) {
    const to = await askText(`Rename ${n.kind === 'directory' ? 'Folder' : 'File'}`, n.path, { okLabel: 'Rename', selectStem: true });
    if (!to || to === n.path) return;
    try {
      await renamePath(n.path, fs.splitPath(to).join('/'));
    } catch (e) {
      toast(String(e), 'error');
    }
  }

  async function remove(n: fs.FileNode) {
    const what = n.kind === 'directory' ? `the folder "${n.path}" and everything in it` : `"${n.path}"`;
    if (await confirmDialog('Delete', `Permanently delete ${what}?`, { okLabel: 'Delete', danger: true })) {
      await deletePath(n.path);
      if (state.selectedPath === n.path) setState('selectedPath', '');
    }
  }

  function openMenu(n: fs.FileNode, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setState('selectedPath', n.path);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.type === 'contextmenu' ? e.clientX : r.right;
    const y = e.type === 'contextmenu' ? e.clientY : r.bottom;
    setMenu({ node: n, x: Math.min(x, window.innerWidth - 210), y: Math.min(y, window.innerHeight - 260) });
  }

  function Row(p: { node: fs.FileNode; depth: number }) {
    const n = p.node;
    const isDir = n.kind === 'directory';
    const open = () => !!state.expanded[n.path];
    return (
      <>
        <div
          class="tree-row"
          classList={{ selected: state.selectedPath === n.path }}
          style={{ 'padding-left': `${8 + p.depth * 14}px` }}
          role="treeitem"
          aria-expanded={isDir ? open() : undefined}
          onClick={() => void openNode(n)}
          onContextMenu={(e) => openMenu(n, e)}
          title={n.path}
        >
          <span class="tree-chev">{isDir ? <Icon name={open() ? 'chevron-down' : 'chevron'} size={12} /> : null}</span>
          <Icon
            name={
              isDir ? (open() ? 'folder-open' : 'folder') : extOf(n.name) === 'r' ? 'r' : IMAGE_EXT.has(extOf(n.name)) ? 'image' : isTabularName(n.name) ? 'table' : 'file'
            }
            size={15}
            class={isDir ? 'folder-icon' : extOf(n.name) === 'r' ? 'r-icon' : isTabularName(n.name) ? 'table-icon' : 'file-icon'}
          />
          <span class="tree-name">{n.name}</span>
          <Show when={!isDir && n.size !== undefined}>
            <span class="tree-size">{formatBytes(n.size)}</span>
          </Show>
          <button class="tree-more" aria-label={`Actions for ${n.name}`} onClick={(e) => openMenu(n, e)}>
            <Icon name="more" size={14} />
          </button>
        </div>
        <Show when={isDir && open()}>
          <For each={n.children}>{(c) => <Row node={c} depth={p.depth + 1} />}</For>
        </Show>
      </>
    );
  }

  return (
    <aside
      class="sidebar"
      classList={{ 'drag-over': dragOver() }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files.length) void uploadFiles(e.dataTransfer.files);
      }}
    >
      <div class="pane-header sidebar-header">
        <div class="pane-tabs" role="tablist">
          <button role="tab" class="pane-tab" classList={{ active: sidebarMode() === 'files' }} aria-selected={sidebarMode() === 'files'} onClick={() => setSidebarMode('files')}>
            <Icon name="folder" size={14} />
            <span>Files</span>
          </button>
          <button role="tab" class="pane-tab" classList={{ active: sidebarMode() === 'search' }} aria-selected={sidebarMode() === 'search'} onClick={() => setSidebarMode('search')}>
            <Icon name="search" size={14} />
            <span>Search</span>
          </button>
        </div>
      </div>
      <Show when={sidebarMode() === 'search'}>
        <SearchPanel />
      </Show>
      <Show when={sidebarMode() === 'files'}>
      <div
        class="sidebar-crumb"
        onClick={() => setState('selectedPath', '')}
        title={
          state.fileMode === 'drive'
            ? 'R reads and writes these files directly in browser storage'
            : 'Compatibility mode: R works on a copy of these files, synced after each command'
        }
      >
        <Icon name="folder" size={13} />
        <span class="sidebar-crumb-path">~/{state.workspace}</span>
        <div class="sidebar-actions" onClick={(e) => e.stopPropagation()}>
          <button class="tb-btn" title="New file" onClick={newFile}>
            <Icon name="file-plus" />
          </button>
          <button class="tb-btn" title="New folder" onClick={newFolder}>
            <Icon name="folder-plus" />
          </button>
          <button class="tb-btn" title="Upload files" onClick={() => uploadInput.click()}>
            <Icon name="upload" />
          </button>
          <button class="tb-btn" title="Refresh" onClick={() => void refreshTree()}>
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div class="tree scroll" role="tree" onClick={(e) => e.target === e.currentTarget && setState('selectedPath', '')}>
        <For each={state.tree}>{(n) => <Row node={n} depth={0} />}</For>
        <Show when={!state.tree.length}>
          <div class="empty-note">
            No files yet.
            <br />
            Create one or drop files here.
          </div>
        </Show>
      </div>
      </Show>
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files?.length) void uploadFiles(Array.from(files));
          e.currentTarget.value = '';
        }}
      />
      <Show when={menu()}>
        {(m) => (
          <Portal>
            <div class="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
              <div class="menu" style={{ left: `${m().x}px`, top: `${m().y}px` }} onClick={(e) => e.stopPropagation()}>
                <div class="menu-title">{m().node.name}</div>
                <Show when={m().node.kind === 'file'}>
                  <button class="menu-item" onClick={() => { const n = m().node; setMenu(null); void openNode(n); }}>
                    <Icon name="file" /> Open
                  </button>
                  <Show when={extOf(m().node.name) === 'r'}>
                    <button
                      class="menu-item"
                      onClick={() => {
                        const n = m().node;
                        setMenu(null);
                        session.submit(`source(${rString(rDisplayPath(n.path))})`);
                      }}
                    >
                      <Icon name="source" /> Source
                    </button>
                  </Show>
                  <Show when={isTabularName(m().node.name)}>
                    <button
                      class="menu-item"
                      onClick={() => {
                        const n = m().node;
                        setMenu(null);
                        void editor()?.openFile(n.path, { grid: true });
                      }}
                    >
                      <Icon name="table" /> Open as Grid
                    </button>
                  </Show>
                  <Show when={['csv', 'tsv'].includes(extOf(m().node.name))}>
                    <button
                      class="menu-item"
                      onClick={() => {
                        const n = m().node;
                        setMenu(null);
                        const v = fs.basename(n.name).replace(/\.\w+$/, '').replace(/[^\w.]/g, '_');
                        const fn = extOf(n.name) === 'tsv' ? 'read.delim' : 'read.csv';
                        session.submit(`${/^[A-Za-z.]/.test(v) ? v : 'data'} <- ${fn}(${rString(rDisplayPath(n.path))})`);
                      }}
                    >
                      <Icon name="table" /> Import Dataset
                    </button>
                  </Show>
                  <button class="menu-item" onClick={() => { const n = m().node; setMenu(null); void downloadPath(n.path); }}>
                    <Icon name="download" /> Download
                  </button>
                </Show>
                <Show when={m().node.kind === 'directory'}>
                  <button
                    class="menu-item"
                    onClick={() => {
                      const n = m().node;
                      setMenu(null);
                      session.submit(`setwd(${rString(rDisplayPath(n.path))})`);
                    }}
                  >
                    <Icon name="to-console" /> Set as Working Directory
                  </button>
                </Show>
                <button
                  class="menu-item"
                  onClick={() => {
                    const n = m().node;
                    setMenu(null);
                    void navigator.clipboard?.writeText(rDisplayPath(n.path)).then(() => toast('Path copied'));
                  }}
                >
                  <Icon name="edit" /> Copy Path
                </button>
                <div class="menu-sep" />
                <button class="menu-item" onClick={() => { const n = m().node; setMenu(null); void rename(n); }}>
                  <Icon name="edit" /> Rename…
                </button>
                <button class="menu-item danger" onClick={() => { const n = m().node; setMenu(null); void remove(n); }}>
                  <Icon name="trash" /> Delete…
                </button>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </aside>
  );
}
