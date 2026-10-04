// components/finance/retrigger.ts — the one-time rebuild of recurring reminder
// alerts from their anchor, and the per-reminder lock it shares with the
// Reminders screen's Done / Snooze / Delete. Pure (the phone and database calls
// are passed in), so it is Node-tested: retrigger.selftest.ts.
//
// Recurring alerts scheduled before the trigger was built from the anchor (it
// used max(now, picked time), so the phone alerted on a different day or time
// than the app shows) are re-scheduled once from their anchor.

import type { Reminder } from '../../db/reminders';
import { withRecurrence } from './notifyIds';
import { anchorOf } from '../../lib/finance/reminderSchedule';

/**
 * Reminders with an action or a rebuild in flight. One JS thread runs both, so
 * this Set is the lock: the rebuild skips a row an action holds (and retries it
 * on a later visit), and an action is ignored while the rebuild holds its row.
 */
export const reminderBusy = new Set<string>();

export interface RetriggerDeps {
  /** May the app post notifications now? (never prompts) */
  allowed(): Promise<boolean>;
  /** Schedule the recurring alert for `freq` from `anchor`; its id, or null. */
  schedule(title: string, freq: Reminder['freq'], anchor: number): Promise<string | null>;
  /** Store `next` only if the row is still active and still holds `expected`. */
  swap(id: string, expected: string | null, next: string): Promise<boolean>;
  cancel(ids: string | null): Promise<void>;
}

/**
 * Rebuild every active recurring row's alert. The new alert is stored before
 * the old one is cancelled, so a failure keeps the old alert rather than none.
 * The store is conditional (deps.swap), so a Done, Snooze or Delete that lands
 * while the new alert is being scheduled wins, and the new alert is cancelled
 * rather than left live on a done or deleted row. Resolves true when every row
 * was rebuilt; a skipped or changed row is retried on a later visit.
 */
export async function retriggerFromAnchors(rows: Reminder[], deps: RetriggerDeps): Promise<boolean> {
  if (!(await deps.allowed())) return false;
  let all = true;
  for (const r of rows) {
    const old = (r.notif_id ?? '').split(',')[0];
    if (r.status !== 'active' || r.freq === 'once' || !old) continue;
    if (reminderBusy.has(r.id)) { all = false; continue; }
    reminderBusy.add(r.id);
    try {
      const fresh = await deps.schedule(r.title, r.freq, anchorOf(r));
      if (!fresh) { all = false; continue; }
      let stored = false;
      try { stored = await deps.swap(r.id, r.notif_id, withRecurrence(r.notif_id, fresh)); } catch { stored = false; }
      if (!stored) { await deps.cancel(fresh); all = false; continue; }
      await deps.cancel(old);
    } finally {
      reminderBusy.delete(r.id);
    }
  }
  return all;
}

/** The "rebuild done" flag is per user: another account on this phone has its own rows. */
export const retriggerDoneKey = (userId: string) => `vc_fin_retrigger_anchor_v1:${userId}`;
