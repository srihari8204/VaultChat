// db/financeTimeline.ts — append-only event log for ledgers & chitti groups.
// Every meaningful edit appends a row; the detail screen renders them as a timeline.

import { financeDb, uuid, now } from './financeDb';

// 'status' = an automatic status change (overdue, closed) the app made on load.
export type TimelineKind = 'created' | 'update' | 'reminder' | 'edit' | 'note' | 'status';
export interface TimelineRow {
  id: string;
  ref_type: 'ledger' | 'chitti';
  ref_id: string;
  kind: TimelineKind;
  detail: string;
  at: number;
}

export async function addTimeline(ref_type: TimelineRow['ref_type'], ref_id: string, kind: TimelineKind, detail: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(
    `INSERT INTO finance_timeline (id, ref_type, ref_id, kind, detail, at) VALUES (?,?,?,?,?,?)`,
    [uuid(), ref_type, ref_id, kind, detail, now()],
  );
}

export async function listTimeline(ref_type: TimelineRow['ref_type'], ref_id: string): Promise<TimelineRow[]> {
  const d = await financeDb();
  return d.getAllAsync<TimelineRow>(
    `SELECT * FROM finance_timeline WHERE ref_type = ? AND ref_id = ? ORDER BY at DESC`, [ref_type, ref_id],
  );
}

export default { addTimeline, listTimeline };
