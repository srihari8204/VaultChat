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
export interface RelayInit { transferId: string; blockCount: number; chunkCount: number; chunkBytes: number; blockBytes: number; expiresAt: string; sessionVersion?: number }
export interface RelayState {
  transferId: string; state: string; totalBytes: number; blockCount: number; chunkCount: number;
  chunkBytes: number; blockBytes: number; plan?: string | null; uploadedMask: string; uploaded: number;
  isSender: boolean; expiresAt: string;
  /** Receiver's verified-chunk bitmap (base64) — how a SENDER learns what the
   *  peer already holds, so it never stages a delivered chunk again. */
  recvMask?: string; received?: number;
  /** Monotonic server-held version; a mismatch on any mutating call is a 409. */
  sessionVersion?: number;
}
export interface BlockUrl { blockIndex: number; url: string }

// ── session version ─────────────────────────────────────────────────
// The server bumps session_version on a MATERIAL RESET (a re-init of the same
// transfer_id), and every mutating route 409s a request that carries the old
// one. That gate is only worth anything if the client actually sends a version,
// and grow/uploaded never did — so the pre-reset sender kept writing bits into
// the new file's layout, which is precisely what migration 076 exists to stop.
//
// Cached here rather than threaded through vaultBeamTransfer: every mutating
// call is already funnelled through this module, and both roles call relayInit
// or relayState before they mutate anything, so the cache is populated by the
// time it matters. Unknown ⇒ send nothing, which the server treats as a
// pre-vbm3 client rather than a mismatch — no new failure mode on a cold path.
const versions = new Map<string, number>();
function noteVersion<T extends { sessionVersion?: number }>(transferId: string, r: T): T {
  if (typeof r?.sessionVersion === 'number') versions.set(transferId, r.sessionVersion);
  return r;
}
export const relayInit = (transferId: string, recipientId: string, totalBytes: number, chatId?: string, blockCount?: number, plan?: string) =>
  api<RelayInit>('/vaultbeam/relay/init', { method: 'POST', json: { transferId, recipientId, totalBytes, chatId, blockCount, plan } })
    .then((r) => noteVersion(transferId, r));

// v2: grow the block count + post the updated content-free plan as the sender
// adapts geometry mid-transfer. blockCount may only increase.
export const relayGrow = (transferId: string, blockCount: number, plan: string) =>
  api<{ blockCount: number }>('/vaultbeam/relay/grow', { method: 'POST', json: { transferId, blockCount, plan, sessionVersion: versions.get(transferId) } });

export const relayBlockUrls = (transferId: string, blocks: number[], op: 'put' | 'get') =>
  api<{ op: string; ttl: number; urls: BlockUrl[] }>('/vaultbeam/relay/block-url', { method: 'POST', json: { transferId, blocks, op } });

export const relayMarkUploaded = (transferId: string, blocks: number[]) =>
  api<{ uploaded: number; blockCount: number; ready: boolean }>('/vaultbeam/relay/uploaded', { method: 'POST', json: { transferId, blocks, sessionVersion: versions.get(transferId) } });

export const relayState = (transferId: string) =>
  api<RelayState>(`/vaultbeam/relay/${encodeURIComponent(transferId)}`).then((r) => noteVersion(transferId, r));

// Recipient publishes its verified-chunk bitmap. Union-merged server-side, so
// posting a stale mask is harmless and ordering does not matter.
export const relayReceived = (transferId: string, mask: string, sessionVersion?: number) =>
  api<{ received: number; chunkCount: number; complete: boolean }>('/vaultbeam/relay/received',
    { method: 'POST', json: { transferId, mask, sessionVersion: sessionVersion ?? versions.get(transferId) } });

// Completion is recorded by the SERVER and is authoritative from that moment,
// whether or not the sender ever hears about it — which is why a lost final
// acknowledgement can no longer cause a re-upload. Idempotent.
export const relayComplete = (transferId: string, opts?: { sessionVersion?: number; mask?: string }) =>
  api<{ ok: boolean }>('/vaultbeam/relay/complete',
    { method: 'POST', json: { transferId, sessionVersion: opts?.sessionVersion ?? versions.get(transferId), mask: opts?.mask } });

// Terminal both ways: drop the cached version so the map cannot grow without
// bound. NOT done on complete — a completion that 409s must retry with the SAME
// version, and forgetting it would silently downgrade the retry to "unversioned".
export const relayAbort = (transferId: string) =>
  api<{ ok: boolean }>('/vaultbeam/relay/abort', { method: 'POST', json: { transferId } })
    .then((r) => { versions.delete(transferId); return r; });

// Server bitmask (base64 BYTEA) → block indices already on R2 (drives GET-side resume).
export function uploadedBlocks(maskB64: string, blockCount: number): number[] {
  const m = Buffer.from(maskB64, 'base64'); const out: number[] = [];
  for (let i = 0; i < blockCount; i++) if ((m[i >> 3] >> (i & 7)) & 1) out.push(i);
  return out;
}

// The byte pipeline (read@offset → encrypt → PUT; GET → decrypt → write@offset)
// lives in the native VaultBeamStream module — see lib/vaultBeamTransfer.
