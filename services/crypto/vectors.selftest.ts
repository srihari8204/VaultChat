// services/crypto/vectors.selftest.ts — golden-vector guard (Rust-core Phase 1, Step 1).
//
// Freezes the current TS crypto behavior as deterministic vectors in
// services/crypto/__vectors__/*.json. The committed JSON is the golden copy:
// the Rust crate (crypto-core) unit-tests against the SAME files, and this
// script guards the TS side against accidental wire/serialization drift.
//
// Check (CI):  npm run test:crypto:vectors
// Regenerate:  npx tsx services/crypto/vectors.selftest.ts --write
//   (only when a format change is INTENTIONAL — the JSON diff is the review)
//
// Only DETERMINISTIC transforms are frozen byte-exactly: KDF chains, Ed25519
// signatures, X3DH responder, same-chain ratchet encrypt/decrypt (no DH step →
// no randomness), sender-key encrypt/decrypt, Shamir reconstruct from frozen
// shares, serializeState/encodeEnvelope of fixed states. Randomized ops
// (keygen, splitSecret, DH-ratchet steps) get interop/round-trip coverage in
// parity.selftest.ts (Step 5), NOT byte-equality here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  sign, verify, x3dhResponder, ratchetEncrypt, ratchetDecrypt,
  serializeState, deserializeState, encodeEnvelope, decodeEnvelope, utf8, fromUtf8,
} from './e2ee';
import type { KeyPair } from './e2ee';
import {
  distributionMessage, processDistribution, groupEncrypt, groupDecrypt,
} from './senderKey';
import type { OwnSenderKey, GroupCipher } from './senderKey';
import { splitSecret, combineShares, shareThreshold } from './shamir';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__vectors__');
const hex = bytesToHex;
const fixed = (label: string): Uint8Array => sha256(utf8(label));

// ── inputs ─────────────────────────────────────────────────────────────

interface E2eeInputs {
  kdfRk: { rk: string; dhOut: string };
  kdfCk: { ck: string };
  msgKey: { mk: string };
  sign: { priv: string; msgUtf8: string };
  x3dh: {
    bobIdentityPriv: string; bobSpkPriv: string; bobOtkPriv: string;
    aliceIdentityPriv: string; aliceEphPriv: string;
  };
  ratchet: { aPriv: string; bPriv: string; rk: string; cks: string; plaintexts: string[] };
}
interface SenderKeyInputs { chainKey: string; signPriv: string; plaintexts: string[] }
interface ShamirInputs { secretHex: string; n: number; k: number; shares: string[] }

// ── compute expected outputs from inputs (pure, deterministic) ─────────

function xkp(privHex: string): KeyPair {
  const priv = hexToBytes(privHex);
  return { priv, pub: x25519.getPublicKey(priv) };
}

