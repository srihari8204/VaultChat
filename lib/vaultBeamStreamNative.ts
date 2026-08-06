// lib/vaultBeamStreamNative.ts — typed bridge to the VaultBeam native byte
// pipeline. This is the concrete implementation of the P1_SEAM documented in
// lib/vaultbeamRelay.ts: JS holds only {blockIndex, url}; the native side owns
// every file byte + the per-chunk AES-256-GCM + the block HTTP PUT/GET.
//
// TWO interchangeable backends, selected at runtime by EXPO_PUBLIC_VAULTBEAM_
// NATIVE_BACKEND ('kotlin' default | 'rust'):
//   • 'kotlin' — the original VaultBeamStream module (Android only).
//   • 'rust'   — the shared vaultbeam-core Rust module VaultBeamStreamRust
//                (Android AND iOS — first iOS VaultBeam). Byte-identical wire
//                (proven by the golden vectors), so a Kotlin peer and a Rust
//                peer interop on every tier.
// The wire format + method surface are identical, so this file is backend-
// agnostic below the resolver. On any capability failure we fall back to Kotlin;
// the orchestrator's tier fallback (LAN/P2P → R2 relay) is the ultimate net, so
// a transfer never crashes. Kill-switch: set the flag to 'kotlin'.
//
// Absent entirely (Expo Go, or a build without either module) →
// isNativeStreamAvailable() is false and the orchestrator refuses >2 GB rather
// than OOMing the JS heap.

import { NativeModules, NativeEventEmitter } from 'react-native';

export type VaultBeamBackend = 'kotlin' | 'rust';

// Methods a usable native module must expose (structural capability check).
const REQUIRED = [
  'prealloc', 'uploadBlock', 'downloadBlock', 'sha256', 'deleteFile',
  'readCipherChunk', 'writeCipherChunk', 'lanIp', 'lanServe', 'lanConnect',
] as const;

function hasSurface(mod: any): boolean {
  return !!mod && REQUIRED.every((m) => typeof mod[m] === 'function');
}

function breadcrumb(message: string, level: 'info' | 'warning' = 'info'): void {
  if (level === 'warning') console.warn(`[vaultbeam] ${message}`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/react-native');
    Sentry.addBreadcrumb({ category: 'vaultbeam', level, message });
  } catch {
    /* Sentry unavailable (Node tests) — the console line above suffices. */
  }
}

// Resolve the backend ONCE at module load. Prefer Rust when the flag asks for it
// AND the module is present with the full surface; otherwise Kotlin; otherwise
// none. Every branch leaves a breadcrumb so field selection/fallback is visible.
function resolveBackend(): { native: any; backend: VaultBeamBackend | null } {
  const want = String(process.env.EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND || 'kotlin').toLowerCase();
  const rust = NativeModules?.VaultBeamStreamRust ?? null;
  const kotlin = NativeModules?.VaultBeamStream ?? null;

  if (want === 'rust') {
    if (hasSurface(rust)) {
      breadcrumb('backend=rust (vaultbeam-core)');
      return { native: rust, backend: 'rust' };
    }
    if (hasSurface(kotlin)) {
      breadcrumb(`flag=rust but VaultBeamStreamRust ${rust ? 'incomplete' : 'absent'} — falling back to kotlin`, 'warning');
      return { native: kotlin, backend: 'kotlin' };
    }
    breadcrumb('flag=rust but NO native module present — relay-only', 'warning');
    return { native: null, backend: null };
  }

  if (hasSurface(kotlin)) {
    breadcrumb('backend=kotlin');
    return { native: kotlin, backend: 'kotlin' };
  }
  // Kotlin absent (e.g. iOS with only the Rust module built): use Rust if usable.
  if (hasSurface(rust)) {
    breadcrumb('backend=rust (kotlin absent on this platform)');
    return { native: rust, backend: 'rust' };
  }
  return { native: null, backend: null };
}

const { native: Native, backend: BACKEND } = resolveBackend();

