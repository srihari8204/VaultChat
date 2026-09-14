// services/deviceId.selftest.ts — run: npx tsx services/deviceId.selftest.ts
//
// Exercises the REAL getDeviceId() body. services/deviceService.ts imports
// expo-secure-store, expo-crypto and react-native, none of which load under
// Node, so — exactly as lib/twoUserConversation.selftest.ts and
// lib/messageQueue.flush.selftest.ts already do — only its IMPORT BLOCK is
// rewritten to point at stubs and the body is used verbatim, regenerated on
// every run so it cannot drift from what ships.
//
// WHAT THIS PROTECTS
//
// getDeviceId() used to read SecureStore on every call. Two things were wrong
// with that, and the second is the one that matters:
//
//   1. Boot paid the Keystore round trip twice — lib/api.ts (which memoises its
//      own call) and initFeatureFlags() are independent callers.
//   2. In principle two callers that both complete the read before either
//      write lands would each mint a SHA-256 and one write would be lost,
//      leaving that caller holding an id the keystore does not have.
//      HONEST LIMIT: case 2 below passes against the OLD code too, because a
//      read that resolves after a write observes that write — so it pins the
//      invariant rather than demonstrating a bug that was reproduced. Case 1
//      is the one that actually fails without the memo.
//
// A memo that also caches FAILURES would be its own bug: a Keystore error while
// the device is still locked during boot would poison the id for the whole
// process. The third case below is what holds that line.

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'deviceService.ts'), 'utf8');

// ── stub state, driven per-case ────────────────────────────────────────────
type Stub = {
  reads: number;
  writes: number;
  stored: string | null;
  failRead: boolean;
};

function buildStub(s: Stub): string {
  return `
export const __state = ${JSON.stringify({ reads: 0, writes: 0, stored: s.stored, failRead: s.failRead })};
export const SecureStore = {
  async getItemAsync(_k) {
    __state.reads++;
    if (__state.failRead) throw new Error('keystore unavailable');
    // Yield so two concurrent callers genuinely interleave; a synchronous
    // resolve would hide the very race this file exists to catch.
    await new Promise(r => setTimeout(r, 5));
    return __state.stored;
  },
  async setItemAsync(_k, v) { __state.writes++; __state.stored = v; },
};
export const Crypto = {
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  // Distinct per call, like a real digest over a raw string containing
  // Date.now() and Math.random() — that difference is what makes a lost write
  // observable.
  async digestStringAsync(_alg, raw) { return 'digest:' + Math.random().toString(36).slice(2); },
};
export const Platform = { OS: 'android', Version: 34 };
`;
}

async function loadWith(stub: Stub) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-devid-'));
  writeFileSync(join(dir, 'stubs.ts'), buildStub(stub));
  // IMPORT BLOCK ONLY. Nothing inside a function body is touched.
  const body = SRC
    .replace(/^﻿/, '')
    .replace(/^import \* as Crypto from "expo-crypto";$/m, `import { Crypto } from './stubs';`)
    .replace(/^import \* as SecureStore from "expo-secure-store";$/m, `import { SecureStore } from './stubs';`)
    .replace(/^import \{ Platform \} from "react-native";$/m, `import { Platform } from './stubs';`);
  if (body.includes('expo-secure-store') || body.includes('react-native')) {
    throw new Error('import rewrite failed — deviceService.ts import block changed shape');
  }
  const file = join(dir, 'deviceService.ts');
  writeFileSync(file, body);
  const mod: any = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  // NO cache-buster on this one. deviceService imports './stubs' with no query,
  // so a `?t=` here resolves to a SECOND module instance and the assertions
  // would inspect a __state object the code under test never touches (which
  // is exactly how this first read 0 keystore calls). Each case gets a fresh
  // temp dir, so the specifier is already unique per case.
  const state: any = (await import(pathToFileURL(join(dir, 'stubs.ts')).href)).__state;
  return { mod, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let failures = 0;
function check(name: string, ok: boolean, why: string) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}\n       ${why}`); }
}

async function main(): Promise<void> {

// 1 — an already-stored id is read ONCE however many callers ask.
{
  const { mod, state, cleanup } = await loadWith({ reads: 0, writes: 0, stored: 'existing-id', failRead: false });
  const ids = await Promise.all([mod.getDeviceId(), mod.getDeviceId(), mod.getDeviceId()]);
  check('concurrent callers all get the stored id',
    ids.every(i => i === 'existing-id'),
    `got ${JSON.stringify(ids)}`);
  check('the keystore is read once, not once per caller',
    state.reads === 1,
    `SecureStore.getItemAsync called ${state.reads} times for 3 callers`);
  const again = await mod.getDeviceId();
  check('a later call is served from the memo',
    again === 'existing-id' && state.reads === 1,
    `reads=${state.reads} after a 4th call`);
  cleanup();
}

// 2 — THE RACE. With nothing stored, concurrent callers must agree, and the id
// they agree on must be the one actually persisted.
{
  const { mod, state, cleanup } = await loadWith({ reads: 0, writes: 0, stored: null, failRead: false });
  const [a, b, c] = await Promise.all([mod.getDeviceId(), mod.getDeviceId(), mod.getDeviceId()]);
  check('concurrent first-run callers agree on one id',
    a === b && b === c,
    `three callers minted different ids: ${a} / ${b} / ${c}`);
  check('exactly one id was written',
    state.writes === 1,
    `SecureStore.setItemAsync called ${state.writes} times — a lost write means the ` +
    `caller that lost is using an id the keystore does not hold`);
  check('the id returned is the id stored',
    a === state.stored,
    `returned ${a} but storage holds ${state.stored}`);
  cleanup();
}

// 3 — a failure must NOT be cached, or a locked keystore at boot poisons the
// whole process.
{
  const { mod, state, cleanup } = await loadWith({ reads: 0, writes: 0, stored: 'later-id', failRead: true });
  let threw = false;
  try { await mod.getDeviceId(); } catch { threw = true; }
  check('a keystore failure propagates', threw, 'getDeviceId resolved despite the read throwing');
  state.failRead = false;                 // keystore comes back
  const id = await mod.getDeviceId();
  check('the next call retries instead of replaying the failure',
    id === 'later-id',
    `expected the retry to succeed, got ${JSON.stringify(id)} (reads=${state.reads})`);
  cleanup();
}

}

function finish(): void {
if (failures) {
  console.error(`\ndeviceId.selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ndeviceId.selftest: all checks passed');
}

// A throw out of main() is a BROKEN HARNESS, not a passing test. Exit non-zero
// rather than letting the success line print.
main().then(finish).catch((e) => {
  console.error('deviceId.selftest: harness error', e);
  process.exit(1);
});
