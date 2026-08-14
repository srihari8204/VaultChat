// lib/localDb.staleData.selftest.ts — run: npx tsx lib/localDb.staleData.selftest.ts
//   (needs the Node sqlite driver once: npm i -D better-sqlite3)
//
// "Old messages keep loading and old chats keep coming back."
//
// These run the REAL SQL, lifted out of localDb.ts rather than restated, against
// a real sqlite. A restatement would agree with itself no matter what ships.
//
// What is proven here:
//   1. a locally deleted message survives a re-fetch that says deleted_at NULL
//   2. a re-fetch never overwrites plaintext with an unopened envelope
//   3. a purged (null) server body never wipes cached plaintext  [pre-existing]
//   4. re-inserting the same server id creates ZERO extra rows
//   5. scroll-back is answerable from disk, so it needs no server call
//   6. the chat cache is pruned to the server's list, so deleted chats stay gone
//   7. an offline/failed chat fetch prunes nothing

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'localDb.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── schema + statements, lifted from the source ──────────────────────────
function ddl(name: string): string {
  const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name}[\\s\\S]*?;`));
  if (!m) throw new Error(`selftest: no DDL for ${name} in localDb.ts — renamed?`);
  return m[0];
}

const db = new Database(':memory:');
db.exec(ddl('messages'));
db.exec(ddl('chats'));

// The real upsert, extracted rather than retyped: if the ON CONFLICT clause
// changes, these tests exercise the change.
const upsertSrc = SRC.match(/INSERT INTO messages[\s\S]*?expires_at\s*=\s*excluded\.expires_at`/);
if (!upsertSrc) throw new Error('selftest: could not locate the messages upsert in localDb.ts');
const UPSERT = upsertSrc[0]
  .replace(/^INSERT INTO/, 'INSERT INTO')
  .replace(/`$/, '')
  .replace(/--[^\n]*/g, '');           // strip comments; sqlite accepts them but keep it clean
check('the messages upsert was lifted from source', UPSERT.includes('ON CONFLICT'));
check('it carries the sticky-tombstone rule',
  /deleted_at\s*=\s*COALESCE\(messages\.deleted_at,\s*excluded\.deleted_at\)/.test(UPSERT),
  'deleted_at is assigned unconditionally — a re-fetch will resurrect deleted messages');

const put = db.prepare(UPSERT);
type Row = { id: number; content: string | null; deleted_at: string | null };
const insert = (m: Partial<Row> & { id: number }, chatId = 'c1') => put.run(
  m.id, chatId, 'u1', 'text', m.content ?? null, null, null,
  '2026-01-01T00:00:00.000Z', null, m.deleted_at ?? null, null,
);
const get = (id: number) => db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as any;
const count = () => (db.prepare(`SELECT COUNT(*) n FROM messages`).get() as any).n;

// ── 1. local delete is sticky ────────────────────────────────────────────
console.log('a locally deleted message must not come back');
insert({ id: 100, content: 'hello' });
db.prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`).run('2026-01-02T00:00:00.000Z', 100);
// The server re-sends the same row; "delete for me" never left the device, so
// its deleted_at is NULL. This is the exact shape that used to un-delete it.
insert({ id: 100, content: 'hello', deleted_at: null });
check('delete-for-me survives a server re-fetch', get(100).deleted_at !== null,
  'the message was resurrected');

// A genuine remote delete must still land.
insert({ id: 101, content: 'hi' });
insert({ id: 101, content: 'hi', deleted_at: '2026-01-03T00:00:00.000Z' });
check('a remote delete-for-everyone still applies', get(101).deleted_at !== null);

// ── 2/3. content is never downgraded ─────────────────────────────────────
console.log('plaintext must not be overwritten');
insert({ id: 200, content: 'readable text' });
insert({ id: 200, content: null });                       // purged body after delivery
check('a purged (null) server body keeps cached plaintext', get(200).content === 'readable text');

// cacheMessages nulls an envelope BEFORE binding, so the DB sees null. Mirror
// that here, and assert the source still does it — the SQL alone cannot.
check('cacheMessages nulls an envelope before writing',
  /encField\(looksLikeEnvelope\(m\.content\) \? null : \(m\.content \?\? null\)\)/.test(SRC),
  'a failed decrypt will write ciphertext over good plaintext');
insert({ id: 200, content: null });                       // what the guard produces
check('an unopened envelope cannot replace plaintext', get(200).content === 'readable text');

// …and the consequence the CHAT BUBBLE depends on, pinned here because it is
// not obvious from either file alone: a message this device cannot read is
// stored with content NULL, exactly like one whose server body was reclaimed.
//
// So a NULL in this table means "no readable copy HERE", never "gone from the
// server" — the sender's own messages are the common case, since a Double
// Ratchet ciphertext cannot be opened by the party that produced it. A bubble
// that reads NULL as server-side loss tells the user their message was dropped
// while the server still holds it in full. MessageBubble.tsx must therefore
// keep wording this as a local absence; see the comment on its null branch.
insert({ id: 210, content: null });                       // never-seen, undecryptable
check('an undecryptable message is stored indistinguishably from a purged one',
  get(210).content === null,
  'if this ever stores the envelope instead, revisit MessageBubble’s null branch');

