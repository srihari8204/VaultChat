/**
 * services/d2deService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * D2DE — Device-to-Device Encrypted
 * REAL AES-256-GCM via react-native-quick-crypto (native C++)
 * Same algorithm used by Signal, WhatsApp, iMessage
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from 'react-native-quick-crypto';
import * as SecureStore from 'expo-secure-store';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface D2DEPayload {
  ciphertext: string;   // base64 AES-256-GCM encrypted data
  iv:         string;   // base64 12-byte GCM nonce
  authTag:    string;   // base64 16-byte GCM auth tag
  hmac:       string;   // base64 HMAC-SHA256 of (iv + ciphertext)
  sessionId:  string;
  timestamp:  number;
  version:    string;
}

export interface LocationPayload {
  lat:       number;
  lng:       number;
  accuracy?: number;
  altitude?: number;
  heading?:  number;
  speed?:    number;
  address?:  string;
  type:      'static' | 'live';
  expiresAt?: number;
}

export interface D2DESession {
  sessionId:  string;
  sessionKey: string;   // 32-byte hex — real AES-256 key
  createdAt:  number;
  expiresAt:  number;
  peerId:     string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 'D2DE-v2-AES-GCM';
const SESSION_TTL_MS   = 8 * 60 * 60 * 1000; // 8 hours
const REPLAY_WINDOW_MS = 30_000;              // 30 second replay window

// ── Key Generation ────────────────────────────────────────────────────────────

/**
 * Generate a real 256-bit AES key using native CSPRNG
 */
export function generateSessionKey(): string {
  const keyBytes = randomBytes(32);
  return Buffer.from(keyBytes).toString('hex');
}

/**
 * Generate a unique session ID (128-bit random)
 */
export function generateSessionId(): string {
  const idBytes = randomBytes(16);
  return Buffer.from(idBytes).toString('hex');
}

// ── Session Management ────────────────────────────────────────────────────────

export async function createSession(peerId: string): Promise<D2DESession> {
  const session: D2DESession = {
    sessionId:  generateSessionId(),
    sessionKey: generateSessionKey(),
    createdAt:  Date.now(),
    expiresAt:  Date.now() + SESSION_TTL_MS,
    peerId,
  };
  await SecureStore.setItemAsync(
    `d2de_session_${session.sessionId}`,
    JSON.stringify(session)
  );
  return session;
}

export async function loadSession(sessionId: string): Promise<D2DESession | null> {
  try {
    const raw = await SecureStore.getItemAsync(`d2de_session_${sessionId}`);
    if (!raw) return null;
    const session: D2DESession = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      await deleteSession(sessionId);
      return null;
    }
    return session;
  } catch { return null; }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`d2de_session_${sessionId}`).catch(() => {});
}

// ── Real AES-256-GCM Encryption ───────────────────────────────────────────────

/**
 * Encrypt any object with REAL AES-256-GCM
 * - 12-byte random IV (nonce) per message
 * - 16-byte GCM auth tag (tamper detection built-in)
 * - HMAC-SHA256 over (iv + ciphertext) for extra integrity layer
 * - Replay protection via timestamp check
 */
export function d2deEncrypt(
  payload: object,
  sessionKey: string,
  sessionId:  string
): D2DEPayload {
  const plaintext  = JSON.stringify(payload);
  const timestamp  = Date.now();

  // 12-byte random nonce for GCM (NIST recommended)
  const iv      = randomBytes(12);
  const keyBuf  = Buffer.from(sessionKey, 'hex');

  // Real AES-256-GCM encrypt
  const cipher  = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc1    = cipher.update(plaintext, 'utf8');
  const enc2    = cipher.final();
  const authTag = (cipher as any).getAuthTag() as Buffer;

  const ciphertext = Buffer.concat([
    Buffer.isBuffer(enc1) ? enc1 : Buffer.from(enc1 as any),
    Buffer.isBuffer(enc2) ? enc2 : Buffer.from(enc2 as any),
  ]);

  // HMAC-SHA256 over iv + ciphertext for extra integrity
  const ivB64   = Buffer.from(iv).toString('base64');
  const ctB64   = ciphertext.toString('base64');
  const hmacObj = createHmac('sha256', keyBuf);
  hmacObj.update(ivB64 + ':' + ctB64 + ':' + timestamp.toString());
  const hmac    = (hmacObj.digest() as Buffer).toString('base64');

  return {
    ciphertext: ctB64,
    iv:         ivB64,
    authTag:    Buffer.from(authTag).toString('base64'),
    hmac,
    sessionId,
    timestamp,
    version:    PROTOCOL_VERSION,
  };
}

