// Workspace storage on the Origin Private File System (OPFS).
// Layout:  /workspaces/<workspace name>/<files...>
// Paths passed to this module are workspace-relative, '/'-separated.

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: FileNode[];
}

export const IDE_DIR = '.ide';
const WS_ROOT = 'workspaces';

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted?.()) return true;
    return (await navigator.storage.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s && s !== '.');
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap(splitPath).join('/');
}

export function dirname(path: string): string {
  const s = splitPath(path);
  s.pop();
  return s.join('/');
}

export function basename(path: string): string {
  const s = splitPath(path);
  return s[s.length - 1] ?? '';
}

// ---------- storage root (OPFS, or an in-memory fallback) ----------

let memoryMode = false;
let memRoot: MemDir | null = null;

/** True when OPFS was unavailable and files only live for this page session. */
export function isMemoryMode() {
  return memoryMode;
}

/** Probe OPFS; fall back to memory (e.g. some private-browsing modes). */
export async function initStorage(): Promise<'opfs' | 'memory'> {
  try {
    if (!opfsSupported()) throw new Error('OPFS unsupported');
    const root = await navigator.storage.getDirectory();
    const probe = await root.getDirectoryHandle(WS_ROOT, { create: true });
    for await (const _ of entries(probe)) break;
    return 'opfs';
  } catch (e) {
    console.warn('OPFS unavailable, using in-memory storage:', e);
    memoryMode = true;
    return 'memory';
  }
}

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  if (memoryMode) return (memRoot ??= new MemDir('')) as unknown as FileSystemDirectoryHandle;
  return navigator.storage.getDirectory();
}

async function wsRoot(): Promise<FileSystemDirectoryHandle> {
  return (await rootDir()).getDirectoryHandle(WS_ROOT, { create: true });
}

function notFound(name: string) {
  return new DOMException(`${name} not found`, 'NotFoundError');
}

class MemFile {
  readonly kind = 'file';
  data = new Uint8Array();
  modified = Date.now();
  constructor(public name: string) {}
  async getFile() {
    return new File([this.data.slice()], this.name, { lastModified: this.modified });
  }
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array) => void chunks.push(new Uint8Array(d)),
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) out.set(c, (o += c.length) - c.length);
        this.data = out;
        this.modified = Date.now();
      },
    };
  }
}

class MemDir {
  readonly kind = 'directory';
  children = new Map<string, MemDir | MemFile>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    const c = this.children.get(name);
    if (c instanceof MemDir) return c;
    if (c) throw new DOMException('Not a directory', 'TypeMismatchError');
    if (!opts?.create) throw notFound(name);
    const d = new MemDir(name);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    const c = this.children.get(name);
    if (c instanceof MemFile) return c;
    if (c) throw new DOMException('Not a file', 'TypeMismatchError');
    if (!opts?.create) throw notFound(name);
    const f = new MemFile(name);
    this.children.set(name, f);
    return f;
  }
  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw notFound(name);
  }
  async *entries() {
    yield* this.children.entries();
  }
  async resolve(): Promise<string[] | null> {
    return null;
  }
}

async function dirHandle(ws: string, path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = await (await wsRoot()).getDirectoryHandle(ws, { create });
  for (const seg of splitPath(path)) dir = await dir.getDirectoryHandle(seg, { create });
  return dir;
}

async function fileHandle(ws: string, path: string, create = false): Promise<FileSystemFileHandle> {
  const dir = await dirHandle(ws, dirname(path), create);
  return dir.getFileHandle(basename(path), { create });
}

async function* entries(dir: FileSystemDirectoryHandle): AsyncGenerator<[string, FileSystemHandle]> {
  // `entries()` is missing from some TS DOM lib versions.
  yield* (dir as any).entries();
}

// ---------- workspaces ----------

export async function listWorkspaces(): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, h] of entries(await wsRoot())) {
    if (h.kind === 'directory') names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function createWorkspace(name: string): Promise<void> {
  await dirHandle(name, '', true);
}

export async function deleteWorkspace(name: string): Promise<void> {
  await (await wsRoot()).removeEntry(name, { recursive: true });
}

export async function renameWorkspace(from: string, to: string): Promise<void> {
  const root = await wsRoot();
  const src = await root.getDirectoryHandle(from);
  const dst = await root.getDirectoryHandle(to, { create: true });
  await copyDir(src, dst);
  await root.removeEntry(from, { recursive: true });
}

export function validName(name: string): boolean {
  return /^[\w .()+-]+$/.test(name) && name.trim() === name && name !== '.' && name !== '..';
}

// ---------- files ----------

export async function listTree(ws: string, includeHidden = false): Promise<FileNode[]> {
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<FileNode[]> {
    const out: FileNode[] = [];
    for await (const [name, h] of entries(dir)) {
      if (!prefix && name === IDE_DIR && !includeHidden) continue;
      if (name.endsWith('.crswap')) continue; // Safari/Chrome temp files from createWritable
      const path = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') {
        out.push({ name, path, kind: 'directory', children: await walk(h as FileSystemDirectoryHandle, path) });
      } else {
        let size: number | undefined;
        let modified: number | undefined;
        try {
          const f = await (h as FileSystemFileHandle).getFile();
          size = f.size;
          modified = f.lastModified;
        } catch {
          /* ignore */
        }
        out.push({ name, path, kind: 'file', size, modified });
      }
    }
    return out.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }
  return walk(await dirHandle(ws, '', true), '');
}

