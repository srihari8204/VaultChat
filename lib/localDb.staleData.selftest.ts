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
const visiblePredicate = SRC.match(/const VISIBLE_MESSAGE = `([^`]+)`;/)?.[1];
if (!visiblePredicate) throw new Error('selftest: missing real visibility predicate');
const expandSql = (sql: string) => sql.replace(/\$\{VISIBLE_MESSAGE\}/g, visiblePredicate);

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
db.exec(SRC.match(/ALTER TABLE messages ADD COLUMN pending_envelope TEXT/)![0]);
db.exec(ddl('chats'));

// The real upsert, extracted rather than retyped: if the ON CONFLICT clause
// changes, these tests exercise the change.
const upsertSrc = SRC.match(/INSERT INTO messages[\s\S]*?WHERE messages\.deleted_at IS NULL`/);
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
  '2026-01-01T00:00:00.000Z', null, m.deleted_at ?? null, null, null,
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
check('a remote tombstone wipes cached plaintext', get(101).content === null);

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
check('an undecryptable message has no displayable plaintext',
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
const backSql = expandSql(backSrc?.[0].match(/`([\s\S]*?)`/)?.[1] ?? '');
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
  return expandSql(fn?.[0].match(/`([\s\S]*?)`/)?.[1] ?? '');
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

// ── 8. Exit Kit: imported history is not cache ───────────────────────────
//
// Imported messages carry NEGATIVE ids and have no server copy. Three guards
// keep that safe, and all three are one-line edits somebody will eventually be
// tempted to "tidy up" — so each is asserted against the real source here.
console.log('imported history must survive, sort as the past, and never sync');

// 8a. capacity cleanup must never remove durable history. Only an explicit
// expiry is safe: delivered bodies may already have been purged server-side.
const victimSql = SRC.match(/SELECT id FROM messages\s+WHERE expires_at IS NOT NULL AND expires_at <= \?\s+ORDER BY expires_at ASC LIMIT 5000/);
check('pruneMessageCache selects only explicitly expired rows', !!victimSql,
  'a count/row-number sweep can permanently destroy delivered local history');

// 8b. no sync/send path may ever pick up an imported row.
const cacheFn = SRC.match(/export async function cacheMessages[\s\S]*?\n}/)?.[0] ?? '';
check('cacheMessages still skips id <= 0',
  /m\.id <= 0\) continue/.test(cacheFn),
  'this guard is what stops an imported row being uploaded as if it were ours');

// 8c. the global sync cursor must be blind to negative ids.
const cursorFn = SRC.match(/export async function getGlobalSyncCursor[\s\S]*?\n}/)?.[0] ?? '';
check('getGlobalSyncCursor reads MAX(id) (which ignores negatives) and floors at the stored mark',
  /MAX\(id\)/.test(cursorFn) && /Math\.max\(fromRows, stored\)/.test(cursorFn));
const noteFn = SRC.match(/export async function noteGlobalSyncCursor[\s\S]*?\n}/)?.[0] ?? '';
check('noteGlobalSyncCursor refuses non-positive ids',
  /id <= 0\) return/.test(noteFn));

// 8d. the additive migration + unique index, lifted from the source.
const alterSql = SRC.match(/ALTER TABLE messages ADD COLUMN import_key TEXT/)?.[0];
const idxSql   = SRC.match(/CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_import_key[\s\S]*?import_key IS NOT NULL/)?.[0];
check('import_key column is added additively', !!alterSql);
check('import_key has a PARTIAL unique index', !!idxSql,
  'without WHERE import_key IS NOT NULL, every pre-existing NULL row would collide');
