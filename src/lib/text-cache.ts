// Text of workspace files, kept between searches (find in files, go to
// definition) so they don't re-read storage on every keystroke or hover.
// An entry is reused while the file's size and modified time are unchanged,
// and dropped when the IDE writes the file.
import * as fs from './opfs';

const MAX_TOTAL = 64 * 1024 * 1024; // characters kept, roughly bytes
const cache = new Map<string, { stamp: string; text: string }>();
let total = 0;

const keyOf = (ws: string, path: string) => `${ws}\n${path}`;

export async function cachedText(ws: string, node: fs.FileNode): Promise<string> {
  const key = keyOf(ws, node.path);
  const stamp = `${node.size ?? '?'}:${node.modified ?? '?'}`;
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp && node.modified !== undefined) {
    // Most recently used goes to the end.
    cache.delete(key);
    cache.set(key, hit);
    return hit.text;
  }
  const text = await fs.readText(ws, node.path);
  drop(key);
  cache.set(key, { stamp, text });
  total += text.length;
  for (const [k, v] of cache) {
    if (total <= MAX_TOTAL) break;
    cache.delete(k);
    total -= v.text.length;
  }
  return text;
}

function drop(key: string) {
  const old = cache.get(key);
  if (old) {
    total -= old.text.length;
    cache.delete(key);
  }
}

/** Forget a file (or a folder's files) after the IDE changes it. */
export function invalidateText(ws: string, path: string) {
  const prefix = keyOf(ws, path);
  for (const k of [...cache.keys()]) if (k === prefix || k.startsWith(prefix + '/')) drop(k);
}