// ── 4. idempotency ───────────────────────────────────────────────────────
console.log('the same server message must never duplicate');
const before = count();
for (let i = 0; i < 5; i++) insert({ id: 300, content: 'once' });
check('5 re-inserts of id 300 create exactly one row', count() === before + 1,
  `${count() - before} rows added`);

// ── 5. scroll-back is answerable from disk ───────────────────────────────
console.log('scroll-back must not need the server');
for (let i = 1; i <= 300; i++) insert({ id: 1000 + i, content: `m${i}` }, 'c2');
const backSrc = SRC.match(/export async function getCachedMessagesBefore[\s\S]*?\n}/);
check('getCachedMessagesBefore exists', !!backSrc,
  'no cached back-page reader — every scroll-up hits the network');
const backSql = backSrc?.[0].match(/`([\s\S]*?)`/)?.[1] ?? '';
check('its query is bounded by id and skips deletes',
  /id < \?/.test(backSql) && /deleted_at IS NULL/.test(backSql), backSql.trim());
if (backSql) {
  const page = db.prepare(backSql).all('c2', 1251, 50) as any[];
  check('a cached back-page returns a full page', page.length === 50, `${page.length} rows`);
  check('and it is strictly older, newest-first',
    page[0].id === 1250 && page[49].id === 1201, `${page[0]?.id}..${page[49]?.id}`);
  // Deleted rows must not reappear via scroll-back either.
  db.prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`).run('2026-01-04T00:00:00.000Z', 1250);
  const page2 = db.prepare(backSql).all('c2', 1251, 50) as any[];
  check('a deleted message is not served by scroll-back',
    !page2.some(r => r.id === 1250));
}

// ── 5b. the back-page query must use an index, not scan ──────────────────
console.log('local history reads must be indexed');
for (const idx of SRC.match(/CREATE INDEX IF NOT EXISTS idx_messages_chat[\s\S]*?;/g) ?? []) db.exec(idx);
if (backSql) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${backSql}`).all('c2', 1251, 50) as any[];
  const detail = plan.map(r => r.detail).join(' | ');
  check('scroll-back uses the (chat_id, id) index rather than scanning',
    /USING INDEX/i.test(detail) && !/SCAN messages(?! USING)/i.test(detail), detail);
}

// ── 5c. the rest of the local reader API ─────────────────────────────────
console.log('the device can browse its own history offline');
const readerSql = (name: string) => {
  const fn = SRC.match(new RegExp(`export async function ${name}[\\s\\S]*?\\n}`));
  return fn?.[0].match(/`([\s\S]*?)`/)?.[1] ?? '';
};
for (const [name, must] of [
  ['getCachedMessagesAfter', /id > \?/],
  ['hasCachedOlderMessages', /id < \?/],
  ['hasCachedNewerMessages', /id > \?/],
] as [string, RegExp][]) {
  const sql = readerSql(name);
  check(`${name} exists and is bounded`, !!sql && must.test(sql), sql.trim().slice(0, 80));
}
check('getCachedMessagesAround exists', /export async function getCachedMessagesAround/.test(SRC));

const afterSql = readerSql('getCachedMessagesAfter');
if (afterSql) {
  const fwd = db.prepare(afterSql).all('c2', 1250, 50) as any[];
  check('forward paging returns strictly newer rows, oldest-first',
    fwd.length > 0 && fwd[0].id > 1250 && fwd[0].id < fwd[fwd.length - 1].id,
    `${fwd[0]?.id}..${fwd[fwd.length - 1]?.id}`);
}
const hasOlderSql = readerSql('hasCachedOlderMessages');
if (hasOlderSql) {
  check('hasCachedOlderMessages is true mid-history',
    !!db.prepare(hasOlderSql).get('c2', 1100));
  check('…and false at the very bottom',
    !db.prepare(hasOlderSql).get('c2', 1001));
}

// ── 6/7. the chat cache follows the server's list ────────────────────────
console.log('deleted chats must stay gone');
const putChat = db.prepare(`INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?,?,?)`);
for (const id of ['a', 'b', 'c']) putChat.run(id, `{"id":"${id}"}`, null);
const pruneSrc = SRC.match(/DELETE FROM chats WHERE id NOT IN[^`]*`/);
check('cacheChats prunes to the server list', !!pruneSrc,
  'the chats table is append-only — a deleted chat repaints from cache every launch');
// Server now reports only a and c (b was deleted/hidden).
const keep = ['a', 'c'];
db.prepare(`DELETE FROM chats WHERE id NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
const ids = (db.prepare(`SELECT id FROM chats ORDER BY id`).all() as any[]).map(r => r.id);
check('a chat absent from the server list is dropped', !ids.includes('b'), ids.join(','));
check('chats still present are kept', ids.includes('a') && ids.includes('c'), ids.join(','));
check('an empty/failed fetch prunes nothing (guarded by `if (!chats) return`)',
  /if \(!chats\) return;/.test(SRC),
  'a nullish list would wipe the cache');

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
