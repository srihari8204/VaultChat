/**
 * VaultChat E2EE core — REAL X3DH key agreement + Double Ratchet.
 * ───────────────────────────────────────────────────────────────────────
 * This is the genuine cryptographic replacement for the fake skeleton in
 * services/doubleRatchetService.ts (whose `dhExchange` was HMAC, not DH).
 *
 * Built entirely on audited pure-JS primitives (@noble/curves, @noble/hashes,
 * @noble/ciphers) so the EXACT same code runs in Node (where it is unit-tested
 * — see e2ee.selftest.ts) and in Hermes/React Native. No native module, no
 * Node/RN crypto divergence.
 *
 * Algorithms (Signal-compatible shapes):
 *   • X3DH       — IK/SPK/OPK key agreement to bootstrap a shared secret (SK).
 *   • Double Ratchet — per-message keys via DH-ratchet + symmetric chains,
 *                      giving forward secrecy + break-in recovery, with a
 *                      skipped-key cache for out-of-order delivery.
 *
 * Key model:
 *   • Identity key (IK)  — X25519 keypair, used for the X3DH DH steps.
 *   • Signing key        — Ed25519 keypair, used ONLY to sign the signed
 *                          prekey so peers can authenticate the bundle.
 *   • Signed prekey (SPK)— X25519 keypair, rotated periodically.
 *   • One-time prekey    — X25519 keypair, consumed once (optional).
 *
 * ⚠️ NOT YET WIRED into lib/chatService.ts. This module is self-contained and
 * proven in isolation; wiring (session bootstrap, SecureStore persistence,
 * offline-queue + search migration, group sender-keys) is the next step.
 * See services/crypto/README_E2EE.md for the integration plan.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

// ── small helpers ──────────────────────────────────────────────────────
const TE = new TextEncoder();
const TD = new TextDecoder();
export const utf8 = (s: string): Uint8Array => TE.encode(s);
export const fromUtf8 = (b: Uint8Array): string => TD.decode(b);
export { bytesToHex, hexToBytes, randomBytes };

// base64 for wire envelopes (Buffer exists in Node and the RN runtime polyfill)
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

function concat(...arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── primitives ─────────────────────────────────────────────────────────
export interface KeyPair { priv: Uint8Array; pub: Uint8Array; }

export function generateDH(): KeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}
function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, pub);
}
export function generateSigningKey(): KeyPair {
  const priv = ed25519.utils.randomSecretKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
}
export function sign(msg: Uint8Array, signingPriv: Uint8Array): Uint8Array {
  return ed25519.sign(msg, signingPriv);
}
export function verify(sig: Uint8Array, msg: Uint8Array, signingPub: Uint8Array): boolean {
  return ed25519.verify(sig, msg, signingPub);
}

const INFO_RK = utf8('VaultChat-RootKDF-v1');
const INFO_X3DH = utf8('VaultChat-X3DH-v1');
const INFO_MSG = utf8('VaultChat-MsgKey-v1');
const ZERO32 = new Uint8Array(32);

// Root KDF: (RK', CK) = HKDF(ikm = DH output, salt = RK).
function kdfRk(rk: Uint8Array, dhOut: Uint8Array): { rk: Uint8Array; ck: Uint8Array } {
  const out = hkdf(sha256, dhOut, rk, INFO_RK, 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}
// Chain KDF: mk = HMAC(CK, 0x01); CK' = HMAC(CK, 0x02).
function kdfCk(ck: Uint8Array): { ck: Uint8Array; mk: Uint8Array } {
  const mk = hmac(sha256, ck, Uint8Array.of(0x01));
  const nck = hmac(sha256, ck, Uint8Array.of(0x02));
  return { ck: nck, mk };
}
// Derive AEAD key (32) + nonce (12) from a single-use message key.
function msgKeyMaterial(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const out = hkdf(sha256, mk, ZERO32, INFO_MSG, 44);
  return { key: out.slice(0, 32), nonce: out.slice(32, 44) };
}
function aeadSeal(mk: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
  const { key, nonce } = msgKeyMaterial(mk);
  return gcm(key, nonce, ad).encrypt(plaintext);
}
function aeadOpen(mk: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Uint8Array {
  const { key, nonce } = msgKeyMaterial(mk);
  return gcm(key, nonce, ad).decrypt(ciphertext); // throws on auth failure
}

// ── X3DH ───────────────────────────────────────────────────────────────
export interface PreKeyBundle {
  identityKey: Uint8Array;      // X25519 pub (DH)
  signingKey: Uint8Array;       // Ed25519 pub (verifies the SPK signature)
  signedPreKey: Uint8Array;     // X25519 pub
  signedPreKeySig: Uint8Array;  // Ed25519 signature over signedPreKey
  oneTimePreKey?: Uint8Array | null; // X25519 pub (optional, single use)
  oneTimePreKeyId?: number | null;
}
export interface InitialHeader {
  identityKey: Uint8Array;      // initiator's X25519 identity pub
  ephemeralKey: Uint8Array;     // initiator's X25519 ephemeral pub
  oneTimePreKeyId?: number | null;
}

/** Initiator (Alice): verify the bundle, derive SK, return the header Bob needs. */
export function x3dhInitiator(
  myIdentity: KeyPair,
  bundle: PreKeyBundle,
): { sk: Uint8Array; ephemeral: KeyPair; header: InitialHeader } {
  if (!verify(bundle.signedPreKeySig, bundle.signedPreKey, bundle.signingKey)) {
    throw new Error('X3DH: signed-prekey signature failed verification');
  }
  const ek = generateDH();
  const parts = [
    dh(myIdentity.priv, bundle.signedPreKey), // DH1: IK_a · SPK_b
    dh(ek.priv, bundle.identityKey),          // DH2: EK_a · IK_b
    dh(ek.priv, bundle.signedPreKey),         // DH3: EK_a · SPK_b
  ];
  if (bundle.oneTimePreKey) parts.push(dh(ek.priv, bundle.oneTimePreKey)); // DH4: EK_a · OPK_b
  const sk = hkdf(sha256, concat(...parts), ZERO32, INFO_X3DH, 32);
  return {
    sk,
    ephemeral: ek,
    header: {
      identityKey: myIdentity.pub,
      ephemeralKey: ek.pub,
      oneTimePreKeyId: bundle.oneTimePreKeyId ?? null,
    },
  };
}

