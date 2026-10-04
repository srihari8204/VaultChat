// lib/decryptReplayCost.selftest.ts — run: npx tsx lib/decryptReplayCost.selftest.ts
//
// "Always loading old messages, taking time."
//
// A device whose E2EE identity is newer than its history has no session for any
// old message, so every one of them failed to decrypt — and each failure cost
// 2x250ms of sleep waiting for an X3DH message that was already on disk, plus (in
// groups) a network GET for sender keys that were sealed to the previous identity.
// Serialized, on every launch. syncEngine records the measurement: 72 messages,
// 0.5-0.9s apart, white screen.
//
// The retries are correct for LIVE out-of-order delivery and pointless for replay.
// The whole fix is telling those two apart, which is exactly the kind of
// distinction that gets flattened later by someone simplifying a signature — so
// it is pinned here.
//
// chatService.ts can't be imported in Node (react-native), so these read the
// source, as localDb.queue.selftest.ts does.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_SERVICE = readFileSync(join(HERE, 'chatService.ts'), 'utf8');
const GROUP = readFileSync(join(HERE, '..', 'services', 'crypto', 'groupSession.rn.ts'), 'utf8');
// The chat screen and its socket effect (components/chat/useChatSocket.ts),
// read as one source. Add a file here if that code moves again.
const CHAT_FILES = ['app/chat.tsx', 'components/chat/useChatSocket.ts'];
const CHAT_SCREEN = CHAT_FILES.map((f) => readFileSync(join(HERE, '..', f), 'utf8')).join('\n');
const SYNC = readFileSync(join(HERE, 'syncEngine.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── replay must not pay the out-of-order retry ───────────────────────────
console.log('history replay skips the live-only retry');

check('the retry loop is gated on replay depth',
  /for \(let i = 0; _bulkDecryptDepth === 0 && i < 2; i\+\+\)/.test(CHAT_SERVICE),
  'the 2x250ms sleep is the dominant per-message cost of every launch');

// The gate must sit INSIDE the no-session branch. Moving it to the `if` would
// drop the case through to the else-if and hand a missing session to
// maybeAutoRecoverSession, which is not what it means during replay.
const branch = CHAT_SERVICE.indexOf("if (m.includes('no session and no X3DH'))");
const elseIf = CHAT_SERVICE.indexOf("} else if (!m.includes('undecryptable (cached)'))");
const gate = CHAT_SERVICE.indexOf('_bulkDecryptDepth === 0 && i < 2');
check('the no-session branch still exists and is not conditional itself', branch > 0);
check('the gate is inside that branch, not on it',
  gate > branch && elseIf > gate,
  'a missing session during replay must not reach maybeAutoRecoverSession');

// ── but a message that just arrived is NOT replay ────────────────────────
console.log('a live message keeps its retry');

check('hydrateMessages takes an explicit live flag',
  /opts\?:\s*\{\s*live\?:\s*boolean\s*\}/.test(CHAT_SERVICE),
  'without it, a live batch-of-one is indistinguishable from history in here');
check('the replay marker is conditional on it',
  /const bulk = !opts\?\.live;/.test(CHAT_SERVICE) && /if \(bulk\) _bulkDecryptDepth\+\+;/.test(CHAT_SERVICE));
check('and is unwound on the same condition',
  /if \(bulk\) _bulkDecryptDepth--;/.test(CHAT_SERVICE),
  'an unbalanced counter would wedge replay detection on permanently');

// Only DELIBERATE, BOUNDED decrypts may set it. Three qualify on this screen:
// the new-message and edit handlers (one message each), and the on-open retry of
// messages already known to be stuck (a short list, and healing them is the
// entire point of that pass). Both are worth the 500ms retry.
//
// What must never set it is a bulk history render, which is why this is a count
// and not a "does any call set it" check: the cost is per message, so one
// careless live:true on a screenful of history is the 36–65s white screen this
// whole file exists to prevent. If this number grows, prove the new caller is
// bounded before raising it.
const liveCalls = CHAT_SCREEN.match(/hydrateMessages\([^)]*live:\s*true[^)]*\)/g) ?? [];
check('only bounded chat-screen decrypts are marked live',
  liveCalls.length === 3 && /hydrateMessages\(chatId, \[raw\], undefined, \{ live: true \}\)/.test(CHAT_SCREEN),
  `${liveCalls.length} call sites pass live:true — expected new message, a single edited row, and the stuck-message retry`);
check('syncEngine does NOT mark its replay as live',
  /hydrateMessages\(/.test(SYNC) && !/live:\s*true/.test(SYNC));

// ── groups: one fetch per chat, not one per message ──────────────────────
console.log('group replay does not fetch per message');

check('the sender-key fetch is coalesced', /ingestOnce\(chatId\)/.test(GROUP));
check('concurrent misses share one in-flight fetch', /_ingestInFlight/.test(GROUP));
check('a sender already known to have no key is not re-fetched per message',
  /_noSenderKeyAt/.test(GROUP) && /INGEST_RETRY_MS/.test(GROUP));
// The cooldown must key off a FAILED lookup, not the chat: keying it on the chat
// would delay a new member's first message by the cooldown.
check('the cooldown is keyed per sender, so a new sender still fetches at once',
  /const k = chatId \+ '\|' \+ senderId;/.test(GROUP));
check('a sender whose key does arrive is cleared from the cooldown',
  /_noSenderKeyAt\.delete\(k\)/.test(GROUP));

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
