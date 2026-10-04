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
// 64-character recovery key and never reaches the server; blobs carry a `vcE2EE`
// header with the non-secret KDF parameters. See lib/backupCrypto — including
// why there is deliberately no escrow, and therefore no recovery from a
// forgotten secret.
//
// Everything below funnels through writeSecret()/decryptBlob(), so both modes
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

import { isSecretBackupKey } from './backupSecretKeys';
import { VISION_COMFORT_STORAGE_KEY } from './visionComfortModel';
import { vaultEncrypt, vaultDecrypt } from './vaultCrypto';
import {
  readE2EEHeader, stampE2EEHeader, newHeader, backupSecretAsync, generateRecoveryKey,
  passwordProblem, recoveryKeyId, normalizeRecoveryKey, heldSecretMayOpen, type E2EEHeader, type BackupMode,
} from './backupCrypto';
import { exportAll, importAll } from './localDb';
import {
  switchBackupSecret, createLock, isBackupSwitchError,
  type SecretPair, type SecretSlot, type PendingMarker,
} from './backupSecretSwitch';
// getCachedUser is what app/(constants)/authService's getCurrentUserAsync
// returned anyway — it is a one-line passthrough to this. Taken directly, so
// lib no longer reaches up into app (2026-09-17).
import { api, getCachedUser } from './api';
import { BACKUP_ROOT, ensureDir } from './storageRoots';
import { e2eeGetCached, e2eeCachePlaintext } from '../services/crypto/e2eeSession.rn';
import { buildBackup as buildFinanceBackup, restoreBackup as restoreFinanceBackup } from '../db/financeBackup';

/**
 * The id finance rows are tagged with. MUST match components/finance/useMe —
 * including its 'local' fallback — or a restore writes rows the finance screens
 * will never query back.
 */
async function financeUserId(): Promise<string> {
  const u = await getCachedUser().catch(() => null);
  return u?.id ?? 'local';
}

export interface BackupMeta {
  exists: boolean; sizeBytes?: number; messageCount?: number; updatedAt?: string;
  /**
   * The server could not be asked — offline, a captive portal, an outage, or a
   * response this build cannot decode. NEVER set on a real answer.
   *
   * WHY THIS EXISTS. The catch below has always collapsed "there is no backup"
   * and "we could not find out" into the same `{ exists: false }`, and one
   * caller acted on that difference without being able to see it:
   * app/(tabs)/chats.tsx burned its once-per-install restore offer before
   * reading `exists`, so a reinstall whose first launch was offline lost the
   * offer permanently — the user's whole history silently never offered again.
   * Offline-right-after-reinstall is the common case, not the edge case.
   *
   * Additive on purpose: every caller that reads `exists` is unaffected, and
   * only the one that must not act on a non-answer looks at this.
   */
  unavailable?: true;
}

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
// on and when they restore, never on the daily path. It dies with the app,
// which is the point: after a reinstall the secret must come from the user,
// because that is the only place it exists.
//
// ONE SecureStore record holds the secret AND its header, so a write is all or
// nothing. They used to be two items written one after the other: a failure
// between them left the new secret beside the old header, and every later
// backup was stamped with a salt its key was not derived from — unopenable on
// any other phone. The two legacy items are still read until the next write.
const E2EE_STORE = 'vc_backup_e2ee';
const LEGACY_SECRET_STORE = 'vc_backup_e2ee_secret';
const LEGACY_HEADER_STORE = 'vc_backup_e2ee_header';

/**
 * The stored pair. `unconfirmed` marks a recovery key the user has not yet
 * typed back on the key screen: it may never have been shown (the app died
 * between storing it and drawing it), so app/backup-e2ee shows it again until
 * it is confirmed. In 'key' mode the stored secret IS the key (backupSecret
 * passes it straight through).
 */
type StoredE2EE = SecretPair<E2EEHeader> & { unconfirmed?: boolean };

/** Thrown when this device's e2ee settings cannot be read. NEVER means "off". */
function unreadable(cause?: unknown): Error {
  const err: any = new Error('Backup encryption settings could not be read on this device.');
  err.code = 'BACKUP_SETTINGS_UNREADABLE';
  err.cause = cause;
  return err;
}
export function isBackupSettingsUnreadable(e: any): boolean {
  return e?.code === 'BACKUP_SETTINGS_UNREADABLE';
}

