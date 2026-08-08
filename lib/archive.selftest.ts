// lib/archive.selftest.ts — run: npx tsx lib/archive.selftest.ts
//
// An archive is untrusted input from another person, so the security case is
// tested first and hardest: a zip whose entry is named `../../secrets` must be
// REFUSED, not sanitised into something plausible. The rest covers navigation,
// where the failure mode is a folder you cannot get back out of.

import {
  listDir, parentDir, safeEntryPath, toEntries, tooLargeToOpen, totalUncompressed,
  MAX_UNCOMPRESSED_BYTES,
} from './archive';

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

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all archive checks passed\n');
process.exit(failures ? 1 : 0);
