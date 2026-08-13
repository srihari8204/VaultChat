// lib/historySync.selftest.ts — run: npx tsx lib/historySync.selftest.ts
//
// The server-side cold-start filter returns only undelivered messages to an
// unrecognised device (measured 277 -> 0 against production). This module
// defeated it: on a fresh install every chat has an empty cache, and the
// back-fill then paged the whole history back in through
// GET /chats/{id}/messages — a different endpoint with no cold-start filter,
// 12 x 50 per chat.
//
// It was caught on a real handset, not in review: the delta returned nothing and
// the client still logged 35 ghash failures replaying history it had just been
// spared. So the invariant is pinned here rather than trusted to a comment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'historySync.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const fn = SRC.slice(SRC.indexOf('try {'), SRC.indexOf('/**', SRC.indexOf('try {')));

console.log('the background back-fill must not run');

// Already-cached chats were always skipped; that must stay.
check('a chat with cached history is still skipped',
  /if \(cached\.length\) return;/.test(fn));

// The fresh-install case must now ALSO bail, before any network call.
const bail = fn.indexOf('return;', fn.indexOf('if (cached.length) return;') + 10);
const firstFetch = fn.indexOf('getMessages(');
check('a chat with NO cached history also bails out',
  bail > 0 && (firstFetch < 0 || bail < firstFetch),
  'the fresh-install back-fill still reaches getMessages, which bypasses the cold-start filter');

// The paging loop must be unreachable, not merely bounded.
check('the 12-page paging loop is no longer reachable',
  bail > 0 && (firstFetch < 0 || bail < firstFetch),
  'guard < 12 with PAGE 50 is up to 600 messages per chat');

console.log('the user-initiated paths must survive');

// These are the sanctioned ways history is fetched: opening a chat with an
// empty cache, and scrolling back. Neither lives here, and neither may be
// removed by this change.
const CHAT = readFileSync(join(HERE, '..', 'app', 'chat.tsx'), 'utf8');
check('opening a chat with an empty cache still fetches',
  /if \(cachedMsgs !== null && !cachedMsgs\.length\)/.test(CHAT),
  'the on-demand cold path was removed — a fresh device could never load a chat');
check('scroll-back still falls through to the server past the cache horizon',
  /getCachedMessagesBefore\(/.test(CHAT) && /before: oldest/.test(CHAT),
  'explicit history loading was removed');

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
