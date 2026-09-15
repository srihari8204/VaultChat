// lib/signalStyleMessageStorage.selftest.ts
//   run: npx tsx lib/signalStyleMessageStorage.selftest.ts
//
// ONE LOCAL MESSAGE RECORD, LIKE SIGNAL.
//
// The reference is not a description of Signal — it is the Signal build
// installed on the test handset (org.thoughtcrime.securesms 8.21.5), whose
// schema was read out of its own dex:
//
//   CREATE TABLE message (
//     _id INTEGER PRIMARY KEY AUTOINCREMENT,
//     date_sent INTEGER NOT NULL,
//     from_recipient_id INTEGER NOT NULL REFERENCES recipient (_id),
//     to_recipient_id   INTEGER NOT NULL REFERENCES recipient (_id),
//     type INTEGER NOT NULL,      -- direction/state bitmask
//     body TEXT,                  -- ONE plaintext column, BOTH directions
//     ... )
//
// plus libsqlcipher.so in its arm64 split: the file is encrypted at rest, which
// is what makes a plaintext column safe. Sent and received differ by the `type`
// bitmask, never by WHERE the text lives. There is no second plaintext store —
// message_send_log(content BLOB) exists, but that is retained ciphertext for
// RESEND, not the render path.
//
// crazzychat had two stores: messages.content (nulled for own messages, because
// the POST ack carries an envelope) and a separate e2ee KV cache the render
// path never consulted. That is what showed "unable to decrypt" on the sender's
// own text after a restart.
//
// What this pins:
//   1. the send path puts PLAINTEXT on the local record
//   2. it stores item.plaintext, not the NUL-wrapped preview form
//   3. the server still receives ciphertext only
//   4. the old KV cache is still written (compat) and read-through migrated
//   5. an envelope can never overwrite stored plaintext

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE = readFileSync(join(HERE, 'messageQueue.ts'), 'utf8');
const CHATSVC = readFileSync(join(HERE, 'chatService.ts'), 'utf8');
const LOCALDB = readFileSync(join(HERE, 'localDb.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── 1. the local record carries plaintext ────────────────────────────────
console.log('the local message record must hold plaintext, like Signal.body');

const postOnce = QUEUE.match(/async function postOnce[\s\S]*?\n}/)?.[0] ?? '';
check('postOnce exists', !!postOnce);
check('the local record is given plaintext',
  /\(real as any\)\.content\s*=\s*item\.plaintext/.test(postOnce),
  'without this the POST ack (ciphertext) is cached, cacheMessages nulls the ' +
  'envelope, and the sender loses their own text on restart');

check('it stores item.plaintext, NOT the wrapped wire form',
  !/\(real as any\)\.content\s*=\s*wire/.test(postOnce),
  'wire is the NUL-prefixed {text+preview} wrapper; Signal keeps previews out ' +
  'of body, and the warm-cache paint path does not unwrap');

check('only for real sends (edit/delete carry no local body)',
  /item\.op\s*\?\?\s*'send'\)\s*===\s*'send'/.test(postOnce));

// ── 2. the server still gets ciphertext only ─────────────────────────────
console.log('the server must still receive only the envelope');

check('the submission payload contains `content` (the encrypted form)',
  /const payload\s*=\s*\{\s*content,/.test(postOnce),
  'the request must carry the DR1/GSK1 envelope, never item.plaintext');
check('CC-Wire and HTTP receive that same encrypted payload',
  /submitCCWireMessage<Message>\(item\.chatId,\s*payload,\s*api\)/.test(postOnce) &&
  /method:\s*'POST',\s*json:\s*payload/.test(postOnce));
check('encryption still happens before the POST',
  /encryptForChat\(item\.chatId,\s*wire\)/.test(postOnce));
// The plaintext assignment must come AFTER the network call, or it could be
// the thing that gets serialised.
const iPost = postOnce.indexOf('await api<Message>');
const iSubmit = postOnce.indexOf('await transportModule.submitCCWireMessage<Message>');
const iAssign = postOnce.search(/\(real as any\)\.content\s*=\s*item\.plaintext/);
check('plaintext is attached only AFTER either submission path returns',
  iPost >= 0 && iSubmit >= 0 && iAssign > iPost && iAssign > iSubmit,
  'assigning before the POST risks the plaintext reaching the wire');

// ── 3. compat + lazy migration ───────────────────────────────────────────
console.log('existing history must migrate, not break');

check('the old KV cache is still written (rollback safety)',
  /cacheOwnPlaintext\(item\.chatId,\s*real\?\.id,\s*wire\)/.test(postOnce));
// Anchored on the CALL, not on a character window between two symbols. A
// distance-bounded scrape is defeated by any comment that grows — exactly how
// the sibling guard in leaveselfapprove_test.go broke, and it broke this check
// on its first run too.
check('a KV hit is promoted into the canonical row on read',
  /cacheMessages\(chatId,\s*\[\{\s*\.\.\.out\[i\]\s*\}/.test(CHATSVC),
  'old own-messages would keep depending on the side cache forever');
check('…and that promotion sits in the own-message branch',
  /readOwnPlaintext\(chatId, m\.id, m\.createdAt\)/.test(CHATSVC));
check('migration is read-through, not a mass rewrite',
  !/UPDATE messages SET content/.test(CHATSVC));

// ── 4. an envelope can never clobber stored plaintext ────────────────────
console.log('ciphertext must never overwrite a stored plaintext body');

check('cacheMessages nulls an envelope before binding',
  /encField\(looksLikeEnvelope\(m\.content\) \? null : \(m\.content \?\? null\)\)/.test(LOCALDB),
  'a re-fetched envelope would replace good plaintext with a blob');
check('upsert retains purged plaintext but wipes explicit tombstones',
  /content\s*=\s*CASE WHEN excluded\.deleted_at IS NOT NULL THEN NULL\s*ELSE COALESCE\(excluded\.content,\s*messages\.content\) END/.test(LOCALDB));

// ── 5. raw ciphertext must never reach the UI ────────────────────────────
console.log('raw DR1/GSK1 must never be rendered');

check('looksEncrypted recognises both envelope forms',
  /startsWith\('GSK1:'\)/.test(CHATSVC) && /\?\.v === 'dr1'/.test(CHATSVC));
check('the chat-list preview drops envelopes',
  /looksLikeEnvelope\(text\)\s*\?\s*null\s*:\s*text/.test(LOCALDB));

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
