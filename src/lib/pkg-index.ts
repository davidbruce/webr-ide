// Package metadata for the package browser.
//
// - The webR binary repository index (PACKAGES) says what can actually be
//   installed in webR: names, versions and dependencies. It's fetched once
//   and works offline via the service worker's network-first cache.
// - R-universe (CRAN mirror, CORS-enabled) provides full-text search,
//   titles, descriptions and popularity. Only package names and the search
//   text are sent; results are filtered to what webR can install.

export const WEBR_REPO = 'https://repo.r-wasm.org';
const R_UNIVERSE = 'https://cran.r-universe.dev';

export interface RepoPackage {
  name: string;
  version: string;
  depends: string[];
  imports: string[];
  linkingTo: string[];
  suggests: string[];
  license: string;
}

export interface PackageHit {
  name: string;
  version: string; // webR repo version
  title?: string;
  usedBy?: number;
}

export interface PackageDetails {
  name: string;
  title?: string;
  description?: string;
  cranVersion?: string;
  license?: string;
  maintainer?: string;
  authors?: string;
  published?: string;
  downloads?: number;
  usedBy?: number;
  urls: string[];
  bugReports?: string;
}

/**
 * Packages that have a webR build but are known not to work in the browser
 * (verified with webR 0.6.1). Shown as warnings in the package browser.
 */
export const KNOWN_ISSUES: Record<string, string> = {
  RSQLite: "Its compiled code doesn't load in webR 0.6.1, and the failed load can break other packages until R restarts. Use duckdb instead.",
  googlesheets4: "Needs Google's OAuth sign-in, which can't run inside the browser. Download the sheet as CSV/XLSX instead.",
  googledrive: "Needs Google's OAuth sign-in, which can't run inside the browser.",
};

/** Packages that ship with R itself (never installed from the repo). */
export const BASE_PACKAGES = new Set([
  'R', 'base', 'compiler', 'datasets', 'graphics', 'grDevices', 'grid', 'methods', 'parallel',
  'splines', 'stats', 'stats4', 'tcltk', 'tools', 'utils', 'translations', 'webr',
]);

// ---------------------------------------------------------------- webR repo index

let indexPromise: Promise<Map<string, RepoPackage>> | null = null;
let indexFor = '';

