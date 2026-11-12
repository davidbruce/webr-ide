/// <reference lib="webworker" />
// Workspace file server, running inside the service worker.
//
// webR mounts each workspace with DRIVEFS (JupyterLite's drive protocol). Its
// worker makes synchronous requests that we answer straight from OPFS:
//
//   POST <scope>ws/<workspace>/api/drive       JSON metadata protocol
//        { data: { method, path, data? } } → JSON
//        methods: lookup getmode getattr readdir mknod rmdir rename get put
//   GET  <scope>ws/<workspace>/api/drive-raw?path=…        whole file (binary)
//        with `Range: bytes=a-b`                             partial read (206)
//        &v=<mtime>:<size>   → 409 if the file changed since R opened it
//        ?op=open&path&id / ?op=close&id                     lazy-reader tracking
//   PUT  <scope>ws/<workspace>/api/drive-raw?path=…        write whole file
//        (writes from the page wait while R is reading that file)
//
// Changes made by R are broadcast to pages as { type: 'drive-changed', ws, changed, deleted }.

import { DIR_MODE, FILE_MODE, S_IFMT, S_IFDIR, WRITER_HEADER } from './protocol';

declare const self: ServiceWorkerGlobalScope;

const OPFS_WORKSPACES = 'workspaces';
const READER_STALE_MS = 60_000;
const PAGE_WRITE_WAIT_MS = 15_000;

/** Handle a fetch if it belongs to the drive API. Returns true when handled. */
export function handleDriveFetch(event: FetchEvent): boolean {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  const prefix = scope.pathname + 'ws/';
  if (url.origin !== scope.origin || !url.pathname.startsWith(prefix)) return false;
  const m = /^([^/]+)\/api\/(drive|drive-raw)$/.exec(url.pathname.slice(prefix.length));
  if (!m) return false;
  const ws = decodeURIComponent(m[1]);
  event.respondWith(m[2] === 'drive' ? handleJson(event.request, ws) : handleRaw(event.request, ws, url));
  return true;
}

// ---------------------------------------------------------------- OPFS helpers

const segs = (p: string) => (p || '').split('/').filter((s) => s && s !== '.');

/** The workspace folder; never created here (an unknown name is an error). */
async function wsRoot(ws: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(OPFS_WORKSPACES)).getDirectoryHandle(ws);
}

async function parentDir(ws: string, path: string, create: boolean) {
  const parts = segs(path);
  let dir = await wsRoot(ws);
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name: parts[parts.length - 1] ?? '' };
}

type Entry = FileSystemFileHandle | FileSystemDirectoryHandle;

async function resolve(ws: string, path: string): Promise<{ dir: FileSystemDirectoryHandle | null; name: string; handle: Entry | null }> {
  const parts = segs(path);
  if (!parts.length) return { dir: null, name: '', handle: await wsRoot(ws) };
  let dir: FileSystemDirectoryHandle;
  try {
    ({ dir } = await parentDir(ws, path, false));
  } catch {
    return { dir: null, name: parts[parts.length - 1], handle: null };
  }
  const name = parts[parts.length - 1];
  for (const get of [() => dir.getFileHandle(name), () => dir.getDirectoryHandle(name)]) {
    try {
      return { dir, name, handle: await get() };
    } catch {
      /* try next */
    }
  }
  return { dir, name, handle: null };
}

async function writeBytes(ws: string, path: string, bytes: Uint8Array) {
  const { dir, name } = await parentDir(ws, path, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as any).createWritable();
  await w.write(bytes);
  await w.close();
}

async function copyInto(src: Entry, dst: FileSystemDirectoryHandle, name: string) {
  if (src.kind === 'file') {
    const fh = await dst.getFileHandle(name, { create: true });
    const w = await (fh as any).createWritable();
    await w.write(await (src as FileSystemFileHandle).getFile());
    await w.close();
  } else {
    const d = await dst.getDirectoryHandle(name, { create: true });
    for await (const [n, h] of (src as any).entries() as AsyncIterable<[string, Entry]>) await copyInto(h, d, n);
  }
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}
function fromBase64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- change notifications

const pendingChanges = new Map<string, { changed: Set<string>; deleted: Set<string> }>();
let flushQueued = false;

function noteChange(ws: string, path: string, deleted = false) {
  let p = pendingChanges.get(ws);
  if (!p) pendingChanges.set(ws, (p = { changed: new Set(), deleted: new Set() }));
  const rel = segs(path).join('/');
  (deleted ? p.deleted : p.changed).add(rel);
  if (flushQueued) return;
  flushQueued = true;
  setTimeout(async () => {
    flushQueued = false;
    const batch = [...pendingChanges.entries()];
    pendingChanges.clear();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const [ws, { changed, deleted }] of batch) {
      for (const c of clients) c.postMessage({ type: 'drive-changed', ws, changed: [...changed], deleted: [...deleted] });
    }
  }, 100);
}

// ---------------------------------------------------------------- lazy-reader tracking

/** key `${ws}\0${path}` → reader id → opened-at */
const readers = new Map<string, Map<string, number>>();
const readerKey = (ws: string, path: string) => `${ws}\0${segs(path).join('/')}`;

function activeReaders(key: string): number {
  const r = readers.get(key);
  if (!r) return 0;
  const now = Date.now();
  for (const [id, t] of r) if (now - t > READER_STALE_MS) r.delete(id);
  if (!r.size) readers.delete(key);
  return r.size;
}

// ---------------------------------------------------------------- JSON protocol

