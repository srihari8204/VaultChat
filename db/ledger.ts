// db/ledger.ts — the Ledger Book store (lend / borrow) for Vault Finance.
//
// Richer than the original financeBook: tracks remaining balance, status and a
// last-updated stamp, with a companion ledger_updates log for manual updates.
// On-device only, tagged with the current user_id.

import { financeDb, uuid, now } from './financeDb';
import { addTimeline, type TimelineRow } from './financeTimeline';
import { toPaise, fromPaise } from '../utils/money';
import type { LedgerStatus } from '../constants/financeTheme';
import type { LedgerPeriod } from '../utils/finance';
import { ledgerStatusFor } from '../utils/financeRules';
import { fmtDate } from '../utils/financeFormat';

export interface LedgerEntry {
  id: string;
  user_id: string;
  direction: 'lend' | 'borrow';
  name: string;
  mobile: string | null;
  interest_type: 'simple' | 'compound';
  principal: number;
  rate: number;
  rate_mode: 'rupees' | 'percent';
  period: LedgerPeriod;
  start_date: number;
  end_date: number | null;
  remaining: number;
  status: LedgerStatus;
  notes: string | null;
  created_at: number;
  last_updated: number;
}

export interface LedgerUpdate {
  id: string;
  ledger_id: string;
  received: number;
  remaining: number;
  note: string | null;
  updated_at: number;
}

type NewLedger = Omit<LedgerEntry, 'id' | 'created_at' | 'last_updated' | 'remaining' | 'status'> &
  Partial<Pick<LedgerEntry, 'remaining' | 'status'>>;

export async function insertLedger(row: NewLedger): Promise<LedgerEntry> {
  const d = await financeDb();
  const t = now();
  // Money normalised to paise at the write boundary — same rule as db/chitti.ts,
  // so totals across the two halves of the finance DB cannot drift apart.
  const principal = fromPaise(toPaise(row.principal));
  const full: LedgerEntry = {
    ...row,
    id: uuid(),
    principal,
    remaining: fromPaise(toPaise(row.remaining ?? principal)),
    status: row.status ?? 'running',
    created_at: t,
    last_updated: t,
  };
  await d.runAsync(
    `INSERT INTO ledger_entries
       (id,user_id,direction,name,mobile,interest_type,principal,rate,rate_mode,period,start_date,end_date,remaining,status,notes,created_at,last_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.user_id, full.direction, full.name, full.mobile, full.interest_type, full.principal,
     full.rate, full.rate_mode, full.period, full.start_date, full.end_date, full.remaining, full.status,
     full.notes, full.created_at, full.last_updated],
  );
  await addTimeline('ledger', full.id, 'created',
    `${full.direction === 'lend' ? 'Lent' : 'Borrowed'} ₹${full.principal.toLocaleString('en-IN')} @ ${full.rate}${full.rate_mode === 'rupees' ? '₹' : '%'} ${full.period}`);
  return full;
}

/** Insert many ledgers all-or-nothing (CSV import): a failure part-way rolls
 *  back instead of leaving half a file imported. */
export async function insertLedgers(rows: NewLedger[]): Promise<number> {
  const d = await financeDb();
  let n = 0;
  await d.withTransactionAsync(async () => {
    for (const row of rows) { await insertLedger(row); n++; }
  });
  return n;
}

/**
 * Bring stored statuses up to date (utils/financeRules ledgerStatusFor): a
 * balance left after the end day is overdue, an overdue loan whose end date
 * moved later runs again. Done on every read, so the dashboard's Overdue tile,
 * reports and lists agree without a background job. `last_updated` is the
 * user's last change and is not touched; the timeline records the transition.
 */
async function syncLedgerStatuses(rows: LedgerEntry[]): Promise<LedgerEntry[]> {
  const t = now();
  const out: LedgerEntry[] = [];
  for (const e of rows) {
    const next = ledgerStatusFor(e, t);
    if (next !== e.status) {
      const d = await financeDb();
      // The `AND status = ?` guard makes overlapping reads race safely: only the
      // read whose UPDATE changed the row writes the timeline entry.
      const r = await d.runAsync(`UPDATE ledger_entries SET status = ? WHERE id = ? AND status = ?`, [next, e.id, e.status]);
      if (r.changes > 0) await addTimeline('ledger', e.id, 'status',
        next === 'overdue' ? `Marked overdue · the end date ${e.end_date ? fmtDate(e.end_date) : ''} has passed`
          : next === 'completed' ? 'Marked completed · nothing remains'
            : 'Running again · the end date is now later');
      out.push({ ...e, status: next });
    } else out.push(e);
  }
  return out;
}

export async function listLedger(userId: string, direction?: 'lend' | 'borrow'): Promise<LedgerEntry[]> {
  const d = await financeDb();
  return syncLedgerStatuses(await (direction
    ? d.getAllAsync<LedgerEntry>(`SELECT * FROM ledger_entries WHERE user_id = ? AND direction = ? ORDER BY created_at DESC`, [userId, direction])
    : d.getAllAsync<LedgerEntry>(`SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC`, [userId])));
}

export async function getLedger(id: string): Promise<LedgerEntry | null> {
  const d = await financeDb();
  const e = await d.getFirstAsync<LedgerEntry>(`SELECT * FROM ledger_entries WHERE id = ?`, [id]);
  return e ? (await syncLedgerStatuses([e]))[0] : null;
}

export async function deleteLedger(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM ledger_entries WHERE id = ?`, [id]);
  await d.runAsync(`DELETE FROM ledger_updates WHERE ledger_id = ?`, [id]);
  // Same rule as deleteGroup: no FKs, no cascades, so the history has to be
  // named explicitly or it outlives the ledger it describes, unreachable.
  await d.runAsync(`DELETE FROM finance_timeline WHERE ref_type = 'ledger' AND ref_id = ?`, [id]);
}

