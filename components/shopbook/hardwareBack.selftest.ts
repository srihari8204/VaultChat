// components/shopbook/hardwareBack.selftest.ts — run: npx tsx components/shopbook/hardwareBack.selftest.ts
//
// N4 (round 7): Android hardware Back was not intercepted anywhere in Shop
// Book, so from any in-screen view it left the mini-app and skipped the bill's
// "Packed quantities not saved yet" prompt. SubHeader (every view's back
// arrow) now registers hardware Back with the same action. This pins the
// wiring statically; the device behaviour is 📱.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const shared = read('components/shopbook/shared.tsx');
const sub = shared.slice(shared.indexOf('export function SubHeader'), shared.indexOf('export function useHardwareBack'));
ok('SubHeader registers hardware Back with its own onBack', /useHardwareBack\(onBack\)/.test(sub));
const hook = shared.slice(shared.indexOf('export function useHardwareBack'));
ok('the hook listens for hardwareBackPress', /BackHandler\.addEventListener\('hardwareBackPress'/.test(hook));
ok('… registers once (mount order is the stacking order)', /\}, \[\]\);/.test(hook));
ok('… reads the latest action from a ref', /latest\.current = onBack/.test(hook) && /latest\.current\(\)/.test(hook));
ok('… declines (returns false) when the header has no back action', /if \(!latest\.current\) return false;/.test(hook));
ok('… consumes Back (returns true) when it ran the action', /latest\.current\(\);\s*return true;/.test(hook));
ok('… and is removed on unmount', /return \(\) => sub\.remove\(\)/.test(hook));

const bill = read('components/shopbook/invoices.tsx');
const billBody = bill.slice(bill.indexOf('export function BillScreen'), bill.indexOf('export function InvoiceView'));
ok('the loaded bill\'s back arrow (and so hardware Back) runs the queued-quantities guard',
  /<SubHeader title="Bill" onBack=\{leave\} \/>/.test(billBody) && /Packed quantities not saved yet/.test(billBody));

// Every exported view that takes an onBack draws a SubHeader, so none is left
// without hardware Back.
const dir = path.join(ROOT, 'components/shopbook');
const missing: string[] = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
  const src = read(path.join('components/shopbook', f));
  const fns = src.split(/(?=export function )/).filter((c) => c.startsWith('export function '));
  for (const fn of fns) {
    const name = /export function (\w+)/.exec(fn)?.[1] ?? '?';
    if (name === 'SubHeader') continue;
    if (/\{[^}]*\bonBack\b[^}]*\}\s*:/.test(fn.slice(0, 300)) && !/<SubHeader\b/.test(fn)) missing.push(`${f}:${name}`);
  }
}
ok('every view with an onBack draws a SubHeader' + (missing.length ? ` — missing: ${missing.join(', ')}` : ''), missing.length === 0);

const others = ['app/shop-book.tsx', ...fs.readdirSync(dir).filter((x) => x.endsWith('.tsx') && x !== 'shared.tsx').map((x) => `components/shopbook/${x}`)]
  .filter((p) => /BackHandler/.test(read(p)));
ok('no second BackHandler competes with the SubHeader one' + (others.length ? ` — found: ${others.join(', ')}` : ''), others.length === 0);

console.log(`shopbook hardwareBack: ${n} checks passed`);
