// lib/backupScheduler.ts — automatic scheduled backups + network policy.
//
// Backups are DAILY by default (WhatsApp's model). This is what makes chat
// history survive an uninstall: the E2EE ratchet destroys old message keys, so
// the server's ciphertext can never be re-opened on a fresh install, and the
// local plaintext cache is the only readable copy of the user's history that
// exists anywhere. Nothing else copies it off the device.
//
// Runs a backup when one is due, honoring the user's settings:
//   • frequency: daily (default) | weekly | monthly | manual (off)
//   • network:   'wifi' (default — Wi-Fi only) | 'any' (Wi-Fi or mobile data)
//
// Destinations, in the order they are attempted:
//   1. the server  — the ONLY one that survives a reinstall; drives the
//                    restore prompt in (tabs)/chats.tsx
//   2. local file  — same-install recovery only (BACKUP_ROOT is sandboxed)
//   3. Google Drive — silent, so it is skipped unless already signed in, and
//                    absent entirely on no-GMS devices
//
// No passphrase: the bundle key is account-managed (see lib/cloudBackup's
// header), so the server can decrypt these blobs. That is deliberate and it is
// WhatsApp's default too — recovery works with nothing for the user to
// remember. Locking the provider out is a separate, opt-in feature.

import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { writeLocalBackup, backupToGoogleDrive, uploadCloudBackup } from './cloudBackup';

const SETTINGS_KEY = 'vc_backup_settings';

export interface BackupSettings {
  frequency: 'daily' | 'weekly' | 'monthly' | 'manual';
  network: 'wifi' | 'any';
  includeVideos: boolean;
  lastBackupAt: number;
}
// DAILY by default — the WhatsApp model, and the only thing that makes chat
// history survive an uninstall.
//
// This was 'manual', on the reasoning that a backup copies decrypted history
// off the device under an account-managed key (see the header of lib/cloudBackup),
// so it is only as private as the account and should be the user's choice.
//
// The privacy point is correct and unchanged. What it missed is what the
// alternative actually costs. E2EE keys live in SecureStore and die with the
// app; the ratchet destroys old message keys by design, so the server's
// ciphertext can NEVER be re-opened after a reinstall. The local plaintext
// cache is the only readable copy of a user's history that exists anywhere —
// and with no schedule, nothing ever copies it. The default was not "no
// backup", it was "silent, unannounced, total loss of chat history on
// uninstall", with no warning at any point.
//
// WhatsApp resolves the same tension the same way: automatic daily backup under
// an account-recoverable key by default, with an OPTIONAL end-to-end-encrypted
// backup (password / 64-digit key) for users who want the provider locked out.
// Default-on recovery, opt-in absolute secrecy. That is the shape to match.
//
// Wi-Fi-only stays the default, so this never spends someone's mobile data.
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  frequency: 'daily', network: 'wifi', includeVideos: false, lastBackupAt: 0,
};

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3, monthly: 30 * 24 * 3600e3,
};

// The flag written by the migration that USED to force schedules off. Its
// presence is the only way to tell "manual because we set it" from "manual
// because the user chose it", so the re-enable below is scoped to exactly the
// installs that flag marks.
const AUTO_OFF_MIGRATION_KEY = 'vc_backup_auto_off_v1';
// Runs once, and only for those installs. Changing DEFAULT_BACKUP_SETTINGS
// alone would never reach them: their forced 'manual' is already persisted, so
// every existing device would keep silently not backing up and would still lose
// its history on uninstall — the exact bug this is fixing, left in place for
// precisely the users who have been carrying it longest.
//
// A user who deliberately chose 'manual' AFTER that migration is flipped too;
// this cannot distinguish them. That is the intended trade: it happens once,
// it is visible in the backup screen, they can set it straight back, and the
// direction of the error is recoverable — whereas the other direction loses
// their chat history permanently and silently.
const AUTO_ON_MIGRATION_KEY = 'vc_backup_auto_on_v1';

export async function getBackupSettings(): Promise<BackupSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_BACKUP_SETTINGS };
    const s: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(raw) };
    if (s.frequency === 'manual'
        && (await AsyncStorage.getItem(AUTO_OFF_MIGRATION_KEY))
        && !(await AsyncStorage.getItem(AUTO_ON_MIGRATION_KEY))) {
      s.frequency = 'daily';
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)).catch(() => {});
      await AsyncStorage.setItem(AUTO_ON_MIGRATION_KEY, '1').catch(() => {});
    }
    return s;
  } catch { return { ...DEFAULT_BACKUP_SETTINGS }; }
}
export async function saveBackupSettings(s: BackupSettings): Promise<void> {
  try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

/** Record that a backup just happened (resets the due timer). */
export async function markBackupDone(): Promise<void> {
  const s = await getBackupSettings();
  await saveBackupSettings({ ...s, lastBackupAt: Date.now() });
}

/** Run a backup if the schedule is due AND the network policy allows it. Silent. */
export async function runScheduledBackupIfDue(): Promise<void> {
  try {
    const s = await getBackupSettings();
    if (s.frequency === 'manual') return;

    const interval = INTERVAL_MS[s.frequency] ?? INTERVAL_MS.daily;
    if (Date.now() - (s.lastBackupAt || 0) < interval) return;

    const net = await NetInfo.fetch();
    if (!net.isConnected) return;
    const onWifi = net.type === 'wifi';
    if (s.network === 'wifi' && !onWifi) return; // Wi-Fi-only and not on Wi-Fi → wait

    // CLOUD FIRST, because it is the only destination that survives a reinstall.
    //
    // This step did not exist, and its absence made the whole feature inert:
    // writeLocalBackup targets BACKUP_ROOT, which storageRoots puts inside the
    // app's PRIVATE sandbox (documentDirectory), so Android deletes it with the
    // app — it can restore a wiped cache on the SAME install and nothing more.
    // Google Drive is skipped whenever the user is not already signed in, and is
    // simply unavailable on the no-GMS devices this app supports.
    //
    // So on a plain Android handset a scheduled backup wrote one file that the
    // uninstall would delete and called it done. Meanwhile the restore prompt in
    // (tabs)/chats.tsx asks cloudBackupMeta() — the SERVER copy — which nothing
    // ever created, so it answered `exists:false` for everyone and the prompt
    // never fired. Both halves of the recovery path were present; they were
    // pointed at different stores.
    //
    // Ordered so the one that matters runs while the radio is known good.
    let ok = false;
    try { await uploadCloudBackup(); ok = true; } catch (e) {
      console.warn('[backup] cloud upload failed:', (e as any)?.message);
    }
    try { await writeLocalBackup(new Date()); ok = true; } catch {}
    try { await backupToGoogleDrive(false); ok = true; } catch {}

    // Only reset the timer if something was actually written. The old code
    // marked the run complete unconditionally, so an account that failed every
    // upload — expired token, no storage configured, offline mid-run — would
    // wait another full day before retrying while the backup screen reported it
    // as backed up. A failed backup the user believes succeeded is worse than
    // no backup at all: it is the one they will rely on.
    if (ok) await saveBackupSettings({ ...s, lastBackupAt: Date.now() });
  } catch { /* never let a backup attempt crash startup */ }
}

export default {};
