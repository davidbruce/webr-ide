// Code that runs INSIDE webR's worker (via `webr::eval_js`). Each function is
// serialized with .toString(), so it must be self-contained: no imports and
// no references to anything outside its own body.
//
// webR 0.6.1 ships JupyterLite's DriveFS. We keep its directory/metadata
// operations (answered by our service worker) and replace its file streams:
//   - files ≤ smallMax are read whole on open, as raw binary (consistent)
//   - larger read-only files are read lazily in blocks via HTTP Range, with a
//     version check so a file changing mid-read can't mix old and new bytes
//   - writes are buffered (growing geometrically) and uploaded once on close
//   - mmap is supported (readr/vroom and data.table::fread need it)
// The stock streams fetch whole files as base64, copy the entire file on
// every write (quadratic) and lack mmap.

export function drivePatch(mount: string, base: string, smallMax: number, blockSize: number): string {
  const M = (globalThis as any).Module;
  const FS = M.FS;
  const drive = FS.lookupPath(mount).node.mount.type;
  if (!drive || !drive.API || !drive.stream_ops || typeof drive.realPath !== 'function' || !('_baseUrl' in drive.API)) {
    throw new Error('DriveFS internals not as expected');
  }
  // Route metadata requests to this app's service worker (works under a subpath).
  // DriveFS passes its endpoint through encodeURI(), so give it the decoded
  // form (e.g. "Project B", not "Project%20B") to avoid double encoding.
  const apiBase = decodeURI(base);
  drive.API._baseUrl = apiBase;
  if (drive.API.endpoint !== apiBase + 'api/drive' || encodeURI(drive.API.endpoint) !== base + 'api/drive') {
    throw new Error('could not redirect the DriveFS endpoint');
  }

  const RAW = base + 'api/drive-raw';
  const EIO = 29;
  const ENOENT = 44;
  const ENODEV = 43;
  const ENOMEM = 48;
  const O_ACCMODE = 3;
  const O_TRUNC = 512;
  const MAX_BLOCKS = 16;
  const so = drive.stream_ops;
  let seq = 0;

  const rel = (node: any): string => {
    const p: string = drive.realPath(node);
    return p.startsWith(mount) ? p.slice(mount.length) || '/' : p;
  };
  const query = (o: Record<string, string | number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
  const request = (method: string, params: Record<string, string | number>, opts: { range?: [number, number]; body?: Uint8Array; binary?: boolean } = {}) => {
    const x = new XMLHttpRequest();
    x.open(method, `${RAW}?${query(params)}`, false);
    if (opts.binary) x.responseType = 'arraybuffer';
    if (opts.range) x.setRequestHeader('Range', `bytes=${opts.range[0]}-${opts.range[1]}`);
    if (method === 'PUT') x.setRequestHeader('X-IDE-Writer', 'r');
    x.send((opts.body ?? null) as XMLHttpRequestBodyInit | null);
    if (x.status >= 400) throw new FS.ErrnoError(x.status === 409 ? EIO : ENOENT);
    return x;
  };
  const getWhole = (path: string) => new Uint8Array(request('GET', { path }, { binary: true }).response as ArrayBuffer);

  so.open = function (stream: any) {
    if (!FS.isFile(stream.node.mode)) return;
    const path = rel(stream.node);
    if ((stream.flags & O_ACCMODE) === 0) {
      const attr = drive.API.getattr(drive.realPath(stream.node));
      const size = attr.size || 0;
      if (size <= smallMax) {
        const data = getWhole(path);
        stream.file = { path, data, size: data.length, dirty: false };
        return;
      }
      const id = `${Date.now().toString(36)}-${++seq}`;
      request('GET', { op: 'open', path, id });
      stream.file = { lazy: true, path, size, id, v: `${new Date(attr.mtime).getTime()}:${size}`, blocks: new Map<number, Uint8Array>() };
    } else if (stream.flags & O_TRUNC) {
      stream.file = { path, data: new Uint8Array(0), size: 0, dirty: true };
    } else {
      const data = getWhole(path);
      stream.file = { path, data, size: data.length, dirty: false };
    }
  };

  const block = (f: any, b: number): Uint8Array => {
    let blk = f.blocks.get(b);
    if (blk) {
      f.blocks.delete(b); // LRU touch
      f.blocks.set(b, blk);
      return blk;
    }
    const start = b * blockSize;
    const end = Math.min(f.size, start + blockSize) - 1;
    blk = new Uint8Array(request('GET', { path: f.path, v: f.v }, { range: [start, end], binary: true }).response as ArrayBuffer);
    f.blocks.set(b, blk);
    if (f.blocks.size > MAX_BLOCKS) f.blocks.delete(f.blocks.keys().next().value);
    return blk;
  };

  so.read = function (stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
    const f = stream.file;
    if (!f || length <= 0) return 0;
    const n = Math.min(f.size - position, length);
    if (n <= 0) return 0;
    if (!f.lazy) {
      buffer.set(f.data.subarray(position, position + n), offset);
      return n;
    }
    let done = 0;
    while (done < n) {
      const pos = position + done;
      const b = Math.floor(pos / blockSize);
      const blk = block(f, b);
      const within = pos - b * blockSize;
      const take = Math.min(n - done, blk.length - within);
      if (take <= 0) break;
      buffer.set(blk.subarray(within, within + take), offset + done);
      done += take;
    }
    return done;
  };

  so.write = function (stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
    const f = stream.file;
    if (!f || length <= 0 || f.lazy) return 0;
    stream.node.timestamp = Date.now();
    const end = position + length;
    if (end > f.data.length) {
      const next = new Uint8Array(Math.max(end, Math.floor(f.data.length * 1.5) + 65536));
      next.set(f.data.subarray(0, f.size));
      f.data = next;
    }
    f.data.set(buffer.subarray(offset, offset + length), position);
    f.size = Math.max(f.size, end);
    f.dirty = true;
    return length;
  };

  const llseek0 = so.llseek;
  so.llseek = function (stream: any, offset: number, whence: number) {
    if (whence === 2 && stream.file) return stream.file.size + offset;
    return llseek0.call(this, stream, offset, whence);
  };

  so.close = function (stream: any) {
    const f = stream.file;
    stream.file = undefined;
    if (!f) return;
    if (f.lazy) {
      try {
        request('GET', { op: 'close', path: f.path, id: f.id });
      } catch {
        /* reader expires on its own */
      }
    } else if (f.dirty) {
      request('PUT', { path: f.path }, { body: f.data.subarray(0, f.size) });
    }
  };

  so.mmap = function (stream: any, length: number, position: number) {
    if (!FS.isFile(stream.node.mode)) throw new FS.ErrnoError(ENODEV);
    const ptr = M._memalign ? M._memalign(65536, length) : M._malloc(length);
    if (!ptr) throw new FS.ErrnoError(ENOMEM);
    const f = stream.file;
    const avail = f ? Math.max(0, Math.min(length, f.size - position)) : 0;
    const filled = avail > 0 ? so.read(stream, M.HEAPU8, ptr, avail, position) : 0;
    M.HEAPU8.fill(0, ptr + filled, ptr + length);
    return { ptr, allocated: true };
  };

  so.msync = function (stream: any, buffer: Uint8Array, offset: number, length: number) {
    so.write(stream, buffer, 0, length, offset);
    return 0;
  };

  so.__ideDrivePatch = true;
  return 'ok';
}

/** Self-check run inside the worker: map a file R just wrote and compare bytes. */
export function driveMmapCheck(path: string, expected: string): string {
  const M = (globalThis as any).Module;
  const FS = M.FS;
  const stream = FS.open(path, 'r');
  try {
    const len = expected.length;
    const res = FS.mmap(stream, len, 0, 1 /* PROT_READ */, 2 /* MAP_PRIVATE */);
    const got = new TextDecoder().decode(M.HEAPU8.slice(res.ptr, res.ptr + len));
    if (res.allocated) M._free(res.ptr);
    return got === expected ? 'ok' : `mismatch: ${JSON.stringify(got)}`;
  } finally {
    FS.close(stream);
  }
}
