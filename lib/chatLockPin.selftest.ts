// lib/chatLockPin.selftest.ts — run: npx tsx lib/chatLockPin.selftest.ts
//
// The chat-lock PIN: salted KDF, migration of old hashes, and the backoff.

import assert from 'node:assert/strict';
import {
  afterFailure, chatPinWaitMs, checkChatPinHash, legacyChatPinHash, makeChatPinHash,
} from './chatLockPin';

async function main() {
  // New format: salted, so the same PIN never stores the same string twice.
  const a = await makeChatPinHash('2468');
  const b = await makeChatPinHash('2468');
  assert.ok(a.startsWith('scrypt1$'));
  assert.notEqual(a, b, 'per-lock random salt');
  assert.ok(!a.includes(legacyChatPinHash('2468')), 'no unsalted digest inside');
  assert.deepEqual(checkChatPinHash(a, '2468'), { ok: true, upgrade: false });
  assert.deepEqual(checkChatPinHash(a, '2469'), { ok: false, upgrade: false });

  // Old format: still opens, and asks to be upgraded; a wrong PIN does neither.
  const old = legacyChatPinHash('1357');
  assert.match(old, /^[0-9a-f]{64}$/, 'the old format is the bare SHA-256 hex');
  assert.deepEqual(checkChatPinHash(old, '1357'), { ok: true, upgrade: true });
  assert.deepEqual(checkChatPinHash(old, '0000'), { ok: false, upgrade: false });

  // Missing hash or PIN never matches.
  assert.equal(checkChatPinHash(undefined, '1357').ok, false);
  assert.equal(checkChatPinHash(a, '').ok, false);

  // Backoff: the first miss is free, then it grows, and 15 quiet minutes reset it.
  const t0 = 1_000_000_000;
  let s = afterFailure({}, t0);
  assert.equal(s.failN, 1);
  assert.equal(chatPinWaitMs(s, t0), 0, 'one typo costs nothing');
  s = afterFailure(s, t0 + 10);
  assert.ok(chatPinWaitMs(s, t0 + 10) > 0, 'the second miss in a row waits');
  for (let i = 0; i < 10; i++) s = afterFailure(s, t0 + 100);
  const wait = chatPinWaitMs(s, t0 + 100);
  assert.ok(wait > 0 && wait <= 60_000, `capped wait (${wait})`);
  assert.equal(chatPinWaitMs(s, t0 + 100 + 60_000), 0, 'the wait runs out');
  assert.equal(afterFailure(s, t0 + 100 + 16 * 60_000).failN, 1, 'a quiet gap starts a new streak');
  assert.ok(chatPinWaitMs(s, t0 - 3_600_000) <= 60_000, 'a clock moved backwards never owes more than one step');

  console.log('chatLockPin.selftest: all checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
