// services/crypto/shamir.ts — Shamir's Secret Sharing over GF(2^8).
//
// Splits a secret (e.g. a backup passphrase, or a 32-byte master key) into N
// shares such that any K reconstruct it exactly and any K-1 reveal NOTHING
// (information-theoretic, not just computational). Pure-JS @noble-style so it
// runs under Hermes. Byte-wise over GF(256) with the AES reduction polynomial
// 0x11b and generator 0x03 — the same field SLIP-0039 / most SSS libs use.
//
// Share wire format (human-copyable, dash-grouped, uppercase):
//   VCSS1-<k>-<group4>-<idx2>-<payloadHex>
//   - k        : threshold (decimal) — how many shares are needed, for the UI
//   - group4   : 2-byte random set id (hex) — all shares of one split match;
//                mixing shares from different splits is rejected
//   - idx2     : the share's x-coordinate (1..255, hex)
//   - payload  : hex of the per-byte evaluations (same length as the secret)
//
// Integrity: a wrong/typo'd or foreign share yields a wrong secret, which the
// caller detects when the reconstructed passphrase fails to decrypt the backup.
// The group id catches the common "mixed two different share sets" mistake up
// front.

import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

// ── GF(2^8) log/exp tables (generator 3, reduction 0x11b) ───────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // x = x * 3 in GF(2^8)
    let p = 0, a = x, b = 3;
    while (b) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    x = p;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const ginv = (a: number): number => EXP[255 - LOG[a]];

// Horner evaluation of a polynomial (coeffs[0] = constant term) at x.
function evalPoly(coeffs: Uint8Array, x: number): number {
  let r = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) r = gmul(r, x) ^ coeffs[i];
  return r;
}

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
const h2 = (n: number): string => n.toString(16).padStart(2, '0');

export interface SplitOptions { n: number; k: number }

// Split `secret` into `n` shares with threshold `k` (2 <= k <= n <= 255).
// Returns the share strings in the VCSS1 wire format.
export function splitSecret(secret: Uint8Array, { n, k }: SplitOptions): string[] {
  if (!secret || secret.length === 0) throw new Error('Secret must be non-empty');
  if (!Number.isInteger(k) || !Number.isInteger(n)) throw new Error('n and k must be integers');
  if (k < 2) throw new Error('Threshold k must be at least 2');
  if (n < k) throw new Error('Share count n must be >= threshold k');
  if (n > 255) throw new Error('At most 255 shares');

  const group = randomBytes(2);
  const groupHex = hex(group);

  // payload[shareIndex] accumulates one evaluation byte per secret byte.
  const payloads: Uint8Array[] = [];
  for (let i = 0; i < n; i++) payloads.push(new Uint8Array(secret.length));

  for (let b = 0; b < secret.length; b++) {
    const coeffs = new Uint8Array(k);
    coeffs[0] = secret[b];
    const rnd = randomBytes(k - 1);
    for (let i = 1; i < k; i++) coeffs[i] = rnd[i - 1];
    for (let si = 0; si < n; si++) {
      const xCoord = si + 1; // 1..n
      payloads[si][b] = evalPoly(coeffs, xCoord);
    }
  }

  const shares: string[] = [];
  for (let si = 0; si < n; si++) {
    const xCoord = si + 1;
    shares.push(`VCSS1-${k}-${groupHex}-${h2(xCoord)}-${hex(payloads[si])}`.toUpperCase());
  }
  return shares;
}

interface ParsedShare { k: number; group: string; x: number; payload: Uint8Array }

function parseShare(raw: string): ParsedShare {
  const s = raw.trim().toUpperCase();
  const parts = s.split('-');
  if (parts.length !== 5 || parts[0] !== 'VCSS1') throw new Error('Not a crazzychat recovery share');
  const k = parseInt(parts[1], 10);
  const group = parts[2].toLowerCase();
  const x = parseInt(parts[3], 16);
  const payload = fromHex(parts[4].toLowerCase());
  if (!Number.isInteger(k) || k < 2) throw new Error('Bad share (threshold)');
  if (!Number.isInteger(x) || x < 1 || x > 255) throw new Error('Bad share (index)');
  if (payload.length === 0) throw new Error('Bad share (empty)');
  return { k, group, x, payload };
}

// Threshold declared by a single share — lets the UI say "need K of these".
export function shareThreshold(raw: string): number {
  return parseShare(raw).k;
}

// Reconstruct the secret from a set of shares (>= k, all from the same split).
// Lagrange interpolation at x = 0 over GF(2^8).
export function combineShares(rawShares: string[]): Uint8Array {
  const parsed = rawShares.map(parseShare);
  if (parsed.length === 0) throw new Error('No shares provided');

  const group = parsed[0].group;
  const len = parsed[0].payload.length;
  const k = parsed[0].k;
  for (const p of parsed) {
    if (p.group !== group) throw new Error('These shares are from different backups — they don’t match');
    if (p.payload.length !== len) throw new Error('Share lengths differ — one is corrupted');
  }
  // Reject duplicate x-coordinates (same share entered twice).
  const seen = new Set<number>();
  for (const p of parsed) {
    if (seen.has(p.x)) throw new Error('Duplicate share — enter different shares');
    seen.add(p.x);
  }
  if (parsed.length < k) throw new Error(`Need at least ${k} shares — you have ${parsed.length}`);

  const xs = parsed.map(p => p.x);
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < parsed.length; i++) {
      const yi = parsed[i].payload[b];
      let num = 1, den = 1;
      for (let j = 0; j < parsed.length; j++) {
        if (j === i) continue;
        num = gmul(num, xs[j]);        // (0 - xj) == xj in GF(2^8)
        den = gmul(den, xs[i] ^ xs[j]); // (xi - xj) == xi ^ xj
      }
      acc ^= gmul(yi, gmul(num, ginv(den)));
    }
    out[b] = acc;
  }
  return out;
}

// Convenience: split/combine a UTF-8 string secret (e.g. a passphrase).
export function splitString(secret: string, opts: SplitOptions): string[] {
  return splitSecret(new TextEncoder().encode(secret), opts);
}
export function combineString(rawShares: string[]): string {
  return new TextDecoder().decode(combineShares(rawShares));
}