function asStored(p: any): StoredE2EE {
  if (typeof p?.secret !== 'string' || !p.secret || (p.header?.mode !== 'password' && p.header?.mode !== 'key')) {
    throw new Error('malformed');
  }
  return p as StoredE2EE;
}

/**
 * This device's e2ee pair, or null in account mode. FAILS CLOSED: a SecureStore
 * error or a corrupt record throws BACKUP_SETTINGS_UNREADABLE. It used to
 * return null, which read as "account mode" — the screen showed Off and the
 * next scheduled backup uploaded a server-readable copy over the user's
 * end-to-end encrypted one.
 */
async function storedE2EE(): Promise<StoredE2EE | null> {
  try {
    const raw = await SecureStore.getItemAsync(E2EE_STORE);
    if (raw) return asStored(JSON.parse(raw));
    const [secret, header] = await Promise.all([
      SecureStore.getItemAsync(LEGACY_SECRET_STORE),
      SecureStore.getItemAsync(LEGACY_HEADER_STORE),
    ]);
    // Half a legacy pair was always account mode (the old reader's rule).
    return secret && header ? asStored({ secret, header: JSON.parse(header) }) : null;
  } catch (e) { throw unreadable(e); }
}

const e2eeSlot: SecretSlot<E2EEHeader> = {
  get: storedE2EE,
  async put(pair) {
    await SecureStore.setItemAsync(E2EE_STORE, JSON.stringify(pair));
    // The record wins over the legacy items, so leftovers are harmless.
    await SecureStore.deleteItemAsync(LEGACY_SECRET_STORE).catch(() => {});
    await SecureStore.deleteItemAsync(LEGACY_HEADER_STORE).catch(() => {});
  },
  async clear() {
    // Legacy first: while the record exists it wins, so a failure part-way
    // leaves the device still on its secret, never on half a legacy pair.
    await SecureStore.deleteItemAsync(LEGACY_SECRET_STORE);
    await SecureStore.deleteItemAsync(LEGACY_HEADER_STORE);
    await SecureStore.deleteItemAsync(E2EE_STORE);
  },
};

// "A switch has not finished": the next backup run re-uploads under whatever
// the device holds, without waiting for the schedule. lib/backupScheduler reads
// the same key (it cannot import this module's constants under its selftest).
// Device-local, so it is never swept into a backup bundle. Holds no secret.
export const SWITCH_PENDING_KEY = 'vc_backup_switch_pending';
const pendingMarker: PendingMarker = {
  set: () => AsyncStorage.setItem(SWITCH_PENDING_KEY, String(Date.now())),
  clear: () => AsyncStorage.removeItem(SWITCH_PENDING_KEY),
};

// Every write that resolves a secret and uploads, and every switch, runs under
// this one lock (lib/backupSecretSwitch.createLock).
const backupLock = createLock();

/** Which mode this device is currently backing up in. Rejects when it cannot be read. */
export async function getBackupMode(): Promise<'account' | BackupMode> {
  return (await storedE2EE())?.header.mode ?? 'account';
}

/** The recovery key while it has not been confirmed as saved, else null. */
export async function getUnconfirmedRecoveryKey(): Promise<string | null> {
  const p = await storedE2EE();
  return p?.unconfirmed && p.header.mode === 'key' ? p.secret : null;
}

/** The user typed the key back: stop showing it. Only for the key the device holds. */
export function confirmRecoveryKey(key: string): Promise<void> {
  return backupLock(async () => {
    const p = await storedE2EE();
    if (p?.unconfirmed && p.secret === normalizeRecoveryKey(key)) {
      await e2eeSlot.put({ secret: p.secret, header: p.header });
    }
  });
}

/**
 * Turn on end-to-end encrypted backup — or, while it is on, change the password,
 * make a new key, or switch between them — and re-upload under the new key.
 * Returns the recovery key in 'key' mode. It is also kept, flagged unconfirmed,
 * until the user types it back (see StoredE2EE).
 *
 * The re-upload is not optional. Leaving the previous account-encrypted blob in
 * place would mean switching this on changed nothing an attacker cares about:
 * the old copy is still there and the server can still read it.
 *
 * Transactional (lib/backupSecretSwitch): on failure it throws a
 * BackupSwitchError saying what the device and the server copy are now under.
 * In 'key' mode, when the server copy was left under the new key, the error
 * carries that key as `recoveryKey`, so the screen can show it.
 */
