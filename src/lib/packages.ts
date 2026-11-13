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
// and can be cleared.
//
// In the index, "<pkg>" is the latest cached version; "<pkg>@<version>" keeps
// an older version that a workspace with its own library still uses.
//
// On start every cached package is mounted under PKG_CACHE (not searched by
// R), and the library PKG_LIB gets links to the ones the workspace uses: all
// of them for a shared library, or the listed versions for a workspace's own
// library (see workspace-config.ts). Installing a package that is already
// cached just adds a link, without downloading.

import { createStore } from 'solid-js/store';
import { setBoot, bootProgress } from './boot';
import * as fs from './opfs';
import { RSession, rString } from './r-session';
import { readLibrary, referencedVersions, writeLibrary, wsConfig, type WorkspaceLibrary } from './workspace-config';

export const PKG_LIB = '/webr-ide/library';
export const PKG_CACHE = '/webr-ide/cache';
/** Packages the IDE itself uses (codetools, styler): kept out of workspace libraries. */
export const PKG_TOOLS = '/webr-ide/tools';
const TOOLS = 'packages/tools.json'; // { "<R ver>": { "<pkg>": "<version>" } }

async function readTools(): Promise<Record<string, Record<string, string>>> {
  try {
    return JSON.parse(await (await fs.readAppFile(TOOLS)).text());
  } catch {
    return {};
  }
}
const INDEX = 'packages/index.json';

