// db/financeBackup.ts — full backup/restore of the local finance database.
//
// WHY THIS EXISTS: lib/cloudBackup.ts backs up localDb (messaging) only, so
// every ledger, Lucky Draw group, collection and auction lived in exactly one
// place — this phone. Losing the device lost all of it. The CSV export is a
// spreadsheet for reading, not a backup: it covers groups but not members,
// collections or auctions, and could not be imported back.
//
// One serializer, two callers: the manual JSON file in app/finance/io.tsx and
// the cloud backup in lib/cloudBackup.ts. They must never drift.
//
// Restore is keyed on the original row ids with INSERT OR REPLACE, so it is
// idempotent — importing the same backup twice yields the same database, and
// relationships (member -> group, collection -> member) survive intact.

import { financeDb } from './financeDb';

/** Bump only for a breaking shape change; restore refuses a newer version. */
export const BACKUP_VERSION = 1;

export interface FinanceBackup {
  version: number;
  exportedAt: number;
  userId: string;
  ledgers: any[];
  ledgerUpdates: any[];
  groups: any[];
  members: any[];
  collections: any[];
  auctions: any[];
  reminders: any[];
  timeline: any[];
}

export interface RestoreCounts {
  ledgers: number; ledgerUpdates: number; groups: number; members: number;
  collections: number; auctions: number; reminders: number; timeline: number;
}

/** Everything belonging to one user, including rows reachable only via a parent id. */
export async function buildBackup(userId: string): Promise<FinanceBackup> {
  const d = await financeDb();
  const all = <T>(sql: string, args: any[] = []) => d.getAllAsync<T>(sql, args);

  const ledgers = await all<any>(`SELECT * FROM ledger_entries WHERE user_id = ?`, [userId]);
  const groups = await all<any>(`SELECT * FROM chitti_groups WHERE user_id = ?`, [userId]);
  const reminders = await all<any>(`SELECT * FROM reminders WHERE user_id = ?`, [userId]);

  // Children have no user_id — they are reachable only through their parent.
  const ledgerIds = ledgers.map(l => l.id);
  const groupIds = groups.map(g => g.id);
  const inClause = (n: number) => Array(n).fill('?').join(',');

  const ledgerUpdates = ledgerIds.length
    ? await all<any>(`SELECT * FROM ledger_updates WHERE ledger_id IN (${inClause(ledgerIds.length)})`, ledgerIds)
    : [];
  const members = groupIds.length
    ? await all<any>(`SELECT * FROM chitti_members WHERE group_id IN (${inClause(groupIds.length)})`, groupIds)
    : [];
  const collections = groupIds.length
    ? await all<any>(`SELECT * FROM chitti_collections WHERE group_id IN (${inClause(groupIds.length)})`, groupIds)
    : [];
  const auctions = groupIds.length
    ? await all<any>(`SELECT * FROM chitti_auctions WHERE group_id IN (${inClause(groupIds.length)})`, groupIds)
    : [];

  // Timeline rows point at a ledger or group by ref_id.
  const refIds = [...ledgerIds, ...groupIds];
  const timeline = refIds.length
    ? await all<any>(`SELECT * FROM finance_timeline WHERE ref_id IN (${inClause(refIds.length)})`, refIds)
    : [];

  return {
    version: BACKUP_VERSION, exportedAt: Date.now(), userId,
    ledgers, ledgerUpdates, groups, members, collections, auctions, reminders, timeline,
  };
}

/** True when `data` looks like a finance backup this build can restore. */
export function isRestorable(data: any): data is FinanceBackup {
  return !!data && typeof data === 'object'
    && typeof data.version === 'number' && data.version <= BACKUP_VERSION
    && Array.isArray(data.groups) && Array.isArray(data.ledgers);
}

/**
 * Merge a backup into the local database. Existing rows with the same id are
 * replaced; anything not in the backup is left alone (never a destructive wipe).
 * Rows are re-tagged to `userId` so a backup restores onto a new account.
 */
export async function restoreBackup(userId: string, data: FinanceBackup): Promise<RestoreCounts> {
  if (!isRestorable(data)) throw new Error('Not a valid finance backup file.');
  const d = await financeDb();

  // Column lists are read from the live schema rather than hardcoded, so a
  // backup taken before a column was added (e.g. chitti_members.address)
  // still restores, and a future column does not silently drop.
  const colsOf = async (table: string): Promise<string[]> =>
    (await d.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(c => c.name);

  const put = async (table: string, rows: any[], stamp?: Record<string, any>): Promise<number> => {
    if (!rows?.length) return 0;
    const cols = await colsOf(table);
    let n = 0;
    for (const raw of rows) {
      const row = { ...raw, ...(stamp ?? {}) };
      // Only columns this build actually has, and only if the row carries an id.
      const use = cols.filter(c => row[c] !== undefined);
      if (!use.includes('id') || row.id == null) continue;
      await d.runAsync(
        `INSERT OR REPLACE INTO ${table} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`,
        use.map(c => row[c] ?? null),
      );
      n++;
    }
    return n;
  };

  // One transaction: a restore that fails part-way rolls back instead of
  // leaving a half-merged book. Parents before children inside it.
  let counts!: RestoreCounts;
  await d.withTransactionAsync(async () => {
    const ledgers = await put('ledger_entries', data.ledgers, { user_id: userId });
    const groups = await put('chitti_groups', data.groups, { user_id: userId });
    const reminders = await put('reminders', data.reminders, { user_id: userId });
    const ledgerUpdates = await put('ledger_updates', data.ledgerUpdates);
    const members = await put('chitti_members', data.members);
    const collections = await put('chitti_collections', data.collections);
    const auctions = await put('chitti_auctions', data.auctions);
    const timeline = await put('finance_timeline', data.timeline);
    counts = { ledgers, ledgerUpdates, groups, members, collections, auctions, reminders, timeline };
  });
  return counts;
}

export default { BACKUP_VERSION, buildBackup, restoreBackup, isRestorable };
