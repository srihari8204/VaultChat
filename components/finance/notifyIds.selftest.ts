// npx tsx components/finance/notifyIds.selftest.ts
import assert from 'node:assert/strict';
import { isUnscheduled, snoozedNotifIds, splitNotifIds, withRecurrence } from './notifyIds';

// recurring: the recurrence survives a snooze
assert.deepEqual(snoozedNotifIds('monthly', 'R1', 'S1'), { keep: 'R1,S1', cancel: null });
// a second snooze replaces only the earlier snooze
assert.deepEqual(snoozedNotifIds('monthly', 'R1,S1', 'S2'), { keep: 'R1,S2', cancel: 'S1' });
// a recurring reminder that was never scheduled keeps its empty slot
assert.deepEqual(snoozedNotifIds('weekly', null, 'S1'), { keep: ',S1', cancel: null });
assert.deepEqual(snoozedNotifIds('weekly', ',S1', 'S2'), { keep: ',S2', cancel: 'S1' });
// snooze could not be scheduled: the recurrence is kept, nothing invented
assert.deepEqual(snoozedNotifIds('daily', 'R1,S1', null), { keep: 'R1', cancel: 'S1' });
// once: the snooze replaces the original
assert.deepEqual(snoozedNotifIds('once', 'O1', 'S1'), { keep: 'S1', cancel: 'O1' });
assert.deepEqual(snoozedNotifIds('once', null, null), { keep: null, cancel: null });
// cancel sees every id, never an empty one
assert.deepEqual(splitNotifIds('R1,S1'), ['R1', 'S1']);
assert.deepEqual(splitNotifIds(',S1'), ['S1']);
assert.deepEqual(splitNotifIds(null), []);
// the "Not scheduled" warning survives a snooze of a recurrence that never scheduled
assert.equal(isUnscheduled('weekly', null), true);
assert.equal(isUnscheduled('weekly', snoozedNotifIds('weekly', null, 'S1').keep), true);
assert.equal(isUnscheduled('weekly', ',S1'), true);
assert.equal(isUnscheduled('monthly', 'R1'), false);
assert.equal(isUnscheduled('monthly', 'R1,S1'), false);
// a one-off is scheduled when its (snooze) id exists
assert.equal(isUnscheduled('once', null), true);
assert.equal(isUnscheduled('once', 'S1'), false);

// re-scheduling a recurrence keeps its pending snooze
assert.equal(withRecurrence('R1,S1', 'R2'), 'R2,S1');
assert.equal(withRecurrence('R1', 'R2'), 'R2');
assert.equal(withRecurrence(',S1', 'R2'), 'R2,S1');
assert.equal(withRecurrence(null, 'R2'), 'R2');

console.log('notifyIds selftest: all passed');
