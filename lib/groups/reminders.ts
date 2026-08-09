// lib/groups/reminders.ts — due-date reminders for shared group tasks
// (Groups & Circles, G4.2).
//
// WHY THIS IS A RECONCILER AND NOT A "SCHEDULE ON SAVE"
//
// Tasks are an event-log fold (see tasks.ts). The list is not something this
// device owns — it changes when somebody else's phone comes out of a tunnel and
// delivers an edit from an hour ago. So "schedule a notification when the user
// taps Save" is wrong in every direction:
//
//   * a task reassigned away from you would keep reminding you
//   * a due date moved on another device would fire at the OLD time
//   * a completed or deleted task would still go off
//   * re-opening the screen would stack a second notification on the first
//
// Instead: compute the reminders that SHOULD exist for the current list, diff
// against the ones that do, and emit the difference. Idempotent by
// construction — running it twice over an unchanged list is a no-op, which is
// the property that makes it safe to run on every screen focus.
//
// WHO GETS REMINDED. Exactly one person per task, decided from the task itself:
// its assignee, or its creator when it is unassigned. Reminding everybody would
// make a shared list a source of group-wide noise, and reminding nobody for an
// unassigned task is how "anyone can do it" becomes "nobody did it".
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/reminders.ts

import type { Task } from './tasks';

/** A reminder this device currently has booked with the OS. */
export interface ScheduledReminder {
  taskId: string;
  /** The OS handle, needed to cancel it. */
  notifId: string;
  /** What it was booked FOR — the field that tells us it is now stale. */
  fireAt: number;
  /** Who it was booked for, so a reassignment is detected as a change. */
  forUser: string;
  /** The title at booking time, so an edited title is re-issued. */
  title: string;
}

/** A reminder that should exist but does not yet. */
export interface PlannedReminder {
  taskId: string;
  fireAt: number;
  forUser: string;
  title: string;
}

export interface ReminderPlan {
  /** OS handles to cancel. */
  cancel: string[];
  /** Reminders to book. */
  schedule: PlannedReminder[];
}

/**
 * Who should be nudged about a task, or null when nobody should be.
 *
 * A completed task reminds nobody — that is the point of completing it.
 */
export function reminderTarget(t: Task): string | null {
  if (t.done) return null;
  if (t.dueAt == null) return null;
  return t.assignee ?? t.createdBy ?? null;
}

/**
 * The reminders that ought to exist for `me`, given this task list.
 *
 * Only reminders for THIS user are planned. Each device schedules its own
 * notifications from the shared list, so a device must not book anything on
 * another person's behalf — it has no way to deliver it, and would only be
 * reminding itself about somebody else's job.
 *
 * A due date already in the past is skipped. The OS cannot schedule backwards,
 * and firing "this was due" the instant a phone syncs a week-old list would be
 * a burst of noise about things the user can already see are overdue — the list
 * marks them, which is the honest place for it.
 */
export function desiredReminders(tasks: Task[], me: string, now: number): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  for (const t of tasks) {
    if (reminderTarget(t) !== me) continue;
    if (t.dueAt == null || t.dueAt <= now) continue;
    out.push({ taskId: t.id, fireAt: t.dueAt, forUser: me, title: t.title });
  }
  // Sorted so the plan is deterministic and two runs over the same list produce
  // byte-identical output — which is what makes the self-check meaningful.
  return out.sort((a, b) => a.fireAt - b.fireAt || (a.taskId < b.taskId ? -1 : 1));
}

/**
 * Diff what should exist against what does.
 *
 * A booked reminder is kept only when it matches on EVERY field that a user
 * would notice: time, recipient and title. Matching on time alone would leave a
 * reminder announcing the old title after an edit; matching on task id alone
 * would leave one booked for a task that has been reassigned.
 */
export function planReminders(
  tasks: Task[],
  scheduled: ScheduledReminder[],
  me: string,
  now: number,
): ReminderPlan {
  const want = desiredReminders(tasks, me, now);
  const wantById = new Map(want.map((r) => [r.taskId, r]));

  const cancel: string[] = [];
  const keep = new Set<string>();

  for (const s of scheduled) {
    const w = wantById.get(s.taskId);
    const unchanged = !!w && w.fireAt === s.fireAt && w.forUser === s.forUser && w.title === s.title;
    if (unchanged) {
      keep.add(s.taskId);
    } else {
      // Covers every removal reason at once: completed, deleted, reassigned,
      // rescheduled, retitled, or now in the past.
      cancel.push(s.notifId);
    }
  }

  return { cancel, schedule: want.filter((w) => !keep.has(w.taskId)) };
}

/** Notification text. Kept here so the self-check can assert what it says. */
export function reminderText(r: PlannedReminder): { title: string; body: string } {
  return {
    title: 'Task due',
    // The task title is the user's own words about their own list, and the
    // notification is delivered to the one person responsible for it. The GROUP
    // is deliberately not named: a lock screen is readable by whoever is
    // holding the phone.
    body: r.title.length > 120 ? r.title.slice(0, 119) + '…' : r.title,
  };
}

