// lib/vaultBeamRecvBitmap.ts — persistent recipient block bitmap.
//
// The relay-receive engine writes each verified+decrypted block into the
// preallocated destination file at its offset. Without a record of WHICH blocks
// it already wrote, a dropped download restarts from block 0 (the in-memory `got`
// set resets each call). This stores a compact bitmask per transferId so a resume
// seeds `got` and skips blocks already on disk. prealloc() never truncates (it
// opens without O_TRUNC and set_len()s to the full size), so previously-written
// regions survive a restart — this bitmap is the only missing piece.
//
// Compact base64 bitmask (1 bit/block): 12 GB / 512 KiB ≈ 24 576 blocks ⇒ ~3 KB.

import AsyncStorage from '@react-native-async-storage/async-storage';

const keyFor = (transferId: string) => `vc_vb_recv_${transferId}`;

function encode(got: Set<number>): string {
  if (got.size === 0) return '';
  let max = 0;
  for (const b of got) if (b > max) max = b;
  const bytes = new Uint8Array((max >> 3) + 1);
  for (const b of got) bytes[b >> 3] |= 1 << (b & 7);
  // base64 without Buffer dependency assumptions (Buffer is available in RN, but
  // keep it self-contained and small).
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa ? globalThis.btoa(bin) : Buffer.from(bytes).toString('base64');
}

function decode(b64: string): Set<number> {
  const out = new Set<number>();
  if (!b64) return out;
  try {
    const bin = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    for (let i = 0; i < bin.length; i++) {
      const byte = bin.charCodeAt(i);
      if (!byte) continue;
      for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out.add((i << 3) + bit);
    }
  } catch {}
  return out;
}

export async function loadRecvBitmap(transferId: string): Promise<Set<number>> {
  try { return decode((await AsyncStorage.getItem(keyFor(transferId))) ?? ''); } catch { return new Set(); }
}

// Throttled writer: coalesces frequent per-block saves so AsyncStorage isn't
// hammered during a fast download.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function saveRecvBitmapSoon(transferId: string, got: Set<number>, delayMs = 1500): void {
  if (timers.has(transferId)) return;
  timers.set(transferId, setTimeout(() => {
    timers.delete(transferId);
    AsyncStorage.setItem(keyFor(transferId), encode(got)).catch(() => {});
  }, delayMs));
}

export async function clearRecvBitmap(transferId: string): Promise<void> {
  const t = timers.get(transferId); if (t) { clearTimeout(t); timers.delete(transferId); }
  try { await AsyncStorage.removeItem(keyFor(transferId)); } catch {}
}

export default { loadRecvBitmap, saveRecvBitmapSoon, clearRecvBitmap };
