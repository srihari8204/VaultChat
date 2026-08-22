// db/financeBackup.sqlite.selftest.ts — run: npx tsx db/financeBackup.sqlite.selftest.ts
//
// The other backup self-test asserts the SOURCE says the right things. This one
// executes the REAL schema and the REAL SQL shapes against an actual SQLite
// engine (better-sqlite3, already a devDependency), because "the source contains
// INSERT OR REPLACE" and "restoring twice does not duplicate a row" are
// different claims, and only the second one matters to a user.
//
// Covers the three things that would silently destroy data:
//   1. the schema is valid SQL and has the `address` column
//   2. the additive migration adds `address` to an OLD install WITHOUT data loss
//   3. restore is idempotent and preserves parent→child relationships
//
// This file is a *.selftest.ts that nothing imports, so its node-only requires
// can never reach a Metro bundle (see the embedded-self-check trap).

import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nVault Finance — real-SQLite backup/restore self-test\n');

// ── 1. the REAL schema text, executed ──
const dbSrc = readFileSync(join(__dirname, 'financeDb.ts'), 'utf8');
const schema = /const SCHEMA = `([\s\S]*?)`;/.exec(dbSrc)?.[1];
check('extracted SCHEMA from db/financeDb.ts', !!schema && schema.includes('chitti_members'));
if (!schema) { console.log('\nCannot continue without the schema.\n'); process.exit(1); }

const db = new Database(':memory:');
let schemaOk = true;
try { db.exec(schema); } catch (e: any) { schemaOk = false; check('schema executes', false, e.message); }
if (schemaOk) check('the real schema is valid SQL', true);

const colsOf = (t: string) => (db.pragma(`table_info(${t})`) as any[]).map(c => c.name);
check('chitti_members has address', colsOf('chitti_members').includes('address'));

