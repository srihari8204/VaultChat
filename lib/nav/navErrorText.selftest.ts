// Run: npx tsx lib/nav/navErrorText.selftest.ts
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { navErrorText, navUserError, NAV_PERMISSION_TEXT, NO_ROUTE_TEXT } from './navErrorText';

const FB = 'Could not plan a route back to the locked spot.';
let n = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };

ok(navErrorText(navUserError(NAV_PERMISSION_TEXT), FB) === NAV_PERMISSION_TEXT, 'the permission reason is kept');
ok(navErrorText(navUserError(NO_ROUTE_TEXT), FB) === NO_ROUTE_TEXT, 'the no-route copy is kept');
ok(navErrorText(new Error('Location request failed due to unsatisfied device settings'), FB) === FB, 'a raw platform message gets the fallback');
ok(navErrorText(new Error('no route'), FB) === FB, 'an unmarked bare message gets the fallback');
ok(navErrorText(Object.assign(new Error('Route limit reached'), { status: 429 }), FB) === 'Route limit reached', 'server copy passes');
ok(navErrorText(new TypeError('Network request failed'), FB) === 'Check your connection and try again.', 'no HTTP answer reads as connection copy');
ok(navErrorText(undefined, FB) === FB && navErrorText(null, FB) === FB, 'nothing thrown → fallback');
ok(navErrorText(Object.assign(new Error(''), { userFacing: true }), FB) === FB, 'an empty marked message → fallback');

// Wiring: the throw sites mark their copy, and every navigate/lock error site
// uses the one rule (no raw e.message left).
const root = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
ok(/throw navUserError\(NAV_PERMISSION_TEXT\)/.test(read('lib/nav/navigationService.ts')), 'startNavigation marks its permission error');
ok(/throw navUserError\(NO_ROUTE_TEXT\)/.test(read('lib/nav/routing.ts')), 'parseRoute marks its no-route error');
for (const f of ['components/lock/LockActiveFace.tsx', 'app/lock-alert.tsx', 'app/navigate.tsx']) {
  ok(/navErrorText\(e,/.test(read(f)), `${f} uses navErrorText`);
}
for (const f of ['components/lock/LockActiveFace.tsx', 'app/lock-alert.tsx', 'app/navigate.tsx', 'app/lock-settings.tsx']) {
  ok(!/e instanceof Error && e\.message/.test(read(f)), `${f} shows no raw e.message`);
}
console.log(`navErrorText selftest: ${n} passed`);
