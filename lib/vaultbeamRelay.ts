// lib/vaultbeamRelay.ts — VaultBeam Tier-3 (R2 relay) client control plane.
//
// The relay CONTROL calls (init/presign/mark/state/complete/abort) + sizing
// constants. All chunk crypto + byte movement live in the native VaultBeamStream
// module; per-transfer key K_t rides the E2EE message manifest (vaultBeamController).
//
// Invariants: the relay only ever holds ciphertext. Canonical sizing MUST match
// routes/vaultbeam.js.

import { Buffer } from 'buffer';
import { api } from './api';

export const CHUNK_BYTES = 512 * 1024;
export const MAX_BYTES   = 12 * 1024 * 1024 * 1024;

// ── Relay control-plane API (against routes/vaultbeam.js) ───────────
export interface RelayInit { transferId: string; blockCount: number; chunkCount: number; chunkBytes: number; blockBytes: number; expiresAt: string }
export interface RelayState { transferId: string; state: string; totalBytes: number; blockCount: number; chunkCount: number; chunkBytes: number; blockBytes: number; uploadedMask: string; uploaded: number; isSender: boolean; expiresAt: string }
export interface BlockUrl { blockIndex: number; url: string }

export const relayInit = (transferId: string, recipientId: string, totalBytes: number, chatId?: string) =>
  api<RelayInit>('/vaultbeam/relay/init', { method: 'POST', json: { transferId, recipientId, totalBytes, chatId } });

export const relayBlockUrls = (transferId: string, blocks: number[], op: 'put' | 'get') =>
  api<{ op: string; ttl: number; urls: BlockUrl[] }>('/vaultbeam/relay/block-url', { method: 'POST', json: { transferId, blocks, op } });

export const relayMarkUploaded = (transferId: string, blocks: number[]) =>
  api<{ uploaded: number; blockCount: number; ready: boolean }>('/vaultbeam/relay/uploaded', { method: 'POST', json: { transferId, blocks } });

export const relayState = (transferId: string) =>
  api<RelayState>(`/vaultbeam/relay/${encodeURIComponent(transferId)}`);

export const relayComplete = (transferId: string) =>
  api<{ ok: boolean }>('/vaultbeam/relay/complete', { method: 'POST', json: { transferId } });

export const relayAbort = (transferId: string) =>
  api<{ ok: boolean }>('/vaultbeam/relay/abort', { method: 'POST', json: { transferId } });

// Server bitmask (base64 BYTEA) → block indices already on R2 (drives GET-side resume).
export function uploadedBlocks(maskB64: string, blockCount: number): number[] {
  const m = Buffer.from(maskB64, 'base64'); const out: number[] = [];
  for (let i = 0; i < blockCount; i++) if ((m[i >> 3] >> (i & 7)) & 1) out.push(i);
  return out;
}

// The byte pipeline (read@offset → encrypt → PUT; GET → decrypt → write@offset)
// lives in the native VaultBeamStream module — see lib/vaultBeamTransfer.