/** Responder (Bob): derive the same SK from Alice's header + Bob's private keys. */
export function x3dhResponder(
  myIdentity: KeyPair,
  mySignedPreKey: KeyPair,
  myOneTimePreKey: KeyPair | null,
  header: InitialHeader,
): Uint8Array {
  const parts = [
    dh(mySignedPreKey.priv, header.identityKey),  // DH1
    dh(myIdentity.priv, header.ephemeralKey),     // DH2
    dh(mySignedPreKey.priv, header.ephemeralKey), // DH3
  ];
  if (myOneTimePreKey) parts.push(dh(myOneTimePreKey.priv, header.ephemeralKey)); // DH4
  return hkdf(sha256, concat(...parts), ZERO32, INFO_X3DH, 32);
}

// ── Double Ratchet ─────────────────────────────────────────────────────
export interface RatchetState {
  DHs: KeyPair;                       // our current ratchet keypair
  DHr: Uint8Array | null;             // their current ratchet public key
  RK: Uint8Array;                     // root key
  CKs: Uint8Array | null;             // sending chain key
  CKr: Uint8Array | null;             // receiving chain key
  Ns: number;                         // messages sent in current sending chain
  Nr: number;                         // messages received in current recv chain
  PN: number;                         // length of previous sending chain
  MKSKIPPED: Map<string, Uint8Array>; // "{dhrHex}:{n}" -> message key
}
export interface RatchetHeader { dh: Uint8Array; pn: number; n: number; }
export interface Envelope { header: RatchetHeader; ciphertext: Uint8Array; }

const MAX_SKIP = 1000;

/** Alice initialises from the X3DH SK + Bob's signed-prekey public (his initial ratchet key). */
export function ratchetInitAlice(sk: Uint8Array, bobSignedPreKeyPub: Uint8Array): RatchetState {
  const DHs = generateDH();
  const { rk, ck } = kdfRk(sk, dh(DHs.priv, bobSignedPreKeyPub));
  return { DHs, DHr: bobSignedPreKeyPub, RK: rk, CKs: ck, CKr: null, Ns: 0, Nr: 0, PN: 0, MKSKIPPED: new Map() };
}
/** Bob initialises from the X3DH SK + his own signed-prekey keypair (his initial ratchet key). */
export function ratchetInitBob(sk: Uint8Array, bobSignedPreKey: KeyPair): RatchetState {
  return { DHs: bobSignedPreKey, DHr: null, RK: sk, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, MKSKIPPED: new Map() };
}

