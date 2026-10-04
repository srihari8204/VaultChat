// components/finance/retrigger.selftest.ts — run: npx tsx components/finance/retrigger.selftest.ts
//
// R3 (round 7): the one-time rebuild re-read the row and then wrote, so a Done,
// Delete or Snooze landing between the two left a live recurring alert on a
// done or deleted row. The write is now conditional (swap), a lost swap
// cancels the new alert, the rebuild shares the screen's per-reminder lock,
// and the "done" flag is per user.

import assert from 'node:assert/strict';
import type { Reminder } from '../../db/reminders';
import { retriggerFromAnchors, reminderBusy, retriggerDoneKey, type RetriggerDeps } from './retrigger';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };

const row = (p: Partial<Reminder>): Reminder => ({
  id: 'r1', user_id: 'u', ref_type: null, ref_id: null, title: 'Rent', freq: 'monthly',
  next_at: 2_000, anchor_at: 1_000, status: 'active', notif_id: 'OLD', created_at: 0, ...p,
});

function fake(over: Partial<RetriggerDeps> = {}) {
  const log: string[] = [];
  let k = 0;
  const deps: RetriggerDeps = {
    allowed: async () => true,
    schedule: async (_t, _f, anchor) => { log.push(`schedule@${anchor}`); return `NEW${++k}`; },
    swap: async (id, expected, next) => { log.push(`swap ${id} ${expected}->${next}`); return true; },
    cancel: async (ids) => { log.push(`cancel ${ids}`); },
    ...over,
  };
  return { deps, log };
}

(async () => {
  {
    const { deps, log } = fake();
    const all = await retriggerFromAnchors([row({ notif_id: 'OLD,SNZ' })], deps);
    ok('a rebuilt row resolves true', all);
    ok('… schedules from the anchor, not next_at', log[0] === 'schedule@1000');
    ok('… stores the new recurrence, keeping the snooze, conditionally on the ids it read', log[1] === 'swap r1 OLD,SNZ->NEW1,SNZ');
    ok('… then cancels only the old recurrence', log[2] === 'cancel OLD' && log.length === 3);
  }
  {
    const { deps, log } = fake({ swap: async () => false });
    const all = await retriggerFromAnchors([row({})], deps);
    ok('a row changed meanwhile (lost swap) is not rebuilt', !all);
    ok('… its new alert is cancelled, the old one is left to the action that changed it',
      log.includes('cancel NEW1') && !log.includes('cancel OLD'));
  }
  {
    const { deps, log } = fake({ swap: async () => { throw new Error('db'); } });
    ok('a failed store also cancels the new alert', !(await retriggerFromAnchors([row({})], deps)) && log.includes('cancel NEW1') && !log.includes('cancel OLD'));
  }
  {
    const { deps, log } = fake({ schedule: async () => null });
    ok('a refused schedule keeps the old alert', !(await retriggerFromAnchors([row({})], deps)) && !log.some((l) => l.startsWith('cancel') || l.startsWith('swap')));
  }
  {
    const { deps, log } = fake({ allowed: async () => false });
    ok('without permission nothing is touched (no prompt)', !(await retriggerFromAnchors([row({})], deps)) && log.length === 0);
  }
  {
    const { deps, log } = fake();
    const all = await retriggerFromAnchors([
      row({ id: 'a', status: 'done' }), row({ id: 'b', freq: 'once' }), row({ id: 'c', notif_id: null }), row({ id: 'd', notif_id: ',SNZ' }),
    ], deps);
    ok('done, one-off and unscheduled rows are skipped and do not block the flag', all && log.length === 0);
  }
  {
    const { deps, log } = fake();
    reminderBusy.add('r1');
    const all = await retriggerFromAnchors([row({})], deps);
    reminderBusy.delete('r1');
    ok('a row an action holds is skipped and retried later', !all && log.length === 0);
  }
  {
    let heldDuring = false;
    const { deps } = fake({ schedule: async () => { heldDuring = reminderBusy.has('r1'); return 'NEW'; } });
    await retriggerFromAnchors([row({})], deps);
    ok('the rebuild holds the row lock while it works …', heldDuring);
    ok('… and releases it after', !reminderBusy.has('r1'));
    const { deps: d2 } = fake({ schedule: async () => { throw new Error('boom'); } });
    await retriggerFromAnchors([row({})], d2).catch(() => {});
    ok('… even when scheduling throws', !reminderBusy.has('r1'));
  }
  ok('the done flag is keyed per user', retriggerDoneKey('u1') !== retriggerDoneKey('u2') && retriggerDoneKey('u1').endsWith(':u1'));
  console.log(`retrigger: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