async function op(ws: string, req: { method: string; path: string; data?: any }): Promise<unknown> {
  const { method, path, data } = req;
  switch (method) {
    case 'lookup': {
      const r = await resolve(ws, path);
      return r.handle ? { ok: true, mode: r.handle.kind === 'directory' ? DIR_MODE : FILE_MODE } : { ok: false };
    }
    case 'getmode': {
      const r = await resolve(ws, path);
      if (!r.handle) throw new Error('ENOENT');
      return r.handle.kind === 'directory' ? DIR_MODE : FILE_MODE;
    }
    case 'getattr': {
      const r = await resolve(ws, path);
      if (!r.handle) throw new Error('ENOENT');
      let size = 0;
      let mtime = new Date(0).toISOString();
      if (r.handle.kind === 'file') {
        const f = await (r.handle as FileSystemFileHandle).getFile();
        size = f.size;
        mtime = new Date(f.lastModified).toISOString();
      }
      return { dev: 1, nlink: 1, uid: 0, gid: 0, rdev: 0, size, blksize: 4096, blocks: Math.ceil(size / 4096), atime: mtime, mtime, ctime: mtime, timestamp: 0 };
    }
    case 'readdir': {
      const r = await resolve(ws, path);
      if (!r.handle || r.handle.kind !== 'directory') return [];
      const names: string[] = [];
      for await (const [n] of (r.handle as any).entries() as AsyncIterable<[string]>) if (!n.endsWith('.crswap')) names.push(n);
      return names;
    }
    case 'mknod': {
      const { dir, name } = await parentDir(ws, path, true);
      // Directory if the S_IFDIR type bit is set (R may use 0755, not 0777).
      if (data && (data.mode & S_IFMT) === S_IFDIR) await dir.getDirectoryHandle(name, { create: true });
      else await dir.getFileHandle(name, { create: true });
      noteChange(ws, path);
      return null;
    }
    case 'rmdir': {
      // DriveFS uses this for both files and directories.
      const r = await resolve(ws, path);
      if (r.dir && r.handle) await r.dir.removeEntry(r.name, { recursive: true });
      noteChange(ws, path, true);
      return null;
    }
    case 'rename': {
      const from = await resolve(ws, path);
      if (!from.handle || !from.dir) throw new Error('ENOENT');
      const { dir: dst, name: newName } = await parentDir(ws, data.newPath, true);
      try {
        await dst.removeEntry(newName, { recursive: true });
      } catch {
        /* nothing to replace */
      }
      let moved = false;
      if (typeof (from.handle as any).move === 'function') {
        try {
          await (from.handle as any).move(dst, newName);
          moved = true;
        } catch {
          /* fall back to copy */
        }
      }
      if (!moved) {
        await copyInto(from.handle, dst, newName);
        await from.dir.removeEntry(from.name, { recursive: true });
      }
      noteChange(ws, path, true);
      noteChange(ws, data.newPath);
      return null;
    }
    case 'get': {
      // Only used by DriveFS paths we don't override (e.g. truncate via setattr).
      const r = await resolve(ws, path);
      if (!r.handle || r.handle.kind !== 'file') return null;
      const bytes = new Uint8Array(await (await (r.handle as FileSystemFileHandle).getFile()).arrayBuffer());
      return { content: toBase64(bytes), format: 'base64' };
    }
    case 'put': {
      const bytes = data.format === 'base64' ? fromBase64(data.data) : new TextEncoder().encode(data.data);
      await writeBytes(ws, path, bytes);
      noteChange(ws, path);
      return null;
    }
  }
  throw new Error(`unknown drive method ${method}`);
}

async function handleJson(request: Request, ws: string): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
    const result = await op(ws, body.data);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---------------------------------------------------------------- binary protocol

async function handleRaw(request: Request, ws: string, url: URL): Promise<Response> {
  const path = url.searchParams.get('path') ?? '';
  try {
    const o = url.searchParams.get('op');
    if (o === 'open' || o === 'close') {
      const id = url.searchParams.get('id') ?? '';
      const key = o === 'open' ? readerKey(ws, path) : url.searchParams.get('key') ?? readerKey(ws, path);
      if (o === 'open') {
        let r = readers.get(key);
        if (!r) readers.set(key, (r = new Map()));
        r.set(id, Date.now());
      } else readers.get(key)?.delete(id);
      return new Response(null, { status: 204 });
    }

    if (request.method === 'PUT') {
      const fromPage = request.headers.get(WRITER_HEADER) === 'page';
      if (fromPage) {
        // Don't change a file under R while it's part-way through reading it.
        const key = readerKey(ws, path);
        const until = Date.now() + PAGE_WRITE_WAIT_MS;
        while (activeReaders(key) && Date.now() < until) await new Promise((r) => setTimeout(r, 40));
      }
      await writeBytes(ws, path, new Uint8Array(await request.arrayBuffer()));
      if (!fromPage) noteChange(ws, path);
      return new Response(null, { status: 204 });
    }

    const r = await resolve(ws, path);
    if (!r.handle || r.handle.kind !== 'file') return new Response(null, { status: 404 });
    const file = await (r.handle as FileSystemFileHandle).getFile();
    const v = url.searchParams.get('v');
    if (v && `${file.lastModified}:${file.size}` !== v) return new Response('file changed since it was opened', { status: 409 });
    const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') ?? '');
    if (!m) return new Response(file, { headers: { 'Content-Length': String(file.size) } });
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : file.size - 1, file.size - 1);
    if (start >= file.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
    const slice = file.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': String(slice.size) },
    });
  } catch (e) {
    return new Response(String((e as Error)?.message ?? e), { status: 500 });
  }
}
