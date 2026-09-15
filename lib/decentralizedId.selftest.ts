// Run: npx tsx lib/decentralizedId.selftest.ts
// Execute the production body with storage stubs and real Ed25519 operations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import ts from 'typescript';
import type { DidRecord } from './decentralizedId';

const requireHere = createRequire(import.meta.url);
const source = readFileSync(new URL('./decentralizedId.ts', import.meta.url), 'utf8')
  .replace(/^import 'react-native-get-random-values';\r?\n/m, '')
  .replace(/^import \* as SecureStore from 'expo-secure-store';\r?\n/m, '')
  .replace(/^import AsyncStorage from '@react-native-async-storage\/async-storage';\r?\n/m, '');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let secret: string | null = null;
let metadata: string | null = null;
let writes = 0;
let readFails = false;
const secureStore = {
  getItemAsync: async () => secret,
  setItemAsync: async (_: string, value: string) => { writes++; secret = value; },
  deleteItemAsync: async () => { writes++; secret = null; },
};
const storage = {
  getItem: async () => { if (readFails) throw new Error('storage unavailable'); return metadata; },
  setItem: async (_: string, value: string) => { writes++; metadata = value; },
  removeItem: async () => { writes++; metadata = null; },
};
const loaded = { exports: {} as typeof import('./decentralizedId') };
new Function('require', 'module', 'exports', 'SecureStore', 'AsyncStorage', compiled)(requireHere, loaded, loaded.exports, secureStore, storage);
const did = loaded.exports;

async function main() {
  assert.equal(await did.proveControl(), false, 'missing identity');
  const first = await did.createDid(' First ');
  const firstSecret = secret;
  assert.equal(first.displayName, 'First');
  assert.equal(await did.proveControl(), true, 'valid identity');
  const second = await did.createDid('Second');
  assert.equal(await did.proveControl(), true, 'valid replacement');
  metadata = JSON.stringify(first);
  assert.equal(await did.proveControl(), false, 'new private key with stale complete identity record');
  secret = firstSecret;
  const baselineWrites = writes;
  for (const patch of [
    { did: second.did }, { publicKeyHex: second.publicKeyHex }, { fingerprint: second.fingerprint },
    { did: '' }, { publicKeyHex: '00' }, { publicKeyHex: 'g'.repeat(64) },
    { fingerprint: null }, { displayName: 1 }, { createdAt: null }, { createdAt: -1 },
  ]) {
    metadata = JSON.stringify({ ...first, ...patch });
    assert.equal(await did.proveControl(), false, `reject changed metadata: ${Object.keys(patch)[0]}`);
  }
  for (const field of Object.keys(first) as (keyof DidRecord)[]) {
    const partial: Partial<DidRecord> = { ...first };
    delete partial[field];
    metadata = JSON.stringify(partial);
    assert.equal(await did.proveControl(), false, `reject missing ${field}`);
  }
  for (const raw of [null, 'null', '[]', '{}', '"text"', 'true', '{broken']) {
    metadata = raw;
    assert.equal(await did.proveControl(), false, 'reject absent/malformed metadata');
  }
  metadata = JSON.stringify({ ...first, publicKeyHex: first.publicKeyHex.toUpperCase() });
  assert.equal(await did.proveControl(), true, 'equivalent public hex encoding');
  for (const invalid of [null, '', 'not hex', '00']) {
    secret = invalid;
    assert.equal(await did.proveControl(), false, 'reject absent/malformed secret');
  }
  secret = firstSecret;
  readFails = true;
  assert.equal(await did.proveControl(), false, 'storage failure');
  readFails = false;
  assert.equal(await did.proveControl(), true, 'valid identity recovers without mutation');
  assert.equal(writes, baselineWrites, 'verification never regenerates or modifies identity');
  console.log('decentralizedId selftest: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
