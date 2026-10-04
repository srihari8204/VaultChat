// npx tsx components/finance/ledgerCsv.selftest.ts
import assert from 'node:assert/strict';
import type { LedgerEntry } from '../../db/ledger';
import { csvCell, toCsv, parseCsv, uncell, ledgerCsvRow, planLedgerImport, LEDGER_HEADERS } from './ledgerCsv';

// formula injection: text that a spreadsheet would execute is neutralised
assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
assert.equal(csvCell('+919876543210'), "'+919876543210");
assert.equal(csvCell('-5 paid'), "'-5 paid");
assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
assert.equal(csvCell('\tcmd'), "'\tcmd");
assert.equal(csvCell(-5), '-5');                 // a number is data, not a formula
assert.equal(csvCell('Ramesh'), 'Ramesh');
assert.equal(uncell("'=1+1"), '=1+1');
assert.equal(uncell("'quoted"), "'quoted");      // an apostrophe we did not add stays

// whole-file parsing: quoted commas, quotes and line breaks
assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"line1\nline2",z\n\n'),
  [['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', 'z']]);
assert.deepEqual(parseCsv('﻿a,b'), [['a', 'b']]);

// full round trip, including the formula guard, a multi-line note and dates
const base: LedgerEntry = {
  id: 'L1', user_id: 'u', direction: 'lend', name: '=Ramesh, Jr', mobile: '+919876543210',
  interest_type: 'compound', principal: 125000.5, rate: 2, rate_mode: 'percent', period: 'monthly',
  start_date: Date.UTC(2025, 0, 15), end_date: Date.UTC(2026, 0, 15), remaining: 0, status: 'completed',
  notes: 'paid in two parts\n"cash", then UPI', created_at: Date.UTC(2025, 0, 15), last_updated: 0,
};
const csv = toCsv(LEDGER_HEADERS, [ledgerCsvRow(base)]);
const now = Date.UTC(2026, 9, 4);
const plan = planLedgerImport(csv, [], now);
assert.equal(plan.rows.length, 1);
const r = plan.rows[0];
assert.equal(r.name, '=Ramesh, Jr');
assert.equal(r.mobile, '9876543210');               // stored normalised, like the forms
assert.equal(r.notes, 'paid in two parts\n"cash", then UPI');
assert.equal(r.principal, 125000.5);
assert.equal(r.remaining, 0);                     // settled stays settled
assert.equal(r.status, 'completed');
assert.equal(r.interest_type, 'compound');
assert.equal(r.start_date, base.start_date);      // dates survive the round trip
assert.equal(r.end_date, base.end_date);

// re-importing the same file into a book that already has it adds nothing
const again = planLedgerImport(csv, [base], now);
assert.equal(again.rows.length, 0);
assert.equal(again.duplicates, 1);
// the same row twice in one file is imported once
const twice = planLedgerImport(toCsv(LEDGER_HEADERS, [ledgerCsvRow(base), ledgerCsvRow(base)]), [], now);
assert.equal(twice.rows.length, 1);
assert.equal(twice.duplicates, 1);

// bad rows are counted, not silently dropped
const bad = planLedgerImport(
  'Name,Mobile,Direction,InterestType,Principal,Rate,RateMode,Period,Remaining,Status\n' +
  'A,,lend,simple,abc,1,percent,monthly,,running\n' +
  'B,,lend,simple,0,1,percent,monthly,,running\n' +
  'C,,lend,simple,100,1,percent,monthly,x1,running\n' +
  'D,,borrow,simple,100,1,percent,monthly,,running\n', [], now);
assert.equal(bad.badPrincipal, 2);
assert.equal(bad.badRemaining, 1);
assert.equal(bad.rows.length, 1);
// an old 12-column export (no StartDate) still imports, starting today
assert.equal(bad.rows[0].start_date, now);
assert.equal(bad.rows[0].end_date, null);
assert.equal(bad.rows[0].remaining, 100);
assert.equal(bad.rows[0].direction, 'borrow');

// an old export is de-duplicated on its Created day
const oldCsv = 'Name,Mobile,Direction,InterestType,Principal,Rate,RateMode,Period,Remaining,Status,Notes,Created\n' +
  `=Ramesh, Jr,,lend,simple,125000.5,2,percent,monthly,0,completed,,${ledgerCsvRow(base)[11]}\n`;
assert.equal(planLedgerImport(oldCsv.replace('=Ramesh, Jr', '"=Ramesh, Jr"'), [base], now).duplicates, 1);

// an unreadable date is reported, not replaced with today
const badDate = planLedgerImport(toCsv(LEDGER_HEADERS, [[...ledgerCsvRow(base).slice(0, 12), 'not a date', '']]), [], now);
assert.equal(badDate.badDate, 1);
assert.equal(badDate.rows.length, 0);

// a mobile is stored normalised; an invalid one is dropped and counted, the row kept
const mob = planLedgerImport(
  'Name,Mobile,Direction,InterestType,Principal,Rate,RateMode,Period,Remaining,Status\n' +
  'E,+91 98765 43210,lend,simple,100,1,percent,monthly,,running\n' +
  'F,12345,lend,simple,200,1,percent,monthly,,running\n', [], now);
assert.equal(mob.rows.length, 2);
assert.equal(mob.rows[0].mobile, '9876543210');
assert.equal(mob.rows[1].mobile, null);
assert.equal(mob.badMobile, 1);

console.log('ledgerCsv selftest: all passed');
