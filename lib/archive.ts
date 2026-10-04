// lib/archive.ts — reading a .zip that arrived in a chat.
//
// Design: docs/design/screens/15-archive (mobile m15-archive).
//
// Uses fflate — PURE JavaScript, no native module — so this ships in the
// existing binary with no prebuild and no new Gradle dependency. A native zip
// library would have been the obvious choice and would have cost a rebuild for
// no capability we need: we list entries and extract one file at a time, both
// of which fflate does in Hermes.
//
// PURE (no react-native import) so the parsing, the tree building and — most
// importantly — the path safety are Node-tested (archive.selftest.ts).

export interface ArchiveEntry {
  /** Path as stored INSIDE the archive, unchanged. Display only. */
  path: string;
  /** Final path segment. */
  name: string;
  /** Directory portion, '' at the root. */
  dir: string;
  size: number;
  isDirectory: boolean;
}

/**
 * An archive is untrusted input from another person. Two things must never
 * happen when extracting: writing outside the destination directory
 * ("zip slip", e.g. `../../secrets`), and an absolute path escaping it.
 *
 * Returns a path safe to join onto a destination directory, or null when the
 * entry must be refused outright. Refusing is correct: an archive containing a
 * traversal entry is either broken or hostile, and neither deserves a best
 * effort.
 */
export function safeEntryPath(entryPath: string): string | null {
  if (!entryPath) return null;
  // Normalise separators; some writers use backslashes.
  const p = entryPath.replace(/\\/g, '/');
  if (p.startsWith('/')) return null;                 // absolute
  if (/^[a-zA-Z]:\//.test(p)) return null;            // windows drive
  if (p.includes('\0')) return null;                  // truncation attack

  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;                    // traversal — refuse, don't "fix"
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** Build the entry list from fflate's {path: bytes} map plus its size info. */
export function toEntries(files: Record<string, { size: number }>): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const [path, info] of Object.entries(files)) {
    const isDirectory = path.endsWith('/');
    const clean = isDirectory ? path.slice(0, -1) : path;
    const idx = clean.lastIndexOf('/');
    out.push({
      path,
      name: idx >= 0 ? clean.slice(idx + 1) : clean,
      dir: idx >= 0 ? clean.slice(0, idx) : '',
      size: info?.size ?? 0,
      isDirectory,
    });
  }
  return out;
}

/** Entries directly inside `dir` — one level, the way a file browser shows it.
 *  Implicit directories (a zip may contain `a/b.txt` with no `a/` entry) are
 *  synthesised so navigation never dead-ends. */
export function listDir(entries: ArchiveEntry[], dir = ''): ArchiveEntry[] {
  const prefix = dir ? dir + '/' : '';
  const files: ArchiveEntry[] = [];
  const subdirs = new Map<string, number>();

  for (const e of entries) {
    if (e.isDirectory) continue;
    if (prefix && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(e);
    } else {
      const sub = rest.slice(0, slash);
      subdirs.set(sub, (subdirs.get(sub) ?? 0) + 1);
    }
  }

  const dirRows: ArchiveEntry[] = [...subdirs.entries()].map(([name, count]) => ({
    path: prefix + name + '/',
    name,
    dir,
    size: count,          // for a directory row this is the child count
    isDirectory: true,
  }));

  dirRows.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirRows, ...files];   // folders first, the usual file-browser order
}

/** Parent directory of `dir`, or null at the root. */
export function parentDir(dir: string): string | null {
  if (!dir) return null;
  const i = dir.lastIndexOf('/');
  return i === -1 ? '' : dir.slice(0, i);
}

export function totalUncompressed(entries: ArchiveEntry[]): number {
  return entries.reduce((n, e) => n + (e.isDirectory ? 0 : e.size), 0);
}

/** Refuse to expand an archive that would not fit in memory. fflate decompresses
 *  into a JS buffer, so a zip bomb is a crash, not a slow load. */
export const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export function tooLargeToOpen(entries: ArchiveEntry[]): boolean {
  return totalUncompressed(entries) > MAX_UNCOMPRESSED_BYTES;
}

/** Entry-count ceiling. Each entry costs a JS object and a buffer even when
 *  empty, so a million zero-byte entries is a bomb of its own. */
export const MAX_ENTRIES = 20_000;

export type ArchiveRefusal =
  | { reason: 'size'; bytes: number }
  | { reason: 'count'; count: number };

/**
 * Zip-bomb guard, run on the CENTRAL DIRECTORY before anything is inflated
 * (fflate's unzip `filter` reports each entry's declared originalSize without
 * decompressing it). tooLargeToOpen above ran only after unzip had already
 * inflated everything into memory, so a bomb crashed the app before the check.
 *
 * Trusting the declared size is sound here: fflate inflates each entry into a
 * buffer pre-allocated at originalSize and does not grow it, so a lying header
 * yields a truncated entry, not unbounded memory.
 */
export function refuseDeclared(infos: { originalSize: number }[]): ArchiveRefusal | null {
  if (infos.length > MAX_ENTRIES) return { reason: 'count', count: infos.length };
  let bytes = 0;
  for (const i of infos) {
    const n = Number(i.originalSize);
    bytes += Number.isFinite(n) && n > 0 ? n : 0;
  }
  return bytes > MAX_UNCOMPRESSED_BYTES ? { reason: 'size', bytes } : null;
}

/** Archive formats lib/docOpen routes to the archive viewer but fflate cannot
 *  read (it reads ZIP only). Returns a display name, or null for ZIP/unknown. */
const UNSUPPORTED: Record<string, string> = {
  rar: 'RAR', '7z': '7-Zip', tar: 'TAR', gz: 'GZip', tgz: 'GZip', bz2: 'BZip2', xz: 'XZ',
};
export function unsupportedArchiveFormat(filename: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || '');
  return m ? UNSUPPORTED[m[1].toLowerCase()] ?? null : null;
}

export default {};
