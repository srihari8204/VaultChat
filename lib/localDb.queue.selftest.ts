// lib/localDb.queue.selftest.ts — run: npx tsx lib/localDb.queue.selftest.ts
//   (needs the Node sqlite driver once: npm i -D better-sqlite3)
//
// The `queues` table is where an unsent message waits. If its DDL or any of the
// statements below is wrong, sends are lost or duplicated — so the real SQL is
// exercised against a real sqlite here.
//
// localDb.ts itself can't be imported in Node (it pulls in react-native), so the
// schema is read OUT of the source file rather than copied — a DDL change is
// picked up automatically instead of silently drifting from the test.

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
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── schema, lifted from the source ───────────────────────────────────────
function ddl(name: string): string {
  const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name}[\\s\\S]*?;`));
  if (!m) throw new Error(`selftest: no DDL for ${name} in localDb.ts — was it renamed?`);
  return m[0];
}
const db = new Database(':memory:');
db.exec(ddl('queues'));
db.exec(ddl('kv'));
for (const idx of SRC.match(/CREATE INDEX IF NOT EXISTS idx_queues_\w+[\s\S]*?;/g) ?? []) db.exec(idx);
check('queues + kv DDL is valid SQL', true);

// ── the statements the helpers run ───────────────────────────────────────
const put = db.prepare(
  `INSERT INTO queues (q, id, tag, data, created_at) VALUES (?,?,?,?,?)
   ON CONFLICT(q, id) DO UPDATE SET data = excluded.data, tag = excluded.tag`);
const ORDER = 'ORDER BY created_at, rowid';
const list = db.prepare(`SELECT data FROM queues WHERE q = ? ${ORDER} LIMIT ? OFFSET ?`);
const page = (q: string, limit: number, offset = 0) => list.all(q, limit, offset);
const byTag = db.prepare(`SELECT data FROM queues WHERE q = ? AND tag = ? ${ORDER} LIMIT ?`);
const get = db.prepare(`SELECT data FROM queues WHERE q = ? AND id = ?`);
const del = db.prepare(`DELETE FROM queues WHERE q = ? AND id = ?`);
const count = db.prepare(`SELECT COUNT(*) AS n FROM queues WHERE q = ?`);

const j = (o: unknown) => JSON.stringify(o);
const datas = (rows: any[]) => rows.map(r => JSON.parse(r.data).text);

put.run('msg', 'a', 'chat1', j({ text: 'first' }), 100);
put.run('msg', 'b', 'chat2', j({ text: 'second' }), 200);
put.run('msg', 'c', 'chat1', j({ text: 'third' }), 300);

eq('oldest-first ordering', datas(page('msg', 10)), ['first', 'second', 'third']);
eq('limit bounds a flush pass', datas(page('msg', 2)), ['first', 'second']);
eq('tag filters to one chat', datas(byTag.all('msg', 'chat1', 500)), ['first', 'third']);

// Re-putting an id must UPDATE the row, not add a second copy — this is what
// keeps a retry from sending the same message twice.
put.run('msg', 'a', 'chat1', j({ text: 'first-retried' }), 100);
eq('re-put updates in place', count.get('msg'), { n: 3 });
eq('re-put keeps queue position', datas(page('msg', 10)), ['first-retried', 'second', 'third']);
eq('get reaches an item by id', JSON.parse((get.get('msg', 'c') as any).data).text, 'third');

del.run('msg', 'b');
eq('delete removes exactly one', datas(page('msg', 10)), ['first-retried', 'third']);
eq('get on a deleted id returns nothing', get.get('msg', 'b'), undefined);

// Queues are namespaced: draining one must not touch another.
put.run('media', 'a', 'chat1', j({ text: 'photo' }), 100);
del.run('msg', 'a');
eq('queues are independent', datas(page('media', 10)), ['photo']);

// queueReplace: wipe + reinsert inside one transaction.
db.transaction(() => {
  db.prepare(`DELETE FROM queues WHERE q = ?`).run('media');
  put.run('media', 'x', 'chat9', j({ text: 'replaced' }), 500);
})();
eq('replace swaps the whole queue', datas(page('media', 10)), ['replaced']);

// ── same-millisecond sends keep their order ──────────────────────────────
// Client ids start with a RANDOM segment, so tie-breaking the sort on `id`
// reorders two messages enqueued in the same tick. Ordering on rowid (insertion
// order) is what keeps a fast double-send from arriving backwards.
db.prepare(`DELETE FROM queues WHERE q = ?`).run('msg');
put.run('msg', 'temp_zzz_early', null, j({ text: 'typed first' }), 1000);
put.run('msg', 'temp_aaa_later', null, j({ text: 'typed second' }), 1000);   // same ms, id sorts BEFORE
eq('same-ms sends keep insertion order', datas(page('msg', 10)), ['typed first', 'typed second']);
// and a retry of the first must not move it behind the second
put.run('msg', 'temp_zzz_early', null, j({ text: 'typed first (retry)' }), 1000);
eq('a retry keeps its queue position', datas(page('msg', 10)), ['typed first (retry)', 'typed second']);

// ── offset rotation steps past a wedged page ─────────────────────────────
// flush() pages the queue. If a whole page fails (200 messages waiting on one
// peer's keys), it advances the offset so items behind it still get a turn.
db.prepare(`DELETE FROM queues WHERE q = ?`).run('msg');
for (let i = 0; i < 5; i++) put.run('msg', `w${i}`, 'stuck-chat', j({ text: `wedged${i}` }), 1000 + i);
put.run('msg', 'fresh', 'other-chat', j({ text: 'behind the wedge' }), 2000);
eq('page 1 is the wedged items', datas(page('msg', 5, 0)), ['wedged0', 'wedged1', 'wedged2', 'wedged3', 'wedged4']);
eq('rotating past it reaches the rest', datas(page('msg', 5, 5)), ['behind the wedge']);
eq('rotating off the end returns empty (flush resets to head)', datas(page('msg', 5, 10)), []);

// ── kv (sync cursors) ────────────────────────────────────────────────────
const setMeta = db.prepare(`INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
const getMeta = db.prepare(`SELECT v FROM kv WHERE k = ?`);
setMeta.run('cursor', '2026-08-08T00:00:00Z');
setMeta.run('cursor', '2026-08-09T00:00:00Z');
eq('kv upsert overwrites', (getMeta.get('cursor') as any).v, '2026-08-09T00:00:00Z');
eq('kv miss is null-ish', getMeta.get('nope'), undefined);

// ── the locked-cache rule ────────────────────────────────────────────────
// With no DEK loaded, decField returns the row STILL SEALED. unseal() must drop
// that row instead of handing back ciphertext a caller would encrypt again and
// send as the user's message. The guard is "JSON.parse throws" — assert it does.
let parsedSealed = true;
try { JSON.parse('enc:v1:AAAAbase64ciphertext=='); } catch { parsedSealed = false; }
check('a sealed row does not parse as JSON (unseal skips it)', !parsedSealed);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all queue checks passed\n');
process.exit(failures ? 1 : 0);
