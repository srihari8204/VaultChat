// lib/vaultBeamSettings.selftest.ts — run: npx tsx lib/vaultBeamSettings.selftest.ts
//
// A change applies in memory at once, even while an earlier write is still on
// its way to disk, and the writes land in call order, so the newest choice is
// the one kept. A failed write rejects (the screen says so) without blocking
// the next one.

import assert from 'node:assert/strict';

const disk = new Map<string, string>();
const pending: (() => void)[] = [];
let failNext = false;
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === '@react-native-async-storage/async-storage') {
    return {
      __esModule: true,
      default: {
        getItem: async () => null,
        // Every write waits until the test releases it, in FIFO order.
        setItem: (k: string, v: string) => new Promise<void>((resolve, reject) => {
          const fail = failNext; failNext = false;
          pending.push(() => { if (fail) reject(new Error('disk full')); else { disk.set(k, v); resolve(); } });
        }),
      },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const vb = require('./vaultBeamSettings') as typeof import('./vaultBeamSettings');
const tick = () => new Promise((r) => setTimeout(r, 0));
const release = async () => { while (pending.length) { pending.shift()!(); await tick(); } };

(async () => {
  failNext = true;
  const first = vb.patchSettings({ mode: 'auto' });
  assert.equal(vb.getSettingsCached().mode, 'auto', 'applied before any write finishes');
  const second = vb.patchSettings({ network: 'any' });
  assert.equal(vb.getSettingsCached().network, 'any', 'a queued change applies at once too');
  await tick();
  assert.equal(pending.length, 1, 'the second write waits for the first');
  await release();
  await assert.rejects(first, /disk full/);
  await second;
  const saved = JSON.parse([...disk.values()][0]);
  assert.equal(saved.mode, 'auto');
  assert.equal(saved.network, 'any', 'the newest settings are what is on disk');
  console.log('vaultBeamSettings.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
