// lib/backupScheduler.ts — automatic backups on a schedule + network policy.
//
// Runs a backup when one is due, honoring the user's settings:
//   • frequency: daily (default) | weekly | monthly | manual
//   • network:   'wifi' (default — Wi-Fi only) | 'any' (Wi-Fi or mobile data)
// Auto-backup is silent, so it needs the backup passphrase stored securely
// (captured the first time the user runs a manual backup). Without it, auto
// backup is skipped (manual still works).

import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { writeLocalBackup, uploadCloudBackup } from './cloudBackup';

const SETTINGS_KEY = 'vc_backup_settings';

export interface BackupSettings {
  frequency: 'daily' | 'weekly' | 'monthly' | 'manual';
  network: 'wifi' | 'any';
  includeVideos: boolean;
  lastBackupAt: number;
}
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  frequency: 'daily', network: 'wifi', includeVideos: false, lastBackupAt: 0,
};

const INTERVAL_MS: Record<string, number> = {
  daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3, monthly: 30 * 24 * 3600e3,
};

export async function getBackupSettings(): Promise<BackupSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_BACKUP_SETTINGS };
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

    // No passphrase: the backup key is account-managed (fetched in cloudBackup).
    // Local file backup always; cloud upload best-effort.
    await writeLocalBackup(new Date()).catch(() => {});
    await uploadCloudBackup().catch(() => {});
    await saveBackupSettings({ ...s, lastBackupAt: Date.now() });
  } catch { /* never let a backup attempt crash startup */ }
}

export default {};
