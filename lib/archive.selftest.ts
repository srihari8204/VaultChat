// lib/archive.selftest.ts — run: npx tsx lib/archive.selftest.ts
//
// An archive is untrusted input from another person, so the security case is
// tested first and hardest: a zip whose entry is named `../../secrets` must be
// REFUSED, not sanitised into something plausible. The rest covers navigation,
// where the failure mode is a folder you cannot get back out of.

import {
  listDir, parentDir, safeEntryPath, toEntries, tooLargeToOpen, totalUncompressed,
  MAX_UNCOMPRESSED_BYTES, MAX_ENTRIES, refuseDeclared, unsupportedArchiveFormat,
} from './archive';
import { unzip, zipSync, type Unzipped, type UnzipFileInfo } from 'fflate';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nArchive self-test\n');

// ── zip slip: the whole reason this file exists ────────────────────────
console.log('Path safety:');
eq('a normal path is kept', safeEntryPath('docs/report.pdf'), 'docs/report.pdf');
eq('a leading ./ is dropped', safeEntryPath('./a/b.txt'), 'a/b.txt');
eq('backslash separators are normalised', safeEntryPath('a\\b\\c.txt'), 'a/b/c.txt');
eq('redundant slashes collapse', safeEntryPath('a//b///c.txt'), 'a/b/c.txt');

for (const evil of [
  '../secrets',
  '../../etc/passwd',
  'a/../../b',
  'a/b/../../../c',
  '/etc/passwd',
  '/',
  'C:/Windows/System32/x.dll',
  'c:/x',
  'a/\0b',
]) {
  eq(`REFUSED: ${JSON.stringify(evil)}`, safeEntryPath(evil), null);
}
eq('an empty path is refused', safeEntryPath(''), null);
eq('a dot-only path is refused', safeEntryPath('./'), null);
check('traversal is never "repaired" into a valid path',
  ['../x', 'a/../../x'].every(p => safeEntryPath(p) === null));

// ── entries ────────────────────────────────────────────────────────────
console.log('\nEntries:');
const raw = {
  'readme.md': { size: 120 },
  'src/': { size: 0 },
  'src/index.ts': { size: 900 },
  'src/lib/util.ts': { size: 400 },
  'assets/logo.png': { size: 2048 },
};
const entries = toEntries(raw);
eq('every raw entry becomes one row', entries.length, Object.keys(raw).length);
eq('a trailing slash marks a directory', entries.find(e => e.path === 'src/')?.isDirectory, true);
eq('name is the last segment', entries.find(e => e.path === 'src/lib/util.ts')?.name, 'util.ts');
eq('dir is everything before it', entries.find(e => e.path === 'src/lib/util.ts')?.dir, 'src/lib');
eq('a root file has no dir', entries.find(e => e.path === 'readme.md')?.dir, '');

// ── navigation ─────────────────────────────────────────────────────────
console.log('\nNavigation:');
const root = listDir(entries, '');
eq('root lists folders first, then files',
  root.map(e => e.name), ['assets', 'src', 'readme.md']);
check('root folders are marked as such', root[0].isDirectory && root[1].isDirectory);
check('root files are not', !root[2].isDirectory);

const src = listDir(entries, 'src');
eq('a subfolder lists its own children', src.map(e => e.name), ['lib', 'index.ts']);
eq('nested folder resolves', listDir(entries, 'src/lib').map(e => e.name), ['util.ts']);

// A zip may omit directory entries entirely; navigation must still work.
const implicitOnly = toEntries({ 'deep/nested/file.txt': { size: 10 } });
eq('an implicit directory is synthesised', listDir(implicitOnly, '').map(e => e.name), ['deep']);
eq('and is navigable', listDir(implicitOnly, 'deep').map(e => e.name), ['nested']);
eq('down to the file', listDir(implicitOnly, 'deep/nested').map(e => e.name), ['file.txt']);

eq('root has no parent', parentDir(''), null);
eq('one level up from a subfolder is the root', parentDir('src'), '');
eq('one level up from nested', parentDir('src/lib'), 'src');
check('you can always climb back out',
  (() => { let d: string | null = 'a/b/c'; let n = 0; while (d !== null && n < 10) { d = parentDir(d); n++; } return d === null; })());

eq('an unknown folder lists nothing', listDir(entries, 'nope'), []);

// ── zip bomb guard ─────────────────────────────────────────────────────
console.log('\nLimits:');
eq('directories do not count toward size', totalUncompressed(entries), 120 + 900 + 400 + 2048);
check('a normal archive opens', !tooLargeToOpen(entries));
check('an oversized archive is refused',
  tooLargeToOpen(toEntries({ 'big.bin': { size: MAX_UNCOMPRESSED_BYTES + 1 } })));

// Declared-size guard: runs on the central directory BEFORE inflating.
eq('a small archive is not refused', refuseDeclared([{ originalSize: 10 }, { originalSize: 20 }]), null);
eq('declared bytes over the cap are refused',
  refuseDeclared([{ originalSize: MAX_UNCOMPRESSED_BYTES }, { originalSize: 1 }]),
  { reason: 'size', bytes: MAX_UNCOMPRESSED_BYTES + 1 });
eq('too many entries are refused',
  refuseDeclared(Array.from({ length: MAX_ENTRIES + 1 }, () => ({ originalSize: 0 }))),
  { reason: 'count', count: MAX_ENTRIES + 1 });
eq('junk sizes count as 0, not NaN', refuseDeclared([{ originalSize: NaN }, { originalSize: -5 }]), null);

console.log('\nFormats:');
eq('rar is named, not attempted', unsupportedArchiveFormat('photos.RAR'), 'RAR');
eq('7z is named', unsupportedArchiveFormat('a.7z'), '7-Zip');
eq('tar.gz is named by its last extension', unsupportedArchiveFormat('src.tar.gz'), 'GZip');
eq('zip is supported', unsupportedArchiveFormat('a.zip'), null);
eq('no extension is not refused here', unsupportedArchiveFormat('archive'), null);

// The screen relies on two fflate behaviours; pin them so an upgrade that
// changes either fails here rather than on a user's phone.
async function fflateContract() {
  console.log('\nfflate contract:');
  const zip = zipSync({ 'z.bin': new Uint8Array(100_000) }, { level: 9 });
  const seen: UnzipFileInfo[] = [];
  const none = await new Promise<Unzipped>((res, rej) =>
    unzip(zip, { filter: f => { seen.push(f); return false; } }, (e, o) => (e ? rej(e) : res(o))));
  eq('filter reports the declared size without inflating', seen.map(f => f.originalSize), [100_000]);
  eq('a filtered-out entry is never inflated', Object.keys(none), []);

  // Lie in the central directory: claim 10 bytes for a 100 kB entry.
  const lying = zip.slice();
  const dv = new DataView(lying.buffer);
  for (let i = lying.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 10, true); break; }
  }
  const out = await new Promise<Unzipped | null>(res =>
    unzip(lying, (e, o) => res(e ? null : o)));
  check('a lying header cannot inflate past its declared size',
    out === null || (out['z.bin']?.length ?? 0) <= 10, `got ${out?.['z.bin']?.length}`);
}

fflateContract().catch(e => { failures++; console.log('  ✗ fflate contract threw', e); }).finally(() => {
  console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all archive checks passed\n');
  process.exit(failures ? 1 : 0);
});
