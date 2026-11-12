/// <reference lib="webworker" />
// Fallback writer for browsers without FileSystemFileHandle.createWritable()
// (older Safari). Sync access handles are only available inside workers.

interface WriteRequest {
  id: number;
  segments: string[];
  data: ArrayBuffer;
}

self.onmessage = async (ev: MessageEvent<WriteRequest>) => {
  const { id, segments, data } = ev.data;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const seg of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const file = await dir.getFileHandle(segments[segments.length - 1], { create: true });
    const handle = await (file as any).createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(new Uint8Array(data), { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
    (self as any).postMessage({ id, ok: true });
  } catch (err) {
    (self as any).postMessage({ id, ok: false, error: String(err) });
  }
};
