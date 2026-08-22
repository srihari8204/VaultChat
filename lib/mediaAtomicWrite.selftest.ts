// lib/mediaAtomicWrite.selftest.ts — run: npx tsx lib/mediaAtomicWrite.selftest.ts
//
// A media file must never be readable until it is COMPLETE.
//
// Both resolvers cache to a fixed path and reuse whatever is already there,
// testing only that it exists and is non-empty. So writing the download or the
// decrypt straight to that path meant an interrupted transfer — app killed,
// process frozen, network dropped mid-stream — left a TRUNCATED file at the
// final name. Every later open returned it instantly, since it exists and has
// bytes. A truncated video plays to the cut and then freezes; an image draws
// half. Permanently, and only for that one attachment, because nothing ever
// re-fetches a file it believes it already has.
//
// Reported as "video gets stuck in between playing".
//
// The rule: write to a sibling `.part`, then MOVE into place. A move on the
// same filesystem is atomic, so the real name only ever exists complete.

import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nMedia atomic write\n');

// ── lib/mediaAttachments.ts — the encrypted/E2EE path ─────────────────
const ATT = readFileSync('lib/mediaAttachments.ts', 'utf8');

check('downloads to a .part file, not the cached name',
  /const part = cached \+ '\.part'/.test(ATT),
  'a partial download would occupy the final path');

check('the plaintext download targets part',
  /downloadAsync\(attachmentUrl\(attachmentId\), part,/.test(ATT));

check('the decrypt targets part',
  /downloadAndDecrypt\(attachmentId, mk, part,/.test(ATT));

check('only a completed file is moved into place',
  /moveAsync\(\{ from: part, to: cached \}\)/.test(ATT));

check('a failed transfer deletes its part file',
  /catch[\s\S]{0,120}deleteAsync\(part/.test(ATT),
  'a leftover .part is harmless but should not accumulate');

// ── lib/mediaStore.ts — the plaintext/legacy path ─────────────────────
const STORE = readFileSync('lib/mediaStore.ts', 'utf8');

check('mediaStore downloads to a .part file too',
  /const part = `\$\{path\}\.part`/.test(STORE),
  'same bug, second module — the fix has to cover both resolvers');

check('mediaStore moves the finished file into place',
  /RNFS\.moveFile\(part, path\)/.test(STORE));

check('mediaStore cleans up on failure',
  /catch[\s\S]{0,120}unlink\(part\)/.test(STORE));

// ── the check that made truncation invisible ──────────────────────────
// Kept deliberately: with atomic writes a non-empty file IS a complete one, so
// the cheap existence test is now sound. This asserts the assumption is still
// paired with the mechanism that makes it true.
check('the existence check still only guards a path written atomically',
  /info\.exists && \(info as any\)\.size/.test(ATT) && /const part = cached \+ '\.part'/.test(ATT),
  'size>0 means "complete" ONLY while writes are atomic');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all media atomic-write checks passed\n');
process.exit(failures ? 1 : 0);