function computeE2ee(inp: E2eeInputs) {
  // KDF construction pins. Formulas intentionally duplicated from e2ee.ts:
  // an independent statement of the spec the Rust crate implements verbatim.
  // Drift between these and e2ee.ts internals is caught by the ratchet
  // vectors below (which run the real code end to end).
  const ZERO32 = new Uint8Array(32);
  const rkOut = hkdf(sha256, hexToBytes(inp.kdfRk.dhOut), hexToBytes(inp.kdfRk.rk), utf8('VaultChat-RootKDF-v1'), 64);
  const mk = hmac(sha256, hexToBytes(inp.kdfCk.ck), Uint8Array.of(0x01));
  const nck = hmac(sha256, hexToBytes(inp.kdfCk.ck), Uint8Array.of(0x02));
  const mkm = hkdf(sha256, hexToBytes(inp.msgKey.mk), ZERO32, utf8('VaultChat-MsgKey-v1'), 44);

  // Ed25519 is deterministic (RFC 8032) → exact signature bytes.
  const signPriv = hexToBytes(inp.sign.priv);
  const signPub = ed25519.getPublicKey(signPriv);
  const sig = sign(utf8(inp.sign.msgUtf8), signPriv);
  if (!verify(sig, utf8(inp.sign.msgUtf8), signPub)) throw new Error('vector: sign/verify failed');

  // X3DH responder side — fully deterministic given fixed keys + header.
  const bobId = xkp(inp.x3dh.bobIdentityPriv);
  const bobSpk = xkp(inp.x3dh.bobSpkPriv);
  const bobOtk = xkp(inp.x3dh.bobOtkPriv);
  const aliceId = xkp(inp.x3dh.aliceIdentityPriv);
  const aliceEph = xkp(inp.x3dh.aliceEphPriv);
  const header = { identityKey: aliceId.pub, ephemeralKey: aliceEph.pub, oneTimePreKeyId: 1 };
  const skWithOtk = x3dhResponder(bobId, bobSpk, bobOtk, header);
  const skNoOtk = x3dhResponder(bobId, bobSpk, null, header);

  // Same-chain ratchet vectors (header.dh === state.DHr → no DH step → no
  // randomness). State JSON is handcrafted in serializeState key order so the
  // round-trip below also pins the exact serialization format.
  const a = xkp(inp.ratchet.aPriv);
  const b = xkp(inp.ratchet.bPriv);
  const senderJson = JSON.stringify({
    DHs: { priv: hex(a.priv), pub: hex(a.pub) },
    DHr: hex(b.pub), RK: inp.ratchet.rk, CKs: inp.ratchet.cks, CKr: null,
    Ns: 0, Nr: 0, PN: 0, skipped: {},
  });
  if (serializeState(deserializeState(senderJson)) !== senderJson) {
    throw new Error('vector: serializeState round-trip is no longer byte-identical');
  }

  const sState = deserializeState(senderJson);
  const envelopes: string[] = [];
  for (const p of inp.ratchet.plaintexts) envelopes.push(encodeEnvelope(ratchetEncrypt(sState, utf8(p))));
  const senderStateAfterJson = serializeState(sState);

  const recvJson = JSON.stringify({
    DHs: { priv: hex(b.priv), pub: hex(b.pub) },
    DHr: hex(a.pub), RK: inp.ratchet.rk, CKs: null, CKr: inp.ratchet.cks,
    Ns: 0, Nr: 0, PN: 0, skipped: {},
  });

  // In-order decrypt of message 0.
  const r1 = deserializeState(recvJson);
  const p0 = fromUtf8(ratchetDecrypt(r1, decodeEnvelope(envelopes[0])));
  const recvInOrder = { plaintext: p0, stateJson: serializeState(r1) };

  // Out-of-order: message 2 first (caches skipped keys n=0,1 in insertion
  // order), then message 0 served from the cache.
  const r2 = deserializeState(recvJson);
  const plaintext2 = fromUtf8(ratchetDecrypt(r2, decodeEnvelope(envelopes[2])));
  const stateJsonAfterSkip = serializeState(r2);
  const thenPlaintext0 = fromUtf8(ratchetDecrypt(r2, decodeEnvelope(envelopes[0])));
  const recvOutOfOrder = {
    plaintext2, stateJsonAfterSkip, thenPlaintext0, stateJsonAfterCacheHit: serializeState(r2),
  };

  return {
    kdfRk: { rk: hex(rkOut.slice(0, 32)), ck: hex(rkOut.slice(32, 64)) },
    kdfCk: { mk: hex(mk), ck: hex(nck) },
    msgKey: { key: hex(mkm.slice(0, 32)), nonce: hex(mkm.slice(32, 44)) },
    sign: { pub: hex(signPub), signature: hex(sig) },
    x3dh: {
      header: { identityKey: hex(aliceId.pub), ephemeralKey: hex(aliceEph.pub) },
      bundlePubs: { identityKey: hex(bobId.pub), signedPreKey: hex(bobSpk.pub), oneTimePreKey: hex(bobOtk.pub) },
      skWithOtk: hex(skWithOtk), skNoOtk: hex(skNoOtk),
    },
    ratchet: {
      senderStateJson: senderJson, envelopes, senderStateAfterJson,
      recvStateJson: recvJson, recvInOrder, recvOutOfOrder,
    },
  };
}

function computeSenderKey(inp: SenderKeyInputs) {
  const own0: OwnSenderKey = {
    chainKeyHex: inp.chainKey, iteration: 0,
    signPrivHex: inp.signPriv, signPubHex: hex(ed25519.getPublicKey(hexToBytes(inp.signPriv))),
  };
  const distribution = distributionMessage(own0);

  let own = own0;
  const ciphers: GroupCipher[] = [];
  for (const p of inp.plaintexts) {
    const r = groupEncrypt(own, p);
    ciphers.push(r.cipher);
    own = r.next;
  }

  // In-order decrypt of message 0 from a fresh peer record.
  const d0 = groupDecrypt(processDistribution(distribution), ciphers[0]);

  // Out-of-order: message 2 first (caches iterations 0,1), then 0 from cache.
  const d2 = groupDecrypt(processDistribution(distribution), ciphers[2]);
  const d0b = groupDecrypt(d2.next, ciphers[0]);

  return {
    own0, distribution, ciphers, ownAfter: own,
    decInOrder: { plaintext: d0.plaintext, next: d0.next },
    decOutOfOrder: {
      plaintext2: d2.plaintext, next: d2.next,
      thenPlaintext0: d0b.plaintext, nextAfterCacheHit: d0b.next,
    },
  };
}

