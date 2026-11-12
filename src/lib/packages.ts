// Versioned, persistent package cache.
//
// webR installs a package by mounting `<pkg>_<version>.tgz` from the repo.
// We keep a copy of each of those archives in OPFS:
//
//   packages/<R major.minor>/<pkg>_<version>.tgz
//   packages/index.json   { "<R ver>": { "<pkg>": CachedPackage } }
//
// Archives are keyed by R version because webR binaries are built per R
// minor release; after a webR upgrade to a new R, the old ones are ignored
// and can be cleared. On start, every cached package for the running R
// version is mounted from a blob: URL before the console becomes usable.

import { createStore } from 'solid-js/store';
import * as fs from './opfs';
import { RSession, rString } from './r-session';

export const PKG_LIB = '/webr-ide/library';
const INDEX = 'packages/index.json';

export interface CachedPackage {
  name: string;
  version: string;
  rVersion: string;
  file: string; // OPFS path
  url: string; // where it was downloaded from
  size: number;
  cachedAt: number;
}

type Index = Record<string, Record<string, CachedPackage>>;

export interface PackageUpdate {
  name: string;
  installed: string;
  available: string;
}

const [pkgCache, setPkgCache] = createStore({
  rVersion: '',
  entries: {} as Record<string, CachedPackage>, // for the running R version
  otherVersionsBytes: 0, // archives for other R versions
  updates: {} as Record<string, PackageUpdate>,
  checkedAt: 0,
  pendingRestart: [] as string[], // updated/removed while loaded
});
export { pkgCache };

let indexChain: Promise<unknown> = Promise.resolve();
/** Serialize read-modify-write of the index. */
function withIndex<T>(fn: (index: Index) => Promise<T> | T, write = true): Promise<T> {
  const run = indexChain.then(async () => {
    const index = await readIndex();
    const result = await fn(index);
    if (write) await fs.writeAppFile(INDEX, JSON.stringify(index, null, 1));
    publish(index);
    return result;
  });
  indexChain = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<Index> {
  try {
    return JSON.parse(await (await fs.readAppFile(INDEX)).text());
  } catch {
    return {};
  }
}

function publish(index: Index) {
  const rv = pkgCache.rVersion;
  let other = 0;
  for (const [ver, pkgs] of Object.entries(index)) {
    if (ver === rv) continue;
    for (const p of Object.values(pkgs)) other += p.size;
  }
  setPkgCache({ entries: { ...(index[rv] ?? {}) }, otherVersionsBytes: other });
}

/**
 * Unpack a webR package image (.tgz) the way webR's own mount does: gunzip,
 * then find the VFS metadata via the trailer or the `.vfs-index.json` entry.
 * Mounting with a Blob (not a blob: URL) works in Safari's worker too.
 */
async function readVfsImage(tgz: Blob): Promise<{ data: ArrayBuffer; metadata: unknown }> {
  const data = await new Response(tgz.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const loc = vfsTrailer(data) ?? vfsIndexEntry(data);
  if (!loc) throw new Error('no VFS metadata in package image');
  const json = new TextDecoder().decode(new Uint8Array(data, 512 * loc.block, loc.len));
  return { data, metadata: JSON.parse(json) };
}

function vfsTrailer(buf: ArrayBuffer): { block: number; len: number } | null {
  if (buf.byteLength < 16) return null;
  const v = new DataView(buf);
  const magic = v.getInt32(buf.byteLength - 16);
  const block = v.getInt32(buf.byteLength - 8);
  const len = v.getInt32(buf.byteLength - 4);
  return magic !== 2003133010 || block === 0 || len === 0 ? null : { block, len };
}

function vfsIndexEntry(buf: ArrayBuffer): { block: number; len: number } | null {
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.byteLength) {
    const header = new Uint8Array(buf, off, 512);
    off += 512;
    if (header.every((b) => b === 0)) return null;
    const type = dec.decode(header.subarray(156, 157));
    const size = parseInt(dec.decode(header.subarray(124, 136)), 8) || 0;
    if (/5|g|[A-Z]/.test(type)) continue;
    const name = dec.decode(header.subarray(0, 100)).replace(/\0+$/, '');
    if (name === '.vfs-index.json') return { block: off / 512, len: size };
    off += 512 * Math.ceil(size / 512);
  }
  return null;
}

export function rMinor(versionR: string): string {
  return versionR.split('.').slice(0, 2).join('.');
}

export const cachedBytes = () => Object.values(pkgCache.entries).reduce((n, p) => n + p.size, 0);

/**
 * Called while R starts, before the console is handed to the user: set up the
 * user library + install hooks, then mount every cached package.
 */
export async function setupPackages(session: RSession): Promise<{ mounted: number; failed: string[] }> {
  const rv = rMinor(session.versionR);
  setPkgCache({ rVersion: rv, pendingRestart: [] });
  await session.evalVoid(`.ide_pkg_setup(${rString(PKG_LIB)})`);

  const entries = await withIndex((index) => Object.values(index[rv] ?? {}), false);
  if (!entries.length) return { mounted: 0, failed: [] };

  const mounted: string[] = [];
  const missing: string[] = [];
  for (const e of entries) {
    try {
      const { data, metadata } = await readVfsImage(await fs.readAppFile(e.file));
      const mountpoint = `${PKG_LIB}/${e.name}`;
      await session.evalVoid(`.ide_mkdirs(${rString(mountpoint)})`);
      await session.webR.FS.mount('WORKERFS', { packages: [{ blob: new Blob([data]), metadata }] } as any, mountpoint);
      mounted.push(e.name);
    } catch (err) {
      console.warn(`could not mount cached ${e.name}`, err);
      missing.push(e.name);
    }
  }
  const failed = mounted.length ? await session.strings(`.ide_pkg_verify(c(${mounted.map(rString).join(',')}))`) : [];
  // Drop index entries whose archive is gone or won't mount; they'll be re-cached on reinstall.
  const bad = [...missing, ...failed];
  if (bad.length) {
    await withIndex(async (index) => {
      for (const n of bad) {
        const e = index[rv]?.[n];
        if (e) await fs.removeAppPath(e.file);
        delete index[rv]?.[n];
      }
    });
  }
  return { mounted: mounted.length - failed.length, failed: bad };
}

/**
 * After a command finishes: store archives for anything webR installed.
 * Returns the newly cached packages.
 */
export async function captureInstalls(session: RSession): Promise<CachedPackage[]> {
  const log = await session.strings('.ide_pkg_take_log()');
  if (!log.length) return [];
  const rv = pkgCache.rVersion || rMinor(session.versionR);
  const added: CachedPackage[] = [];
  for (let i = 0; i + 2 < log.length; i += 3) {
    const [name, version, url] = [log[i], log[i + 1], log[i + 2]];
    if (pkgCache.entries[name]?.version === version) continue;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      const file = `packages/${rv}/${name}_${version}.tgz`;
      await fs.writeAppFile(file, data);
      const entry: CachedPackage = { name, version, rVersion: rv, file, url, size: data.length, cachedAt: Date.now() };
      await withIndex(async (index) => {
        const prev = index[rv]?.[name];
        if (prev && prev.file !== file) await fs.removeAppPath(prev.file); // superseded version
        (index[rv] ??= {})[name] = entry;
      });
      setPkgCache('updates', name, undefined!);
      added.push(entry);
    } catch (e) {
      console.warn(`could not cache ${name} ${version}:`, e);
    }
  }
  return added;
}

