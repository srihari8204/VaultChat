// lib/transferManager.ts — Transfer Manager with Resume Support
// Tracks active/paused/failed transfers
// Enables resume from last successful chunk
// Persists state in AsyncStorage

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

const TRANSFERS_KEY = 'vc_transfer_state';

export interface TransferState {
  id: string;
  chatId: string;
  fileName: string;
  fileSize: number;
  fileUri?: string;
  direction: 'send' | 'receive';
  status: 'active' | 'paused' | 'completed' | 'failed';
  totalChunks: number;
  completedChunks: number;
  progress: number;
  peerUid: string;
  peerName: string;
  startedAt: number;
  lastActiveAt: number;
  error?: string;
  sha256?: string;            // expected hash (from the sender)
  verified?: boolean;         // true once the received bytes hash-match
}

/** SHA-256 (hex) of base64-encoded bytes — the on-wire representation VaultBeam
 *  streams. Hashing the same encoding on both ends detects any corruption. */
export function sha256OfBase64(base64: string): string {
  return bytesToHex(sha256(new Uint8Array(Buffer.from(base64, 'base64'))));
}

/** SHA-256 (hex) of a local file's bytes. */
export async function computeFileSha256(fileUri: string): Promise<string> {
  const b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: 'base64' as any });
  return sha256OfBase64(b64);
}

// Get all transfers
export async function getTransfers(): Promise<TransferState[]> {
  try {
    const raw = await AsyncStorage.getItem(TRANSFERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Save transfer state
export async function saveTransfer(transfer: TransferState): Promise<void> {
  const all = await getTransfers();
  const idx = all.findIndex(t => t.id === transfer.id);
  if (idx >= 0) all[idx] = transfer;
  else all.unshift(transfer);
  await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all.slice(0, 100)));
}

// Update transfer progress
export async function updateProgress(id: string, completedChunks: number, totalChunks: number): Promise<void> {
  const all = await getTransfers();
  const t = all.find(t => t.id === id);
  if (t) {
    t.completedChunks = completedChunks;
    t.progress = completedChunks / totalChunks;
    t.lastActiveAt = Date.now();
    await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all));
  }
}

// Pause transfer
export async function pauseTransfer(id: string): Promise<void> {
  const all = await getTransfers();
  const t = all.find(t => t.id === id);
  if (t) {
    t.status = 'paused';
    t.lastActiveAt = Date.now();
    await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all));
  }
}

// Resume transfer — returns the chunk to start from
export async function resumeTransfer(id: string): Promise<number> {
  const all = await getTransfers();
  const t = all.find(t => t.id === id);
  if (t) {
    t.status = 'active';
    t.lastActiveAt = Date.now();
    await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all));
    return t.completedChunks; // Resume from this chunk
  }
  return 0;
}

// Mark transfer complete. Pass `verified` (from a SHA-256 compare) when known so
// the dashboard can show an integrity badge.
export async function completeTransfer(id: string, verified?: boolean): Promise<void> {
  const all = await getTransfers();
  const t = all.find(t => t.id === id);
  if (t) {
    t.status = 'completed';
    t.progress = 1;
    t.completedChunks = t.totalChunks;
    t.lastActiveAt = Date.now();
    if (verified !== undefined) t.verified = verified;
    await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all));
  }
}

// Mark transfer failed
export async function failTransfer(id: string, error: string): Promise<void> {
  const all = await getTransfers();
  const t = all.find(t => t.id === id);
  if (t) {
    t.status = 'failed';
    t.error = error;
    t.lastActiveAt = Date.now();
    await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all));
  }
}

// Get resumable (paused/failed) transfers
export async function getResumableTransfers(): Promise<TransferState[]> {
  const all = await getTransfers();
  return all.filter(t => t.status === 'paused' || t.status === 'failed');
}

// Clean old completed transfers (keep last 50)
export async function cleanOldTransfers(): Promise<void> {
  const all = await getTransfers();
  const cleaned = all.filter(t => t.status !== 'completed' || Date.now() - t.lastActiveAt < 7 * 86400000).slice(0, 50);
  await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(cleaned));
}

// SHA-256 hash verification for a completed transfer: recompute the hash of the
// received file on disk and compare it to the sender's expected hash. Persists
// the result on the transfer record. Returns false on mismatch / missing file.
export async function verifyTransferHash(transferId: string, expectedHash: string): Promise<boolean> {
  const all = await getTransfers();
  const t = all.find(x => x.id === transferId);
  if (!t || !t.fileUri || !expectedHash) return false;
  let ok = false;
  try {
    const actual = await computeFileSha256(t.fileUri);
    ok = actual.toLowerCase() === expectedHash.toLowerCase();
  } catch { ok = false; }
  t.sha256 = expectedHash;
  t.verified = ok;
  await AsyncStorage.setItem(TRANSFERS_KEY, JSON.stringify(all));
  return ok;
}

// Get transfer stats for dashboard
export async function getTransferStats(): Promise<{
  active: number; queued: number; completed: number; failed: number;
  totalSent: number; totalReceived: number;
}> {
  const all = await getTransfers();
  return {
    active: all.filter(t => t.status === 'active').length,
    queued: all.filter(t => t.status === 'paused').length,
    completed: all.filter(t => t.status === 'completed').length,
    failed: all.filter(t => t.status === 'failed').length,
    totalSent: all.filter(t => t.direction === 'send' && t.status === 'completed').reduce((a, t) => a + t.fileSize, 0),
    totalReceived: all.filter(t => t.direction === 'receive' && t.status === 'completed').reduce((a, t) => a + t.fileSize, 0),
  };
}
