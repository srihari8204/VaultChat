// services/security/vaultKeys.ts — PIN-derived vault keys + sealed-blob crypto.
//
// The shared PIN-crypto primitive behind pinStore, sessionSeal, auditChain,
// cacheCrypto, notesVaultCore and status/gateKey. PURE: no
// React-Native imports, so the EXACT same code runs in Node (proven in
// vaultKeys.selftest.ts) and in Hermes — same pattern as services/crypto/e2ee.ts.
//
// Model: a vault key is derived from a PIN with a memory-hard KDF (scrypt) over
// a per-install random salt. Each "vault" is a small blob sealed with AES-256-GCM
// under its own PIN-derived key. Which vault opens is decided ONLY by which key
// successfully authenticates the blob — so a PIN can never open a vault it
// doesn't own, and the PIN itself is never stored anywhere.

import { gcm } from '@noble/ciphers/aes.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';

const TE = new TextEncoder();
const TD = new TextDecoder();
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

// P3.2: native scrypt engine (react-native-quick-crypto → OpenSSL) when the
// app runs under Hermes with the native module present. scrypt is scrypt —
// identical output bytes for identical params — so headers sealed by either
// engine open under the other. The guarded require keeps this file Node-clean:
// in the selftests the require throws, QC stays null, and the @noble path runs
// (the "PURE" contract above is preserved — no RN import, only a soft probe).
let QC: any = null;
try { QC = require('react-native-quick-crypto'); if (typeof QC?.scryptSync !== 'function') QC = null; } catch { QC = null; }

// scrypt parameters. N=2^14 is memory-hard enough to slow brute force of a
// short PIN meaningfully while staying ~sub-300ms on low-end Android. Tunable.
export const KDF_PARAMS = { N: 1 << 14, r: 8, p: 1, dkLen: 32 } as const;
// OpenSSL enforces maxmem: 128*N*r = 16 MB for these params; give headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Derive a 32-byte vault key from a PIN + salt (memory-hard, deterministic).
 *  Native (OpenSSL) when available — ~5-10× faster than the JS loop, cutting
 *  the unlock stall on low-end devices; @noble otherwise (Node/Expo Go). */
export function deriveVaultKey(pin: string, salt: Uint8Array): Uint8Array {
  if (QC) {
    try {
      const dk = QC.scryptSync(Buffer.from(TE.encode(pin)), Buffer.from(salt), KDF_PARAMS.dkLen,
        { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: SCRYPT_MAXMEM });
      return new Uint8Array(dk.buffer ? dk : Buffer.from(dk));
    } catch { /* fall through to JS */ }
  }
  return scrypt(TE.encode(pin), salt, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, dkLen: KDF_PARAMS.dkLen,
  });
}

/** Async twin of deriveVaultKey. On the native engine the derivation runs on
 *  quick-crypto's background thread pool, so the JS thread stays free during
 *  unlock (the lock screen keeps animating). Same output bytes as the sync
 *  path — callers may mix them freely. */
export function deriveVaultKeyAsync(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  if (QC && typeof QC.scrypt === 'function') {
    return new Promise((resolve, reject) => {
      QC.scrypt(Buffer.from(TE.encode(pin)), Buffer.from(salt), KDF_PARAMS.dkLen,
        { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: SCRYPT_MAXMEM },
        (err: any, dk: any) => {
          if (err || !dk) { try { resolve(deriveVaultKey(pin, salt)); } catch (e) { reject(e); } return; }
          resolve(new Uint8Array(dk.buffer ? dk : Buffer.from(dk)));
        });
    });
  }
  return Promise.resolve(deriveVaultKey(pin, salt));
}

/** Fresh 16-byte random salt (one per install). */
export function newSalt(): Uint8Array {
  return randomBytes(16);
}