export interface CachedPackage {
  name: string;
  version: string;
  rVersion: string;
  file: string; // OPFS path
  url: string; // where it was downloaded from
  size: number;
  cachedAt: number;
  /**
   * false: only the IDE installed it (a tool such as codetools, or one of its
   * dependencies), so shared libraries don't include it. Missing = yours.
   */
  user?: boolean;
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
  /** What the library links to in this session: package → version. */
  linked: {} as Record<string, string>,
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
  const latest = Object.fromEntries(Object.entries(index[rv] ?? {}).filter(([k]) => !k.includes('@')));
  setPkgCache({ entries: latest, otherVersionsBytes: other });
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

/** Which packages (name → version) a library uses, given the cache index. */
function wanted(lib: WorkspaceLibrary, pkgs: Record<string, CachedPackage>): Record<string, string> {
  if (lib.mode === 'workspace') return { ...lib.packages };
  return Object.fromEntries(Object.entries(pkgs).filter(([k, e]) => !k.includes('@') && e.user !== false).map(([k, e]) => [k, e.version]));
}

const cacheDir = (name: string, version: string) => `${name}_${version}`;
const mountedDirs = new Set<string>();

/** Mount a cached archive under PKG_CACHE (once per session). */
async function mountCached(session: RSession, e: CachedPackage) {
  const dir = cacheDir(e.name, e.version);
  if (mountedDirs.has(dir)) return;
  const { data, metadata } = await readVfsImage(await fs.readAppFile(e.file));
  const mountpoint = `${PKG_CACHE}/${dir}`;
  await session.evalVoid(`.ide_mkdirs(${rString(mountpoint)})`);
  await session.webR.FS.mount('WORKERFS', { packages: [{ blob: new Blob([data]), metadata }] } as any, mountpoint);
  mountedDirs.add(dir);
}

const entryFor = (pkgs: Record<string, CachedPackage>, name: string, version: string) =>
  pkgs[name]?.version === version ? pkgs[name] : pkgs[`${name}@${version}`];

/**
 * Called while R starts, before the console is handed to the user: set up the
 * library + install hooks, mount every cached package and link the ones the
 * workspace `ws` uses.
 */
export async function setupPackages(session: RSession, ws: string): Promise<{ mounted: number; failed: string[]; missing: string[] }> {
  const rv = rMinor(session.versionR);
  mountedDirs.clear();
  setPkgCache({ rVersion: rv, pendingRestart: [], linked: {} });
  await session.evalVoid(`.ide_pkg_setup(${rString(PKG_LIB)}, ${rString(PKG_CACHE)}, ${rString(PKG_TOOLS)})`);

  const pkgs = await withIndex((index) => ({ ...(index[rv] ?? {}) }), false);
  const want = wanted(await readLibrary(ws), pkgs);
  const tools = (await readTools())[rv] ?? {};
  // The latest version of everything (so installs can link instead of
  // downloading), plus older versions this workspace uses.
  const toMount = new Map<string, CachedPackage>();
  for (const [k, e] of Object.entries(pkgs)) if (!k.includes('@')) toMount.set(k, e);
  for (const [n, v] of [...Object.entries(want), ...Object.entries(tools)]) {
    const e = entryFor(pkgs, n, v);
    if (e) toMount.set(`${n}@${v}`, e);
  }
  if (!toMount.size) return { mounted: 0, failed: [], missing: Object.keys(want) };

  const bad: string[] = [];
  setBoot({ label: 'Restoring your packages', done: 0, total: toMount.size });
  let done = 0;
  for (const [key, e] of toMount) {
    bootProgress(done++, toMount.size);
    try {
      await mountCached(session, e);
    } catch (err) {
      console.warn(`could not mount cached ${key}`, err);
      bad.push(key);
    }
  }
  // The IDE's own tools, in their separate library.
  const toolLinks = Object.entries(tools).filter(([n, v]) => mountedDirs.has(cacheDir(n, v)));
  if (toolLinks.length)
    await session.evalVoid(
      `.ide_pkg_link(c(${toolLinks.map(([n]) => rString(n)).join(',')}), c(${toolLinks.map(([n, v]) => rString(cacheDir(n, v))).join(',')}), ${rString(PKG_TOOLS)})`,
    );
  const linkable = Object.entries(want).filter(([n, v]) => mountedDirs.has(cacheDir(n, v)));
  const missing = Object.keys(want).filter((n) => !linkable.some(([m]) => m === n));
  await linkPackages(session, linkable);
  const failed = linkable.length ? await session.strings(`.ide_pkg_verify(c(${linkable.map(([n]) => rString(n)).join(',')}))`) : [];
  for (const n of failed) setPkgCache('linked', n, undefined!);
  // Drop index entries whose archive is gone or won't mount; they'll be re-cached on reinstall.
  const drop = [...bad, ...failed.map((n) => (pkgs[n]?.version === want[n] ? n : `${n}@${want[n]}`))];
  if (drop.length) {
    await withIndex(async (index) => {
      for (const k of drop) {
        const e = index[rv]?.[k];
        if (e) await fs.removeAppPath(e.file);
        delete index[rv]?.[k];
      }
    });
  }
  return { mounted: linkable.length - failed.length, failed: drop.map((k) => k.split('@')[0]), missing };
}

async function linkPackages(session: RSession, list: [string, string][]) {
  if (!list.length) return;
  await session.evalVoid(`.ide_pkg_link(c(${list.map(([n]) => rString(n)).join(',')}), c(${list.map(([n, v]) => rString(cacheDir(n, v))).join(',')}))`);
  for (const [n, v] of list) setPkgCache('linked', n, v);
}

/**
 * Make the running session's library match `lib`, without restarting R if
 * possible. Returns false when a package that has to go (or change version)
 * is loaded, so R must restart for the change.
 */
export async function applyLibrary(session: RSession, lib: WorkspaceLibrary): Promise<boolean> {
  const rv = pkgCache.rVersion;
  const pkgs = await withIndex((index) => ({ ...(index[rv] ?? {}) }), false);
  const want = wanted(lib, pkgs);
  const have = { ...pkgCache.linked };
  const remove = Object.keys(have).filter((n) => want[n] !== have[n]);
  if ((await loadedAmong(session, remove)).length) return false;
  for (const n of remove) {
    await session.strings(`as.character(.ide_pkg_drop(${rString(n)}))`);
    setPkgCache('linked', n, undefined!);
  }
  const add: [string, string][] = [];
  for (const [n, v] of Object.entries(want)) {
    if (have[n] === v) continue;
    const e = entryFor(pkgs, n, v);
    if (!e) continue;
    try {
      await mountCached(session, e);
      add.push([n, v]);
    } catch (err) {
      console.warn(`could not mount ${n} ${v}`, err);
    }
  }
  await linkPackages(session, add);
  return true;
}

/** True if switching to `ws` needs an R restart (its library differs from what's loaded). */
export async function libraryNeedsRestart(session: RSession, lib: WorkspaceLibrary): Promise<boolean> {
  const rv = pkgCache.rVersion;
  const pkgs = await withIndex((index) => ({ ...(index[rv] ?? {}) }), false);
  const want = wanted(lib, pkgs);
  const changed = Object.keys(pkgCache.linked).filter((n) => want[n] !== pkgCache.linked[n]);
  return (await loadedAmong(session, changed)).length > 0;
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
  const installed: [string, string][] = [];
  const toolInstalls: [string, string][] = [];
  let refs: Set<string> | null = null;
  for (let i = 0; i + 3 < log.length; i += 4) {
    const [name, version, url, where] = [log[i], log[i + 1], log[i + 2], log[i + 3]];
    if (where === 'tools') toolInstalls.push([name, version]);
    else {
      installed.push([name, version]);
      setPkgCache('linked', name, version);
    }
    // No URL: linked from the cache, nothing to download. Installed by you
    // now: it belongs in shared libraries even if a tool brought it in first.
    if (!url || pkgCache.entries[name]?.version === version) {
      if (where !== 'tools' && pkgCache.entries[name]?.user === false)
        await withIndex((index) => {
          const e = index[rv]?.[name];
          if (e) delete e.user;
        });
      continue;
    }
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      const file = `packages/${rv}/${name}_${version}.tgz`;
      await fs.writeAppFile(file, data);
      const entry: CachedPackage = { name, version, rVersion: rv, file, url, size: data.length, cachedAt: Date.now() };
      if (where === 'tools') entry.user = false;
      refs ??= new Set([...(await referencedVersions()), ...Object.entries((await readTools())[rv] ?? {}).map(([n, v]) => `${n}@${v}`)]);
      const used = refs;
      await withIndex(async (index) => {
        const pkgs = (index[rv] ??= {});
        const prev = pkgs[name];
        if (prev && prev.file !== file) {
          // Superseded: keep it if a workspace's own library still uses it.
          if (used.has(`${name}@${prev.version}`)) pkgs[`${name}@${prev.version}`] = prev;
          else await fs.removeAppPath(prev.file);
        }
        delete pkgs[`${name}@${version}`];
        pkgs[name] = entry;
      });
      setPkgCache('updates', name, undefined!);
      added.push(entry);
      // Into the cache mounts now too, so other workspaces can link it this session.
      await mountCached(session, entry).catch((e) => console.warn(`could not mount ${name} in the cache`, e));
    } catch (e) {
      console.warn(`could not cache ${name} ${version}:`, e);
    }
  }
  // The IDE's tools are remembered separately, with everything they depend
  // on (even packages that were already installed), to relink at every start.
  if (toolInstalls.length) {
    const all = await readTools();
    const flat = await session.strings(`.ide_tool_closure(c(${toolInstalls.map(([n]) => rString(n)).join(',')}))`).catch(() => [] as string[]);
    for (let i = 0; i + 1 < flat.length; i += 2) (all[rv] ??= {})[flat[i]] = flat[i + 1];
    for (const [n, v] of toolInstalls) (all[rv] ??= {})[n] = v;
    await fs.writeAppFile(TOOLS, JSON.stringify(all, null, 1));
  }
  // A workspace with its own library records what it installs.
  const lib = wsConfig.library;
  if (lib.mode === 'workspace' && installed.some(([n, v]) => lib.packages[n] !== v)) {
    const packages = { ...lib.packages };
    for (const [n, v] of installed) packages[n] = v;
    await writeLibrary(wsConfig.workspace, { mode: 'workspace', packages });
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
 * Remove packages: from this workspace's own library (the archives stay in
 * the shared cache), or with a shared library, from the cache (kept if a
 * workspace's own library still uses that version). Returns the names that
 * stay active until R restarts.
 */
export async function removeCached(session: RSession, names: string[]): Promise<string[]> {
  const rv = pkgCache.rVersion;
  const lib = wsConfig.library;
  if (lib.mode === 'workspace') {
    const packages = { ...lib.packages };
    for (const n of names) delete packages[n];
    await writeLibrary(wsConfig.workspace, { mode: 'workspace', packages });
  } else {
    const used = await referencedVersions();
    await withIndex(async (index) => {
      for (const n of names) {
        const e = index[rv]?.[n];
        if (!e) continue;
        if (used.has(`${n}@${e.version}`)) index[rv][`${n}@${e.version}`] = e;
        else await fs.removeAppPath(e.file);
        delete index[rv]?.[n];
      }
    });
  }
  const stillLoaded: string[] = [];
  for (const n of names) {
    const dropped = session.status === 'ready' ? await session.strings(`as.character(.ide_pkg_drop(${rString(n)}))`) : ['TRUE'];
    if (dropped[0] !== 'TRUE') stillLoaded.push(n);
    else setPkgCache('linked', n, undefined!);
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
