// lib/lock/lockSettings.ts — persisted Location Lock preferences: the alert
// channel configuration and the last-used radius. Same tiny external-store
// pattern as lib/nav/navSettings.ts so screens and the running lock service
// (foreground or headless) read identical values.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

export type LockTone = 'siren' | 'beep';
export type LockVibe = 'strong' | 'medium' | 'pulse';

export interface LockAlertSettings {
  siren: boolean;            // loud siren / beep tone channel
  continuousBeep: boolean;   // repeating short beep channel
  vibration: boolean;
  voice: boolean;            // spoken warnings (TTS)
  flash: boolean;            // full-screen flashing alert
  volume: number;            // 0..1 alarm volume
  tone: LockTone;
  vibePattern: LockVibe;
  graceS: number;            // 0..60 s before the alarm fires after an exit
  repeat: boolean;           // keep re-firing until back inside
  repeatIntervalS: number;   // gap between alarm cycles when repeating
}

export interface LockSettings {
  alerts: LockAlertSettings;
  lastRadius: number;        // last chosen radius (m), pre-selected next time
}

export const DEFAULT_LOCK_ALERTS: LockAlertSettings = {
  siren: true, continuousBeep: true, vibration: true, voice: true, flash: true,
  volume: 1, tone: 'siren', vibePattern: 'strong',
  graceS: 5, repeat: true, repeatIntervalS: 10,
};

const DEFAULT: LockSettings = { alerts: DEFAULT_LOCK_ALERTS, lastRadius: 30 };
const KEY = 'vc_lock_settings_v1';

let settings: LockSettings = DEFAULT;
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((c) => { try { c(); } catch {} });

export async function loadLockSettings(): Promise<LockSettings> {
  if (loaded) return settings;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      settings = { ...DEFAULT, ...p, alerts: { ...DEFAULT_LOCK_ALERTS, ...(p?.alerts ?? {}) } };
    }
  } catch {}
  emit();
  return settings;
}

export function getLockSettings(): LockSettings { return settings; }

export async function setLockSettings(patch: Partial<LockSettings>): Promise<void> {
  settings = {
    ...settings, ...patch,
    alerts: patch.alerts ? { ...settings.alerts, ...patch.alerts } : settings.alerts,
  };
  emit();
  try { await AsyncStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
}

export async function setLockAlerts(patch: Partial<LockAlertSettings>): Promise<void> {
  await setLockSettings({ alerts: { ...settings.alerts, ...patch } });
}

export function useLockSettings(): LockSettings {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); if (!loaded) loadLockSettings(); return () => { subs.delete(cb); }; },
    () => settings, () => settings,
  );
}

export default {};
