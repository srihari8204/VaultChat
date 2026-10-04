// npx tsx components/finance/notifyIds.selftest.ts
import assert from 'node:assert/strict';
import { snoozedNotifIds, splitNotifIds } from './notifyIds';

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

console.log('notifyIds selftest: all passed');
