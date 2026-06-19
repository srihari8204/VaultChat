// lib/cloudBackup.ts — WhatsApp-style encrypted backup & restore.
//
// Bundles EVERYTHING needed to fully restore a chat on a new device/reinstall:
//   • AsyncStorage prefs (themes, drafts, sound prefs, …)
//   • the local SQLite message DB (envelopes + chat list)
//   • the decrypted plaintext cache  ← so restored history is readable
//   • the E2EE identity + per-peer session ratchets ← so NO re-key, and future
//     messages keep decrypting on the new device
//
// The bundle is encrypted on-device with the user's passphrase (AES-256-GCM via
// lib/vaultCrypto) and stored as an OPAQUE blob — locally (file) or in the cloud
// (the server can never read it: zero-knowledge, like WhatsApp's E2E backups).

import { Platform } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { vaultEncrypt, vaultDecrypt } from './vaultCrypto';
import { exportAll, importAll } from './localDb';
import { api } from './api';
import {
  exportE2EEKeys, importE2EEKeys, e2eeGetCached, e2eeCachePlaintext,
} from '../services/crypto/e2eeSession.rn';

export interface BackupMeta { exists: boolean; sizeBytes?: number; messageCount?: number; updatedAt?: string }

// Account-managed backup key (WhatsApp default): fetched once from the server
// (which generates + stores it), cached on-device. No user passphrase needed.
const BACKUP_KEY_STORE = 'vc_backup_dek';
export async function getBackupKey(): Promise<string> {
  let k = await SecureStore.getItemAsync(BACKUP_KEY_STORE).catch(() => null);
  if (k) return k;
  const r = await api<{ key: string }>('/user/backup/key');
  if (!r?.key) throw new Error('Could not get backup key');
  await SecureStore.setItemAsync(BACKUP_KEY_STORE, r.key).catch(() => {});
  return r.key;
}

function safeParse(s: any): any { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } }

function peerIdsFromChats(chats: any[]): string[] {
  const ids = new Set<string>();
  for (const c of chats) {
    const d = safeParse(c?.data);
    if (d?.peerUserId) ids.add(String(d.peerUserId));
  }
  return [...ids];
}

/** Gather everything + encrypt with a secret. Returns the opaque blob. */
async function buildEncryptedBackup(secret: string): Promise<{ blob: string; messageCount: number; sizeBytes: number }> {
  // 1. AsyncStorage prefs
  const keys = await AsyncStorage.getAllKeys();
  const pairs = await AsyncStorage.multiGet(keys);
  const asyncStorage: Record<string, string | null> = {};
  for (const [k, v] of pairs) asyncStorage[k] = v;

  // 2. Local message DB (envelopes + chats)
  const local = await exportAll();

  // 3. Decrypted plaintext cache — keyed "<chatId>:<messageId>"
  const plaintexts: Record<string, string> = {};
  for (const m of local.messages) {
    if (!m.id || m.id <= 0 || !m.chat_id) continue;
    try {
      const pt = await e2eeGetCached(m.chat_id, m.id);
      if (pt != null) plaintexts[`${m.chat_id}:${m.id}`] = pt;
    } catch {}
  }

  // 4. E2EE identity + per-peer sessions
  const e2eeKeys = await exportE2EEKeys(peerIdsFromChats(local.chats));

  const bundle = JSON.stringify({
    v: 2,
    createdAt: new Date().toISOString(),
    asyncStorage,
    messages: local.messages,
    chats: local.chats,
    plaintexts,
    e2eeKeys,
  });
  const blob = JSON.stringify(vaultEncrypt(secret, bundle)); // real AES-256-GCM
  return { blob, messageCount: local.messages.length, sizeBytes: bundle.length };
}

/** Decrypt + apply a backup blob to local storage. Returns messages restored. */
async function applyEncryptedBackup(secret: string, blob: string): Promise<number> {
  const json = vaultDecrypt(secret, JSON.parse(blob)); // throws on wrong key
  const data = JSON.parse(json);

  if (data.asyncStorage) {
    const entries = Object.entries(data.asyncStorage).filter(([, v]) => v != null) as [string, string][];
    if (entries.length) await AsyncStorage.multiSet(entries);
  }
  const n = await importAll({ messages: data.messages, chats: data.chats });
  if (data.e2eeKeys) await importE2EEKeys(data.e2eeKeys);
  if (data.plaintexts) {
    for (const [k, pt] of Object.entries(data.plaintexts as Record<string, string>)) {
      const i = k.lastIndexOf(':');
      const chatId = k.slice(0, i);
      const id = parseInt(k.slice(i + 1), 10);
      if (chatId && id > 0) { try { await e2eeCachePlaintext(chatId, id, pt); } catch {} }
    }
  }
  return n;
}

