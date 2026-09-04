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
// ── Two key modes, and only one of them is zero-knowledge ──────────────────
// DEFAULT (account-managed). The server generates the key, stores it
// (user_backup_keys.dek), and hands it back to any authenticated session via GET
// /user/backup/key. Anyone who can authenticate as the user — or who reads that
// table — can decrypt these blobs. Treat their confidentiality as equal to the
// account's, not better (audit F-2). This is on by default because it is the
// only mode where recovery needs nothing the user has to keep, and losing a
// phone must not mean losing every conversation on it. WhatsApp's default is
// the same, for the same reason.
//
// OPT-IN (end-to-end). The key comes from the user's password or a generated
// 64-digit recovery key and never reaches the server; blobs carry a `vcE2EE`
// header with the non-secret KDF parameters. See lib/backupCrypto — including
// why there is deliberately no escrow, and therefore no recovery from a
// forgotten secret.
//
// Everything below funnels through writeSecret()/readSecret(), so both modes
// cover all three destinations (server, Drive, local file) without any
// destination needing to know which mode is active.
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
import {
  readE2EEHeader, stampE2EEHeader, newHeader, backupSecret, generateRecoveryKey,
  passwordProblem, type E2EEHeader, type BackupMode,
} from './backupCrypto';
import { exportAll, importAll } from './localDb';
import { api } from './api';
import { BACKUP_ROOT, ensureDir } from './storageRoots';
import { e2eeGetCached, e2eeCachePlaintext } from '../services/crypto/e2eeSession.rn';
import { buildBackup as buildFinanceBackup, restoreBackup as restoreFinanceBackup } from '../db/financeBackup';
import { getCurrentUserAsync } from '../app/(constants)/authService';

/**
 * The id finance rows are tagged with. MUST match components/finance/useMe —
 * including its 'local' fallback — or a restore writes rows the finance screens
 * will never query back.
 */
async function financeUserId(): Promise<string> {
  const u = await getCurrentUserAsync().catch(() => null);
  return u?.id ?? 'local';
}

export interface BackupMeta { exists: boolean; sizeBytes?: number; messageCount?: number; updatedAt?: string }

// Account-managed backup key: fetched once from the server (which generates and
// stores it), cached on-device. No user passphrase needed — and, as set out
// above, no secrecy from the server either. This is the DEFAULT; the opt-in
// end-to-end mode below takes the server out of the loop entirely.
const BACKUP_KEY_STORE = 'vc_backup_dek';
async function accountBackupKey(): Promise<string> {
  let k = await SecureStore.getItemAsync(BACKUP_KEY_STORE).catch(() => null);
  if (k) return k;
  const r = await api<{ key: string }>('/user/backup/key');
  if (!r?.key) throw new Error('Could not get backup key');
  await SecureStore.setItemAsync(BACKUP_KEY_STORE, r.key).catch(() => {});
  return r.key;
}

// ── End-to-end encrypted backup (opt-in) ────────────────────────────────
// The derived secret is cached on-device so scheduled backups keep running
// silently — the user enters their password or recovery key when they turn this
// on and when they restore, never on the daily path. Both entries die with the
// app, which is the point: after a reinstall the secret must come from the user,
// because that is the only place it exists.
const E2EE_SECRET_STORE = 'vc_backup_e2ee_secret';
const E2EE_HEADER_STORE = 'vc_backup_e2ee_header';

async function storedE2EE(): Promise<{ secret: string; header: E2EEHeader } | null> {
  try {
    const [secret, raw] = await Promise.all([
      SecureStore.getItemAsync(E2EE_SECRET_STORE),
      SecureStore.getItemAsync(E2EE_HEADER_STORE),
    ]);
    if (!secret || !raw) return null;
    return { secret, header: JSON.parse(raw) as E2EEHeader };
  } catch { return null; }
}

/** Which mode this device is currently backing up in. */
export async function getBackupMode(): Promise<'account' | BackupMode> {
  return (await storedE2EE())?.header.mode ?? 'account';
}

/**
 * Turn on end-to-end encrypted backup and immediately re-upload under the new
 * key. Returns the recovery key when mode is 'key' — shown once, never stored
 * anywhere we could hand back later.
 *
 * The re-upload is not optional. Leaving the previous account-encrypted blob in
 * place would mean switching this on changed nothing an attacker cares about:
 * the old copy is still there and the server can still read it.
 */
export async function enableE2EEBackup(
  mode: BackupMode, password?: string,
): Promise<{ recoveryKey?: string }> {
  const header = newHeader(mode);
  const userSecret = mode === 'key' ? generateRecoveryKey() : (password ?? '');
  if (mode === 'password') {
    const problem = passwordProblem(userSecret);
    if (problem) throw new Error(problem);
  }
  const secret = backupSecret(header, userSecret);
  await SecureStore.setItemAsync(E2EE_SECRET_STORE, secret);
  await SecureStore.setItemAsync(E2EE_HEADER_STORE, JSON.stringify(header));
  try {
    await uploadCloudBackup();
  } catch (e) {
    // Roll back rather than leave the device claiming a protection whose blob
    // was never written — the next restore would ask for a secret that opens
    // nothing, and the readable copy on the server would still be the old one.
    await SecureStore.deleteItemAsync(E2EE_SECRET_STORE).catch(() => {});
    await SecureStore.deleteItemAsync(E2EE_HEADER_STORE).catch(() => {});
    throw e;
  }
  return mode === 'key' ? { recoveryKey: userSecret } : {};
}

/** Revert to the account-managed key and re-upload so the server copy matches. */
export async function disableE2EEBackup(): Promise<void> {
  await SecureStore.deleteItemAsync(E2EE_SECRET_STORE).catch(() => {});
  await SecureStore.deleteItemAsync(E2EE_HEADER_STORE).catch(() => {});
  await uploadCloudBackup();
}

