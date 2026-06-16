// lib/notesCrypto.ts — real at-rest encryption for the Encrypted Notes vault.
//
// The notes screen used to write plaintext JSON to AsyncStorage despite being
// called "Encrypted Notes". Now the notes blob is sealed with AES-256-GCM under
// a random 256-bit data-encryption key (DEK) kept in SecureStore (OS keystore /
// Keychain — encrypted at rest, never in AsyncStorage). @noble primitives so it
// runs under Hermes.

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';

const DEK_KEY = 'vc_notes_dek_v1';
let dekCache: Uint8Array | null = null;

async function getDEK(): Promise<Uint8Array> {
  if (dekCache) return dekCache;
  let hex = await SecureStore.getItemAsync(DEK_KEY);
  if (!hex) {
    const dek = randomBytes(32);
    hex = bytesToHex(dek);
    await SecureStore.setItemAsync(DEK_KEY, hex);
    dekCache = dek;
    return dek;
  }
  dekCache = hexToBytes(hex);
  return dekCache;
}

export interface NotesCipher { v: 1; iv: string; ct: string }

function isCipher(o: any): o is NotesCipher {
  return o && o.v === 1 && typeof o.iv === 'string' && typeof o.ct === 'string';
}

// Encrypt a plaintext string → a JSON string holding the sealed blob.
export async function encryptNotes(plaintext: string): Promise<string> {
  const key = await getDEK();
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  const payload: NotesCipher = {
    v: 1,
    iv: Buffer.from(iv).toString('base64'),
    ct: Buffer.from(ct).toString('base64'),
  };
  return JSON.stringify(payload);
}

// Decrypt a stored value back to plaintext. Transparently passes through legacy
// plaintext (pre-encryption notes) so existing data isn't lost — callers re-save
// it encrypted. Returns null only when a real sealed blob fails to open.
export async function decryptNotes(raw: string): Promise<{ text: string; wasEncrypted: boolean } | null> {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { text: raw, wasEncrypted: false }; }

  // Legacy: the old format stored the notes array directly.
  if (!isCipher(parsed)) return { text: raw, wasEncrypted: false };

  try {
    const key = await getDEK();
    const iv = Buffer.from(parsed.iv, 'base64');
    const ct = Buffer.from(parsed.ct, 'base64');
    const pt = gcm(key, iv).decrypt(ct);
    return { text: new TextDecoder().decode(pt), wasEncrypted: true };
  } catch {
    return null; // wrong/rotated key or tampered blob
  }
}

export function clearNotesKeyCache(): void { dekCache = null; }
