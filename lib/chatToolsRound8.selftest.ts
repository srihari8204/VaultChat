// lib/chatToolsRound8.selftest.ts — run: npx tsx lib/chatToolsRound8.selftest.ts
//
// Pins the two chat-tool regressions rerate7 found in rounds 6–7 (screens, so
// checked at source level like silentFailure / hiddenChatMask):
//   1. in-chat-search: after "Show more matches", `limit` grows before the page
//      lands, so a footer gated on `limit` hid itself (and its spinner), and
//      the badge read "80 results". Both must read the limit the shown results
//      were fetched with.
//   2. hidden-chats: the background relock released the iOS app-switcher blur
//      on the very event iOS snapshots on, while a hidden chat could still be
//      open above the list. The blur is held from unlock until unmount.
// Plus chat-export's Still-needed 3: a sweep (cold start or screen open) must
// not delete a file an export is still writing or sharing — the real
// components/chattools/chatExportFile.ts, run in a VM over an in-memory disk.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { importSkipNote } from '../components/chattools/importSkipNote';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ── 1. in-chat-search ──
const search = read('app/in-chat-search.tsx');
assert.match(search, /setResults\(hits\); setShownLimit\(limit\);/, 'the shown limit is recorded with the results it fetched');
assert.match(search, /ListFooterComponent=\{results\.length >= shownLimit \?/, 'the footer stays up while the next page loads');
assert.ok(!/ListFooterComponent=\{results\.length >= limit/.test(search), 'the footer is not gated on the pending limit');
assert.match(search, /results\.length >= shownLimit\s*\n\s*\? `Showing the first \$\{shownLimit\} matches/, 'the badge keeps "Showing the first N" until the page lands');
assert.match(search, /accessibilityState=\{\{ disabled: loadingMore, busy: loadingMore \}\}/, 'the footer reports busy while loading');

// Simulate the footer/badge decision across a "Show more" tap.
const HIT_LIMIT = 80;
const footer = (resultsLen: number, shownLimit: number) => resultsLen >= shownLimit;
// Before the tap: 80 shown of limit 80 → footer. During the load: limit is 160
// but shownLimit stays 80 → footer (spinner) still shown. After: 120 of 160 → none.
assert.equal(footer(HIT_LIMIT, HIT_LIMIT), true);
assert.equal(footer(HIT_LIMIT, HIT_LIMIT), true, 'during the load the footer is still shown');
assert.equal(footer(120, 2 * HIT_LIMIT), false);

// ── 2. hidden-chats ──
const hidden = read('app/hidden-chats.tsx');
assert.ok(!/\(stage === 'list' \? holdAppSwitcherBlur\(\) : undefined\)/.test(hidden), 'the blur is not tied to the list stage (relock released it)');
assert.match(hidden, /if \(stage === 'list' && !blurRelease\.current\) blurRelease\.current = holdAppSwitcherBlur\(\);/, 'held once, at unlock');
assert.match(hidden, /useEffect\(\(\) => \(\) => \{ blurRelease\.current\?\.\(\); blurRelease\.current = null; \}, \[\]\);/, 'released on unmount only');
// The relock itself still happens on background.
assert.match(hidden, /if \(st === 'background'\) \{\s*awaySince\.current = Date\.now\(\);\s*setStage\('pin'\);/, 'background still relocks the list');

// ── 3. chat-export sweep vs. an export in flight ──
async function exportSweep() {
  const disk = new Map<string, string>();
  const CACHES = '/caches';
  let unlinkGate: Promise<void> | null = null;
  const RNFS = {
    CachesDirectoryPath: CACHES,
    async mkdir() {},
    async writeFile(p: string, v: string) { disk.set(p, v); },
    async appendFile(p: string, v: string) { if (!disk.has(p)) throw new Error('ENOENT ' + p); disk.set(p, disk.get(p) + v); },
    async unlink(p: string) {
      if (unlinkGate) await unlinkGate;
      for (const k of [...disk.keys()]) if (k === p || k.startsWith(p + '/')) disk.delete(k);
    },
    async readDir() { return []; },
  };
  const FileSystem = { async deleteAsync(uri: string) { disk.delete(uri.replace('file://', '')); }, async readAsStringAsync() { return ''; } };
  const Sharing = { async isAvailableAsync() { return true; }, async shareAsync() {} };
  const compiled = ts.transpileModule(read('components/chattools/chatExportFile.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mods: Record<string, unknown> = {
    '@dr.pogodin/react-native-fs': RNFS, 'expo-file-system/legacy': FileSystem, 'expo-sharing': Sharing, 'react-native': { Share: {} },
  };
  const exp: any = {};
  runInNewContext(compiled, { exports: exp, require: (m: string) => mods[m], Set, Promise });

  // A sweep that runs while an export is writing removes nothing.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  async function* chunks() { yield ['a']; await gate; yield ['b']; }
  const writing = exp.writeExportFile('x.txt', 'H\n', chunks(), (s: string) => s + '\n', (n: number) => `T${n}\n`, { cancelled: () => false });
  await new Promise((r) => setTimeout(r, 5));
  await exp.sweepExportFiles();
  release();
  const { uri, count } = await writing;
  assert.equal(count, 2);
  assert.equal(disk.get(uri.replace('file://', '')), 'H\na\nb\nT2\n', 'the export survived a sweep run mid-write');
  // Still with the share sheet: still protected.
  await exp.sweepExportFiles();
  assert.ok(disk.has(uri.replace('file://', '')), 'a sweep while sharing leaves the file');
  await exp.shareExportFile(uri, 'text/plain');
  assert.ok(!disk.has(uri.replace('file://', '')), 'sharing deletes it');

  // A leftover is swept once nothing is in flight.
  disk.set(`${CACHES}/chat-export/old.txt`, 'plaintext');
  await exp.sweepExportFiles();
  assert.ok(!disk.has(`${CACHES}/chat-export/old.txt`), 'crash leftovers are still swept');

  // An export that starts while a sweep is deleting waits for it, then writes.
  let unblock!: () => void;
  unlinkGate = new Promise<void>((r) => { unblock = r; });
  const sweep = exp.sweepExportFiles();
  async function* one() { yield ['z']; }
  const w2 = exp.writeExportFile('y.txt', 'H\n', one(), (s: string) => s + '\n', (n: number) => `T${n}\n`, { cancelled: () => false });
  await new Promise((r) => setTimeout(r, 5));
  unlinkGate = null; unblock();
  await sweep;
  const r2 = await w2;
  assert.equal(disk.get(r2.uri.replace('file://', '')), 'H\nz\nT1\n', 'an export started during a sweep is written after it, intact');

  // A failed export removes its file and stops protecting it.
  async function* bad() { yield ['q']; throw new Error('boom'); }
  await assert.rejects(exp.writeExportFile('z.txt', 'H', bad(), (s: string) => s, () => '', { cancelled: () => false }), /boom/);
  assert.ok(!disk.has(`${CACHES}/chat-export/z.txt`));
}

// ── 4. import-chats Done: say what was skipped ──
assert.equal(importSkipNote({ duplicates: 0, unsupported: 0, missingMedia: 0, mediaSkipped: 0 }), null, 'nothing skipped: no note');
const note = importSkipNote({ duplicates: 2, unsupported: 1, missingMedia: 3, mediaSkipped: 1 })!;
assert.ok(note.startsWith('Skipped: 2 messages were already in this chat'), note);
assert.ok(note.includes('1 line in the export did not read as a message'), note);
assert.ok(note.includes('3 media files are mentioned but not in the export — export the chat again with media to bring them'), note);
assert.ok(note.includes('1 media file was too large to copy') && note.endsWith('.'), note);
const flow = read('components/chattools/useImportFlow.ts');
assert.ok(!/unsupported: parsed\.unsupported \+ parsed\.missingMedia/.test(flow) && /missingMedia: parsed\.missingMedia/.test(flow),
  'missing media is reported as its own kind, not folded into "unsupported"');
assert.match(read('components/chattools/importChatsParts.tsx'), /const skipped = importSkipNote\(outcome\);/, 'Done shows the note');

exportSweep().then(() => {
  console.log('chatToolsRound8 selftest: all passed');
}).catch((e) => { console.error(e); process.exit(1); });
