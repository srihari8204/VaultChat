// lib/groups/eventReminderPrivacy.selftest.ts — run: npx tsx lib/groups/eventReminderPrivacy.selftest.ts
//
// eventReminderTitle — what a shared-calendar reminder may show on this phone's
// lock screen: the title only for the user's own event while the tray-privacy
// preference allows names; generic text otherwise.
import assert from 'node:assert/strict';
import { eventReminderTitle, GENERIC_EVENT_REMINDER } from './calendar';
import { planReminders } from './reminders';
import type { Task } from './tasks';

const mine = { title: 'Dentist', createdBy: 'me' };
const theirs = { title: 'Surprise party for Sam', createdBy: 'sam' };

assert.equal(eventReminderTitle(mine, 'me', 'name'), 'Dentist', 'own event, names allowed → title');
assert.equal(eventReminderTitle(theirs, 'me', 'name'), GENERIC_EVENT_REMINDER, "another member's event → generic");
assert.equal(eventReminderTitle(mine, 'me', 'generic'), GENERIC_EVENT_REMINDER, 'generic preference hides own titles');
assert.equal(eventReminderTitle(mine, 'me', 'hidden'), GENERIC_EVENT_REMINDER, 'hidden preference hides own titles');

// Switching the preference must rewrite an already-booked reminder: the shown
// text is the item title, and the reconciler re-books on a title change.
const t0 = 1_700_000_000_000;
const item = (title: string): Task => ({
  id: 'e@1', title, assignee: 'me', dueAt: t0 + 3_600_000, done: false,
  updatedAt: 0, createdAt: 0, createdBy: 'me', doneBy: null,
});
const booked = [{ taskId: 'e@1', fireAt: t0 + 3_600_000, forUser: 'me', title: 'Dentist', notifId: 'n1' }];
const plan = planReminders([item(eventReminderTitle(mine, 'me', 'generic'))], booked, 'me', t0);
assert.deepEqual(plan.cancel, ['n1'], 'the titled reminder is cancelled');
assert.equal(plan.schedule[0]?.title, GENERIC_EVENT_REMINDER, 'and re-booked with generic text');

console.log('eventReminderPrivacy selftest OK');
