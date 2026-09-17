// Run: npx tsx constants/vaultID.selftest.ts
//
// This exists because vaultID.ts stopped calling `ethers` (2026-09-18) and now
// does EIP-55 addressing, EIP-191 signing and signature recovery against
// @noble/curves directly. "Compatible" is not good enough for an identity key:
// a signature made by a shipped build must recover to the same address on the
// next one, so this proves the bytes are IDENTICAL, not merely valid —
//   1. against fixed public vectors, and
//   2. against ethers itself, over 200 random keys.
//
// ethers stays in package.json for exactly this: it is the oracle, and it is a
// devDependency of the truth rather than something the app ships.
//
// Executes the production module body with storage stubs (same trick as
// lib/decentralizedId.selftest.ts) so the tested code is the shipped code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import ts from 'typescript';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ethers } from 'ethers';

const requireHere = createRequire(import.meta.url);
const source = readFileSync(new URL('./vaultID.ts', import.meta.url), 'utf8')
  .replace(/^import 'react-native-get-random-values';\r?\n/m, '')
  .replace(/^import \* as Crypto from 'expo-crypto';\r?\n/m, '')
  .replace(/^import \* as SecureStore from 'expo-secure-store';\r?\n/m, '')
  .replace(/^import AsyncStorage from '@react-native-async-storage\/async-storage';\r?\n/m, '');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let secret: string | null = null;
const store = new Map<string, string>();
const Crypto = {
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algo: string, data: string) =>
    createHash('sha256').update(data, 'utf8').digest('hex'),
};
const SecureStore = {
  getItemAsync: async () => secret,
  setItemAsync: async (_k: string, v: string) => { secret = v; },
  deleteItemAsync: async () => { secret = null; },
};
const AsyncStorage = {
  getItem: async (k: string) => store.get(k) ?? null,
  setItem: async (k: string, v: string) => { store.set(k, v); },
  removeItem: async (k: string) => { store.delete(k); },
};
const loaded = { exports: {} as typeof import('./vaultID') };
new Function('require', 'module', 'exports', 'Crypto', 'SecureStore', 'AsyncStorage', compiled)(
  requireHere, loaded, loaded.exports, Crypto, SecureStore, AsyncStorage,
);
const vault = loaded.exports;

// ── 1. fixed vectors ────────────────────────────────────────────
// Hardhat/Ganache account #0 — published, never funded on mainnet.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
// eth_sign of "hello" by that key, EIP-191 personal_sign, r||s||v.
const SIG_HELLO =
  '0xf16ea9a3478698f695fd1401bfe27e9e4a7e8e3da94aa72b021125e31fa899cc' +
  '573c48ea3fe1d4ab61a9db10c19032026e3ed2dbccba5a178235ac27f94504311c';

async function main() {
  // The signer lives behind SecureStore, so load the vector key into it.
  secret = PK;
  assert.equal(await vault.signMessage('hello'), SIG_HELLO, 'known-vector signature');
  assert.equal(vault.verifySignature('hello', SIG_HELLO, ADDR), true, 'known-vector verify');
  assert.equal(
    vault.verifySignature('hello', SIG_HELLO, '0x0000000000000000000000000000000000000001'),
    false,
    'wrong address must not verify',
  );
  console.log('ok  fixed vector: sign and verify');

  // ── 2. differential against ethers ────────────────────────────
  const messages = ['hello', '', 'VaultChat', 'a'.repeat(300), '日本語 🎉 مرحبا'];
  const wallet = new ethers.Wallet(PK);
  for (const m of messages) {
    assert.equal(await vault.signMessage(m), await wallet.signMessage(m), `sig differs for ${JSON.stringify(m.slice(0, 16))}`);
  }
  console.log('ok  byte-identical to ethers over', messages.length, 'messages incl. empty and non-ASCII');

  for (let i = 0; i < 200; i++) {
    const sk = secp256k1.utils.randomSecretKey();
    secret = `0x${bytesToHex(sk)}`;
    const ew = new ethers.Wallet(secret);
    const m = `vaultchat-${i}-${bytesToHex(sk).slice(0, 8)}`;
    const mine = await vault.signMessage(m);
    assert.equal(mine, await ew.signMessage(m), 'signature');
    // ethers accepts ours, and ours accepts ethers' — both directions matter,
    // because upgraded and not-yet-upgraded builds have to interoperate.
    assert.equal(ethers.verifyMessage(m, mine), ew.address, 'ethers rejects our signature');
    assert.equal(vault.verifySignature(m, await ew.signMessage(m), ew.address), true, 'we reject ethers signature');
  }
  console.log('ok  200 random keys: signatures identical and cross-verified with ethers');

  // ── 3. generated identities keep ethers' formats ──────────────
  for (let i = 0; i < 20; i++) {
    store.clear();
    secret = null;
    const id = await vault.generateVaultID('Tester', '🦊', 'bio');
    assert.ok(secret, 'private key stored');
    const ew = new ethers.Wallet(secret!);
    assert.equal(id.walletAddress, ew.address, 'EIP-55 checksummed address matches ethers');
    assert.equal(id.publicKey, `0x${bytesToHex(secp256k1.getPublicKey(hexToBytes(secret!.slice(2)), true))}`, 'compressed publicKey');
    assert.match(id.publicKey, /^0x0[23][0-9a-f]{64}$/, 'publicKey is 33-byte compressed, as ethers returned');
    assert.equal(hexToBytes(secret!.slice(2)).length, 32, 'private key is 32 bytes');
    assert.match(id.vaultTag, /^@vault_[0-9a-f]{8}$/, 'vault tag shape');
    // Round trip through the real entry points.
    const cert = await vault.generateIdentityCertificate(id);
    const { payload, signature } = JSON.parse(Buffer.from(cert, 'base64').toString('utf8'));
    assert.equal(vault.verifySignature(payload, signature, id.walletAddress), true, 'certificate verifies');
    assert.equal(ethers.verifyMessage(payload, signature), ew.address, 'certificate verifies under ethers too');
  }
  console.log('ok  20 generated identities: address, publicKey and certificate all match ethers');

  // ── 4. tamper and malformed input ─────────────────────────────
  secret = PK;
  const good = await vault.signMessage('hello');
  const flipped = good.slice(0, 10) + (good[10] === 'f' ? '0' : 'f') + good.slice(11);
  assert.equal(vault.verifySignature('hello', flipped, ADDR), false, 'tampered signature');
  assert.equal(vault.verifySignature('hell0', good, ADDR), false, 'tampered message');
  for (const junk of ['', '0x', '0xdead', 'not-hex', good.slice(0, -2) + '05']) {
    assert.equal(vault.verifySignature('hello', junk, ADDR), false, `junk signature ${junk} must not verify`);
  }
  console.log('ok  tampered and malformed signatures rejected without throwing');

  console.log('vaultID selftest passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