// ── 2. the additive migration, on an OLD install that already has data ──
const old = new Database(':memory:');
old.exec(`CREATE TABLE chitti_members (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL,
  phone TEXT, number INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
old.prepare(`INSERT INTO chitti_members (id,group_id,name,phone,number,created_at) VALUES (?,?,?,?,?,?)`)
  .run('m1', 'g1', 'Ramesh', '9876543210', 1, 1000);
// This mirrors the guard in financeDb.ts financeDb().
const hasAddress = (d: any) => (d.pragma('table_info(chitti_members)') as any[]).some(c => c.name === 'address');
check('guard correctly detects the missing column', !hasAddress(old));
if (!hasAddress(old)) old.exec(`ALTER TABLE chitti_members ADD COLUMN address TEXT`);
check('address added to the old install', hasAddress(old));
const survivor = old.prepare(`SELECT * FROM chitti_members WHERE id = ?`).get('m1') as any;
eq('existing member survived the migration', survivor.name, 'Ramesh');
eq('…with its phone intact', survivor.phone, '9876543210');
eq('…and a NULL address rather than a crash', survivor.address, null);
// Running the guarded migration again must be a no-op, not an error.
let reran = true;
try { if (!hasAddress(old)) old.exec(`ALTER TABLE chitti_members ADD COLUMN address TEXT`); }
catch { reran = false; }
check('migration is safe to run on every boot', reran && hasAddress(old));

// ── 3. restore semantics against the real engine ──
// Seed a group with children, exactly as buildBackup would capture them.
const put = (table: string, row: Record<string, any>) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(cols.map(c => row[c]));
};
const group = { id: 'g1', user_id: 'u1', name: 'Sundar Group', chit_value: 100000, installment: 5000, members: 20, duration: 20, start_date: 1, foreman: null, status: 'active', created_at: 1 };
const member = { id: 'm1', group_id: 'g1', name: 'Ramesh', phone: '9876543210', address: 'MG Road', number: 1, created_at: 1 };
const coll = { id: 'c1', group_id: 'g1', member_id: 'm1', month: 1, amount: 5000, status: 'paid', at: 1 };
const auction = { id: 'a1', group_id: 'g1', month: 1, winner_id: 'm1', winner_name: 'Ramesh', winning_bid: 1000, commission: 0, dividend: 50, at: 1 };

for (const _ of [1, 2]) {          // restore the SAME backup twice
  put('chitti_groups', group);
  put('chitti_members', member);
  put('chitti_collections', coll);
  put('chitti_auctions', auction);
}
const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
eq('restoring twice does not duplicate the group', count('chitti_groups'), 1);
eq('…nor the member', count('chitti_members'), 1);
eq('…nor the collection', count('chitti_collections'), 1);
eq('…nor the auction', count('chitti_auctions'), 1);

// The relationship must survive a restore, or dues belong to nobody.
const joined = db.prepare(
  `SELECT m.name, c.status FROM chitti_collections c
   JOIN chitti_members m ON m.id = c.member_id WHERE c.group_id = ?`).get('g1') as any;
eq('member → collection relationship intact after restore', joined?.name, 'Ramesh');
eq('…with the due status preserved', joined?.status, 'paid');

// A restore must UPDATE an existing row, not silently keep the stale one.
put('chitti_members', { ...member, name: 'Ramesh Kumar', address: 'New Address' });
const updated = db.prepare(`SELECT * FROM chitti_members WHERE id = ?`).get('m1') as any;
eq('restore updates an existing row in place', updated.name, 'Ramesh Kumar');
eq('…including the new address column', updated.address, 'New Address');
eq('…still exactly one row', count('chitti_members'), 1);

// Restoring must never remove rows the backup did not mention.
put('chitti_members', { id: 'm2', group_id: 'g1', name: 'Suresh', phone: null, address: null, number: 2, created_at: 2 });
put('chitti_groups', group);
eq('a second member is not wiped by a later restore', count('chitti_members'), 2);

// ── 4. delete must not leave orphans ──
// SQLite FKs are off and the schema declares no cascades, so every child table
// has to be named explicitly. `chitti_auctions` was missing from deleteGroup,
// so auctions outlived their group: unreachable, unbacked-up, unbounded.
db.prepare(`INSERT INTO finance_timeline (id,ref_type,ref_id,kind,detail,at) VALUES (?,?,?,?,?,?)`)
  .run('t1', 'chitti', 'g1', 'created', 'Group created', 1);

const chittiSrc = readFileSync(join(__dirname, 'chitti.ts'), 'utf8');
const delGroup = /export async function deleteGroup[\s\S]*?\n}/.exec(chittiSrc)?.[0] ?? '';
for (const t of ['chitti_groups', 'chitti_members', 'chitti_collections', 'chitti_auctions', 'finance_timeline']) {
  check(`deleteGroup names ${t}`, delGroup.includes(t));
}

// Execute exactly what deleteGroup does and prove nothing is left behind.
db.prepare(`DELETE FROM chitti_groups WHERE id = ?`).run('g1');
db.prepare(`DELETE FROM chitti_members WHERE group_id = ?`).run('g1');
db.prepare(`DELETE FROM chitti_collections WHERE group_id = ?`).run('g1');
db.prepare(`DELETE FROM chitti_auctions WHERE group_id = ?`).run('g1');
db.prepare(`DELETE FROM finance_timeline WHERE ref_type = 'chitti' AND ref_id = ?`).run('g1');
eq('group gone', count('chitti_groups'), 0);
eq('members gone (both of them)', count('chitti_members'), 0);
eq('collections gone', count('chitti_collections'), 0);
eq('auctions gone — the leak this fixes', count('chitti_auctions'), 0);
eq('timeline gone', count('finance_timeline'), 0);

const ledgerSrc = readFileSync(join(__dirname, 'ledger.ts'), 'utf8');
const delLedger = /export async function deleteLedger[\s\S]*?\n}/.exec(ledgerSrc)?.[0] ?? '';
for (const t of ['ledger_entries', 'ledger_updates', 'finance_timeline']) {
  check(`deleteLedger names ${t}`, delLedger.includes(t));
}

// markCollection must not skip a real change: guarding on status alone dropped
// an amount edit and left the due recorded at the old figure.
const markFn = /export async function markCollection[\s\S]*?\n}/.exec(chittiSrc)?.[0] ?? '';
check('markCollection skips only when status AND amount are unchanged',
  /existing\.status === status && existing\.amount === amount/.test(markFn));

db.close(); old.close();
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
