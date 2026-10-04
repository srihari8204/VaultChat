// db/financeBackup.selftest.ts — run: npx tsx db/financeBackup.selftest.ts
//
// This is the only path that can restore a lost ledger or Lucky Draw group, so
// the invariants that make a restore SAFE are asserted here rather than trusted:
//   • restoring the same file twice must not duplicate rows (idempotent)
//   • a restore must never delete data the file doesn't mention
//   • a finance failure must never sink the chat restore it rides along with
//   • the user id finance rows are tagged with must match components/finance/useMe
//
// financeBackup.ts imports expo-sqlite (no DB under tsx), so the pure predicate
// is mirrored here and the rest is asserted against the real source text.

import { readFileSync } from 'fs';
import { join } from 'path';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const BACKUP_VERSION = 1;
// Mirror of isRestorable in db/financeBackup.ts.
function isRestorable(data: any): boolean {
  return !!data && typeof data === 'object'
    && typeof data.version === 'number' && data.version <= BACKUP_VERSION
    && Array.isArray(data.groups) && Array.isArray(data.ledgers);
}

console.log('\nVault Finance — backup/restore self-test\n');

// ── the restore gate accepts only what it can actually read ──
const good = { version: 1, groups: [], ledgers: [] };
check('current-version backup accepted', isRestorable(good));
check('older version accepted', isRestorable({ ...good, version: 0 }));
check('FUTURE version refused (would drop unknown columns)', !isRestorable({ ...good, version: 2 }));
check('null refused', !isRestorable(null));
check('non-object refused', !isRestorable('backup'));
check('missing version refused', !isRestorable({ groups: [], ledgers: [] }));
check('missing groups refused', !isRestorable({ version: 1, ledgers: [] }));
check('wrong-shaped groups refused', !isRestorable({ version: 1, groups: {}, ledgers: [] }));
// A chat backup blob must not be mistaken for a finance one.
check('a chat bundle is not restorable as finance', !isRestorable({ v: 4, messages: [], chats: [] }));

// ── each row of an untrusted file is checked before INSERT OR REPLACE ──
// Mirror of isBackupRow in db/financeBackup.ts (asserted against the source below).
function isBackupRow(raw: any): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && typeof raw.id === 'string' && raw.id !== '';
}
check('a plain row with a string id is accepted', isBackupRow({ id: 'g1', name: 'x' }));
check('a string row is refused', !isBackupRow('g1'));
check('an array row is refused', !isBackupRow(['g1']));
check('a numeric id is refused', !isBackupRow({ id: 7 }));
check('an empty id is refused', !isBackupRow({ id: '' }));
check('null is refused', !isBackupRow(null));

// ── source invariants: db/financeBackup.ts ──
const src = readFileSync(join(__dirname, 'financeBackup.ts'), 'utf8');
check('the row guard mirrored above is the real one',
  src.includes("typeof (raw as { id?: unknown }).id === 'string'") && src.includes('if (!isBackupRow(raw)) continue;'));
check('only scalar column values are bound', src.includes('isScalar(row[c])'));

check('restore is idempotent (INSERT OR REPLACE, keyed on original id)',
  src.includes('INSERT OR REPLACE INTO'));
check('restore never deletes — no DELETE/DROP/TRUNCATE in the module',
  !/\b(DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i.test(src));
check('columns come from the live schema, not a hardcoded list',
  src.includes('PRAGMA table_info'));
check('a row with no id is skipped rather than inserted blind',
  src.includes("!use.includes('id')"));
check('backup is scoped to one user', src.includes('WHERE user_id = ?'));

// Parents must be written before children, or a child can reference a row that
// isn't there yet.
const iGroups = src.indexOf("put('chitti_groups'");
const iMembers = src.indexOf("put('chitti_members'");
const iColl = src.indexOf("put('chitti_collections'");
const iLedgers = src.indexOf("put('ledger_entries'");
const iLedUpd = src.indexOf("put('ledger_updates'");
check('groups restored before members', iGroups > 0 && iMembers > iGroups);
check('members restored before collections', iMembers > 0 && iColl > iMembers);
check('ledgers restored before ledger updates', iLedgers > 0 && iLedUpd > iLedgers);

// Children have no user_id — losing the parent-id scoping would silently back
// up nothing (or everything).
check('members gathered via their group ids', src.includes('WHERE group_id IN'));
check('ledger updates gathered via their ledger ids', src.includes('WHERE ledger_id IN'));

// ── source invariants: lib/cloudBackup.ts wiring ──
const cb = readFileSync(join(__dirname, '..', 'lib', 'cloudBackup.ts'), 'utf8');

check('bundle carries finance', /finance,/.test(cb) && cb.includes('buildFinanceBackup'));
check('bundle version bumped to 4', /v:\s*4/.test(cb));
check('restore reads finance from the bundle', cb.includes('data.finance'));
check('finance snapshot failure cannot sink a chat backup',
  /catch \(e\) \{ console\.warn\('\[backup\] finance snapshot skipped/.test(cb));
check('finance restore failure cannot sink a chat restore',
  /catch \(e\) \{ console\.warn\('\[backup\] finance restore skipped/.test(cb));

// THE DRIFT HAZARD: finance rows are tagged with useMe's id, including its
// 'local' fallback. If these two disagree, a restore writes rows the finance
// screens will never query back — silently, with no error.
const useMe = readFileSync(join(__dirname, '..', 'components', 'finance', 'useMe.ts'), 'utf8');
const useMeFallback = /u\?\.id \?\? '([^']+)'/.exec(useMe)?.[1];
const backupFallback = /u\?\.id \?\? '([^']+)'/.exec(cb)?.[1];
check('backup user id matches useMe exactly',
  !!useMeFallback && useMeFallback === backupFallback,
  `useMe='${useMeFallback}' cloudBackup='${backupFallback}'`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