export function enableE2EEBackup(
  mode: BackupMode, password?: string,
): Promise<{ recoveryKey?: string }> {
  const userSecret = mode === 'key' ? generateRecoveryKey() : (password ?? '');
  if (mode === 'password') {
    const problem = passwordProblem(userSecret);
    if (problem) return Promise.reject(new Error(problem));
  }
  return backupLock(async () => {
    const header = newHeader(mode, mode === 'key' ? userSecret : undefined);
    const next: StoredE2EE = { secret: await backupSecretAsync(header, userSecret), header };
    if (mode === 'key') next.unconfirmed = true;
    try {
      await switchBackupSecret(e2eeSlot, pendingMarker, next, (using) => uploadCloudBackupUsing(using).then(() => {}));
    } catch (e) {
      if (mode === 'key' && isBackupSwitchError(e) && e.server === 'next') e.recoveryKey = userSecret;
      throw e;
    }
    return mode === 'key' ? { recoveryKey: userSecret } : {};
  });
}

/**
 * Revert to the account-managed key and re-upload so the server copy matches.
 * The same transactional switch as enableE2EEBackup (next = account key): if the
 * upload or the clear fails, the device keeps writing encrypted backups instead
 * of silently switching to server-readable ones while the screen says "On".
 * Callers should re-read getBackupMode() on failure; the BackupSwitchError says
 * what the server copy is under.
 */
export function disableE2EEBackup(): Promise<void> {
  return backupLock(() => switchBackupSecret(e2eeSlot, pendingMarker, null, (using) => uploadCloudBackupUsing(using).then(() => {})));
}

/** Thrown by a restore that needs a secret this device does not hold. */
export function isSecretRequired(e: any): e is { code: string; mode: BackupMode } {
  return e?.code === 'BACKUP_SECRET_REQUIRED';
}

function secretRequired(mode: BackupMode): Error {
  const err: any = new Error('This backup is end-to-end encrypted.');
  err.code = 'BACKUP_SECRET_REQUIRED';
  err.mode = mode;
  return err;
}

/** The secret to WRITE with, plus the header to stamp (null ⇒ account-managed). Throws when unreadable. */
async function writeSecret(): Promise<{ secret: string; header: E2EEHeader | null }> {
  const e = await storedE2EE();
  if (e) return { secret: e.secret, header: e.header };
  return { secret: await accountBackupKey(), header: null };
}

/**
 * Decrypt a blob with the secret it needs — decided by the BLOB, not by what
 * this device happens to be set to. A device restoring someone's e2ee backup
 * has no local state to consult, and a device whose password or key has since
 * changed holds a secret that no longer opens it. Returns the bundle JSON.
 *
 * The device's own secret is tried only when the blob's header names it (same
 * password salt, same key id). A key-mode blob from before key ids existed is
 * tried too, and a failed decrypt then asks for the secret instead of failing
 * as an unexplained "restore failed" — after "Make a new key", an older copy
 * needs the OLD key, and the user is asked for it.
 */
async function decryptBlob(blob: string, userSecret?: string): Promise<string> {
  const payload = JSON.parse(blob);
  const header = readE2EEHeader(blob);
  if (!header) return vaultDecrypt(await accountBackupKey(), payload);   // account-managed or pre-e2ee
  if (userSecret) {
    if (header.mode === 'key' && header.kid && recoveryKeyId(userSecret) !== header.kid) {
      throw new Error('That key is not the one this backup was made with.');
    }
    return vaultDecrypt(await backupSecretAsync(header, userSecret), payload);
  }
  // A read failure here only means "ask the user", which is always safe.
  const cached = await storedE2EE().catch(() => null);
  if (cached && heldSecretMayOpen(cached.header, header)) {
    try { return vaultDecrypt(cached.secret, payload); } catch { /* not this device's secret: ask */ }
  }
  throw secretRequired(header.mode);
}

/** Back-compat for callers outside this module. */
export async function getBackupKey(): Promise<string> {
  return (await writeSecret()).secret;
}

/**
 * Gather everything + encrypt under the CURRENT key. Returns the opaque blob.
 * `using` overrides the key for one write (null = account key); only the
 * secret switch passes it, to upload under a pair the device does not hold yet.
 */