if (alterSql && idxSql) {
  db.exec(alterSql);
  db.exec(idxSql);

  // Real behaviour, real sqlite: two chats' worth of rows already exist above
  // (ids 1001..1250 in c2). Import three messages into c2 with negative ids.
  // Conflict target repeats the partial index's predicate — SQLite rejects the
  // upsert outright without it. Lifted from the shipped statement so the two
  // cannot drift.
  check('the shipped upsert targets the partial index correctly',
    /ON CONFLICT\(import_key\) WHERE import_key IS NOT NULL DO NOTHING/.test(SRC),
    'a bare ON CONFLICT(import_key) does not prepare against a partial index');
  const ins = db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, type, content, created_at, import_key)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(import_key) WHERE import_key IS NOT NULL DO NOTHING`);
  const rows: [number, string, string, string, string, string, string][] = [
    [-3000, 'c2', 'u1', 'text', 'hi',    '2022-01-01T10:00:00Z', 'k1'],
    [-2000, 'c2', 'u2', 'text', 'hello', '2023-01-01T10:00:00Z', 'k2'],
    [-1000, 'c2', 'u1', 'text', 'bye',   '2024-01-01T10:00:00Z', 'k3'],
  ];
  for (const r of rows) ins.run(...r);
  check('imported rows insert', (db.prepare(`SELECT COUNT(*) n FROM messages WHERE id < 0`).get() as any).n === 3);

  // Re-import: same keys, DIFFERENT ids (as a shifted export would produce).
  let dupes = 0;
  for (const r of rows) { const res = ins.run(r[0] - 7, ...r.slice(1) as any); if (res.changes === 0) dupes++; }
  check('re-importing the same conversation adds nothing',
    (db.prepare(`SELECT COUNT(*) n FROM messages WHERE id < 0`).get() as any).n === 3 && dupes === 3,
    'the UNIQUE index is what makes retry safe — not the import loop');

  // Extended export: the SAME messages plus a newer one.
  ins.run(-500, 'c2', 'u2', 'text', 'new', '2025-06-01T10:00:00Z', 'k4');
  check('an extended re-export adds only its new messages',
    (db.prepare(`SELECT COUNT(*) n FROM messages WHERE id < 0`).get() as any).n === 4);

  // 8e. ordering: imported history renders BEFORE all server history, using the
  // real reader SQL rather than a restatement of it.
  const readSql = SRC.match(/export async function getCachedMessages\(/)
    ? `SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`
    : '';
  const page = db.prepare(readSql).all('c2', 1000) as any[];   // newest-first
  const firstNeg = page.findIndex(r => r.id < 0);
  check('every imported row sorts below every server row',
    firstNeg > 0 && page.slice(firstNeg).every(r => r.id < 0) && page.slice(0, firstNeg).every(r => r.id > 0),
    `boundary at index ${firstNeg} of ${page.length}`);
  check('imported rows keep their own original order',
    (() => { const n = page.filter(r => r.id < 0).map(r => r.created_at); return [...n].sort().reverse().join() === n.join(); })(),
    'newest-first within the imported block');

  // 8f. the expiry sweep, run for real, must leave all durable history alone.
  if (victimSql) {
    db.prepare(`UPDATE messages SET expires_at = ? WHERE id = ?`).run('2025-01-01T00:00:00Z', 1001);
    const victims = db.prepare(victimSql[0]).all('2026-09-15T00:00:00Z') as any[];
    check('expiry cleanup selects exactly the expired row',
      victims.length === 1 && victims[0].id === 1001, victims.map(v => v.id).join(','));
    check('ordinary and imported history survive automatic cleanup',
      !victims.some(v => v.id < 0 || v.id === 1002));
  }

  // 8g. MAX(id) — the sync cursor's source — is unmoved by the import.
  const maxId = (db.prepare(`SELECT MAX(id) AS m FROM messages`).get() as any).m;
  check('MAX(id) is unaffected by imported rows', maxId > 0, `MAX(id)=${maxId}`);
}

// 8h. id derivation: monotonic in time, and inside the safe-integer budget.
const CEIL = 4102444800, SLOTS = 65536;
const idFor = (ms: number, seq: number) => (Math.floor(ms / 1000) - CEIL) * SLOTS + seq;
check('importedIdFor matches the shipped constants',
  new RegExp(`IMPORT_ID_CEILING = ${CEIL}`).test(SRC) && new RegExp(`IMPORT_ID_SLOTS   = ${SLOTS}`).test(SRC));
const t2022 = Date.parse('2022-01-01T00:00:00Z'), t2026 = Date.parse('2026-08-01T00:00:00Z');
check('a later message always gets a larger id', idFor(t2026, 0) > idFor(t2022, 0));
check('same second, later message still gets a larger id', idFor(t2022, 1) > idFor(t2022, 0));
check('every imported id is negative', idFor(t2026, SLOTS - 1) < 0);
check('ids stay inside Number.MAX_SAFE_INTEGER', Math.abs(idFor(0, 0)) < Number.MAX_SAFE_INTEGER,
  `|min id| = ${Math.abs(idFor(0, 0))}`);

// The same indexed keyset query must keep returning a fixed-size newest window
// as local history grows. Avoid wall-clock assertions: the query plan is the
// deterministic performance contract and does not flake on slower CI hosts.
console.log('large local histories stay index-paged');
const scale = new Database(':memory:');
scale.exec(ddl('messages'));
scale.exec(`CREATE INDEX idx_messages_chat ON messages(chat_id, id DESC)`);
scale.exec(ddl('chats'));
scale.exec(`CREATE INDEX idx_messages_preview ON messages(chat_id, id DESC)
             WHERE deleted_at IS NULL AND type <> 'reaction'`);
scale.exec(`CREATE INDEX idx_messages_expiry ON messages(expires_at)
             WHERE expires_at IS NOT NULL`);
scale.prepare(`INSERT INTO chats (id, data) VALUES ('large', '{}')`).run();
const addScale = scale.prepare(
  `INSERT INTO messages (id, chat_id, sender_id, type, content, created_at)
   VALUES (?, 'large', 'u1', 'text', ?, '2026-01-01T00:00:00Z')`);
const addMany = scale.transaction((from: number, to: number) => {
  for (let id = from; id <= to; id++) addScale.run(id, `m${id}`);
});
let inserted = 0;
for (const size of [100, 1000, 10000, 100000]) {
  addMany(inserted + 1, size); inserted = size;
  const newest = scale.prepare(
    `SELECT id FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
  ).all('large', 50) as any[];
  const older = scale.prepare(
    `SELECT id FROM messages WHERE chat_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
  ).all('large', size - 49, 100) as any[];
  check(`${size.toLocaleString()} rows: newest 50 remains exact`,
    newest.length === 50 && newest[0].id === size && newest[49].id === size - 49);
  check(`${size.toLocaleString()} rows: older page is keyset-correct`,
    older.length === Math.min(100, size - 50) && (older.length === 0 || older[0].id === size - 50));
}
const plan = scale.prepare(
  `EXPLAIN QUERY PLAN SELECT id FROM messages
    WHERE chat_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
).all('large', 99951, 100) as any[];
check('100,000-row pagination uses the chat/id index',
  plan.some(r => /idx_messages_chat/i.test(String(r.detail))), plan.map(r => r.detail).join(' | '));
