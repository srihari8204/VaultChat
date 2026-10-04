// Run: npx tsx lib/spaces/attendanceDays.selftest.ts
// The attendance week is built from CALENDAR days, so a daylight-saving change
// cannot put a day near midnight in the wrong column.
import assert from 'node:assert/strict';
import { calendarDaysAgo, crossingsForDay } from './attendance';

// A zone with daylight saving, set before any Date is made (Node re-reads TZ
// when it changes, so this works after the imports too).
process.env.TZ = 'Europe/London';

// 00:30 on Mon 30 Mar 2026, the day after the clocks went forward (29 Mar, a
// 23-hour day). now - 1×24h is 23:30 on the 28th: a whole day too far back.
const now = new Date(2026, 2, 30, 0, 30).getTime();
assert.equal(new Date(now - 24 * 3600_000).getDate(), 28, 'the old arithmetic really is wrong here');
assert.equal(new Date(calendarDaysAgo(now, 1)).getDate(), 29, 'one calendar day back is the 29th');
assert.equal(new Date(calendarDaysAgo(now, 2)).getDate(), 28);
assert.equal(new Date(calendarDaysAgo(now, 0)).getTime(), now, 'zero days back is now');
assert.equal(new Date(calendarDaysAgo(now, 30)).getMonth(), 1, 'crosses a month boundary');
// And the 25-hour day in October: 23:30 on Sun 25 Oct, one day back is the 24th.
const autumn = new Date(2026, 9, 25, 23, 30).getTime();
assert.equal(new Date(autumn - 24 * 3600_000).getDate(), 25, 'the old arithmetic stays on the same day');
assert.equal(new Date(calendarDaysAgo(autumn, 1)).getDate(), 24);

// The 25-hour day keeps its last hour: a crossing at 23:30 local on the 25th.
const lateOn25th = new Date(2026, 9, 25, 23, 30).getTime();
const cr = [{ kind: 'enter' as const, at: lateOn25th }];
assert.equal(crossingsForDay(cr, new Date(2026, 9, 25, 12).getTime()).length, 1, 'last hour of a 25-hour day belongs to it');
assert.equal(crossingsForDay(cr, new Date(2026, 9, 26, 12).getTime()).length, 0, 'and not to the next day');

console.log('spaces/attendanceDays self-check OK');