async function buildEncryptedBackup(using?: SecretPair<E2EEHeader> | null): Promise<{ blob: string; messageCount: number; sizeBytes: number }> {
  // 1. AsyncStorage prefs, minus keys that describe THIS INSTALL rather than the
  //    user. Restoring those onto another device makes it lie about its own
  //    state — e.g. carrying the media-migration flag across would convince a
  //    device that still has a legacy external tree that it had already been
  //    drained, stranding those files outside the sandbox permanently.
  const DEVICE_LOCAL_KEYS = new Set(['vc_media_migrated_v1', 'vc_restore_prompted', VISION_COMFORT_STORAGE_KEY, SWITCH_PENDING_KEY]);
  // ── Key material must not ride along in the blanket sweep ──────────────
  //
  // The exclusion documented above removed the e2eeKeys FIELD, and the identity
  // itself lives in SecureStore, so that part holds. But this sweep copies ALL
  // of AsyncStorage, and two kinds of key material live there:
  //
  //   vc_mk_*      per-file media keys (lib/mediaKeyStore.ts, whose own header
  //                says "the key never leaves the device"). With the DEFAULT
  //                account-managed mode the server holds the bundle key, so
  //                shipping these hands the server the keys to the attachment
  //                ciphertext it is already storing. Media E2EE, defeated.
  //                They are not needed for the stated goal either: readable
  //                history comes from the plaintext cache below.
  //
  //   vc_peer_ik_* the pinned peer identity keys behind the "safety number
  //                changed" warning (lib/keyChange.ts). Exported they leak who
  //                the user talks to; IMPORTED they are worse - applyEncrypted
  //                Backup does a blanket multiSet, so a bundle that controls
  //                these can pre-acknowledge a key change and silence the MITM
  //                warning for a chosen peer.
  //
  // Prefix-matched, not listed: both are per-peer/per-attachment (2026-09-17).
  const isSecret = isSecretBackupKey;
  const keys = await AsyncStorage.getAllKeys();
  const pairs = await AsyncStorage.multiGet(keys);
  const asyncStorage: Record<string, string | null> = {};
  for (const [k, v] of pairs) if (!DEVICE_LOCAL_KEYS.has(k) && !isSecret(k)) asyncStorage[k] = v;

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
  const { secret, header } = using === undefined ? await writeSecret()
    : using ?? { secret: await accountBackupKey(), header: null };
  const payload = vaultEncrypt(secret, bundle);              // real AES-256-GCM
  const blob = header ? stampE2EEHeader(payload, header) : JSON.stringify(payload);
  return { blob, messageCount: local.messages.length, sizeBytes: bundle.length };
}

