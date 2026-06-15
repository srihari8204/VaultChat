// services/security/safetyNumber.ts — verifiable contact safety number (#101).
//
// A deterministic numeric fingerprint of two parties' public identity keys, so
// users can compare it out-of-band (read it aloud / scan a QR) and detect a
// man-in-the-middle. Same construction as Signal's numeric fingerprint
// (iterated SHA-512 over version‖identityKey‖stableId), with the two 30-digit
// halves sorted before concatenation so BOTH sides compute the identical
// 60-digit number regardless of who is "local".
//
// PURE (no RN imports) → runs in Node (proven in safetyNumber.selftest.ts) and
// in Hermes. Identity keys are the public packed blobs fetched from the backend
// (GET /user/:id/identity); nothing secret is involved.

import { sha512 } from '@noble/hashes/sha2.js';

const TE = new TextEncoder();
const ITERATIONS = 5200;          // Signal's iteration count
const VERSION = 0;

const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

function concat(...arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// Iterated hash → first 30 bytes, per party.
function fingerprintBytes(stableId: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let hash = concat(new Uint8Array([(VERSION >> 8) & 0xff, VERSION & 0xff]), publicKey, stableId);
  for (let i = 0; i < ITERATIONS; i++) hash = sha512(concat(hash, publicKey));
  return hash.slice(0, 30);
}

// 5 bytes (40-bit big-endian) → 5 decimal digits. Multiplication avoids the
// 32-bit overflow of JS bitwise ops (value < 2^40 < 2^53, so it's exact).
function chunk5(b: Uint8Array, off: number): string {
  const n = b[off] * 4294967296 + b[off + 1] * 16777216 + b[off + 2] * 65536 + b[off + 3] * 256 + b[off + 4];
  return String(n % 100000).padStart(5, '0');
}

function displayHalf(fp30: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 30; i += 5) out += chunk5(fp30, i);   // 6 chunks → 30 digits
  return out;
}

/**
 * The 60-digit safety number for a pair of users. `idA`/`idB` are the stable
 * identifiers (user UUIDs); `keyA`/`keyB` are their public identity keys (the
 * packed base64 blobs from the keybundle). Symmetric: swapping (A,B) yields the
 * same number.
 */
export function computeSafetyNumber(idA: string, keyA: string, idB: string, keyB: string): string {
  const ha = displayHalf(fingerprintBytes(TE.encode(idA), fromB64(keyA)));
  const hb = displayHalf(fingerprintBytes(TE.encode(idB), fromB64(keyB)));
  return ha <= hb ? ha + hb : hb + ha;   // sort → identical on both devices
}

/** Group the 60-digit number into 12 blocks of 5 for display. */
export function formatSafetyNumber(num: string): string {
  return (num.match(/.{1,5}/g) || []).join(' ');
}