/** Ask the repository which cached packages have newer versions. */
export async function checkUpdates(session: RSession): Promise<PackageUpdate[]> {
  const entries = Object.values(pkgCache.entries);
  if (!entries.length) {
    setPkgCache({ updates: {}, checkedAt: Date.now() });
    return [];
  }
  const flat = await session.strings(
    `.ide_pkg_updates(c(${entries.map((e) => rString(e.name)).join(',')}), c(${entries.map((e) => rString(e.version)).join(',')}))`,
  );
  const updates: Record<string, PackageUpdate> = {};
  for (let i = 0; i + 2 < flat.length; i += 3) updates[flat[i]] = { name: flat[i], installed: flat[i + 1], available: flat[i + 2] };
  setPkgCache({ updates, checkedAt: Date.now() });
  return Object.values(updates);
}

/** Packages among `names` whose namespace is loaded in this session. */
export async function loadedAmong(session: RSession, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  return session.strings(`.ide_pkg_loaded(c(${names.map(rString).join(',')}))`);
}

/**
 * Remove packages from the cache, and from the running session if they
 * aren't loaded. Returns the names that stay active until R restarts.
 */
export async function removeCached(session: RSession, names: string[]): Promise<string[]> {
  const rv = pkgCache.rVersion;
  await withIndex(async (index) => {
    for (const n of names) {
      const e = index[rv]?.[n];
      if (e) await fs.removeAppPath(e.file);
      delete index[rv]?.[n];
    }
  });
  const stillLoaded: string[] = [];
  for (const n of names) {
    const dropped = session.status === 'ready' ? await session.strings(`as.character(.ide_pkg_drop(${rString(n)}))`) : ['TRUE'];
    if (dropped[0] !== 'TRUE') stillLoaded.push(n);
  }
  if (stillLoaded.length) setPkgCache('pendingRestart', (p) => [...new Set([...p, ...stillLoaded])]);
  return stillLoaded;
}

/** Delete archives built for other R versions (left over after a webR upgrade). */
export async function clearOtherRVersions(): Promise<void> {
  const rv = pkgCache.rVersion;
  await withIndex(async (index) => {
    for (const ver of Object.keys(index)) {
      if (ver === rv) continue;
      await fs.removeAppPath(`packages/${ver}`);
      delete index[ver];
    }
  });
}