/**
 * Decrypt a D2DE payload with REAL AES-256-GCM
 * Returns null if tampered, replayed, or wrong key
 */
export function d2deDecrypt(
  payload:    D2DEPayload,
  sessionKey: string
): object | null {
  try {
    // 1. Replay attack check
    if (Math.abs(Date.now() - payload.timestamp) > REPLAY_WINDOW_MS) {
      console.warn('[D2DE] Replay attack blocked');
      return null;
    }

    // 2. Protocol version check
    if (payload.version !== PROTOCOL_VERSION) {
      console.warn('[D2DE] Version mismatch');
      return null;
    }

    const keyBuf = Buffer.from(sessionKey, 'hex');

    // 3. HMAC verification
    const hmacObj = createHmac('sha256', keyBuf);
    hmacObj.update(payload.iv + ':' + payload.ciphertext + ':' + payload.timestamp.toString());
    const expectedHmac = (hmacObj.digest() as Buffer).toString('base64');
    if (expectedHmac !== payload.hmac) {
      console.warn('[D2DE] HMAC failed — data tampered');
      return null;
    }

    // 4. AES-256-GCM decrypt (auth tag verified by GCM automatically)
    const iv         = Buffer.from(payload.iv,         'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const authTag    = Buffer.from(payload.authTag,    'base64');

    const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
    (decipher as any).setAuthTag(authTag);

    const dec1 = decipher.update(ciphertext);
    const dec2 = decipher.final();

    const plaintext = Buffer.concat([
      Buffer.isBuffer(dec1) ? dec1 : Buffer.from(dec1 as any),
      Buffer.isBuffer(dec2) ? dec2 : Buffer.from(dec2 as any),
    ]).toString('utf8');

    return JSON.parse(plaintext);
  } catch (e) {
    console.warn('[D2DE] Decryption failed:', e);
    return null;
  }
}

// ── Location Helpers ──────────────────────────────────────────────────────────

export function encryptLocation(
  location:   LocationPayload,
  sessionKey: string,
  sessionId:  string
): D2DEPayload {
  return d2deEncrypt(location, sessionKey, sessionId);
}

export function decryptLocation(
  payload:    D2DEPayload,
  sessionKey: string
): LocationPayload | null {
  return d2deDecrypt(payload, sessionKey) as LocationPayload | null;
}

// ── Session Link ──────────────────────────────────────────────────────────────

/**
 * Encode session key for delivery via E2EE chat message
 * NEVER store this on the server — send via Double Ratchet only
 */
export function encodeSessionLink(session: D2DESession): string {
  return Buffer.from(JSON.stringify({
    id:  session.sessionId,
    key: session.sessionKey,
    exp: session.expiresAt,
  })).toString('base64');
}

export function decodeSessionLink(link: string): { id: string; key: string; exp: number } | null {
  try { return JSON.parse(Buffer.from(link, 'base64').toString('utf8')); }
  catch { return null; }
}

// ── Wipe ──────────────────────────────────────────────────────────────────────

export async function wipeAllSessions(sessionIds: string[]): Promise<void> {
  await Promise.all(sessionIds.map(id => deleteSession(id)));
}

// ── Quick test (call from app to verify working) ──────────────────────────────

export function testD2DE(): boolean {
  try {
    const key     = generateSessionKey();
    const id      = generateSessionId();
    const payload = { test: 'hello', lat: 17.3850, lng: 78.4867 };
    const enc     = d2deEncrypt(payload, key, id);
    const dec     = d2deDecrypt(enc, key) as any;
    const ok      = dec?.test === 'hello' && dec?.lat === 17.3850;
    console.log('[D2DE] Self-test:', ok ? 'PASSED ✅' : 'FAILED ❌');
    return ok;
  } catch (e) {
    console.error('[D2DE] Self-test error:', e);
    return false;
  }
}

export default {
  createSession, loadSession, deleteSession,
  d2deEncrypt, d2deDecrypt,
  encryptLocation, decryptLocation,
  generateSessionKey, generateSessionId,
  encodeSessionLink, decodeSessionLink,
  wipeAllSessions, testD2DE,
};
