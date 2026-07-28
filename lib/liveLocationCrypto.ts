// lib/liveLocationCrypto.ts — E2E encryption for the live-location stream (W6).
//
// Static location pins ride inside an E2E message's content, so they're already
// end-to-end encrypted. The LIVE stream is different: positions update every few
// seconds and are relayed over the socket for low latency, NOT stored as messages.
// To keep the server zero-knowledge, each position is encrypted client-side with a
// per-session symmetric key and relayed as an OPAQUE blob; the server never sees
// coordinates.
//
// Key delivery: when a live session starts, the sender generates a random session
// key and ships it to the peer ONCE inside the initial E2E 'location' message
// (content carries `lk`). That message is end-to-end encrypted exactly like a text
// message, so the key is delivered E2E. The peer stashes it (keyed by chat+sender)
// and uses it to open every subsequent relayed blob.
//
// Pure-JS @noble so it runs under Hermes; same AES-256-GCM primitive as media.

import 'react-native-get-random-values';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

export interface LivePosition {
  lat: number;
  lng: number;
  address?: string;
}

/** Fresh base64 32-byte session key for one live-share session. */
export function newLiveKey(): string {
  return Buffer.from(randomBytes(32)).toString('base64');
}

/** Encrypt a position → base64( nonce(12) || ciphertext+tag ). Returns null on bad key. */
export function encryptPosition(keyB64: string, pos: LivePosition): string | null {
  try {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) return null;
    const nonce = randomBytes(12);
    const ct = gcm(key, nonce).encrypt(Buffer.from(JSON.stringify(pos), 'utf8'));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0);
    out.set(ct, nonce.length);
    return Buffer.from(out).toString('base64');
  } catch { return null; }
}

/** Open a relayed blob with the session key. Returns null if the key is wrong/missing. */
export function decryptPosition(keyB64: string, blobB64: string): LivePosition | null {
  try {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) return null;
    const buf = Buffer.from(blobB64, 'base64');
    if (buf.length <= 12) return null;
    const nonce = buf.subarray(0, 12);
    const ct = buf.subarray(12);
    const pt = gcm(key, nonce).decrypt(new Uint8Array(ct));
    const obj = JSON.parse(Buffer.from(pt).toString('utf8'));
    if (obj && typeof obj.lat === 'number' && typeof obj.lng === 'number') return obj as LivePosition;
    return null;
  } catch { return null; }
}

// ─── Generic seal/open (same AES-256-GCM) for richer payloads ─────────────────
// Family Circle pings carry more than a position (battery, speed, ts), so they use
// these instead of encryptPosition/decryptPosition, which are position-shaped.

/** Seal any JSON-serializable value with a 32-byte base64 key → base64( nonce(12) || ct+tag ). */
export function sealJSON(keyB64: string, value: unknown): string | null {
  try {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) return null;
    const nonce = randomBytes(12);
    const ct = gcm(key, nonce).encrypt(Buffer.from(JSON.stringify(value), 'utf8'));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0);
    out.set(ct, nonce.length);
    return Buffer.from(out).toString('base64');
  } catch { return null; }
}

/** Open a sealJSON blob with the key. Returns null on wrong/missing key or malformed data. */
export function openJSON<T = any>(keyB64: string, blobB64: string): T | null {
  try {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) return null;
    const buf = Buffer.from(blobB64, 'base64');
    if (buf.length <= 12) return null;
    const pt = gcm(key, buf.subarray(0, 12)).decrypt(new Uint8Array(buf.subarray(12)));
    return JSON.parse(Buffer.from(pt).toString('utf8')) as T;
  } catch { return null; }
}

// ─── Ephemeral per-session key store (chat+peer → key) ────────────────────────
// In-memory only: a live session lives as long as the app is open, and the key is
// re-delivered E2E whenever a new session starts. Nothing sensitive persists.
const _liveKeys = new Map<string, string>();
const k = (chatId: string, userId: string) => `${chatId}::${userId}`;

/** Remember the session key for a peer's live stream in this chat. */
export function putLiveKey(chatId: string, userId: string, keyB64: string): void {
  if (chatId && userId && keyB64) _liveKeys.set(k(chatId, userId), keyB64);
}

/** Look up the session key to decrypt a peer's relayed blobs. */
export function getLiveKey(chatId: string, userId: string): string | null {
  return _liveKeys.get(k(chatId, userId)) ?? null;
}

/** Forget a peer's session key (on stop / leaving the chat). */
export function clearLiveKey(chatId: string, userId: string): void {
  _liveKeys.delete(k(chatId, userId));
}
