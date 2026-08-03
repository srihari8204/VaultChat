// lib/cloudBackup.ts — encrypted chat backup & restore.
//
// Bundles what is needed to restore readable chat history on a new device or
// after a reinstall:
//   • AsyncStorage prefs (themes, drafts, sound prefs, …)
//   • the local SQLite message DB (envelopes + chat list)
//   • the decrypted plaintext cache  ← so restored history is readable
//
// The bundle is AES-256-GCM encrypted on-device (lib/vaultCrypto) and stored as
// an opaque blob — as a local file, in the user's Google Drive, or on the server.
//
// ── What this is NOT ───────────────────────────────────────────────────────
// This is NOT a zero-knowledge backup, and earlier comments here wrongly said it
// was. On the default path the encryption key is ACCOUNT-MANAGED: the server
// generates it, stores it (user_backup_keys.dek), and hands it back to any
// authenticated session via GET /user/backup/key. Anyone who can authenticate as
// the user — or who reads that table — can decrypt any of these blobs. Treat the
// backup's confidentiality as equal to the account's, not better (audit F-2).
//
// ── Why E2EE identity keys are no longer included ──────────────────────────
// The bundle used to carry the long-term E2EE identity and every per-peer
// session ratchet, so a restore resumed sessions with no re-key. Combined with a
// server-recoverable bundle key, that meant the server could reconstruct the
// identity keys protecting every past and future message — retroactively
// defeating end-to-end encryption for the whole account.
//
// Identity material is therefore excluded from both export and import. The cost
// is real and accepted: restoring on a new device re-keys with peers (the
// existing X3DH + 'e2ee_rekey' recovery path handles this automatically). What
// the user actually wants back — readable history — comes from the plaintext
// cache, which is still included.

import * as RNFS from '@dr.pogodin/react-native-fs';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { vaultEncrypt, vaultDecrypt } from './vaultCrypto';
import { exportAll, importAll } from './localDb';
import { api } from './api';
import { BACKUP_ROOT, ensureDir } from './storageRoots';
import { e2eeGetCached, e2eeCachePlaintext } from '../services/crypto/e2eeSession.rn';

export interface BackupMeta { exists: boolean; sizeBytes?: number; messageCount?: number; updatedAt?: string }

// Account-managed backup key: fetched once from the server (which generates and
// stores it), cached on-device. No user passphrase needed — and, as set out
// above, no secrecy from the server either.
const BACKUP_KEY_STORE = 'vc_backup_dek';
export async function getBackupKey(): Promise<string> {
  let k = await SecureStore.getItemAsync(BACKUP_KEY_STORE).catch(() => null);
  if (k) return k;
  const r = await api<{ key: string }>('/user/backup/key');
  if (!r?.key) throw new Error('Could not get backup key');
  await SecureStore.setItemAsync(BACKUP_KEY_STORE, r.key).catch(() => {});
  return r.key;
}

/** Gather everything + encrypt with a secret. Returns the opaque blob. */
async function buildEncryptedBackup(secret: string): Promise<{ blob: string; messageCount: number; sizeBytes: number }> {
  // 1. AsyncStorage prefs, minus keys that describe THIS INSTALL rather than the
  //    user. Restoring those onto another device makes it lie about its own
  //    state — e.g. carrying the media-migration flag across would convince a
  //    device that still has a legacy external tree that it had already been
  //    drained, stranding those files outside the sandbox permanently.
  const DEVICE_LOCAL_KEYS = new Set(['vc_media_migrated_v1', 'vc_restore_prompted']);
  const keys = await AsyncStorage.getAllKeys();
  const pairs = await AsyncStorage.multiGet(keys);
  const asyncStorage: Record<string, string | null> = {};
  for (const [k, v] of pairs) if (!DEVICE_LOCAL_KEYS.has(k)) asyncStorage[k] = v;

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

  // NOTE: no e2eeKeys. v2 bundles carried the identity + per-peer ratchets; v3
  // deliberately does not (see the header). Restores re-key instead.
  const bundle = JSON.stringify({
    v: 3,
    createdAt: new Date().toISOString(),
    asyncStorage,
    messages: local.messages,
    chats: local.chats,
    plaintexts,
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
  // v2 bundles carry `data.e2eeKeys` (identity + per-peer ratchets). They are
  // deliberately IGNORED rather than imported: restoring long-term identity
  // material out of a bundle whose key the server can recover is what made the
  // backup a bypass of end-to-end encryption. Sessions re-key on next send.
  if (data.e2eeKeys) {
    console.warn('[backup] legacy v2 bundle: ignoring embedded E2EE identity keys — sessions will re-key');
  }
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

// ── Google Drive (the user's own Drive — WhatsApp model) ─────────────────
import { driveUpload, driveDownload } from './googleDrive';

export async function backupToGoogleDrive(interactive = true): Promise<{ messageCount: number; sizeBytes: number }> {
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup(await getBackupKey());
  await driveUpload(blob, interactive);
  return { messageCount, sizeBytes };
}

export async function restoreFromGoogleDrive(): Promise<number> {
  const blob = await driveDownload();
  if (!blob) throw new Error('No backup found');
  return applyEncryptedBackup(await getBackupKey(), blob);
}

// ── Local file backups ("Databases" folder) ──────────────────────────────
// Encrypted backup files written next to Media/ inside the PRIVATE sandbox, so
// a rolling set of restore points exists offline. Retention keeps the latest few.
//
// These used to live in the external media folder, which meant up to 7 full
// history bundles — decryptable with a server-held key — sat in a world-readable
// directory that survived uninstall (audit F-2). They are sandbox-only now.
const DB_BACKUP_DIR = BACKUP_ROOT;
const KEEP_LOCAL = 7;

export interface LocalBackup { name: string; path: string; size: number; mtime: number }

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
