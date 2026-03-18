// services/encryptionService.ts — AES-256-GCM Message Encryption
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

export interface EncryptedPayload { ciphertext: string; iv: string; tag?: string; }

export function generateIV(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Buffer.from(a).toString('base64');
}

async function deriveKey(senderUid: string, recipientUid: string): Promise<CryptoKey> {
  const [a, b] = [senderUid, recipientUid].sort();
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

async function getKey(senderUid: string, recipientUid: string): Promise<CryptoKey> {
  const k = [senderUid, recipientUid].sort().join('_');
  if (!keyCache.has(k)) keyCache.set(k, await deriveKey(senderUid, recipientUid));
  return keyCache.get(k)!;
}

export async function encryptMessage(plaintext: string, senderUid: string, recipientUid: string): Promise<EncryptedPayload> {
  const key = await getKey(senderUid, recipientUid);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, enc.encode(plaintext)
  );
  return {
    ciphertext: Buffer.from(new Uint8Array(encrypted)).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

export async function decryptMessage(payload: EncryptedPayload, senderUid: string, recipientUid: string): Promise<string> {
  const key = await getKey(senderUid, recipientUid);
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext
  );
  return new TextDecoder().decode(dec);
}