export function flattenTree(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((n) => [n, ...(n.children ? flattenTree(n.children) : [])]);
}

export async function exists(ws: string, path: string): Promise<boolean> {
  try {
    await fileHandle(ws, path);
    return true;
  } catch {
    try {
      await dirHandle(ws, path);
      return true;
    } catch {
      return false;
    }
  }
}

export async function readFile(ws: string, path: string): Promise<Uint8Array> {
  const f = await (await fileHandle(ws, path)).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function readText(ws: string, path: string): Promise<string> {
  const f = await (await fileHandle(ws, path)).getFile();
  return f.text();
}

export async function readFileObject(ws: string, path: string): Promise<File> {
  return (await fileHandle(ws, path)).getFile();
}

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

function writeViaWorker(segments: string[], data: Uint8Array): Promise<void> {
  if (!worker) {
    worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      ev.data.ok ? p.resolve() : p.reject(new Error(ev.data.error));
    };
  }
  const id = ++reqId;
  const buf = data.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, segments, data: buf }, [buf]);
  });
}

// Writes are serialized per path so overlapping saves can't interleave.
const writeChains = new Map<string, Promise<void>>();

export function writeFile(ws: string, path: string, data: Uint8Array | string): Promise<void> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const key = `${ws}/${path}`;
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => doWrite(ws, path, bytes));
  writeChains.set(key, next);
  next.finally(() => writeChains.get(key) === next && writeChains.delete(key));
  return next;
}

async function doWrite(ws: string, path: string, bytes: Uint8Array): Promise<void> {
  const fh = await fileHandle(ws, path, true);
  if (typeof (fh as any).createWritable === 'function') {
    const w = await (fh as any).createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    await writeViaWorker([WS_ROOT, ws, ...splitPath(path)], bytes);
  }
}

export async function mkdir(ws: string, path: string): Promise<void> {
  await dirHandle(ws, path, true);
}

export async function remove(ws: string, path: string): Promise<void> {
  const parent = await dirHandle(ws, dirname(path));
  await parent.removeEntry(basename(path), { recursive: true });
}

async function copyDir(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle, srcPathForWorker?: string[]) {
  for await (const [name, h] of entries(src)) {
    if (h.kind === 'directory') {
      await copyDir(h as FileSystemDirectoryHandle, await dst.getDirectoryHandle(name, { create: true }), srcPathForWorker);
    } else {
      const data = new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
      const out = await dst.getFileHandle(name, { create: true });
      if (typeof (out as any).createWritable === 'function') {
        const w = await (out as any).createWritable();
        await w.write(data);
        await w.close();
      } else {
        // Resolve the destination path from the OPFS root for the worker.
        const root = await rootDir();
        const segs = await root.resolve(out);
        if (!segs) throw new Error('Cannot resolve path for ' + name);
        await writeViaWorker(segs, data);
      }
    }
  }
}

/** Rename/move a file or folder within a workspace (copy + delete; OPFS has no portable move). */
export async function rename(ws: string, from: string, to: string): Promise<void> {
  if (from === to) return;
  if (await exists(ws, to)) throw new Error(`"${to}" already exists`);
  let isDir = false;
  try {
    await dirHandle(ws, from);
    isDir = true;
  } catch {
    /* file */
  }
  if (isDir) {
    await copyDir(await dirHandle(ws, from), await dirHandle(ws, to, true));
  } else {
    await writeFile(ws, to, await readFile(ws, from));
  }
  await remove(ws, from);
}

// ---------- app-level files (outside workspaces), e.g. the package cache ----------

async function appDir(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await rootDir();
  for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create });
  return dir;
}

export async function readAppFile(path: string): Promise<File> {
  const segs = splitPath(path);
  const dir = await appDir(segs.slice(0, -1), false);
  return (await dir.getFileHandle(segs[segs.length - 1])).getFile();
}

export async function writeAppFile(path: string, data: Uint8Array | string): Promise<void> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const segs = splitPath(path);
  const dir = await appDir(segs.slice(0, -1), true);
  const fh = await dir.getFileHandle(segs[segs.length - 1], { create: true });
  if (typeof (fh as any).createWritable === 'function') {
    const w = await (fh as any).createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    await writeViaWorker(segs, bytes);
  }
}

export async function removeAppPath(path: string): Promise<void> {
  const segs = splitPath(path);
  try {
    const dir = await appDir(segs.slice(0, -1), false);
    await dir.removeEntry(segs[segs.length - 1], { recursive: true });
  } catch {
    /* already gone */
  }
}
