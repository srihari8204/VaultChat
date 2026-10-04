// lib/vaultCipherSpeed.ts — how fast this build seals vault files.
//
// Times the chunk cipher this build uses for v4 vault files (lib/vaultCrypto
// chunkCipher: native AES-256-GCM, or @noble's JS one) on 1 MiB chunks held in
// memory, so disk speed is not part of the number. Only the cipher calls are
// timed; the UI gets a turn between chunks, as in a real seal. Used by the
// "Test encryption speed" row in app/vault-features.tsx (the only way to read
// a phone's number) and by scripts/bench/vault-cipher.ts on Node. Nothing is
// written anywhere.

import { randomBytes } from '@noble/hashes/utils.js';
import { chunkCipher, V3_CHUNK, V3_HEADER_BYTES, VaultCancelledError, type ChunkCipher } from './vaultCrypto';

export interface SealSpeed {
  cipher: ChunkCipher['name'];
  bytes: number;
  ms: number;
  /** Megabytes (10^6 bytes) per second; Infinity when the run took under 1 ms. */
  mbPerSec: number;
}

/** MB/s for `ms` milliseconds spent on `bytes` bytes. */
export function mbPerSec(bytes: number, ms: number): number {
  return ms > 0 ? bytes / 1e6 / (ms / 1000) : Infinity;
}

/** "312 MB/s", "4.8 MB/s", "0.62 MB/s". */
export function formatMbPerSec(v: number): string {
  if (!Number.isFinite(v)) return 'over 1,000 MB/s';
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)} MB/s`;
}

/**
 * Seal `mib` MiB of random bytes in 1 MiB chunks with `cipher` (default: the
 * one this build uses) and time the cipher. `cancelled` is checked before each
 * chunk; a cancel throws VaultCancelledError.
 */
export async function measureSealSpeed(
  mib: number, opts: { cipher?: ChunkCipher; cancelled?: () => boolean; now?: () => number } = {},
): Promise<SealSpeed> {
  const cipher = opts.cipher ?? chunkCipher();
  const now = opts.now ?? (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));
  const chunks = Math.max(1, Math.round(mib));
  // One chunk, reused: what is measured is the cipher, not the RNG (which
  // hands out at most 64 KiB per call, so that block is repeated).
  const pt = new Uint8Array(V3_CHUNK);
  const block = randomBytes(1 << 16);
  for (let o = 0; o < V3_CHUNK; o += block.length) pt.set(block, o);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const aad = randomBytes(V3_HEADER_BYTES + 32);   // a v4 header ‖ file id
  let ms = 0;
  for (let i = 0; i < chunks; i++) {
    if (opts.cancelled?.()) throw new VaultCancelledError();
    iv[11] = i;   // a fresh IV per chunk, as a real seal uses
    const t0 = now();
    const ct = cipher.seal(key, iv, aad, pt);
    ms += now() - t0;
    if (ct.length !== V3_CHUNK + 16) throw new Error('The cipher returned the wrong length.');
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  const bytes = chunks * V3_CHUNK;
  return { cipher: cipher.name, bytes, ms, mbPerSec: mbPerSec(bytes, ms) };
}
