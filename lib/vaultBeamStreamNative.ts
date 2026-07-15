// lib/vaultBeamStreamNative.ts — typed bridge to the VaultBeamStream native module
// (the P1 byte pipeline). This is the concrete implementation of the P1_SEAM
// documented in lib/vaultbeamRelay.ts: JS holds only {blockIndex, url}; the native
// side owns every file byte + the per-chunk AES-256-GCM + the block HTTP PUT/GET.
//
// Absent under Expo Go / iOS (Android-only for now) → isNativeStreamAvailable()
// is false and the orchestrator refuses >2 GB rather than OOMing the JS heap.

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const Native: any = NativeModules?.VaultBeamStream ?? null;

export function isNativeStreamAvailable(): boolean {
  return !!Native && Platform.OS === 'android';
}

// Event bus for native-driven LAN transfer progress (vbLanProgress / vbLanBound).
const emitter = Native ? new NativeEventEmitter(Native) : null;
export function onLanEvent(event: 'vbLanProgress' | 'vbLanBound', cb: (d: any) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener(event, cb);
  return () => sub.remove();
}

function requireNative(): any {
  if (!Native) {
    throw new Error('VaultBeamStream native module unavailable — needs a dev/EAS build (not Expo Go); Android only for now.');
  }
  return Native;
}

// Geometry + secrets a block op needs. All fields are canonical (must match
// routes/vaultbeam.js): chunkBytes=512KiB, blockBytes=4MiB, chunkCount/blockCount
// server-computed, totalBytes the true file size. keyB64 is K_t (never leaves the
// device except ratchet-wrapped over E2EE). fileId binds the AAD to one file.
export interface BlockOp {
  url: string;          // presigned R2 URL for this block (PUT for send, GET for receive)
  keyB64: string;       // per-transfer key K_t, base64 (32 raw bytes)
  transferId: string;
  fileId: string;
  blockIndex: number;
  chunkBytes: number;
  blockBytes: number;
  chunkCount: number;
  totalBytes: number;
}

export interface UploadBlockOp extends BlockOp { srcPath: string }
export interface DownloadBlockOp extends BlockOp { dstPath: string }

// Preallocate the destination shell so out-of-order/resumed block writes land right.
export function prealloc(path: string, totalBytes: number): Promise<boolean> {
  return requireNative().prealloc(path, totalBytes);
}

// Seal this block's chunks and PUT the ciphertext to R2. Resolves bytes uploaded.
export function uploadBlock(op: UploadBlockOp): Promise<number> {
  return requireNative().uploadBlock(op);
}

// GET the block, verify+decrypt each chunk, write plaintext @ offset. Resolves
// chunks written; throws on a tampered/short block (so the caller won't mark it).
export function downloadBlock(op: DownloadBlockOp): Promise<number> {
  return requireNative().downloadBlock(op);
}

// Whole-file SHA-256 (hex) for the post-assembly integrity check.
export function sha256File(path: string): Promise<string> {
  return requireNative().sha256(path);
}

export function deleteFile(path: string): Promise<boolean> {
  return requireNative().deleteFile(path);
}

// ── P2 (WebRTC) per-chunk cipher primitives ─────────────────────────
// JS shuttles ONE chunk's ciphertext at a time over the datachannel; crypto +
// positional file I/O stay native. Same wire format as the R2/LAN paths.
export interface CipherChunkOp {
  keyB64: string; transferId: string; fileId: string;
  chunkIndex: number; chunkBytes: number; chunkCount: number; totalBytes: number;
}
export function readCipherChunk(op: CipherChunkOp & { srcPath: string }): Promise<string> {
  return requireNative().readCipherChunk(op);           // → base64 ciphertext (ct‖tag)
}
export function writeCipherChunk(op: CipherChunkOp & { dstPath: string; ctB64: string }): Promise<number> {
  return requireNative().writeCipherChunk(op);          // verify+decrypt+write; → plaintext bytes
}

// ── P3 (LAN) direct TCP transport ───────────────────────────────────
export function lanIp(): Promise<string | null> {
  return requireNative().lanIp();
}
export interface LanServeOp {
  srcPath: string; keyB64: string; transferId: string; fileId: string; token: string;
  chunkBytes: number; chunkCount: number; totalBytes: number; port?: number;
}
// SENDER: bind + accept + stream. Resolves with chunk count. The bound port
// arrives first via the vbLanBound event (subscribe with onLanEvent).
export function lanServe(op: LanServeOp): Promise<number> {
  return requireNative().lanServe(op);
}
export interface LanConnectOp {
  host: string; port: number; dstPath: string; keyB64: string; transferId: string; fileId: string;
  token: string; chunkBytes: number; chunkCount: number; totalBytes: number;
}
// RECEIVER: connect + pull + write. Resolves with chunk count.
export function lanConnect(op: LanConnectOp): Promise<number> {
  return requireNative().lanConnect(op);
}
