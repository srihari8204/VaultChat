// components/finance/notifyTrigger.selftest.ts — run: npx tsx components/finance/notifyTrigger.selftest.ts
//
// The trigger notify.ts hands to expo-notifications, checked against the
// library's own validity test: a one-off { date } without its `type` was
// rejected, so "Once" reminders and every Snooze never alerted.
import assert from 'node:assert/strict';

// expo-notifications pulls in native modules; only its enum is needed here.
const TYPES = { CALENDAR: 'calendar', DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly', DATE: 'date', TIME_INTERVAL: 'timeInterval' };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'expo-notifications') return { SchedulableTriggerInputTypes: TYPES };
  return origLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { triggerFor } = require('./notify') as typeof import('./notify');
// The library's own check (pure JS), as scheduleNotificationAsync runs it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hasValidTriggerObject } = require('expo-notifications/build/hasValidTriggerObject') as { hasValidTriggerObject: (t: unknown) => boolean };

const at = (y: number, m: number, d: number, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const now = at(2026, 10, 4, 8);
let n = 0;

for (const freq of ['once', 'daily', 'weekly', 'monthly', 'yearly'] as const) {
  const t = triggerFor(freq, at(2026, 11, 5), now) as unknown as Record<string, unknown>;
  assert.ok(hasValidTriggerObject(t), `${freq}: the library accepts it`);
  assert.equal(t.type, freq === 'once' ? 'date' : freq, `${freq}: carries its type`);
  n += 2;
}

// Field values reach the library unchanged.
const once = triggerFor('once', at(2026, 11, 5, 9, 30), now) as unknown as { type: string; date: Date };
assert.ok(once.date instanceof Date && once.date.getTime() === at(2026, 11, 5, 9, 30), 'once: fires at its time');
assert.deepEqual(triggerFor('monthly', at(2026, 9, 5), now), { type: 'monthly', day: 5, hour: 9, minute: 0 });
assert.deepEqual(triggerFor('yearly', at(2025, 3, 15), now), { type: 'yearly', month: 2, day: 15, hour: 9, minute: 0 });
assert.deepEqual(triggerFor('weekly', at(2026, 10, 4), now), { type: 'weekly', weekday: new Date(at(2026, 10, 4)).getDay() + 1, hour: 9, minute: 0 });
assert.deepEqual(triggerFor('daily', at(2026, 10, 4, 7, 15), now), { type: 'daily', hour: 7, minute: 15 });
n += 5;

console.log(`notifyTrigger: ${n} assertions passed`);
