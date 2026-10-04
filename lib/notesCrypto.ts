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
// Set while a sealed notes blob has failed to open in this process. A new key
// minted then (e.g. by attaching a file) would sit in SecureStore and make the
// real key's recovery look like a conflict, so creation is refused until the
// notes open or a key is imported.
let storeUnreadable = false;

// A key is only ever CREATED on the encrypt paths. Reading (decrypt) with no key
// used to mint a fresh one: the notes failed to open, and the new key then sat
// in SecureStore, so recovering the real key from a backup was refused as
// "this device already has a key" and the next save sealed over the old notes
// for good (2026-10-04). Now a missing key on read is a failure the screen
// reports, and nothing is written.
async function getDEK(create = true): Promise<Uint8Array | null> {
  if (dekCache) return dekCache;
  let hex = await SecureStore.getItemAsync(DEK_KEY);
  if (!hex) {
    if (!create) return null;
    if (storeUnreadable) throw new Error('Your notes key is missing on this device. Recover it from Backup first.');
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
  const key = (await getDEK())!;
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
    const key = await getDEK(false);
    if (!key) { storeUnreadable = true; return null; }   // the key is missing — never invent one here
    const iv = Buffer.from(parsed.iv, 'base64');
    const ct = Buffer.from(parsed.ct, 'base64');
    const pt = gcm(key, iv).decrypt(ct);
    storeUnreadable = false;
    return { text: new TextDecoder().decode(pt), wasEncrypted: true };
  } catch {
    storeUnreadable = true;
    return null; // wrong/rotated key or tampered blob
  }
}

// ── Binary attachments ──────────────────────────────────────────────────────
// Note attachments (images/files) are sealed with the SAME notes DEK and written
// to disk as a small JSON envelope {v,iv,ct(base64)}. Returns the envelope string
// to persist via FileSystem.writeAsStringAsync (UTF-8).
export async function encryptBytesToString(bytes: Uint8Array): Promise<string> {
  const key = (await getDEK())!;
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(bytes);
  const payload: NotesCipher = {
    v: 1,
    iv: Buffer.from(iv).toString('base64'),
    ct: Buffer.from(ct).toString('base64'),
  };
  return JSON.stringify(payload);
}

// Reverse of encryptBytesToString. Returns null on a wrong key or tampered blob.
export async function decryptStringToBytes(raw: string): Promise<Uint8Array | null> {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isCipher(parsed)) return null;
  try {
    const key = await getDEK(false);
    if (!key) return null;
    const iv = Buffer.from(parsed.iv, 'base64');
    const ct = Buffer.from(parsed.ct, 'base64');
    return gcm(key, iv).decrypt(ct);
  } catch {
    return null;
  }
}

export function clearNotesKeyCache(): void { dekCache = null; }

// ── DEK custody (for lib/notesVault: passphrase-wrapped backup/restore) ──────
// The DEK lives ONLY in SecureStore, which no backup path copies. Losing the
// phone therefore lost every note permanently — including the Recovery Keys and
// Bank/Cards categories this vault invites people to use. notesVault wraps the
// DEK under a user passphrase so it can travel as ciphertext; these two
// accessors are the only way in and out, and neither is called by UI code.

/** The raw DEK as hex, creating it if this install has none. */
export async function exportDEKHex(): Promise<string> {
  return bytesToHex((await getDEK())!);
}

/**
 * Adopt a DEK recovered from a backup. Refuses to overwrite an existing key
 * unless `force` — a silent overwrite would strand whatever notes the current
 * key already seals, with no way back.
 */
export async function importDEKHex(hex: string, force = false): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Not a valid notes key.');
  if (!force && await SecureStore.getItemAsync(DEK_KEY)) return false;
  await SecureStore.setItemAsync(DEK_KEY, hex.toLowerCase());
  dekCache = hexToBytes(hex.toLowerCase());
  storeUnreadable = false;
  return true;
}

/** True when this install already holds a notes key. */
export async function hasDEK(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(DEK_KEY).catch(() => null));
}