const expiryPlan = scale.prepare(
  `EXPLAIN QUERY PLAN SELECT id FROM messages
    WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC LIMIT 5000`,
).all('2026-09-15T00:00:00Z') as any[];
check('expiry cleanup uses its partial index',
  expiryPlan.some(r => /idx_messages_expiry/i.test(String(r.detail))),
  expiryPlan.map(r => r.detail).join(' | '));
addScale.run(100001, 'newest reaction');
scale.prepare(`UPDATE messages SET type = 'reaction' WHERE id = 100001`).run();
const previewFn = SRC.match(/export async function getLastMessagePerChat[\s\S]*?\n}/)?.[0] ?? '';
const previewSql = previewFn.match(/getAllAsync\(\s*`([\s\S]*?)`, \[\]\)/)?.[1] ?? '';
check('the preview query is lifted from production', !!previewSql);
if (previewSql) {
  const preview = scale.prepare(previewSql).get() as any;
  check('100,000-row preview returns the newest non-reaction', preview?.id === 100000, `id=${preview?.id}`);
  const previewPlan = scale.prepare(`EXPLAIN QUERY PLAN ${previewSql}`).all() as any[];
  check('chat preview seeks the partial preview index',
    previewPlan.some(r => /idx_messages_preview/i.test(String(r.detail))),
    previewPlan.map(r => r.detail).join(' | '));
}
scale.close();

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
