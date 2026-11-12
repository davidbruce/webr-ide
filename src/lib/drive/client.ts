// Page side of the workspace drive: mounting a workspace into webR straight
// from OPFS (no copy in R's memory), saving through the service worker, and
// listening for files R changed.

import type { WebR } from 'webr';
import { BLOCK_SIZE, SMALL_FILE_MAX, WRITER_HEADER } from './protocol';
import { drivePatch, driveMmapCheck } from './worker-patch';

/** Resolve once this page is controlled by our service worker (or give up). */
export async function driveServiceWorker(timeoutMs = 3000): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
  if (!reg) return null;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((r) => {
      const t = setTimeout(r, timeoutMs);
      navigator.serviceWorker.addEventListener('controllerchange', () => (clearTimeout(t), r()), { once: true });
    });
  }
  return navigator.serviceWorker.controller ? reg : null;
}

let scopeUrl: string | null = null;

export function setDriveScope(scope: string) {
  scopeUrl = scope;
}

/** Base URL of the drive API for one workspace, e.g. https://host/app/ws/Default/ */
export function driveBase(ws: string): string {
  if (!scopeUrl) throw new Error('drive not initialised');
  return new URL(`ws/${encodeURIComponent(ws)}/`, scopeUrl).href;
}

const runInWorker = <A extends unknown[]>(webR: WebR, fn: (...args: A) => string, ...args: A) =>
  webR.evalRString(`webr::eval_js(${JSON.stringify(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`)})`);

/** Mount a workspace folder at `mountpoint` and install our stream handling. */
export async function mountDrive(webR: WebR, ws: string, mountpoint: string): Promise<void> {
  await webR.FS.mount('DRIVEFS', { browsingContextId: 'webr-ide' } as any, mountpoint);
  try {
    const r = await runInWorker(webR, drivePatch, mountpoint, driveBase(ws), SMALL_FILE_MAX, BLOCK_SIZE);
    if (r !== 'ok') throw new Error(r);
  } catch (e) {
    await webR.FS.unmount(mountpoint).catch(() => {});
    throw e;
  }
}

export async function unmountDrive(webR: WebR, mountpoint: string): Promise<void> {
  await webR.FS.unmount(mountpoint);
}

/**
 * Exercise the mount end to end before trusting it with user files: write,
 * read, mmap, rename and delete in a scratch folder. Throws on any mismatch.
 */
export async function selfTestDrive(webR: WebR, mountpoint: string): Promise<void> {
  const dir = `${mountpoint}/.ide/selftest-${Date.now().toString(36)}`;
  const q = (s: string) => JSON.stringify(s);
  const ok = await webR.evalRString(`local({
    d <- ${q(dir)}
    dir.create(d, recursive = TRUE, showWarnings = FALSE)
    f <- file.path(d, "t.csv")
    df <- data.frame(a = 1:3, b = c("x", "y", "z"))
    write.csv(df, f, row.names = FALSE)
    r1 <- identical(read.csv(f), df)
    cat("tail\\n", file = f, append = TRUE)
    r2 <- tail(readLines(f), 1) == "tail"
    f2 <- file.path(d, "t2.csv")
    file.rename(f, f2)
    r3 <- file.exists(f2) && !file.exists(f)
    saveRDS(mtcars, file.path(d, "m.rds"))
    r4 <- identical(readRDS(file.path(d, "m.rds")), mtcars)
    writeLines("mmap-check", file.path(d, "map.txt"))
    paste(r1, r2, r3, r4)
  })`);
  if (ok !== 'TRUE TRUE TRUE TRUE') throw new Error(`file self-test failed (${ok})`);
  const mm = await runInWorker(webR, driveMmapCheck, `${dir}/map.txt`, 'mmap-check');
  if (mm !== 'ok') throw new Error(`mmap self-test failed (${mm})`);
  await webR.evalRVoid(`unlink(${q(dir)}, recursive = TRUE)`);
}

/**
 * Write a workspace file through the service worker. If R is part-way through
 * reading it, the write waits for R to finish (up to 15 s).
 */
export async function driveWrite(ws: string, path: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${driveBase(ws)}api/drive-raw?path=${encodeURIComponent('/' + path)}`, {
    method: 'PUT',
    headers: { [WRITER_HEADER]: 'page' },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(`write failed (${res.status}): ${await res.text()}`);
}

export interface DriveChange {
  ws: string;
  changed: string[];
  deleted: string[];
}

/** Subscribe to files R created, changed or deleted. */
export function onDriveChange(fn: (c: DriveChange) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'drive-changed') fn(e.data as DriveChange);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
