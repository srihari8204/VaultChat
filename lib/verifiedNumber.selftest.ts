// lib/verifiedNumber.selftest.ts — run: npx tsx lib/verifiedNumber.selftest.ts
//
// "Verified" holds only for the safety number that was verified. Before this,
// the flag was stored per contact id alone, so after a key change (which
// lib/keyChange detects, and whose chat banner links to app/verify-contact)
// the screen still said "Verified — tap to clear" next to the NEW number.
//
// Runs the real lib/verification.ts (pure status + fingerprint) and the real
// lib/keyChange.ts (AsyncStorage in memory, the E2EE session stubbed).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const store = new Map<string, string>();
let peerKey = 'aa11';
const Module = require('module');
const stubs: Record<string, any> = {
  '@sentry/react-native': { setUser() {} },
  'expo-router': { router: { replace() {}, push() {} } },
  'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} },
  '@react-native-async-storage/async-storage': { __esModule: true, default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  } },
  '../services/crypto/e2eeSession.rn': { e2eePeerIdentityKey: async () => peerKey },
};
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).__DEV__ = false;
const V = require('./verification') as typeof import('./verification');
// keyChange's dynamic import() bypasses Module._load under tsx, so compile it
// to CommonJS (import() → require) and hand it the stubs directly.
const K = {} as typeof import('./keyChange');
new Function('require', 'exports', ts.transpileModule(readFileSync('lib/keyChange.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText)((name: string) => stubs[name] ?? require(name), K);

async function main() {
  // ── fingerprint ───────────────────────────────────────────────────────
  const n1 = '123456789012345678901234567890123456789012345678901234567890';
  const n2 = '923456789012345678901234567890123456789012345678901234567890';
  const f1 = V.safetyFingerprint(n1);
  assert.match(f1, /^[0-9a-f]{64}$/, 'a sha-256 hex, not the number');
  assert.equal(V.safetyFingerprint('12345 67890 ' + n1.slice(10)), f1, 'grouping does not matter');
  assert.notEqual(V.safetyFingerprint(n2), f1);

  // ── status ────────────────────────────────────────────────────────────
  assert.equal(V.verificationStatus(false, f1, f1, false), 'unverified', 'the flag is the decision');
  assert.equal(V.verificationStatus(true, f1, f1, true), 'verified', 'same number');
  assert.equal(V.verificationStatus(true, f1, V.safetyFingerprint(n2), false), 'changed', 'number changed since verified');
  assert.equal(V.verificationStatus(true, K.STALE_VERIFICATION, f1, false), 'changed', 'stale marker never matches');
  assert.equal(V.verificationStatus(true, null, f1, true), 'changed', 'unrecorded verification + pending key change');
  assert.equal(V.verificationStatus(true, null, f1, false), 'verified', 'unrecorded verification, no change: adopted');

  // ── keyChange storage ─────────────────────────────────────────────────
  assert.equal(await K.checkKeyChange('p'), null, 'first sight is the baseline');
  await K.setVerifiedFingerprint('p', f1);
  assert.equal(await K.getVerifiedFingerprint('p'), f1);
  peerKey = 'bb22';
  const change = await K.checkKeyChange('p');
  assert.ok(change && change.currentHex === 'bb22', 'the change is detected');
  await K.acknowledgeKeyChange('p', 'bb22');
  assert.equal(await K.getVerifiedFingerprint('p'), f1, 'a recorded number is kept (it no longer matches by itself)');
  await K.setVerifiedFingerprint('p', null);
  assert.equal(await K.getVerifiedFingerprint('p'), null, 'clearing forgets it');

  // An old verification with no recorded number: acknowledging the banner
  // must not let it silently carry over to the new key.
  assert.equal(await K.checkKeyChange('q'), null);
  peerKey = 'cc33';
  const qc = await K.checkKeyChange('q');
  assert.ok(qc);
  await K.acknowledgeKeyChange('q', qc!.currentHex);
  assert.equal(await K.checkKeyChange('q'), null, 'banner quiet after acknowledgement');
  const recorded = await K.getVerifiedFingerprint('q');
  assert.equal(recorded, K.STALE_VERIFICATION);
  assert.equal(V.verificationStatus(true, recorded, f1, false), 'changed', '…so the screen still says it changed');
  assert.ok([...store.keys()].every((k) => k.startsWith('vc_peer_ik_')),
    'every key is vc_peer_ik_* (kept out of backups by lib/backupSecretKeys)');

  // ── the screen uses it ────────────────────────────────────────────────
  const screen = readFileSync('app/verify-contact.tsx', 'utf8');
  assert.match(screen, /verificationStatus\(verifiedList\.includes\(peerId\), recorded, fp, change != null\)/);
  assert.match(screen, /setVerifiedFingerprint\(peerId, next \? safetyFingerprint\(state\.number\) : null\)/);
  assert.match(screen, /Not verified — the security code changed/);
  assert.doesNotMatch(screen, /setVerified\(verifiedList\.includes\(peerId\)\)/, 'the flag alone no longer decides');

  console.log('verified number: fingerprint, status, key-change marker and screen wiring checks passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