/** Thrown by a restore that needs a secret this device does not hold. */
export function isSecretRequired(e: any): e is { code: string; mode: BackupMode } {
  return e?.code === 'BACKUP_SECRET_REQUIRED';
}

/** The secret to WRITE with, plus the header to stamp (null ⇒ account-managed). */
async function writeSecret(): Promise<{ secret: string; header: E2EEHeader | null }> {
  const e = await storedE2EE();
  if (e) return { secret: e.secret, header: e.header };
  return { secret: await accountBackupKey(), header: null };
}

/**
 * The secret to READ a specific blob with — decided by the BLOB, not by what
 * this device happens to be set to. A device restoring someone's e2ee backup
 * has no local state to consult, and a device whose password has since changed
 * holds a secret that no longer opens it.
 */
async function readSecret(blob: string, userSecret?: string): Promise<string> {
  const header = readE2EEHeader(blob);
  if (!header) return accountBackupKey();          // account-managed or pre-e2ee
  if (userSecret) return backupSecret(header, userSecret);
  const cached = await storedE2EE();
  // Salt match matters: a cached secret derived under a PREVIOUS password would
  // otherwise be fed to AES-GCM and fail as an unexplained "restore failed"
  // instead of simply asking for the current one.
  if (cached && cached.header.mode === header.mode && cached.header.salt === header.salt) {
    return cached.secret;
  }
  const err: any = new Error('This backup is end-to-end encrypted.');
  err.code = 'BACKUP_SECRET_REQUIRED';
  err.mode = header.mode;
  throw err;
}

/** Back-compat for callers outside this module. */
export async function getBackupKey(): Promise<string> {
  return (await writeSecret()).secret;
}

/** Gather everything + encrypt under the CURRENT key. Returns the opaque blob. */
async function buildEncryptedBackup(): Promise<{ blob: string; messageCount: number; sizeBytes: number }> {
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

  // 4. Vault Finance — ledgers, Lucky Draw groups/members/dues/auctions.
  //    These live in a SEPARATE SQLite file (interest.db) that no backup path
  //    covered, so losing the phone lost every ledger and collection record.
  //    Best-effort: a finance read must never sink a chat backup.
  let finance: any = null;
  try { finance = await buildFinanceBackup(await financeUserId()); }
  catch (e) { console.warn('[backup] finance snapshot skipped:', (e as any)?.message); }

  // NOTE: no e2eeKeys. v2 bundles carried the identity + per-peer ratchets; v3
  // deliberately does not (see the header). Restores re-key instead.
  // v4 adds `finance`; it is purely additive, so v3 bundles still restore.
  const bundle = JSON.stringify({
    v: 4,
    createdAt: new Date().toISOString(),
    asyncStorage,
    messages: local.messages,
    chats: local.chats,
    plaintexts,
    finance,
  });
  // Resolved HERE, at the moment of writing, rather than passed in — every
  // destination (server, Drive, local file) then encrypts under the same key
  // automatically, and turning e2ee on cannot leave one of them still writing
  // under the account key because a caller was missed.
  const { secret, header } = await writeSecret();
  const payload = vaultEncrypt(secret, bundle);              // real AES-256-GCM
  const blob = header ? stampE2EEHeader(payload, header) : JSON.stringify(payload);
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
  // v4+ bundles carry finance; v3 and earlier simply don't have the field.
  // Best-effort and non-destructive (merge by row id), so a finance failure
  // never costs the caller their restored messages.
  if (data.finance) {
    try { await restoreFinanceBackup(await financeUserId(), data.finance); }
    catch (e) { console.warn('[backup] finance restore skipped:', (e as any)?.message); }
  }
  return n;
}

// ── Cloud (zero-knowledge server storage) ───────────────────────────────
export async function cloudBackupMeta(): Promise<BackupMeta> {
  try { return await api<BackupMeta>('/user/backup/meta'); }
  catch { return { exists: false }; }
}

export async function uploadCloudBackup(): Promise<{ messageCount: number; sizeBytes: number }> {
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup();
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

export async function restoreCloudBackup(userSecret?: string): Promise<number> {
  const r = await api<{ mode?: string; downloadUrl?: string; blob?: string }>('/user/backup');
  let blob = r?.blob;
  if (r?.mode === 'object' && r.downloadUrl) {
    const resp = await fetch(r.downloadUrl);
    if (!resp.ok) throw new Error(`backup download failed (${resp.status})`);
    blob = await resp.text();
  }
  if (!blob) throw new Error('No backup found');
  return applyEncryptedBackup(await readSecret(blob, userSecret), blob);
}

export async function deleteCloudBackup(): Promise<void> {
  await api('/user/backup', { method: 'DELETE' });
}

// ── Google Drive (the user's own Drive — WhatsApp model) ─────────────────
import { driveUpload, driveDownload } from './googleDrive';

export async function backupToGoogleDrive(interactive = true): Promise<{ messageCount: number; sizeBytes: number }> {
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup();
  await driveUpload(blob, interactive);
  return { messageCount, sizeBytes };
}

export async function restoreFromGoogleDrive(userSecret?: string): Promise<number> {
  const blob = await driveDownload();
  if (!blob) throw new Error('No backup found');
  return applyEncryptedBackup(await readSecret(blob, userSecret), blob);
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
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup();
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
export async function restoreLocalBackup(path?: string, userSecret?: string): Promise<number> {
  let p = path;
  if (!p) { const list = await listLocalBackups(); if (!list.length) throw new Error('No local backup found'); p = list[0].path; }
  const blob = await RNFS.readFile(p, 'utf8');
  return applyEncryptedBackup(await readSecret(blob, userSecret), blob);
}

export default {};