export function loadRepoIndex(rVersion: string): Promise<Map<string, RepoPackage>> {
  if (indexPromise && indexFor === rVersion) return indexPromise;
  indexFor = rVersion;
  indexPromise = fetch(`${WEBR_REPO}/bin/emscripten/contrib/${rVersion}/PACKAGES`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then(parsePackages)
    .catch((e) => {
      indexPromise = null;
      throw e;
    });
  return indexPromise;
}

function parsePackages(text: string): Map<string, RepoPackage> {
  const out = new Map<string, RepoPackage>();
  for (const block of text.split(/\n\s*\n/)) {
    const f: Record<string, string> = {};
    let key = '';
    for (const line of block.split('\n')) {
      if (/^\s/.test(line) && key) f[key] += ' ' + line.trim();
      else {
        const i = line.indexOf(':');
        if (i > 0) {
          key = line.slice(0, i);
          f[key] = line.slice(i + 1).trim();
        }
      }
    }
    if (!f.Package) continue;
    out.set(f.Package, {
      name: f.Package,
      version: f.Version ?? '',
      depends: deps(f.Depends),
      imports: deps(f.Imports),
      linkingTo: deps(f.LinkingTo),
      suggests: deps(f.Suggests),
      license: f.License ?? '',
    });
  }
  return out;
}

function deps(field?: string): string[] {
  if (!field) return [];
  return field
    .split(',')
    .map((d) => d.replace(/\(.*?\)/g, '').trim())
    .filter((d) => d && d !== 'R');
}

/** Packages that installing `name` would add (Depends + Imports, recursively). */
export function missingDependencies(index: Map<string, RepoPackage>, name: string, installed: Set<string>): string[] {
  const seen = new Set<string>();
  const stack = [name];
  while (stack.length) {
    const p = index.get(stack.pop()!);
    if (!p) continue;
    for (const d of [...p.depends, ...p.imports]) {
      if (seen.has(d) || BASE_PACKAGES.has(d) || installed.has(d)) continue;
      seen.add(d);
      stack.push(d);
    }
  }
  seen.delete(name);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- search

/** Name matches from the local index: exact, then prefix, then substring. */
export function searchNames(index: Map<string, RepoPackage>, query: string, limit = 40): PackageHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: RepoPackage[] = [];
  const prefix: RepoPackage[] = [];
  const contains: RepoPackage[] = [];
  for (const p of index.values()) {
    const n = p.name.toLowerCase();
    if (n === q) exact.push(p);
    else if (n.startsWith(q)) prefix.push(p);
    else if (n.includes(q)) contains.push(p);
  }
  const byLen = (a: RepoPackage, b: RepoPackage) => a.name.length - b.name.length || a.name.localeCompare(b.name);
  return [...exact, ...prefix.sort(byLen), ...contains.sort(byLen)].slice(0, limit).map((p) => ({ name: p.name, version: p.version }));
}

interface RemoteHit {
  Package: string;
  Title?: string;
  _score?: number;
  _usedby?: number;
}

/**
 * Full-text search via R-universe, re-ranked to balance relevance with
 * popularity (reverse dependencies) and name/title matches.
 */
export async function searchRemote(query: string, signal?: AbortSignal): Promise<{ name: string; title: string; usedBy: number }[]> {
  const res = await fetch(`${R_UNIVERSE}/api/search?q=${encodeURIComponent(query)}&limit=100`, { signal });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const { results } = (await res.json()) as { results: RemoteHit[] };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rank = (h: RemoteHit) => {
    const name = h.Package.toLowerCase();
    const title = (h.Title ?? '').toLowerCase();
    let s = (h._score ?? 0) * (1 + 0.35 * Math.log10(1 + (h._usedby ?? 0)));
    if (terms.some((t) => name.includes(t))) s *= 3;
    if (terms.every((t) => title.includes(t) || name.includes(t))) s *= 1.5;
    return s;
  };
  return results
    .map((h) => ({ h, s: rank(h) }))
    .sort((a, b) => b.s - a.s)
    .map(({ h }) => ({ name: h.Package, title: clean(h.Title) ?? '', usedBy: h._usedby ?? 0 }));
}

const detailsCache = new Map<string, Promise<PackageDetails>>();

export function fetchDetails(name: string): Promise<PackageDetails> {
  let p = detailsCache.get(name);
  if (!p) {
    p = fetch(`${R_UNIVERSE}/api/packages/${encodeURIComponent(name)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: any): PackageDetails => ({
        name,
        title: clean(d.Title),
        description: clean(d.Description),
        cranVersion: d.Version,
        license: d.License,
        maintainer: clean(d.Maintainer)?.replace(/\s*<[^>]*>/, ''),
        authors: clean(d.Author)?.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\([^)]*ORCID[^)]*\)/g, ''),
        published: d['Date/Publication']?.slice(0, 10),
        downloads: d._downloads?.count,
        usedBy: d._usedby,
        urls: String(d.URL ?? '')
          .split(/[\s,]+/)
          .filter((u: string) => /^https?:\/\//.test(u)),
        bugReports: /^https?:\/\//.test(d.BugReports ?? '') ? d.BugReports : undefined,
      }))
      .catch((e) => {
        detailsCache.delete(name);
        throw e;
      });
    detailsCache.set(name, p);
  }
  return p;
}

function clean(s?: string): string | undefined {
  return s?.replace(/\s+/g, ' ').trim() || undefined;
}

/** Shown when the search box is empty. */
export const POPULAR: { name: string; title: string }[] = [
  { name: 'tidyverse', title: 'Easily install and load the tidyverse' },
  { name: 'ggplot2', title: 'Create elegant data visualisations using the grammar of graphics' },
  { name: 'dplyr', title: 'A grammar of data manipulation' },
  { name: 'tidyr', title: 'Tidy messy data' },
  { name: 'readr', title: 'Read rectangular text data' },
  { name: 'readxl', title: 'Read Excel files' },
  { name: 'stringr', title: 'Simple, consistent wrappers for common string operations' },
  { name: 'lubridate', title: 'Make dealing with dates a little easier' },
  { name: 'purrr', title: 'Functional programming tools' },
  { name: 'data.table', title: 'Extension of data.frame' },
  { name: 'jsonlite', title: 'A simple and robust JSON parser and generator for R' },
  { name: 'broom', title: 'Convert statistical objects into tidy tibbles' },
  { name: 'janitor', title: 'Simple tools for examining and cleaning dirty data' },
  { name: 'patchwork', title: 'The composer of plots' },
  { name: 'gt', title: 'Easily create presentation-ready display tables' },
  { name: 'duckdb', title: 'DBI package for the DuckDB database management system' },
  { name: 'tidymodels', title: 'Easily install and load the tidymodels packages' },
  { name: 'palmerpenguins', title: 'Palmer Archipelago (Antarctica) penguin data' },
  { name: 'nycflights13', title: 'Flights that departed NYC in 2013' },
  { name: 'gapminder', title: 'Data from Gapminder' },
];
