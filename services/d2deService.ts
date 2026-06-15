import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import { E2EE_ENABLED } from '../constants/flags';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  v: number;
}

export interface D2DEStatusLayer {
  layer: string;
  active: boolean;
  label: string;
}

async function deriveSharedKey(uid1: string, uid2: string): Promise<CryptoKey> {
  const [a, b] = [uid1, uid2].sort();
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(`vaultchat-v1-${a}-${b}`),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('vaultchat-aes-gcm-salt-2026'), iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

const keyCache = new Map<string, CryptoKey>();

async function getKey(myUid: string, peerUid: string): Promise<CryptoKey> {
  const k = [myUid, peerUid].sort().join('_');
  if (!keyCache.has(k)) keyCache.set(k, await deriveSharedKey(myUid, peerUid));
  return keyCache.get(k)!;
}

export function clearKeyCache() { keyCache.clear(); }

export async function encryptMessage(
  plaintext: string, myUid: string, peerUid: string
): Promise<EncryptedPayload> {
  const key = await getKey(myUid, peerUid);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, enc.encode(plaintext)
  );
  // Web Crypto AES-GCM appends the auth tag to the ciphertext automatically.
  // The tag field is kept for protocol compatibility but is embedded in ciphertext.
  const encBytes = new Uint8Array(encrypted);
  const tagStart = encBytes.length - 16; // 128-bit tag = 16 bytes
  const ciphertextOnly = encBytes.slice(0, tagStart);
  const tagBytes = encBytes.slice(tagStart);
  return {
    ciphertext: Buffer.from(encBytes).toString('base64'),
    iv:   Buffer.from(iv).toString('base64'),
    tag:  Buffer.from(tagBytes).toString('base64'),
    keyId: 'v1-pbkdf2',
    v: 1,
  };
}

export async function decryptMessage(
  payload: EncryptedPayload, myUid: string, peerUid: string
): Promise<string> {
  const key        = await getKey(myUid, peerUid);
  const iv         = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext
  );
  return new TextDecoder().decode(dec);
}

// Reports the REAL encryption posture. TLS is always on (transport). The
// end-to-end layers are active only when E2EE_ENABLED — i.e. they reflect the
// actual services/crypto double-ratchet path used for direct chats, not a
// hardcoded "everything green".
export function getD2DEStatus(): D2DEStatusLayer[] {
  const e2e = E2EE_ENABLED;
  return [
    { layer: 'TLS 1.3',        active: true, label: 'Transport — encrypted on all connections' },
    { layer: 'AES-256-GCM',    active: e2e,  label: e2e ? 'Direct messages encrypted on your device' : 'End-to-end encryption rolling out' },
    { layer: 'Double Ratchet', active: e2e,  label: e2e ? 'Forward secrecy — a fresh key per message' : 'Not active yet' },
    { layer: 'X3DH',           active: e2e,  label: e2e ? 'Key agreement via published prekeys' : 'Not active yet' },
    { layer: 'Secure Keystore',active: e2e,  label: e2e ? 'Keys held in the device secure store' : 'No end-to-end keys yet' },
  ];
}