// ── Cloud (zero-knowledge server storage) ───────────────────────────────
export async function cloudBackupMeta(): Promise<BackupMeta> {
  try { return await api<BackupMeta>('/user/backup/meta'); }
  catch { return { exists: false }; }
}

export async function uploadCloudBackup(): Promise<{ messageCount: number; sizeBytes: number }> {
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup(await getBackupKey());
  // Prefer direct-to-object-storage (presigned PUT) so the blob never passes
  // through the API/DB — no size cap, no server memory spike. Inline fallback
  // only when object storage is off.
  const presign = await api<{ mode: string; uploadUrl?: string; key?: string }>(
    '/user/backup/presign', { method: 'POST', json: { sizeBytes, messageCount } },
  );
  if (presign.mode === 'object' && presign.uploadUrl && presign.key) {
    const put = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!put.ok) throw new Error(`backup upload failed (${put.status})`);
    await api('/user/backup/commit', { method: 'POST', json: { key: presign.key, sizeBytes, messageCount } });
  } else {
    await api('/user/backup', { method: 'PUT', json: { blob, sizeBytes, messageCount } });
  }
  return { messageCount, sizeBytes };
}

export async function restoreCloudBackup(): Promise<number> {
  const r = await api<{ mode?: string; downloadUrl?: string; blob?: string }>('/user/backup');
  let blob = r?.blob;
  if (r?.mode === 'object' && r.downloadUrl) {
    const resp = await fetch(r.downloadUrl);
    if (!resp.ok) throw new Error(`backup download failed (${resp.status})`);
    blob = await resp.text();
  }
  if (!blob) throw new Error('No backup found');
  return applyEncryptedBackup(await getBackupKey(), blob);
}

export async function deleteCloudBackup(): Promise<void> {
  await api('/user/backup', { method: 'DELETE' });
}

// ── Local file backups (WhatsApp-style "Databases" folder) ───────────────
// Encrypted backup files written to the app's browsable external folder, next
// to Media/, so a user can see/copy them and restore offline. Rolling retention
// keeps the latest few (like WhatsApp's daily backups).
const PKG = 'com.vaultchat.app';
const DB_BACKUP_DIR = Platform.OS === 'android'
  ? `${RNFS.ExternalStorageDirectoryPath}/Android/media/${PKG}/VaultChat/Databases`
  : `${RNFS.DocumentDirectoryPath}/VaultChat/Databases`;
const KEEP_LOCAL = 7;

export interface LocalBackup { name: string; path: string; size: number; mtime: number }

async function ensureDir(p: string): Promise<void> { if (!(await RNFS.exists(p))) await RNFS.mkdir(p); }

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write an encrypted backup file into VaultChat/Databases/ and prune old ones. */
export async function writeLocalBackup(when: Date): Promise<{ path: string; messageCount: number; sizeBytes: number }> {
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup(await getBackupKey());
  await ensureDir(DB_BACKUP_DIR);
  const path = `${DB_BACKUP_DIR}/msgstore-${stamp(when)}.vcbak`;
  await RNFS.writeFile(path, blob, 'utf8');
  if (Platform.OS === 'android') { try { await RNFS.scanFile(path); } catch {} }
  await pruneLocalBackups();
  return { path, messageCount, sizeBytes };
}

/** Newest-first list of local backup files. */
export async function listLocalBackups(): Promise<LocalBackup[]> {
  try {
    if (!(await RNFS.exists(DB_BACKUP_DIR))) return [];
    const items = await RNFS.readDir(DB_BACKUP_DIR);
    return items
      .filter(i => i.isFile() && i.name.endsWith('.vcbak'))
      .map(i => ({ name: i.name, path: i.path, size: Number(i.size) || 0, mtime: i.mtime ? new Date(i.mtime).getTime() : 0 }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

async function pruneLocalBackups(): Promise<void> {
  const all = await listLocalBackups();
  for (const old of all.slice(KEEP_LOCAL)) { try { await RNFS.unlink(old.path); } catch {} }
}

/** Restore from a specific local backup file (or the newest if omitted). */
export async function restoreLocalBackup(path?: string): Promise<number> {
  let p = path;
  if (!p) { const list = await listLocalBackups(); if (!list.length) throw new Error('No local backup found'); p = list[0].path; }
  const blob = await RNFS.readFile(p, 'utf8');
  return applyEncryptedBackup(await getBackupKey(), blob);
}

export default {};
