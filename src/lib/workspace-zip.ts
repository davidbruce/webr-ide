// Export a workspace as a .zip (a backup, or to move it to another browser or
// device) and import one as a new workspace.
import { Zip, ZipDeflate, AsyncZipDeflate, ZipPassThrough, unzip } from 'fflate';
import * as fs from './opfs';
import { state, editor, syncFromR, downloadBlob, refreshWorkspaces, switchWorkspace } from './ide';
import { askText, choiceDialog, formatBytes, toast } from './ui';

/** Already compressed: stored as-is (deflating them again wastes time). */
const STORED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'rds', 'rda', 'rdata', 'parquet', 'feather', 'xlsx', 'docx', 'pptx', 'pdf', 'mp3', 'mp4', 'mov', 'woff2']);

const ext = (p: string) => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '');

/** Download the current workspace (files, history, saved environment) as <name>.zip. */
export async function exportWorkspace() {
  const ws = state.workspace;
  if (!ws) return;
  if (editor()?.hasDirty()) {
    const r = await choiceDialog('Unsaved changes', 'Save open files first, so the export has your latest edits?', 'Save & Export', {
      label: 'Export Saved Versions',
      value: 'skip',
    });
    if (r === null) return;
    if (r !== 'skip') await editor()?.saveAll();
  }
  await syncFromR().catch(() => {});
  toast(`Exporting ${ws}…`);
  const nodes = fs.flattenTree(await fs.listTree(ws, true));
  const chunks: Uint8Array[] = [];
  let failed: unknown = null;
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      chunks.push(chunk);
      if (final) resolve();
    });
    void (async () => {
      try {
        for (const n of nodes) {
          const name = `${ws}/${n.path}`;
          if (n.kind === 'directory') {
            if (!n.children?.length) {
              const dir = new ZipPassThrough(name + '/');
              zip.add(dir);
              dir.push(new Uint8Array(0), true);
            }
            continue;
          }
          const data = await fs.readFile(ws, n.path);
          // Large files are compressed in a worker so the page stays responsive.
          const entry = STORED.has(ext(n.name))
            ? new ZipPassThrough(name)
            : data.length > 512 * 1024
              ? new AsyncZipDeflate(name, { level: 6 })
              : new ZipDeflate(name, { level: 6 });
          if (n.modified) entry.mtime = n.modified;
          zip.add(entry);
          entry.push(data, true);
        }
        zip.end();
      } catch (e) {
        failed = e;
        reject(e);
      }
    })();
  });
  try {
    await done;
  } catch (e) {
    toast(`Export failed: ${failed ?? e}`, 'error');
    return;
  }
  const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
  downloadBlob(blob, `${ws}.zip`);
  toast(`Exported ${ws}.zip (${formatBytes(blob.size)})`);
}

const JUNK = (p: string) => p.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(p) || /(^|\/)\._[^/]*$/.test(p);

/** Make a new workspace from a .zip file. */
export async function importWorkspace(file: File) {
  let entries: [string, Uint8Array][];
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(data, (err, out) => (err ? reject(err) : resolve(out))));
    entries = Object.entries(files).filter(([p]) => !JUNK(p));
  } catch (e) {
    toast(`Couldn't read ${file.name}: ${e}`, 'error');
    return;
  }
  // Paths must stay inside the workspace.
  entries = entries.filter(([p]) => !p.split('/').some((seg) => seg === '..') && !p.startsWith('/'));
  if (!entries.some(([p]) => !p.endsWith('/'))) return toast(`${file.name} has no files`, 'warn');
  // A zip of one folder (as exported): use that folder as the workspace.
  const tops = new Set(entries.map(([p]) => p.split('/')[0]));
  const wrapped = tops.size === 1 && entries.every(([p]) => p.includes('/'));
  const top = [...tops][0];
  if (wrapped) entries = entries.map(([p, d]) => [p.slice(top.length + 1), d] as [string, Uint8Array]).filter(([p]) => p);

  let name = (wrapped ? top : file.name.replace(/\.zip$/i, '')).replace(/[^\w .-]/g, '_').trim() || 'Imported';
  while (state.workspaces.includes(name)) name = /\s(\d+)$/.test(name) ? name.replace(/\d+$/, (n) => String(Number(n) + 1)) : `${name} 2`;
  const total = entries.reduce((s, [, d]) => s + d.length, 0);
  const chosen = await askText('Import Workspace', name, {
    okLabel: 'Import',
    message: `${entries.filter(([p]) => !p.endsWith('/')).length} files, ${formatBytes(total)}. The workspace's files, history and saved environment come with it.`,
  });
  if (!chosen) return;
  if (!fs.validName(chosen)) return toast('Use letters, numbers, spaces, dots, dashes or underscores', 'error');
  if (state.workspaces.includes(chosen)) return toast(`Workspace "${chosen}" already exists`, 'error');
  try {
    await fs.createWorkspace(chosen);
    for (const [p, d] of entries) {
      if (p.endsWith('/')) await fs.mkdir(chosen, p.replace(/\/+$/, ''));
      else await fs.writeFile(chosen, p, d);
    }
  } catch (e) {
    toast(`Import failed: ${e}`, 'error');
    return;
  }
  await refreshWorkspaces();
  await switchWorkspace(chosen);
  toast(`Imported "${chosen}"`);
}

/** Pick a .zip and import it. */
export function pickWorkspaceZip() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importWorkspace(f);
  };
  input.click();
}