/** Re-insert a full row verbatim — used to restore an undo-deleted ledger. */
export async function restoreLedger(e: LedgerEntry): Promise<void> {
  const d = await financeDb();
  await d.runAsync(
    `INSERT OR REPLACE INTO ledger_entries
       (id,user_id,direction,name,mobile,interest_type,principal,rate,rate_mode,period,start_date,end_date,remaining,status,notes,created_at,last_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id, e.user_id, e.direction, e.name, e.mobile, e.interest_type, e.principal, e.rate, e.rate_mode,
     e.period, e.start_date, e.end_date, e.remaining, e.status, e.notes, e.created_at, e.last_updated],
  );
}

/** Everything deleteLedger removes: the row, its repayments and its history. */
export interface LedgerSnapshot { entry: LedgerEntry; updates: LedgerUpdate[]; timeline: TimelineRow[] }

/** Read a ledger's full record before deleting it, so the delete can be undone. */
export async function snapshotLedger(id: string): Promise<LedgerSnapshot | null> {
  const d = await financeDb();
  const entry = await d.getFirstAsync<LedgerEntry>(`SELECT * FROM ledger_entries WHERE id = ?`, [id]);
  if (!entry) return null;
  const updates = await d.getAllAsync<LedgerUpdate>(`SELECT * FROM ledger_updates WHERE ledger_id = ?`, [id]);
  const timeline = await d.getAllAsync<TimelineRow>(`SELECT * FROM finance_timeline WHERE ref_type = 'ledger' AND ref_id = ?`, [id]);
  return { entry, updates, timeline };
}

/** Put a snapshotted ledger back exactly, all-or-nothing (row ids are kept). */
export async function restoreLedgerSnapshot(snap: LedgerSnapshot): Promise<void> {
  const d = await financeDb();
  await d.withTransactionAsync(async () => {
    await restoreLedger(snap.entry);
    for (const u of snap.updates) {
      await d.runAsync(`INSERT OR REPLACE INTO ledger_updates (id,ledger_id,received,remaining,note,updated_at) VALUES (?,?,?,?,?,?)`,
        [u.id, u.ledger_id, u.received, u.remaining, u.note, u.updated_at]);
    }
    for (const t of snap.timeline) {
      await d.runAsync(`INSERT OR REPLACE INTO finance_timeline (id,ref_type,ref_id,kind,detail,at) VALUES (?,?,?,?,?,?)`,
        [t.id, t.ref_type, t.ref_id, t.kind, t.detail, t.at]);
    }
  });
}

/** Record a manual amount update: log it, set remaining + status, timeline it. */
export async function addLedgerUpdate(ledgerId: string, rawReceived: number, rawRemaining: number, note: string | null): Promise<void> {
  const d = await financeDb();
  const t = now();
  // Repayments are where drift would compound fastest — every update rewrites
  // `remaining`, so an unrounded value would carry forward into the next one.
  const received = fromPaise(toPaise(rawReceived));
  const remaining = fromPaise(toPaise(rawRemaining));
  // A part-payment on an overdue loan leaves it overdue; 'running' here used
  // to flip it back until the next read re-marked it (and re-timelined it).
  const cur = await d.getFirstAsync<{ end_date: number | null }>(`SELECT end_date FROM ledger_entries WHERE id = ?`, [ledgerId]);
  const status: LedgerStatus = ledgerStatusFor({ status: 'running', remaining, end_date: cur?.end_date ?? null }, t);
  await d.runAsync(
    `INSERT INTO ledger_updates (id,ledger_id,received,remaining,note,updated_at) VALUES (?,?,?,?,?,?)`,
    [uuid(), ledgerId, received, remaining, note, t],
  );
  await d.runAsync(`UPDATE ledger_entries SET remaining = ?, status = ?, last_updated = ? WHERE id = ?`,
    [remaining, status, t, ledgerId]);
  await addTimeline('ledger', ledgerId, 'update',
    `Received ₹${received.toLocaleString('en-IN')} · remaining ₹${remaining.toLocaleString('en-IN')}${note ? ` — ${note}` : ''}`);
}

export async function listLedgerUpdates(ledgerId: string): Promise<LedgerUpdate[]> {
  const d = await financeDb();
  return d.getAllAsync<LedgerUpdate>(`SELECT * FROM ledger_updates WHERE ledger_id = ? ORDER BY updated_at DESC`, [ledgerId]);
}

type EditableFields = Pick<LedgerEntry,
  'name' | 'mobile' | 'interest_type' | 'principal' | 'rate' | 'rate_mode' | 'period' | 'start_date' | 'end_date' | 'notes'>;

/** Edit a ledger's terms (not the balance). If principal grows and nothing has
 *  been repaid yet, remaining tracks the new principal. Appends a timeline note. */
export async function updateLedgerDetails(id: string, f: EditableFields): Promise<void> {
  const d = await financeDb();
  const cur = await d.getFirstAsync<LedgerEntry>(`SELECT * FROM ledger_entries WHERE id = ?`, [id]);
  if (!cur) return;
  const principal = fromPaise(toPaise(f.principal));
  const remaining = fromPaise(toPaise(cur.remaining === cur.principal ? principal : cur.remaining));
  await d.runAsync(
    `UPDATE ledger_entries SET name=?, mobile=?, interest_type=?, principal=?, rate=?, rate_mode=?, period=?, start_date=?, end_date=?, notes=?, remaining=?, last_updated=? WHERE id=?`,
    [f.name, f.mobile, f.interest_type, principal, f.rate, f.rate_mode, f.period, f.start_date, f.end_date, f.notes, remaining, now(), id],
  );
  await addTimeline('ledger', id, 'edit', `Terms edited · ${f.name} · ₹${f.principal.toLocaleString('en-IN')} @ ${f.rate}${f.rate_mode === 'rupees' ? '₹' : '%'} ${f.period}`);
}

export async function setLedgerStatus(id: string, status: LedgerStatus): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE ledger_entries SET status = ?, last_updated = ? WHERE id = ?`, [status, now(), id]);
}

export default { insertLedger, insertLedgers, listLedger, getLedger, deleteLedger, restoreLedger, snapshotLedger, restoreLedgerSnapshot, addLedgerUpdate, listLedgerUpdates, updateLedgerDetails, setLedgerStatus };
