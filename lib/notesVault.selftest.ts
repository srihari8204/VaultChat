// lib/notesVault.selftest.ts — the pure half of the notes vault, under assert.
//
//   npx tsx lib/notesVault.selftest.ts
//
// Only the pure functions: the wrap crypto and the trash-purge boundary. The
// persistence half needs AsyncStorage/FileSystem and belongs on a device.
//
// NOT imported by the app — a source-scanning selftest inside the bundle is
// what breaks assembleRelease (see the notes on require('fs') in app code).

import assert from 'node:assert';
import { makeWrap, openWrap, isWrap, isBundle, purgeExpired } from './notesVaultCore';

const DEK = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  // ── wrap round-trip ───────────────────────────────────────────────────────
  const wrap = await makeWrap('correct horse battery', DEK);
  assert.ok(isWrap(wrap), 'makeWrap produces a wrap record');
  assert.strictEqual(await openWrap('correct horse battery', wrap), DEK, 'right passphrase recovers the DEK');

  // The whole point: a wrong passphrase yields NOTHING, not a plausible key.
  assert.strictEqual(await openWrap('correct horse batteryx', wrap), null, 'wrong passphrase is rejected');
  assert.strictEqual(await openWrap('', wrap), null, 'empty passphrase is rejected');

  // A fresh salt per wrap, so two wraps of the same key never look alike —
  // otherwise identical ciphertext would leak that two backups share a key.
  const wrap2 = await makeWrap('correct horse battery', DEK);
  assert.notStrictEqual(wrap.salt, wrap2.salt, 'each wrap gets its own salt');
  assert.notStrictEqual(wrap.wrapped, wrap2.wrapped, 'each wrap seals differently');
  assert.strictEqual(await openWrap('correct horse battery', wrap2), DEK, 'the second wrap opens too');

  // Tampering must fail closed — GCM's auth tag, not a checksum we trust.
  const bits = Buffer.from(wrap.wrapped, 'base64');
  bits[bits.length - 1] ^= 0xff;
  assert.strictEqual(
    await openWrap('correct horse battery', { ...wrap, wrapped: bits.toString('base64') }),
    null, 'a tampered wrap is rejected',
  );

  // ── bundle validation ─────────────────────────────────────────────────────
  const bundle = { v: 1, kind: 'vaultchat-notes', createdAt: 0, wrap, notes: 'x', attachments: {} };
  assert.ok(isBundle(bundle), 'a well-formed bundle validates');
  assert.ok(isBundle({ ...bundle, notes: null }), 'an empty vault is still a valid bundle');
  assert.ok(!isBundle({ ...bundle, kind: 'something-else' }), 'a foreign file is refused');
  assert.ok(!isBundle({ ...bundle, wrap: { v: 1 } }), 'a bundle with no usable wrap is refused');
  assert.ok(!isBundle(null) && !isBundle('{}'), 'junk is refused');

  // ── trash purge boundary ──────────────────────────────────────────────────
  const now = 100 * DAY;
  const notes = [
    { id: 'live' },
    { id: 'fresh', isDeleted: true, deletedAt: now - 29 * DAY },
    { id: 'edge', isDeleted: true, deletedAt: now - 30 * DAY },          // exactly 30d: kept
    { id: 'stale', isDeleted: true, deletedAt: now - 31 * DAY, attachments: [{ id: 'att1' }, { id: 'att2' }] },
    { id: 'unstamped', isDeleted: true },                                 // no deletedAt: never purged
  ];
  const { kept, purgedAttachmentIds } = purgeExpired(notes, now, 30);
  assert.deepStrictEqual(kept.map(n => n.id), ['live', 'fresh', 'edge', 'unstamped'], 'only expired trash is dropped');
  assert.deepStrictEqual(purgedAttachmentIds, ['att1', 'att2'], 'the purged note surrenders its attachments');

  // A live note is never touched, however old.
  const ancient = purgeExpired([{ id: 'old', deletedAt: 0 }], now, 30);
  assert.strictEqual(ancient.kept.length, 1, 'a note that was never trashed survives a stale deletedAt');

  console.log('notesVault selftest: all assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