// P5: native AES-GCM engine (react-native-quick-crypto → OpenSSL) for
// seal/open, same treatment scrypt got above and for the same reason — @noble
// runs in interpreted Hermes at ~1 MB/s, and cacheCrypto routes EVERY sealed
// field through here. The family history store seals a few-hundred-KB blob per
// accepted location ping, which at pure-JS speed became seconds of JS-thread
// CPU per ping: pings arrived faster than they could be sealed and the app
// wedged at 100% CPU until the ANR dialog (device-diagnosed on the Honor,
// 2026-08-21 — async steps of 2.9–15.7s, every JS tracer silent).
//
// Byte-identical wire format — base64( nonce(12) || ct || tag(16) ), AES-256-GCM,
// no AAD — proven by a startup round-trip probe in BOTH directions against
// @noble. If the probe fails, the engine stays off and @noble handles
// everything, so a device without the native module never notices.
let _gcmProbe: boolean | null = null;
// LAZY, not module-load: quick-crypto's cipher needs crypto.getRandomValues,
// which the app's polyfills install after this module is first imported — a
// load-time probe always failed with "crypto.getRandomValues must be defined"
// and silently pinned every seal to the slow JS path (device-diagnosed).
function gcmNative(): boolean {
  if (_gcmProbe !== null) return _gcmProbe;
  _gcmProbe = (() => {
  try {
    if (!QC?.createCipheriv || !QC?.createDecipheriv) return false;
    const k = new Uint8Array(32).fill(7);
    const probe = 'vc-gcm-probe';
    // native-sealed → noble-opened
    const n1 = randomBytes(12);
    const c = QC.createCipheriv('aes-256-gcm', Buffer.from(k), Buffer.from(n1));
    const ct = Buffer.concat([c.update(Buffer.from(TE.encode(probe))), c.final(), c.getAuthTag()]);
    const nobleSide = TD.decode(gcm(k, n1).decrypt(new Uint8Array(ct)));
    if (nobleSide !== probe) return false;
    // noble-sealed → native-opened
    const n2 = randomBytes(12);
    const nct = gcm(k, n2).encrypt(TE.encode(probe));
    const body = Buffer.from(nct.slice(0, nct.length - 16));
    const tag = Buffer.from(nct.slice(nct.length - 16));
    const d = QC.createDecipheriv('aes-256-gcm', Buffer.from(k), Buffer.from(n2));
    d.setAuthTag(tag);
    const back = Buffer.concat([d.update(body), d.final()]).toString('utf8');
    return back === probe;
  } catch { return false; }
  })();
  return _gcmProbe;
}

/** Seal a string under a key → base64( nonce(12) || ciphertext+tag ). */
export function seal(key: Uint8Array, plaintext: string): string {
  const nonce = randomBytes(12);
  if (gcmNative()) {
    try {
      const c = QC.createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
      const ct = Buffer.concat([c.update(Buffer.from(TE.encode(plaintext))), c.final(), c.getAuthTag()]);
      const out = new Uint8Array(12 + ct.length);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), 12);
      return toB64(out);
    } catch { /* fall through to @noble */ }
  }
  const ct = gcm(key, nonce).encrypt(TE.encode(plaintext));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return toB64(out);
}

/**
 * Open a sealed blob. Returns the plaintext, or null if `key` is wrong — the
 * GCM auth tag fails to verify, so a non-owning key cannot decrypt it. This
 * null-on-wrong-key is exactly the property every caller relies on.
 *
 * On the native engine a decrypt throw means the auth tag refused the key —
 * the same null the @noble path reports. The startup probe already proved the
 * engine itself works, so a throw here is a verdict, not an outage; and the
 * fail direction is safe regardless (a wrong PIN is rejected, never misrouted).
 */
export function open(key: Uint8Array, envelope: string): string | null {
  try {
    const buf = fromB64(envelope);
    // 12-byte nonce + 16-byte tag is the floor; an empty plaintext is exactly 28.
    if (buf.length < 12 + 16) return null;
    const nonce = buf.slice(0, 12);
    if (gcmNative()) {
      const body = Buffer.from(buf.slice(12, buf.length - 16));
      const tag = Buffer.from(buf.slice(buf.length - 16));
      const d = QC.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    }
    const ct = buf.slice(12);
    return TD.decode(gcm(key, nonce).decrypt(ct));
  } catch {
    return null;
  }
}

// ─── PIN credential (pure) ────────────────────────────────────────────────────
//
// One representation for "is this the user's PIN?", replacing the two weaker
// ones that grew up alongside this file: an unsalted SHA-256 in authService and
// the PIN stored verbatim in securityService. Same scrypt + AES-GCM machinery as
// the vault headers above, so there is one KDF in the app, not three.
//
// A record holds a per-install salt and a sealed known constant. Verifying =
// deriving the key and trying to open it: the GCM auth tag decides, so a wrong
// PIN yields null and the PIN itself is never stored in any form. Persistence
// lives in services/security/pinStore.ts — this half stays Node-testable.

const PIN_PROOF = 'vc-pin-ok';

export interface PinRecord { v: 1; salt: string; verifier: string }

export function makePinRecord(pin: string): PinRecord {
  const salt = newSalt();
  return { v: 1, salt: toB64(salt), verifier: seal(deriveVaultKey(pin, salt), PIN_PROOF) };
}

export async function makePinRecordAsync(pin: string): Promise<PinRecord> {
  const salt = newSalt();
  const key = await deriveVaultKeyAsync(pin, salt);
  return { v: 1, salt: toB64(salt), verifier: seal(key, PIN_PROOF) };
}

export function checkPinRecord(rec: PinRecord | null | undefined, pin: string): boolean {
  if (!rec || rec.v !== 1 || !rec.salt || !rec.verifier) return false;
  return open(deriveVaultKey(pin, fromB64(rec.salt)), rec.verifier) === PIN_PROOF;
}

/** Async twin — keeps the lock screen responsive during the scrypt derivation. */
export async function checkPinRecordAsync(rec: PinRecord | null | undefined, pin: string): Promise<boolean> {
  if (!rec || rec.v !== 1 || !rec.salt || !rec.verifier) return false;
  const key = await deriveVaultKeyAsync(pin, fromB64(rec.salt));
  return open(key, rec.verifier) === PIN_PROOF;
}
