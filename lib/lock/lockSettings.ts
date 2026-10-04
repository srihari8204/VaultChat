// lib/lock/lockSettings.ts — persisted Location Lock preferences: the alert
// channel configuration and the last-used radius. Same tiny external-store
// pattern as lib/nav/navSettings.ts so screens and the running lock service
// (foreground or headless) read identical values.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { type Units } from './format';
import { MODE_CONFIGS, type LockMode, type ZoneConfig } from './zoneMachine';

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

export type LockCadence = 'auto' | 'saver' | 'high';

export interface LockSettings {
  alerts: LockAlertSettings;
  lastRadius: number;        // last chosen radius (m), pre-selected next time
  units: Units;              // applies to every distance/speed readout
  mode: LockMode;            // monitoring sensitivity + navigate-back default
  customSensitivity: { warningBand: number; hysteresis: number };  // mode === 'custom'
  cadence: LockCadence;      // tracking frequency: adaptive / battery saver / high precision
}

export const DEFAULT_LOCK_ALERTS: LockAlertSettings = {
  siren: true, continuousBeep: true, vibration: true, voice: true, flash: true,
  volume: 1, tone: 'siren', vibePattern: 'strong',
  graceS: 5, repeat: true, repeatIntervalS: 10,
};

const DEFAULT: LockSettings = {
  alerts: DEFAULT_LOCK_ALERTS, lastRadius: 30,
  units: 'metric', mode: 'walking', customSensitivity: { warningBand: 5, hysteresis: 3 },
  cadence: 'auto',
};
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
  // The change is live in memory either way. A failed write is RETHROWN so the
  // screen can say the setting will not survive a restart: an alarm setting
  // that silently resets is a safety gap. Every caller catches.
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}

export async function setLockAlerts(patch: Partial<LockAlertSettings>): Promise<void> {
  await setLockSettings({ alerts: { ...settings.alerts, ...patch } });
}

/** The zone-engine config the current mode implies (custom applies the user's sliders). */
export function zoneConfigFor(s: LockSettings): ZoneConfig {
  const base = MODE_CONFIGS[s.mode] ?? MODE_CONFIGS.walking;
  if (s.mode !== 'custom') return base;
  return {
    ...base,
    warningBand: Math.max(2, Math.min(30, s.customSensitivity.warningBand)),
    hysteresis: Math.max(1, Math.min(20, s.customSensitivity.hysteresis)),
  };
}

export function useLockSettings(): LockSettings {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); if (!loaded) loadLockSettings(); return () => { subs.delete(cb); }; },
    () => settings, () => settings,
  );
}

export default {};
