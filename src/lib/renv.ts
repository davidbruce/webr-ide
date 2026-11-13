// renv.lock support: check a desktop renv project's packages against what
// webR can install, and set the workspace up with its own library of them.
import { createSignal } from 'solid-js';
import { BASE_PACKAGES, KNOWN_ISSUES, loadRepoIndex, type RepoPackage } from './pkg-index';

export interface LockPackage {
  name: string;
  version: string;
  /** Where renv got it: Repository (CRAN etc.), GitHub, Bioconductor, … */
  source: string;
}

export interface Lockfile {
  rVersion: string;
  packages: LockPackage[];
}

export type RowStatus = 'builtin' | 'same' | 'newer' | 'older' | 'issue' | 'missing' | 'skip';

export interface CheckRow extends LockPackage {
  status: RowStatus;
  /** Version webR has (repo or built in). */
  webrVersion?: string;
  note?: string;
}

export interface CheckResult {
  lock: Lockfile;
  rows: CheckRow[];
  verdict: 'compatible' | 'versions' | 'partial' | 'none';
  /** Packages to install from the webR repo. */
  installable: string[];
  /** Short hash of the lockfile, to remember it was checked. */
  hash: string;
  repoError?: string;
}

export function parseLockfile(text: string): Lockfile {
  const json = JSON.parse(text);
  const pkgs = json.Packages ?? {};
  return {
    rVersion: json.R?.Version ?? '',
    packages: Object.entries<any>(pkgs).map(([key, p]) => ({
      name: p.Package ?? key,
      version: String(p.Version ?? ''),
      source: p.Source === 'Repository' ? (p.Repository ?? 'CRAN') : String(p.Source ?? p.RemoteType ?? 'unknown'),
    })),
  };
}

/** Compare R package versions ("1.2-3" style). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function hashText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check every locked package against the webR repository and the packages
 * built into webR (`builtin`: name → version, from the running R).
 */
export async function checkLockfile(text: string, rVersion: string, builtin: Map<string, string>): Promise<CheckResult> {
  const lock = parseLockfile(text);
  let index = new Map<string, { version: string }>();
  let repoError: string | undefined;
  try {
    index = await loadRepoIndex(rVersion);
  } catch (e) {
    repoError = `Couldn't load webR's package list (${e}). Connect once to check.`;
  }
  const rows: CheckRow[] = lock.packages.map((p) => {
    if (p.name === 'renv') return { ...p, status: 'skip', note: 'Not needed: the IDE manages packages' };
    const built = builtin.get(p.name) ?? (BASE_PACKAGES.has(p.name) ? '' : undefined);
    if (built !== undefined) return { ...p, status: 'builtin', webrVersion: built || undefined };
    const repo = index.get(p.name);
    if (!repo) {
      const why = /github|gitlab|bitbucket|git/i.test(p.source)
        ? `From ${p.source}; no webR build in the repository`
        : /bioc/i.test(p.source)
          ? 'Bioconductor packages aren\'t in the webR repository'
          : 'No webR build';
      return { ...p, status: 'missing', note: why };
    }
    if (KNOWN_ISSUES[p.name]) return { ...p, status: 'issue', webrVersion: repo.version, note: KNOWN_ISSUES[p.name] };
    const cmp = compareVersions(repo.version, p.version);
    return { ...p, status: cmp === 0 ? 'same' : cmp > 0 ? 'newer' : 'older', webrVersion: repo.version };
  });
  const counted = rows.filter((r) => r.status !== 'skip');
  const missing = counted.filter((r) => r.status === 'missing' || r.status === 'issue').length;
  const differ = counted.filter((r) => r.status === 'newer' || r.status === 'older').length;
  const verdict = repoError
    ? 'partial'
    : missing === 0
      ? differ === 0
        ? 'compatible'
        : 'versions'
      : missing === counted.length
        ? 'none'
        : 'partial';
  const installable = rows.filter((r) => r.status === 'same' || r.status === 'newer' || r.status === 'older').map((r) => r.name);
  return { lock, rows, verdict, installable, hash: await hashText(text), repoError };
}

/**
 * Build an renv.lock for `packages` (name → version) that `renv::restore()`
 * can use on desktop R. An existing lockfile is updated rather than replaced:
 * its R version and repositories stay, and so do entries webR can't provide
 * (GitHub, Bioconductor, …), so a desktop project keeps them after a round
 * trip through the browser.
 */
export interface VersionChange {
  name: string;
  /** Version in the existing renv.lock. */
  locked: string;
  /** Version this workspace uses in webR. */
  webr: string;
}

/**
 * Packages whose locked version differs from the one the workspace uses.
 * Writing would change these pins, so the user is asked first.
 */
export function versionChanges(existing: string | null, packages: Record<string, string>): VersionChange[] {
  let old: Record<string, any> = {};
  try {
    old = existing ? (JSON.parse(existing).Packages ?? {}) : {};
  } catch {
    return [];
  }
  return Object.entries(packages)
    .filter(([n, v]) => old[n]?.Version && old[n].Version !== v && !BASE_PACKAGES.has(n))
    .map(([n, v]) => ({ name: n, locked: String(old[n].Version), webr: v }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildLockfile(
  existing: string | null,
  packages: Record<string, string>,
  opts: {
    rVersion: string;
    index: Map<string, RepoPackage> | null;
    builtin: Set<string>;
    /** Leave entries already in the lockfile at their locked versions. */
    keepLocked?: boolean;
  },
): string {
  let base: any = {};
  try {
    base = existing ? JSON.parse(existing) : {};
  } catch {
    base = {};
  }
  const R = base.R ?? { Version: opts.rVersion, Repositories: [{ Name: 'CRAN', URL: 'https://cloud.r-project.org' }] };
  const old: Record<string, any> = base.Packages ?? {};
  const out: Record<string, any> = {};
  // Keep renv's own record (restore uses it), and what webR can't provide:
  // packages not in the webR repository and not built in.
  for (const [name, rec] of Object.entries(old)) {
    if (packages[name]) continue;
    if (name === 'renv') {
      out[name] = rec;
      continue;
    }
    const providable = opts.index ? opts.index.has(name) || opts.builtin.has(name) || BASE_PACKAGES.has(name) : false;
    if (!providable) out[name] = rec;
  }
  for (const [name, version] of Object.entries(packages)) {
    if (BASE_PACKAGES.has(name)) continue;
    const prev = old[name];
    if (opts.keepLocked && prev?.Version && prev.Version !== version) {
      out[name] = prev; // pinned: leave it exactly as it was
      continue;
    }
    const repo = opts.index?.get(name);
    const requirements = repo ? [...new Set([...repo.depends, ...repo.imports, ...repo.linkingTo])].filter((d) => !BASE_PACKAGES.has(d)).sort() : undefined;
    const rec: Record<string, unknown> = {
      Package: name,
      Version: version,
      Source: 'Repository',
      Repository: prev?.Repository && prev?.Source === 'Repository' ? prev.Repository : 'CRAN',
    };
    if (requirements?.length) rec.Requirements = requirements;
    // A hash only stays valid for the same version; renv computes missing ones.
    if (prev?.Hash && prev.Version === version) rec.Hash = prev.Hash;
    out[name] = rec;
  }
  const sorted = Object.fromEntries(Object.keys(out).sort((a, b) => a.localeCompare(b)).map((k) => [k, out[k]]));
  return JSON.stringify({ ...base, R, Packages: sorted }, null, 2) + '\n';
}

/** The renv check dialog (RenvDialog) for the current workspace. */
export const [renvCheck, setRenvCheck] = createSignal<CheckResult | null>(null);
