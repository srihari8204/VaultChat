// db/reminders.ts — local reminder store for Vault Finance.
// CRUD only; the reminders screen handles expo-notifications scheduling and
// passes the resulting notif_id in here so it can be cancelled on delete/done.

import { financeDb, uuid, now } from './financeDb';

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
  status: ReminderStatus;
  notif_id: string | null;
  created_at: number;
}

export async function insertReminder(row: Omit<Reminder, 'id' | 'created_at' | 'status'> & { status?: ReminderStatus }): Promise<Reminder> {
  const d = await financeDb();
  const full: Reminder = { ...row, id: uuid(), status: row.status ?? 'active', created_at: now() };
  await d.runAsync(
    `INSERT INTO reminders (id,user_id,ref_type,ref_id,title,freq,next_at,status,notif_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.user_id, full.ref_type, full.ref_id, full.title, full.freq, full.next_at, full.status, full.notif_id, full.created_at],
  );
  return full;
}

export async function listReminders(userId: string): Promise<Reminder[]> {
  const d = await financeDb();
  return d.getAllAsync<Reminder>(`SELECT * FROM reminders WHERE user_id = ? ORDER BY next_at ASC`, [userId]);
}

export async function setReminderStatus(id: string, status: ReminderStatus): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE reminders SET status = ? WHERE id = ?`, [status, id]);
}

export async function snoozeReminder(id: string, nextAt: number, notifId: string | null): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE reminders SET next_at = ?, status = 'active', notif_id = ? WHERE id = ?`, [nextAt, notifId, id]);
}

export async function deleteReminder(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM reminders WHERE id = ?`, [id]);
}

export default { insertReminder, listReminders, setReminderStatus, snoozeReminder, deleteReminder };
