// lib/screenGuard.selftest.ts — run: npx tsx lib/screenGuard.selftest.ts
//
// The privacy dashboard's screenshot fact (Android, release build):
//   • nothing confirmed yet reads 'unknown', never a guess,
//   • readSecureStateSettled waits for a setSecure call still in flight, so a
//     screen that loads during the root layout's call reads its outcome,
//   • a call neither path confirmed reads 'unknown' again; clearing reads false,
//   • a build whose native module can read the window flag (isSecure) reports
//     that read, and falls back when the read fails or returns junk.

import assert from 'node:assert/strict';

(globalThis as any).__DEV__ = false;
let release: (() => void) | null = null;
let failExpo = false;
// The native module stand-in: no methods at first (an older build).
const guard: { isSecure?: () => Promise<unknown> } = {};
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native') return { NativeModules: { VaultViewGuard: guard }, NativeEventEmitter: class {}, Platform: { OS: 'android' } };
  if (request === 'expo-screen-capture') {
    const slow = () => new Promise<void>((resolve, reject) => { release = () => (failExpo ? reject(new Error('x')) : resolve()); });
    return { preventScreenCaptureAsync: slow, allowScreenCaptureAsync: slow };
  }
  return origLoad.call(this, request, ...rest);
};
const g = require('./screenGuard') as typeof import('./screenGuard');
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  assert.equal(g.readSecureState(), 'unknown', 'nothing applied yet');
  const set = g.setSecure(true);
  const read = g.readSecureStateSettled();
  await tick();
  assert.equal(g.readSecureState(), 'unknown', 'the plain read does not guess while the call runs');
  release!();
  assert.equal(await set, true);
  assert.equal(await read, true, 'the settled read waited for the call');
  assert.equal(await g.readSecureStateSettled(), true, 'nothing in flight: immediate');

  failExpo = true;
  const failed = g.setSecure(true);
  await tick(); release!();
  assert.equal(await failed, false);
  assert.equal(await g.readSecureStateSettled(), 'unknown', 'an unconfirmed call is unknown, not on');

  failExpo = false;
  const off = g.setSecure(false);
  await tick(); release!();
  await off;
  assert.equal(await g.readSecureStateSettled(), false);

  // A build that can read the window: its answer wins over the last applied value.
  guard.isSecure = async () => true;
  assert.equal(await g.readSecureStateSettled(), true, 'the native read of the window flag');
  assert.equal(g.readSecureState(), false, 'the sync read is still the last applied value');
  guard.isSecure = async () => { throw new Error('no activity'); };
  assert.equal(await g.readSecureStateSettled(), false, 'a failed native read falls back');
  guard.isSecure = async () => 'yes';
  assert.equal(await g.readSecureStateSettled(), false, 'a non-boolean native answer is ignored');
  console.log('screenGuard.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
