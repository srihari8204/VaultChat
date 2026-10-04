// components/finance/ledgerDeleteHandoff.selftest.ts — run: npx tsx components/finance/ledgerDeleteHandoff.selftest.ts
//
// R1 (round 7): the Ledger Book deleted whatever ledger a `deleteId` route
// param named, unconfirmed, so vaultchat://finance/ledger?deleteId=<id> could
// delete a ledger. The detail's confirmed Delete now reaches the list through
// an in-memory, one-shot, short-lived handoff, and the list reads no params.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handOffLedgerDelete, takeLedgerDelete, hasLedgerDelete } from './ledgerDeleteHandoff';

const ROOT = path.resolve(__dirname, '../..');
let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// --- the handoff
ok('nothing is waiting at start', !hasLedgerDelete() && takeLedgerDelete() === null);
handOffLedgerDelete('abc', 1_000);
ok('a handoff waits until taken', hasLedgerDelete());
ok('it is taken once with its id', takeLedgerDelete(2_000) === 'abc');
ok('… and only once', !hasLedgerDelete() && takeLedgerDelete(2_000) === null);
handOffLedgerDelete('old', 1_000);
ok('an uncollected handoff expires (15 s) instead of deleting later', takeLedgerDelete(1_000 + 15_001) === null);
ok('… and is gone after the expired take', !hasLedgerDelete());
handOffLedgerDelete('a', 0); handOffLedgerDelete('b', 0);
ok('a newer handoff replaces an older one', takeLedgerDelete(1) === 'b');

// --- the screens
const list = strip(fs.readFileSync(path.join(ROOT, 'app/finance/ledger/index.tsx'), 'utf8'));
ok('the list reads no route params', !/useLocalSearchParams|useGlobalSearchParams/.test(list));
ok('the list never mentions deleteId', !/deleteId/.test(list));
ok('the list takes the in-memory handoff', /takeLedgerDelete\(\)/.test(list));

const detail = strip(fs.readFileSync(path.join(ROOT, 'app/finance/ledger/[id].tsx'), 'utf8'));
ok('the detail sends no deleteId param', !/deleteId/.test(detail));
const del = detail.slice(detail.indexOf('const onDelete'));
ok('the detail hands off only inside its destructive confirmation',
  /Alert\.alert\('Delete ledger\?'[\s\S]*?style: 'destructive', onPress: \(\) => \{ handOffLedgerDelete\(e\.id\); router\.dismissTo\('\/finance\/ledger'\)/.test(del));
ok('handOffLedgerDelete is called from exactly one place', (detail.match(/handOffLedgerDelete\(/g) ?? []).length === 1);

console.log(`ledgerDeleteHandoff: ${n} checks passed`);
