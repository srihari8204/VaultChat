// lib/lastMessageQuery.selftest.ts — run: npx tsx lib/lastMessageQuery.selftest.ts
//
// getLastMessagePerChat feeds every preview line on the chat list. It used to
// be a DISTINCT plus one indexed lookup PER CHAT — correct, but one JS/native
// bridge crossing each, so fifty chats cost fifty-one round trips on every
// render of that screen.
//
// The replacement is a single window-function query. That is only worth doing
// if it returns exactly what the loop did, and "the previews look wrong" is a
// quiet failure — a stale line, or the wrong sender's text under someone's
// name. So this runs BOTH forms against a real SQLite and compares them.
//
// Uses node:sqlite (built in since Node 22), so there is nothing to install.

import { DatabaseSync } from 'node:sqlite';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nChat-list last-message query\n');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY, chat_id TEXT, content TEXT, type TEXT,
  sender_id TEXT, deleted_at TEXT
);`);

const rows: [number, string, string, string, string, string | null][] = [
  // chat A: newest is 30, but 40 is a reaction and 35 is deleted — both skipped
  [10, 'A', 'a-old',      'text',     'u1', null],
  [30, 'A', 'a-newest',   'text',     'u2', null],
  [35, 'A', 'a-deleted',  'text',     'u1', '2026-01-01'],
  [40, 'A', 'a-reaction', 'reaction', 'u2', null],
  // chat B: a single message
  [20, 'B', 'b-only',     'image',    'u3', null],
  // chat C: every message is excluded → C must not appear at all
  [50, 'C', 'c-del',      'text',     'u1', '2026-01-01'],
  [51, 'C', 'c-react',    'reaction', 'u1', null],
  // chat D: ids deliberately out of insertion order
  [70, 'D', 'd-newest',   'text',     'u4', null],
  [60, 'D', 'd-older',    'text',     'u5', null],
];
const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)');
for (const r of rows) ins.run(...r);

type Row = { chat_id: string; id: number; content: string; type: string; sender_id: string };
const key = (m: Map<string, Row>) =>
  [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([c, r]) => `${c}:${r.id}:${r.content}:${r.type}:${r.sender_id}`).join('|');

// ── OLD: DISTINCT + one lookup per chat (what shipped) ────────────────
const oldWay = new Map<string, Row>();
for (const c of db.prepare('SELECT DISTINCT chat_id FROM messages').all() as any[]) {
  const r = db.prepare(
    `SELECT chat_id, id, content, type, sender_id FROM messages
      WHERE chat_id = ? AND deleted_at IS NULL AND type <> 'reaction'
      ORDER BY id DESC LIMIT 1`).get(c.chat_id) as any;
  if (r) oldWay.set(r.chat_id, r);
}

// ── NEW: one window-function query ────────────────────────────────────
const newWay = new Map<string, Row>();
for (const r of db.prepare(
  `SELECT chat_id, id, content, type, sender_id FROM (
     SELECT chat_id, id, content, type, sender_id,
            ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id DESC) AS rn
       FROM messages
      WHERE deleted_at IS NULL AND type <> 'reaction'
   ) WHERE rn = 1`).all() as any[]) newWay.set(r.chat_id, r);

check('the two forms agree exactly', key(oldWay) === key(newWay),
  `old=${key(oldWay)} new=${key(newWay)}`);

// Spell out the properties, so a future edit that breaks one says which.
check('picks the newest by id, not by insertion order', newWay.get('D')?.content === 'd-newest');
check('skips deleted messages', newWay.get('A')?.content !== 'a-deleted');
check('skips reactions — they must never be a preview', newWay.get('A')?.content !== 'a-reaction');
check('...so chat A previews its newest REAL message', newWay.get('A')?.content === 'a-newest');
check('a chat with one message still appears', newWay.get('B')?.content === 'b-only');
check('a chat whose messages are all excluded is omitted entirely',
  !newWay.has('C'), 'an empty preview row would render a ghost chat');
check('carries the fields the preview needs',
  newWay.get('B')?.type === 'image' && newWay.get('B')?.sender_id === 'u3');
check('one row per chat', newWay.size === 3);

db.close();
console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all last-message query checks passed\n');
process.exit(failures ? 1 : 0);
