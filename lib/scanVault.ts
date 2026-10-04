// lib/scanVault.ts — at-rest encryption for app/docscanner's saved scans.
//
// Scans used to sit as plaintext PDFs in documentDirectory/VaultScans (named
// after the user's title) with the titles in plain AsyncStorage. Now:
//   • a per-install 32-byte key lives in SecureStore (Keystore/Keychain);
//   • each PDF is AES-256-GCM encrypted (lib/mediaCrypto, the same cipher and
//     wire format as E2E media) under its own random MediaKey and stored as
//     VaultScans/<id>.vcs — the file name says nothing about the document;
//   • the recent list (titles + per-file keys) is sealed under the install key.
// Plaintext only exists transiently: a vt_ cache copy made for Share/Send,
// swept by lib/mediaCacheGC at boot and logout.
//
// ponytail: the install key is device-bound, not PIN-bound, so this protects
// scans from file-system extraction and backups, not from someone using the
// unlocked app. Bind it to the PIN-derived key (as lib/cacheCrypto does) if
// scans must stay closed while the app is locked.

import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { open, seal } from '../services/security/vaultKeys';
import {
  newMediaKey, encryptMediaFile, decryptMediaFile, encryptMediaB64, decryptMediaB64, type MediaKey,
} from './mediaCrypto';
import { VIEWER_TEMP_PREFIX } from './mediaCacheGC';
import { resolveScanKey } from './media/scanRecent';

const KEY_NAME = 'vc_docscan_key';
/** AsyncStorage key of the recent list, sealed under the scan key. It is the
 *  only thing sealed under that key (each .vcs has its own MediaKey, kept in
 *  the list), so it is what decides whether a missing key may be replaced. */
export const SCAN_RECENT_KEY = 'vc_docscanner_recent_v2';

let keyPromise: Promise<Uint8Array> | null = null;
/** The install's scan key. Created on first use — but never while a sealed
 *  list exists: then a missing key throws RecentListUnavailable('keyLost')
 *  (lib/media/scanRecent resolveScanKey) and nothing is written, so a key
 *  that only read back empty is not overwritten. A failure is not cached;
 *  the next call reads SecureStore again. */
export function scanKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    const p = resolveScanKey({
      get: () => SecureStore.getItemAsync(KEY_NAME),
      set: hex => SecureStore.setItemAsync(KEY_NAME, hex),
      sealedListExists: async () => (await AsyncStorage.getItem(SCAN_RECENT_KEY)) != null,
    }, () => bytesToHex(randomBytes(32))).then(hexToBytes);
    keyPromise = p;
    p.catch(() => { if (keyPromise === p) keyPromise = null; });
  }
  return keyPromise;
}

/** Seal a JSON-able value for AsyncStorage. */
export async function sealJson(value: unknown): Promise<string> {
  return seal(await scanKey(), JSON.stringify(value));
}

/** Open a sealed value; null when it cannot be opened (wrong/missing key). */
export async function openJson<T>(sealed: string): Promise<T | null> {
  const plain = open(await scanKey(), sealed);
  if (plain == null) return null;
  try { return JSON.parse(plain) as T; } catch { return null; }
}

/** Encrypt plainUri → destUri under a fresh MediaKey (returned), then check
 *  that destUri decrypts back to a file the size of plainUri: the caller
 *  deletes the plaintext once this resolves, so the encrypted copy must be
 *  known good first. Throws (and removes destUri) when it is not. The
 *  plaintext is NOT deleted here. */
export async function encryptFileTo(plainUri: string, destUri: string): Promise<MediaKey> {
  const mk = newMediaKey();
  try {
    if (!(await encryptMediaFile(plainUri, destUri, mk))) {
      // No streaming engine (Expo Go): whole-file path. Scans are a few MB.
      const b64 = await FileSystem.readAsStringAsync(plainUri, { encoding: FileSystem.EncodingType.Base64 });
      await FileSystem.writeAsStringAsync(destUri, encryptMediaB64(b64, mk), { encoding: FileSystem.EncodingType.Base64 });
    }
    const check = await decryptToTemp(destUri, mk, 'check.pdf');   // throws if the GCM tag fails
    try {
      const [a, b] = await Promise.all([FileSystem.getInfoAsync(plainUri), FileSystem.getInfoAsync(check)]);
      if (!a.exists || !b.exists || a.size !== b.size) throw new Error('encrypted scan does not match its source');
    } finally {
      await FileSystem.deleteAsync(check.slice(0, check.lastIndexOf('/') + 1), { idempotent: true }).catch(() => {});
    }
  } catch (e) {
    await FileSystem.deleteAsync(destUri, { idempotent: true }).catch(() => {});
    throw e;
  }
  return mk;
}

/** Decrypt an encrypted scan into a fresh vt_ cache directory, under its real
 *  filename (what the share sheet and the chat show). Throws if the GCM tag
 *  does not verify. */
export async function decryptToTemp(encUri: string, mk: MediaKey, filename: string): Promise<string> {
  const dir = (FileSystem.cacheDirectory || '') + VIEWER_TEMP_PREFIX + 'scan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '/';   // unique: callers delete the whole dir
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const dest = dir + (filename || 'scan.pdf').replace(/[/\\:*?"<>|]/g, '_');
  if (!(await decryptMediaFile(encUri, dest, mk))) {
    const ct = await FileSystem.readAsStringAsync(encUri, { encoding: FileSystem.EncodingType.Base64 });
    await FileSystem.writeAsStringAsync(dest, decryptMediaB64(ct, mk), { encoding: FileSystem.EncodingType.Base64 });
  }
  return dest;
}

export default {};
