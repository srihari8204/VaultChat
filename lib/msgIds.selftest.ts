/**
 * lib/msgIds.selftest.ts
 *   run with: npx tsx lib/msgIds.selftest.ts
 *
 * The server serializes message ids as STRINGS on every path — `chatsPublicMsg`
 * is `ID string` / `ReplyToID *string` — while everything on the device is
 * number-keyed. That mismatch is silent in the worst way: a row with a string
 * id decrypts fine and renders fine, then `cacheMessages` skips it (it only
 * upserts number ids) and the message is simply gone on the next cold start.
 *
 * Measured on a handset: a chat showed 7 messages, the app was restarted, and
 * 1 came back. The server still held all 8.
 *
 * Four ingest boundaries used to each carry their own `Number(msg.id)` patch —
 * the GET page, the POST ack, the PATCH ack and the socket payload — and not
 * one of them touched `replyToId`, which is why a reply quote rendered the
 * "Replied message / Tap to view" placeholder instead of the quoted text: the
 * reply-target lookup is a `Map<number, …>`.
 *
 * This asserts the normalizer's behaviour, and then asserts the thing that
 * actually rots — that no ingest site has quietly grown a fifth hand-rolled
 * patch instead of calling it.
 */
import fs from 'fs';
import path from 'path';

import { normalizeMsgIds } from './msgIds';

let n = 0;
function ok(label: string, cond: boolean): void {
  n++;
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
}

// ── the normalizer itself ──────────────────────────────────────────────
const row: any = { id: '42', replyToId: '17', content: 'x' };
normalizeMsgIds(row);
ok('id string → number', row.id === 42);
ok('replyToId string → number', row.replyToId === 17);
ok('other fields untouched', row.content === 'x');

// A reply-target Map is number-keyed; a string id misses it entirely. This is
// the reply-quote bug in one assertion.
ok('normalized id hits a number-keyed map', new Map([[42, 'found']]).get(row.id) === 'found');

// Absent is not the same as zero. `replyToId` is null on every non-reply
// message, and Number(null) is 0 — which would point every ordinary message at
// message 0 as its reply target.
const plain: any = { id: '8', replyToId: null };
normalizeMsgIds(plain);
ok('null replyToId stays null, never 0', plain.replyToId === null);

const bare: any = { id: '9' };
normalizeMsgIds(bare);
ok('missing replyToId is not invented', !('replyToId' in bare) || bare.replyToId === undefined);

// Already-numeric rows (the local cache round-trips these) must survive.
const cached: any = { id: 5, replyToId: 3 };
normalizeMsgIds(cached);
ok('numbers pass through unchanged', cached.id === 5 && cached.replyToId === 3);

ok('returns the same object, not a copy', normalizeMsgIds(cached) === cached);

// ── no site may hand-roll the coercion again ───────────────────────────
// The bug was not that the coercion was wrong; it was that it lived in five
// places and each one only remembered `id`.
//
// This looks for the exact shape of that mistake — WRITING a coerced id back
// onto a row (`x.id = Number(x.id)`), which is what you do to a payload fresh
// off the wire. Merely READING `Number(r.id)` off a local SQLite row or an
// already-normalized object is fine and stays unflagged; a guard that shouted
// about those would be switched off within a week, and a guard nobody runs
// protects nothing.
const SCAN = ['lib', 'app', 'components'];
const HAND_ROLLED = /\.(?:id|replyToId)\s*=\s*Number\(/;
const offenders: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name) && !e.name.includes('.selftest.') && e.name !== 'msgIds.ts') {
      out.push(p);
    }
  }
  return out;
}

for (const dir of SCAN) {
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!HAND_ROLLED.test(line)) return;
      // `msgid-exempt:` for the places that legitimately coerce an id that did
      // NOT come off the wire — a route param, a Map key being rebuilt.
      if (/msgid-exempt:/.test(line)) return;
      offenders.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
}

ok(
  offenders.length === 0
    ? 'every wire id is normalized through normalizeMsgIds()'
    : 'hand-rolled id coercion (call normalizeMsgIds, or add a msgid-exempt: note):\n      ' +
        offenders.join('\n      '),
  offenders.length === 0,
);

console.log(`msgIds.selftest: ${n} assertions passed`);