// ── self-check ──
if (require.main === module) {
  const t0 = 1_700_000_000_000;
  const task = (over: Partial<Task> & { id: string }): Task => ({
    title: 'T', assignee: null, dueAt: null, done: false,
    updatedAt: t0, createdAt: t0, createdBy: 'me', doneBy: null,
    ...over,
  });
  const ids = (rs: { taskId: string }[]) => rs.map((r) => r.taskId).sort().join(',');

  // 1. who is reminded
  if (reminderTarget(task({ id: 'a', dueAt: t0 + 100, assignee: 'u2' })) !== 'u2') {
    throw new Error('an assigned task reminds its assignee');
  }
  if (reminderTarget(task({ id: 'a', dueAt: t0 + 100, createdBy: 'u9' })) !== 'u9') {
    throw new Error('an unassigned task reminds its creator');
  }
  if (reminderTarget(task({ id: 'a', dueAt: t0 + 100, done: true })) !== null) {
    throw new Error('a completed task reminds nobody');
  }
  if (reminderTarget(task({ id: 'a' })) !== null) {
    throw new Error('an undated task reminds nobody');
  }

  // 2. only MY reminders are planned — a device must not book somebody else's
  const mixed = [
    task({ id: 'mine', dueAt: t0 + 100, assignee: 'me' }),
    task({ id: 'theirs', dueAt: t0 + 100, assignee: 'u2' }),
  ];
  if (ids(desiredReminders(mixed, 'me', t0)) !== 'mine') throw new Error('planned somebody else\'s reminder');

  // 3. a past due date is not scheduled
  if (desiredReminders([task({ id: 'a', dueAt: t0 - 1, assignee: 'me' })], 'me', t0).length !== 0) {
    throw new Error('must not schedule into the past');
  }

  // 4. IDEMPOTENCE — the property that makes it safe on every focus
  const list = [task({ id: 'a', dueAt: t0 + 100, assignee: 'me', title: 'Milk' })];
  const first = planReminders(list, [], 'me', t0);
  if (first.schedule.length !== 1 || first.cancel.length !== 0) throw new Error('first run should book one');
  const booked: ScheduledReminder[] = first.schedule.map((r, i) => ({ ...r, notifId: `n${i}` }));
  const second = planReminders(list, booked, 'me', t0);
  if (second.schedule.length !== 0 || second.cancel.length !== 0) {
    throw new Error('re-running over an unchanged list must be a no-op');
  }

  // 5. every way a reminder goes stale must cancel it
  const stale: [string, Task[]][] = [
    ['completed', [task({ id: 'a', dueAt: t0 + 100, assignee: 'me', title: 'Milk', done: true })]],
    ['deleted', []],
    ['reassigned', [task({ id: 'a', dueAt: t0 + 100, assignee: 'u2', title: 'Milk' })]],
    ['rescheduled', [task({ id: 'a', dueAt: t0 + 999, assignee: 'me', title: 'Milk' })]],
    ['retitled', [task({ id: 'a', dueAt: t0 + 100, assignee: 'me', title: 'Oat milk' })]],
    ['date cleared', [task({ id: 'a', assignee: 'me', title: 'Milk' })]],
  ];
  for (const [why, next] of stale) {
    const p = planReminders(next, booked, 'me', t0);
    if (!p.cancel.includes('n0')) throw new Error(`${why}: the old reminder must be cancelled`);
  }
  // …and the three that are still wanted are re-booked, not merely dropped
  for (const why of ['rescheduled', 'retitled']) {
    const next = stale.find(([w]) => w === why)![1];
    if (planReminders(next, booked, 'me', t0).schedule.length !== 1) {
      throw new Error(`${why}: a replacement must be booked`);
    }
  }
  for (const why of ['completed', 'deleted', 'reassigned', 'date cleared']) {
    const next = stale.find(([w]) => w === why)![1];
    if (planReminders(next, booked, 'me', t0).schedule.length !== 0) {
      throw new Error(`${why}: nothing should be re-booked`);
    }
  }

  // 6. a reminder whose time has passed since booking is cancelled, not kept
  if (!planReminders(list, booked, 'me', t0 + 500).cancel.includes('n0')) {
    throw new Error('a reminder now in the past must be cancelled');
  }

  // 7. the plan is deterministic regardless of task order
  const many = [
    task({ id: 'c', dueAt: t0 + 300, assignee: 'me' }),
    task({ id: 'a', dueAt: t0 + 100, assignee: 'me' }),
    task({ id: 'b', dueAt: t0 + 200, assignee: 'me' }),
  ];
  const A = JSON.stringify(desiredReminders(many, 'me', t0));
  const B = JSON.stringify(desiredReminders([...many].reverse(), 'me', t0));
  if (A !== B) throw new Error('plan must not depend on task order');

  // 8. the notification names the task, never the group
  const txt = reminderText({ taskId: 'a', fireAt: t0, forUser: 'me', title: 'Buy milk' });
  if (txt.body !== 'Buy milk') throw new Error('body should be the task title');
  if (/group|circle|family/i.test(txt.title + txt.body)) throw new Error('must not name the group');
  const long = reminderText({ taskId: 'a', fireAt: t0, forUser: 'me', title: 'x'.repeat(400) });
  if (long.body.length > 120) throw new Error('body should be bounded');

  console.log('groups/reminders self-check OK');
}
