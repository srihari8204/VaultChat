// lib/backupScheduler.ts — OPTIONAL scheduled backups + network policy.
//
// Backups are MANUAL by default: nothing leaves the device unless the user asks
// for it, either from the backup screen or when moving to a new device. A
// schedule only runs if the user turns one on.
//
// Runs a backup when one is due, honoring the user's settings:
//   • frequency: manual (default) | daily | weekly | monthly
//   • network:   'wifi' (default — Wi-Fi only) | 'any' (Wi-Fi or mobile data)
// Auto-backup is silent, so it needs the backup passphrase stored securely
// (captured the first time the user runs a manual backup). Without it, auto
// backup is skipped (manual still works).

import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { writeLocalBackup, backupToGoogleDrive } from './cloudBackup';

const SETTINGS_KEY = 'vc_backup_settings';

export interface BackupSettings {
  frequency: 'daily' | 'weekly' | 'monthly' | 'manual';
  network: 'wifi' | 'any';
  includeVideos: boolean;
  lastBackupAt: number;
}
// MANUAL by default. A backup copies decrypted chat history off the device, and
// the bundle key is account-managed (see the header of lib/cloudBackup) — so it
// is only as private as the account, not better. Doing that on a silent daily
// timer nobody asked for is the user's decision to make, not a default: they
// back up when they choose to, or when moving to a new device.
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  frequency: 'manual', network: 'wifi', includeVideos: false, lastBackupAt: 0,
};

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3, monthly: 30 * 24 * 3600e3,
};

// One-time flip of installs still carrying the OLD 'daily' default. Changing
// DEFAULT_BACKUP_SETTINGS alone would not reach them — their choice is already
// persisted — so every existing device would have kept backing up on a silent
// timer. Runs once (flag), so anyone who deliberately re-enables a schedule
// afterwards keeps it.
const AUTO_OFF_MIGRATION_KEY = 'vc_backup_auto_off_v1';

export async function getBackupSettings(): Promise<BackupSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_BACKUP_SETTINGS };
    const s: BackupSettings = { ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(raw) };
    if (s.frequency === 'daily' && !(await AsyncStorage.getItem(AUTO_OFF_MIGRATION_KEY))) {
      s.frequency = 'manual';
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)).catch(() => {});
      await AsyncStorage.setItem(AUTO_OFF_MIGRATION_KEY, '1').catch(() => {});
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

    // No passphrase: the backup key is account-managed. Local file always;
    // Google Drive SILENTLY (interactive=false) — only if already signed in, so
    // auto-backup never pops a sign-in dialog.
    await writeLocalBackup(new Date()).catch(() => {});
    await backupToGoogleDrive(false).catch(() => {});
    await saveBackupSettings({ ...s, lastBackupAt: Date.now() });
  } catch { /* never let a backup attempt crash startup */ }
}

export default {};