function headerAd(h: RatchetHeader): Uint8Array {
  return utf8(`${bytesToHex(h.dh)}|${h.pn}|${h.n}`);
}

export function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array): Envelope {
  if (state.CKs === null) {
    throw new Error('ratchet: no sending chain yet (responder must receive a message first)');
  }
  const { ck, mk } = kdfCk(state.CKs);
  state.CKs = ck;
  const header: RatchetHeader = { dh: state.DHs.pub, pn: state.PN, n: state.Ns };
  state.Ns += 1;
  const ciphertext = aeadSeal(mk, plaintext, headerAd(header));
  return { header, ciphertext };
}

function skipMessageKeys(state: RatchetState, until: number): void {
  if (state.CKr === null) {
    if (until > 0) throw new Error('ratchet: cannot skip messages without a receiving chain');
    return;
  }
  if (until - state.Nr > MAX_SKIP) throw new Error('ratchet: too many skipped messages');
  while (state.Nr < until) {
    const { ck, mk } = kdfCk(state.CKr);
    state.CKr = ck;
    state.MKSKIPPED.set(`${bytesToHex(state.DHr as Uint8Array)}:${state.Nr}`, mk);
    state.Nr += 1;
  }
}
function dhRatchet(state: RatchetState, header: RatchetHeader): void {
  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = header.dh;
  const recv = kdfRk(state.RK, dh(state.DHs.priv, state.DHr));
  state.RK = recv.rk;
  state.CKr = recv.ck;
  state.DHs = generateDH();
  const send = kdfRk(state.RK, dh(state.DHs.priv, state.DHr));
  state.RK = send.rk;
  state.CKs = send.ck;
}

export function ratchetDecrypt(state: RatchetState, env: Envelope): Uint8Array {
  const { header, ciphertext } = env;
  const skKey = `${bytesToHex(header.dh)}:${header.n}`;
  const cached = state.MKSKIPPED.get(skKey);
  if (cached) {
    state.MKSKIPPED.delete(skKey);
    return aeadOpen(cached, ciphertext, headerAd(header));
  }
  const isNewRatchet = state.DHr === null || !ctEqual(header.dh, state.DHr);
  if (isNewRatchet) {
    if (state.DHr !== null) skipMessageKeys(state, header.pn);
    dhRatchet(state, header);
  }
  skipMessageKeys(state, header.n);
  const { ck, mk } = kdfCk(state.CKr as Uint8Array);
  state.CKr = ck;
  state.Nr += 1;
  return aeadOpen(mk, ciphertext, headerAd(header));
}

// ── serialization (SecureStore-friendly hex for state; base64 for wire) ──
export function serializeState(s: RatchetState): string {
  const skipped: Record<string, string> = {};
  for (const [k, v] of s.MKSKIPPED) skipped[k] = bytesToHex(v);
  return JSON.stringify({
    DHs: { priv: bytesToHex(s.DHs.priv), pub: bytesToHex(s.DHs.pub) },
    DHr: s.DHr ? bytesToHex(s.DHr) : null,
    RK: bytesToHex(s.RK),
    CKs: s.CKs ? bytesToHex(s.CKs) : null,
    CKr: s.CKr ? bytesToHex(s.CKr) : null,
    Ns: s.Ns, Nr: s.Nr, PN: s.PN, skipped,
  });
}
export function deserializeState(json: string): RatchetState {
  const o = JSON.parse(json);
  const m = new Map<string, Uint8Array>();
  for (const k of Object.keys(o.skipped || {})) m.set(k, hexToBytes(o.skipped[k]));
  return {
    DHs: { priv: hexToBytes(o.DHs.priv), pub: hexToBytes(o.DHs.pub) },
    DHr: o.DHr ? hexToBytes(o.DHr) : null,
    RK: hexToBytes(o.RK),
    CKs: o.CKs ? hexToBytes(o.CKs) : null,
    CKr: o.CKr ? hexToBytes(o.CKr) : null,
    Ns: o.Ns, Nr: o.Nr, PN: o.PN, MKSKIPPED: m,
  };
}
export function encodeEnvelope(e: Envelope): string {
  return JSON.stringify({ dh: toB64(e.header.dh), pn: e.header.pn, n: e.header.n, ct: toB64(e.ciphertext) });
}
export function decodeEnvelope(s: string): Envelope {
  const o = JSON.parse(s);
  return { header: { dh: fromB64(o.dh), pn: o.pn, n: o.n }, ciphertext: fromB64(o.ct) };
}
