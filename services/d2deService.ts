import 'react-native-get-random-values';
import { Buffer } from 'buffer';

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
  return {
    ciphertext: Buffer.from(new Uint8Array(encrypted)).toString('base64'),
    iv:   Buffer.from(iv).toString('base64'),
    tag:  '',
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

export function getD2DEStatus(): D2DEStatusLayer[] {
  return [
    { layer: 'TLS 1.3',         active: true,  label: 'Transport â€” TLS 1.3 on all connections' },
    { layer: 'AES-256-GCM',     active: true,  label: 'Messages â€” unique IV per message' },
    { layer: 'Double Ratchet',  active: false, label: 'Forward Secrecy (Phase 3)' },
    { layer: 'X3DH',            active: false, label: 'Key Exchange (Phase 3)' },
    { layer: 'Android Keystore',active: false, label: 'Hardware Keys (Phase 4)' },
  ];
}
