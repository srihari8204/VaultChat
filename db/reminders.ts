// db/reminders.ts — local reminder store for Vault Finance.
// CRUD only; the reminders screen handles expo-notifications scheduling and
// passes the resulting notif_id in here so it can be cancelled on delete/done.

import { financeDb, uuid, now } from './financeDb';
import { addTimeline } from './financeTimeline';
import { advanceAnchored } from '../lib/finance/reminderSchedule';
import { fmtDateTime } from '../utils/financeFormat';

export type ReminderFreq = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type ReminderStatus = 'active' | 'done';

export interface Reminder {
  id: string;
  user_id: string;
  ref_type: 'ledger' | 'chitti' | null;
  ref_id: string | null;
  title: string;
  freq: ReminderFreq;
  next_at: number;
  /** First occurrence; recurrences count from it (null on pre-anchor rows). */
  anchor_at: number | null;
  status: ReminderStatus;
  notif_id: string | null;
  created_at: number;
}

export async function insertReminder(
  row: Omit<Reminder, 'id' | 'created_at' | 'status' | 'anchor_at'> & { status?: ReminderStatus; anchor_at?: number | null },
): Promise<Reminder> {
  const d = await financeDb();
  const full: Reminder = { ...row, anchor_at: row.anchor_at ?? row.next_at, id: uuid(), status: row.status ?? 'active', created_at: now() };
  await d.runAsync(
    `INSERT INTO reminders (id,user_id,ref_type,ref_id,title,freq,next_at,anchor_at,status,notif_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.user_id, full.ref_type, full.ref_id, full.title, full.freq, full.next_at, full.anchor_at, full.status, full.notif_id, full.created_at],
  );
  // A reminder set from a ledger or group belongs in that record's history.
  if (full.ref_type && full.ref_id) {
    await addTimeline(full.ref_type, full.ref_id, 'reminder',
      `Reminder set · ${full.title} · ${full.freq === 'once' ? '' : `${full.freq} from `}${fmtDateTime(full.next_at)}`);
  }
  return full;
}

/**
 * Lists reminders with every recurring one moved to its next occurrence,
 * counted from its anchor (lib/finance/reminderSchedule). The OS keeps firing a recurring
 * notification on its own; without this `next_at` stayed on the first date
 * forever, so Calendar and the dashboard's "due today" never saw it again.
 */
export async function listReminders(userId: string): Promise<Reminder[]> {
  const d = await financeDb();
  const rows = await d.getAllAsync<Reminder>(`SELECT * FROM reminders WHERE user_id = ? ORDER BY next_at ASC`, [userId]);
  const moves = advanceAnchored(rows, now());
  if (moves.length === 0) return rows;
  for (const m of moves) await d.runAsync(`UPDATE reminders SET next_at = ? WHERE id = ?`, [m.next_at, m.id]);
  const byId = new Map(moves.map(m => [m.id, m.next_at]));
  return rows.map(r => (byId.has(r.id) ? { ...r, next_at: byId.get(r.id)! } : r)).sort((a, b) => a.next_at - b.next_at);
}

export async function setReminderStatus(id: string, status: ReminderStatus): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE reminders SET status = ? WHERE id = ?`, [status, id]);
}

/** Moves only next_at: anchor_at stays, so the series resumes on its own day. */
export async function snoozeReminder(id: string, nextAt: number, notifId: string | null): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE reminders SET next_at = ?, status = 'active', notif_id = ? WHERE id = ?`, [nextAt, notifId, id]);
}

export async function deleteReminder(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM reminders WHERE id = ?`, [id]);
}

export default { insertReminder, listReminders, setReminderStatus, snoozeReminder, deleteReminder };