/** Which native backend is live ('kotlin' | 'rust' | null) — for diagnostics. */
export function vaultBeamBackend(): VaultBeamBackend | null {
  return BACKEND;
}

export function isNativeStreamAvailable(): boolean {
  return !!Native;
}

// Event bus for native-driven LAN transfer progress (vbLanProgress / vbLanBound).
// Both backends emit the same event names/payloads via NativeEventEmitter.
const emitter = Native ? new NativeEventEmitter(Native) : null;
export function onLanEvent(event: 'vbLanProgress' | 'vbLanBound', cb: (d: any) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener(event, cb);
  return () => sub.remove();
}

function requireNative(): any {
  if (!Native) {
    throw new Error('VaultBeam native module unavailable — needs a dev/EAS build (not Expo Go). Set EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust for iOS + Android, or use the relay tier.');
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
  // Segmented geometry (R4): this block's plaintext byte offset. Supplied ⇒ the
  // native op uses offset-based chunk identity (AAD+nonce) so per-segment size
  // changes stay clean. Omitted ⇒ legacy uniform path (offset = blockIndex·blockBytes).
  blockPlainOffset?: number;
  // Chunk-identity scheme (mirrors services/vaultbeam/rust/src/chunk.rs IdScheme).
  // 'canonical' ⇒ id = blockPlainOffset/chunkBytes, i.e. the chunk's GLOBAL LOGICAL
  // INDEX — identical on every transport, which is what lets one resume bitmap
  // span LAN, P2P and the relay. Omitted ⇒ the pre-vbm3 default for the call
  // shape ('legacyOffset' when blockPlainOffset is present, else 'uniform'), so
  // an un-upgraded caller is byte-identical to before.
  idScheme?: 'uniform' | 'legacyOffset' | 'canonical';
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

/**
 * Is the durability barrier available on the resolved backend?
 *
 * Deliberately NOT part of REQUIRED above: adding it there would make an older
 * native module fail the capability check outright and drop the whole device to
 * relay-only, which is a far bigger behaviour change than the gap it guards.
 * Instead the engine asks, and reports honestly when the answer is no.
 */
export function isDurableSyncAvailable(): boolean {
  return typeof Native?.syncFile === 'function';
}

/**
 * DURABILITY BARRIER: block until this file's written bytes are on stable
 * storage. Resolves true, or REJECTS — a rejection must never be read as
 * durable. See services/vaultbeam/rust/src/fileio.rs::sync_file for why closing
 * a file is not enough.
 */
export function syncFile(path: string): Promise<boolean> {
  const n = requireNative();
  if (typeof n.syncFile !== 'function') {
    throw new Error('VaultBeam native module has no syncFile — durability cannot be guaranteed on this build');
  }
  return n.syncFile(path);
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
/** Resume: stream ONLY these logical-chunk runs. Absent ⇒ the whole file, which
 *  is byte-identical to the pre-resume behaviour. The LAN frame format is
 *  unchanged (each frame already carries its chunk index), so a subset needs no
 *  new framing and the frozen LAN golden vector still applies. */
export interface LanChunkRun { start: number; count: number }

export interface LanServeOp {
  srcPath: string; keyB64: string; transferId: string; fileId: string; token: string;
  chunkBytes: number; chunkCount: number; totalBytes: number; port?: number;
  runs?: LanChunkRun[];
}
// SENDER: bind + accept + stream. Resolves with chunk count. The bound port
// arrives first via the vbLanBound event (subscribe with onLanEvent).
export function lanServe(op: LanServeOp): Promise<number> {
  return requireNative().lanServe(op);
}
export interface LanConnectOp {
  host: string; port: number; dstPath: string; keyB64: string; transferId: string; fileId: string;
  token: string; chunkBytes: number; chunkCount: number; totalBytes: number;
  /** Must match the sender's runs; both sides derive them from one work-list. */
  runs?: LanChunkRun[];
}
// RECEIVER: connect + pull + write. Resolves with chunk count.
export function lanConnect(op: LanConnectOp): Promise<number> {
  return requireNative().lanConnect(op);
}
