// lib/chatLockMigration.selftest.ts — run: npx tsx lib/chatLockMigration.selftest.ts
//
// Runs the REAL lib/chatLock.ts (React Native modules stubbed, AsyncStorage
// in memory) to prove the lock table is migrated and rate-limited:
//   • a lock stored with the old unsalted hash still opens with its PIN,
//   • and on that success the stored hash is replaced by the salted format,
//   • wrong PINs are counted on the stored record and then refused unchecked,
//   • a new lock is written in the salted format from the start.

import assert from 'node:assert/strict';

const store = new Map<string, string>();
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
    } };
  }
  if (request === 'expo-local-authentication') return {};
  if (request === 'react-native') return { Platform: { OS: 'android' } };
  return origLoad.call(this, request, ...rest);
};
const CL = require('./chatLock') as typeof import('./chatLock');
const { legacyChatPinHash } = require('./chatLockPin') as typeof import('./chatLockPin');

// The writes are fire-and-forget (verifyPin is synchronous), and the upgrade
// runs a scrypt derivation first — poll for the stored result rather than
// guess a delay, which flaked under the parallel test runner.
async function waitFor(what: string, pred: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const stored = (id: string) => JSON.parse(store.get('vc_locked_chats')!)[id];

async function main() {
  const KEY = 'vc_locked_chats';
  store.set(KEY, JSON.stringify({
    c1: { chatId: 'c1', chatName: 'Old', locked: true, lockMethod: 'pin', autoLockTimer: 0, pinHash: legacyChatPinHash('4321') },
  }));

  // Old record: opens, then is upgraded in storage.
  const lock = (await CL.getLock('c1'))!;
  assert.equal(CL.verifyPin(lock, '4321'), true, 'the old hash still opens with its PIN');
  await waitFor('the hash upgrade', () => String(stored('c1').pinHash).startsWith('scrypt1$'));
  const upgraded = JSON.parse(store.get(KEY)!).c1;
  assert.match(upgraded.pinHash, /^scrypt1\$/, 'migrated to the salted format on success');
  assert.equal(CL.verifyPin(upgraded, '4321'), true, 'and the migrated record still opens');
  assert.equal(CL.verifyPin(upgraded, '0000'), false);

  // Wrong PINs: counted, persisted, and then refused without a check.
  const again = (await CL.getLock('c1'))!;
  assert.equal(CL.verifyPin(again, '1111'), false);
  assert.equal(CL.verifyPin(again, '2222'), false);
  await waitFor('the failure streak', () => stored('c1').failN === 2);
  assert.equal(JSON.parse(store.get(KEY)!).c1.failN, 2, 'the streak is stored on the lock');
  assert.ok(CL.pinRetryAfterMs(again) > 0, 'a backoff is owed');
  assert.equal(CL.verifyPin(again, '4321'), false, 'even the right PIN waits out the backoff');
  const fresh = (await CL.getLock('c1'))!;
  assert.ok(CL.pinRetryAfterMs(fresh) > 0, 'leaving and coming back does not reset it');

  // New locks are salted from the start; isChatLocked reads the table.
  await CL.setChatLock('c2', 'New', 'pin', 0, '8642');
  const c2 = JSON.parse(store.get(KEY)!).c2;
  assert.match(c2.pinHash, /^scrypt1\$/);
  assert.equal(await CL.isChatLocked('c2'), true);
  assert.equal(await CL.isChatLocked('nope'), false);

  console.log('chatLockMigration.selftest: all checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
