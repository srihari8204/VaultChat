// lib/finance/legacyRoute.selftest.ts — run: npx tsx lib/finance/legacyRoute.selftest.ts
//
// app/interest-calculator.tsx is kept for old links (deleting it is an open
// decision, fix_status §5). Kept, it must be a redirect shim and nothing more,
// the way app/creator-channels.tsx is (lib/orphanRoutes.selftest.ts):
//   - a bare <Redirect> to the calculator, so nothing renders or flashes and
//     there is no second calculator to drift from app/finance/interest.tsx;
//   - its target exists;
//   - nothing in the app routes to the legacy path (in-app links go to
//     /finance/interest directly; a second way in is how duplicates grow).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const shim = strip(fs.readFileSync(path.join(ROOT, 'app/interest-calculator.tsx'), 'utf8'));
ok('the legacy route redirects to /finance/interest', /<Redirect\s+href="\/finance\/interest"\s*\/>/.test(shim));
ok('… and renders nothing else (one JSX element)', (shim.match(/<[A-Z]/g) ?? []).length === 1);
ok('… with no state, effects or casts', !/use(State|Effect|Callback|Memo)\b|\bas\s+any\b/.test(shim));
ok('the redirect target exists', fs.existsSync(path.join(ROOT, 'app/finance/interest.tsx')));

const callers: string[] = [];
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.[jt]sx?$/.test(e.name) && !e.name.includes('.selftest.')) {
      if (/['"`]\/interest-calculator(?=['"`?#/])/.test(strip(fs.readFileSync(p, 'utf8')))) {
        callers.push(path.relative(ROOT, p));
      }
    }
  }
}
['app', 'components', 'lib', 'utils'].forEach((d) => walk(path.join(ROOT, d)));
ok('nothing in the app routes to /interest-calculator' + (callers.length ? ` — found: ${callers.join(', ')}` : ''),
  callers.length === 0);

console.log(`legacyRoute.selftest: ${n} assertions passed`);