function computeShamir(inp: ShamirInputs) {
  return {
    threshold: shareThreshold(inp.shares[0]),
    combinedAll: hex(combineShares(inp.shares)),
    combinedFirstK: hex(combineShares(inp.shares.slice(0, inp.k))),
    combinedLastK: hex(combineShares(inp.shares.slice(-inp.k))),
  };
}

// ── write mode: derive fixed inputs, freeze inputs+expected to JSON ────

function buildInputs(): { e2ee: E2eeInputs; senderKey: SenderKeyInputs; shamir: ShamirInputs } {
  const f = (l: string) => hex(fixed(l));
  const secret = fixed('vc-vec/shamir/secret');
  const n = 5, k = 3;
  const shares = splitSecret(secret, { n, k }); // random ONCE at write time; frozen in JSON
  if (hex(combineShares(shares)) !== hex(secret)) throw new Error('vector: shamir self-check failed');
  return {
    e2ee: {
      kdfRk: { rk: f('vc-vec/kdfRk/rk'), dhOut: f('vc-vec/kdfRk/dhOut') },
      kdfCk: { ck: f('vc-vec/kdfCk/ck') },
      msgKey: { mk: f('vc-vec/msgKey/mk') },
      sign: { priv: f('vc-vec/sign/priv'), msgUtf8: 'VaultChat golden vector — sign me' },
      x3dh: {
        bobIdentityPriv: f('vc-vec/x3dh/bobId'), bobSpkPriv: f('vc-vec/x3dh/bobSpk'),
        bobOtkPriv: f('vc-vec/x3dh/bobOtk'), aliceIdentityPriv: f('vc-vec/x3dh/aliceId'),
        aliceEphPriv: f('vc-vec/x3dh/aliceEph'),
      },
      ratchet: {
        aPriv: f('vc-vec/ratchet/aPriv'), bPriv: f('vc-vec/ratchet/bPriv'),
        rk: f('vc-vec/ratchet/rk'), cks: f('vc-vec/ratchet/cks'),
        plaintexts: ['first vector message', 'second — with unicode ✓ émoji 🙂', 'third message, decrypted out of order'],
      },
    },
    senderKey: {
      chainKey: f('vc-vec/senderKey/chain'), signPriv: f('vc-vec/senderKey/sign'),
      plaintexts: ['group msg 0', 'group msg 1 — unicode ✓ 🙂', 'group msg 2 (out of order)'],
    },
    shamir: { secretHex: hex(secret), n, k, shares },
  };
}

// ── main ───────────────────────────────────────────────────────────────

const COMPUTE = { e2ee: computeE2ee, senderKey: computeSenderKey, shamir: computeShamir } as const;
type Name = keyof typeof COMPUTE;
const FILES = Object.keys(COMPUTE) as Name[];

if (process.argv.includes('--write')) {
  const inputs = buildInputs();
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of FILES) {
    const doc = { inputs: inputs[name], expected: (COMPUTE[name] as (i: unknown) => unknown)(inputs[name]) };
    fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(doc, null, 2) + '\n');
    console.log(`wrote __vectors__/${name}.json`);
  }
} else {
  console.log('golden-vector check\n');
  let ok = true;
  for (const name of FILES) {
    const file = path.join(DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
      console.error(`  ✗ ${name}: missing ${file} — run: npx tsx services/crypto/vectors.selftest.ts --write`);
      ok = false;
      continue;
    }
    const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
    try {
      deepStrictEqual((COMPUTE[name] as (i: unknown) => unknown)(committed.inputs), committed.expected);
      console.log(`  ✓ ${name}: TS reproduces committed vectors exactly`);
    } catch (e) {
      console.error(`  ✗ ${name}: DRIFT from committed golden vectors\n${(e as Error).message}`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
  console.log('\nALL GOLDEN VECTORS REPRODUCED ✓');
}