/** Decrypt + apply a backup blob to local storage. Returns messages restored. */
async function applyEncryptedBackup(blob: string, userSecret?: string): Promise<number> {
  // Decrypted in full before anything is written: a wrong key changes nothing.
  const data = JSON.parse(await decryptBlob(blob, userSecret));

  if (data.asyncStorage) {
    // Filter on the way IN as well, not only on the way out. Bundles taken
    // before 2026-09-17 already contain vc_mk_* and vc_peer_ik_*, and this
    // multiSet would write them straight back. For the peer pins that is an
    // active attack surface: a bundle that pre-acknowledges a key change
    // silences the "safety number changed" warning for that peer, so a MITM
    // lands with the user never told.
    const entries = Object.entries(data.asyncStorage)
      .filter(([k, v]) => v != null && k !== VISION_COMFORT_STORAGE_KEY && !isSecretBackupKey(k)) as [string, string][];
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
// protobuf-migration. Decodes the typed answer into the SAME object the JSON
// path produces — including the SHAPE of the no-backup answer.
//
// The keys are added conditionally rather than assigned undefined, because the
// JSON for "no backup" is literally `{"exists":false}` with three keys ABSENT,
// not null. Writing `sizeBytes: undefined` would make `'sizeBytes' in meta`
// true on the typed path and false on the JSON path — a difference JSON.stringify
// hides (it drops undefined) and `in` does not.
//
// sizeBytes is int64 on the wire, so protobuf-es hands back a bigint; BackupMeta
// types it `number` and the JSON path has always produced one. Number() is the
// adaptation — the typed path adapts, the runtime type is not "fixed".
// ponytail: a backup above 2^53 bytes (9 PB) would lose precision here. Switch
// the field to jstype = JS_STRING and the interface to string if that day comes.
//
// The dynamic import carries no `.js` suffix: Metro cannot resolve one, and tsc
// does not catch it.
async function decodeBackupMeta(bytes: Uint8Array): Promise<BackupMeta> {
  const { BackupMeta: Wire } = await import('./ccwire/gen/ccwire/v1/backup_meta_pb');
  const m = Wire.fromBinary(bytes);
  const out: BackupMeta = { exists: m.exists };
  if (m.sizeBytes !== undefined) out.sizeBytes = Number(m.sizeBytes);
  if (m.messageCount !== undefined) out.messageCount = m.messageCount;
  if (m.updatedAt !== undefined) out.updatedAt = m.updatedAt;
  // THE SERVER'S OWN INVARIANT, ENFORCED HERE. userBackupMetaWrite (internal/
  // routes/user.go) sets the three detail fields only inside the `Exists`
  // branch, so `exists: true` with any of them missing is a shape the handler
  // cannot produce. Treat it as a corrupt body.
  //
  // This is not defensive decoration — protobuf-es does NOT throw on every
  // malformed body. The two bytes `0a 7f` (field 1 arriving with the
  // length-delimited wire type, claiming 127 bytes that are not there) decode
  // to exactly `{ exists: true }` with no error at all. Without this check a
  // truncated or rewritten response makes the app announce "A cloud backup was
  // found for this account" and offer a restore that cannot succeed.
  if (out.exists && (out.sizeBytes === undefined
    || out.messageCount === undefined || out.updatedAt === undefined)) {
    throw new Error('backup meta: exists=true without the details the server always sends');
  }
  return out;
}

export async function cloudBackupMeta(): Promise<BackupMeta> {
  // Passing a decoder only OFFERS protobuf. A server that answers JSON — every
  // deployment until the Go half ships — is parsed by the unchanged path in
  // api(), with no second request.
  try { return await api<BackupMeta>('/user/backup/meta', { proto: decodeBackupMeta }); }
  // `exists: false` is kept so every existing caller behaves exactly as before;
  // `unavailable` is the part that says this is not an answer. See BackupMeta.
  catch { return { exists: false, unavailable: true }; }
}

/**
 * Upload under the device's current pair. A success also settles an unfinished
 * secret switch: the server copy now matches what the device holds.
 */
export function uploadCloudBackup(): Promise<{ messageCount: number; sizeBytes: number }> {
  return backupLock(async () => {
    const r = await uploadCloudBackupUsing(undefined);
    await pendingMarker.clear().catch(() => {});
    return r;
  });
}

async function uploadCloudBackupUsing(
  using: SecretPair<E2EEHeader> | null | undefined,
): Promise<{ messageCount: number; sizeBytes: number }> {
  const { blob, messageCount, sizeBytes } = await buildEncryptedBackup(using);
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
  return applyEncryptedBackup(blob, userSecret);
}

export async function deleteCloudBackup(): Promise<void> {
  await api('/user/backup', { method: 'DELETE' });
}

// ── Google Drive (the user's own Drive — WhatsApp model) ─────────────────
import { driveUpload, driveDownload } from './googleDrive';

export function backupToGoogleDrive(interactive = true): Promise<{ messageCount: number; sizeBytes: number }> {
  return backupLock(async () => {
    const { blob, messageCount, sizeBytes } = await buildEncryptedBackup();
    await driveUpload(blob, interactive);
    return { messageCount, sizeBytes };
  });
}

export async function restoreFromGoogleDrive(userSecret?: string): Promise<number> {
  const blob = await driveDownload();
  if (!blob) throw new Error('No backup found');
  return applyEncryptedBackup(blob, userSecret);
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
export function writeLocalBackup(when: Date): Promise<{ path: string; messageCount: number; sizeBytes: number }> {
  return backupLock(async () => {
    const { blob, messageCount, sizeBytes } = await buildEncryptedBackup();
    await ensureDir(DB_BACKUP_DIR);
    const path = `${DB_BACKUP_DIR}/msgstore-${stamp(when)}.vcbak`;
    await RNFS.writeFile(path, blob, 'utf8');
    await pruneLocalBackups();
    return { path, messageCount, sizeBytes };
  });
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
  return applyEncryptedBackup(blob, userSecret);
}

export default {};
