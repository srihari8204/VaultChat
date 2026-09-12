// lib/remoteFlags.selftest.ts — run: npx tsx lib/remoteFlags.selftest.ts
//
// AUDIT F11. A remote flag system has one rule that carries all of its safety:
// the server can turn features OFF and can never turn them ON. /app/flags is
// unauthenticated, so a system that honoured a remote `true` would be a
// remote-enable primitive pointed at every installation — able to light up a
// code path the installed build may not contain, may have shipped half
// finished, or may never have been tested in that combination.
//
// Every case below exists to pin that asymmetry, or to pin the other half of
// the contract: an uncertain answer must leave the app behaving exactly as
// built. Features that vanish because a network request failed would be a worse
// bug than the one this fixes.

import fs from 'node:fs';
import path from 'node:path';

import { resolveFlag, sanitizeFlags } from './remoteFlagPolicy';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

console.log('\nRemote-flag self-test\n');

console.log('The server can only DISABLE:');
check('remote false turns an enabled feature off', resolveFlag('x', true, { x: false }) === false);
check('remote true CANNOT turn a disabled feature on',
  resolveFlag('x', false, { x: true }) === true === false,
  'this is the whole safety argument — /app/flags is unauthenticated');
check('remote true on an enabled feature changes nothing', resolveFlag('x', true, { x: true }) === true);
check('remote false on an already-disabled feature keeps it off', resolveFlag('x', false, { x: false }) === false);

console.log('\nUncertainty leaves the build in charge:');
check('no flags fetched yet ⇒ build default', resolveFlag('x', true, null) === true);
check('undefined flags ⇒ build default', resolveFlag('x', true, undefined) === true);
check('an empty answer ⇒ build default', resolveFlag('x', true, {}) === true);
check('a name the server never mentioned ⇒ build default', resolveFlag('x', true, { other: false }) === true);
check('a disabled build stays disabled whatever arrives', resolveFlag('x', false, {}) === false);

console.log('\nOnly an explicit false survives the wire:');
check('true is dropped', JSON.stringify(sanitizeFlags({ a: true })) === '{}');
check('false is kept', sanitizeFlags({ a: false }).a === false);
check('a string "false" is NOT a false', JSON.stringify(sanitizeFlags({ a: 'false' })) === '{}',
  'a stringly-typed value must never read as a kill');
check('0 is not a false', JSON.stringify(sanitizeFlags({ a: 0 })) === '{}');
check('null is not a false', JSON.stringify(sanitizeFlags({ a: null })) === '{}');
check('a non-object answer yields no flags',
  JSON.stringify(sanitizeFlags('nope')) === '{}' && JSON.stringify(sanitizeFlags(null)) === '{}');

console.log('\nThe wiring is in place:');
const RF = read('lib/remoteFlags.ts');
check('the last answer is persisted, so a kill survives a cold start offline',
  /AsyncStorage\.setItem\(CACHE_KEY/.test(RF) && /AsyncStorage\.getItem\(CACHE_KEY/.test(RF));
check('the cached answer is applied BEFORE the fetch',
  RF.indexOf('AsyncStorage.getItem(CACHE_KEY') < RF.indexOf('await fetch('));
check('a failed fetch keeps whatever the cache gave us', /catch \{[\s\S]{0,400}\} finally \{/.test(RF));
check('reads are synchronous — call sites are render paths',
  /export function flagEnabled\(name: string, buildTimeDefault = true\): boolean/.test(RF));

const LAYOUT = read('app/_layout.tsx');
check('flags load at boot and nothing waits on them', /loadRemoteFlags\(\)\.catch\(\(\) => \{\}\);/.test(LAYOUT));

const MINI = read('app/(tabs)/mini.tsx');
check('mini-app tiles are behind a kill switch', /flagEnabled\(`mini\.\$\{app\.id\}`\)/.test(MINI));
check('a killed mini-app is unreachable, not merely hidden',
  /if \(!flagEnabled\(`mini\.\$\{appId\}`\)\) return;/.test(MINI),
  'hiding the button while the route still opens is a half-disabled feature');

const GO = read('vaultchat-backend-go/internal/routes/appflags.go');
check('the server strips every true before answering', /if v \{\s*\n\s*delete\(out, k\)/.test(GO),
  'the wire should never carry something that looks like a remote enable');
check('unparseable config is ignored LOUDLY', /log\.Printf\("\[app\/flags\]/.test(GO),
  'the silent version is an operator believing a feature is off when it is not');
check('a broken env var disables nothing', /out = map\[string\]bool\{\}/.test(GO));

console.log(failures === 0 ? '\nAll remote-flag checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
