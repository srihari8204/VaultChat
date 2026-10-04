// lib/googleDrive.ts — backup storage in the user's own Google Drive.
//
// Uses the Drive "appDataFolder" — a hidden, app-private folder in the user's
// Drive (they can't see it; we can only touch our own data). Exactly how
// WhatsApp backs up: the data lives in the USER's Drive, so storage + data-loss
// is on them, not us. We never see it on our servers.
//
// Requires Google Sign-In configured in the Firebase/Google project (OAuth
// Android client via SHA-1, Google sign-in enabled, Drive API enabled) and the
// drive.appdata scope.
//
// Every request here has a deadline (lib/backupTransfer): lib/cloudBackup runs
// the upload and download under its backup lock, and RN's fetch on Android has
// none of its own, so a dead link used to hold that lock until the app was
// killed. The interactive sign-in is NOT run under the lock: lib/cloudBackup
// signs in first, then calls these with `interactive` false.

import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { withDeadline, giveUpAfter, transferDeadlineMs, SMALL_REQUEST_MS } from './backupTransfer';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_NAME = 'vaultchat-backup.vcbak';

// Web client ID from google-services.json (oauth_client, client_type 3). Used by
// google-signin to mint tokens. If you change Firebase projects, update this.
const WEB_CLIENT_ID = '553821750020-2v6ul3cu0tr4o76uvtabjubgnbk2m40u.apps.googleusercontent.com';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  GoogleSignin.configure({ webClientId: WEB_CLIENT_ID, scopes: [SCOPE], offlineAccess: false });
  configured = true;
}

/** Get a Drive access token, signing in if needed (interactive) or skipping. */
export async function getDriveToken(interactive = true): Promise<string> {
  ensureConfigured();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: interactive });
  try {
    return (await GoogleSignin.getTokens()).accessToken;
  } catch {
    if (!interactive) throw new Error('not signed in');
    await GoogleSignin.signIn();
    return (await GoogleSignin.getTokens()).accessToken;
  }
}

export async function getDriveEmail(): Promise<string | null> {
  ensureConfigured();
  try {
    const u: any = await GoogleSignin.getCurrentUser();
    return u?.user?.email ?? u?.data?.user?.email ?? null;
  } catch { return null; }
}

export async function driveSignOut(): Promise<void> {
  try { await GoogleSignin.signOut(); } catch {}
}

/**
 * A token without UI (silent refresh), within a deadline; interactive sign-in
 * has none. The native refresh takes no signal, so it is given up on rather
 * than waited for (giveUpAfter): a token writes nothing, and a late one is
 * never used.
 */
function tokenFor(interactive: boolean): Promise<string> {
  return interactive ? getDriveToken(true) : giveUpAfter(SMALL_REQUEST_MS, () => getDriveToken(false));
}

async function findBackupFile(token: string): Promise<{ id: string; modifiedTime?: string; size?: string } | null> {
  const q = encodeURIComponent(`name='${BACKUP_NAME}'`);
  return withDeadline(SMALL_REQUEST_MS, async (signal) => {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)&q=${q}`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    );
    if (!r.ok) throw new Error(`drive list ${r.status}`);
    const j = await r.json();
    return j.files?.[0] ?? null;
  });
}

/**
 * The Drive copy, if any. `unavailable` when a Google account IS linked but
 * Drive could not be asked (offline, token refresh failed): NOT "no copy" —
 * lib/restoreDecision keeps uploads paused on it. With no linked account (or
 * no Google Play services) there is no Drive copy this phone can reach, and the
 * answer is a plain `exists: false`.
 */
export async function driveBackupMeta(): Promise<{ exists: boolean; modifiedTime?: string; size?: number; unavailable?: true }> {
  try {
    const token = await tokenFor(false);
    const f = await findBackupFile(token);
    return f ? { exists: true, modifiedTime: f.modifiedTime, size: Number(f.size) || 0 } : { exists: false };
  } catch {
    const linked = await getDriveEmail().catch(() => null);
    return linked ? { exists: false, unavailable: true } : { exists: false };
  }
}

/** Upload (or replace) the encrypted backup blob in the user's Drive appData. */
export async function driveUpload(blob: string, interactive = true): Promise<void> {
  const token = await tokenFor(interactive);
  const existing = await findBackupFile(token);
  const deadline = transferDeadlineMs(blob.length);
  if (existing) {
    const r = await withDeadline(deadline, (signal) => fetch(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: blob,
      signal,
    }));
    if (!r.ok) throw new Error(`drive update ${r.status}`);
    return;
  }
  const boundary = 'vcbnd' + Date.now();
  const meta = { name: BACKUP_NAME, parents: ['appDataFolder'] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${blob}\r\n--${boundary}--`;
  const r = await withDeadline(deadline, (signal) => fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    signal,
  }));
  if (!r.ok) throw new Error(`drive upload ${r.status}`);
}

/** Download the encrypted backup blob from the user's Drive, or null if none. */
export async function driveDownload(interactive = true): Promise<string | null> {
  const token = await tokenFor(interactive);
  const f = await findBackupFile(token);
  if (!f) return null;
  return withDeadline(transferDeadlineMs(Number(f.size) || undefined), async (signal) => {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!r.ok) throw new Error(`drive download ${r.status}`);
    return await r.text();
  });
}

export default {};
