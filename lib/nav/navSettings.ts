// lib/nav/navSettings.ts — persisted navigation preferences: the Direction-Lock
// profile, display mode, notification timing, costing, and any custom vibration
// patterns. A tiny external store (useSyncExternalStore) so the nav screen and
// the running session read the same values.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { type NavProfile, type HapticEvent, type HapticPattern } from './hapticLanguage';
import { type DisplayMode } from './hapticPlayer';
import { type NotifTiming } from './adaptiveDistance';
import { type Costing } from './routing';

export interface NavSettings {
  profile: NavProfile;
  mode: DisplayMode;
  timing: NotifTiming;
  costing: Costing;
  custom: Partial<Record<HapticEvent, HapticPattern>>;   // used when profile === 'custom'
}
const DEFAULT: NavSettings = { profile: 'standard', mode: 'vibrationOnly', timing: 'normal', costing: 'auto', custom: {} };
const KEY = 'vc_nav_settings_v1';

let settings: NavSettings = DEFAULT;
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((c) => { try { c(); } catch {} });

export async function loadNavSettings(): Promise<NavSettings> {
  if (loaded) return settings;
  loaded = true;
  try { const raw = await AsyncStorage.getItem(KEY); if (raw) settings = { ...DEFAULT, ...JSON.parse(raw) }; } catch {}
  emit();
  return settings;
}
export function getNavSettings(): NavSettings { return settings; }

export async function setNavSettings(patch: Partial<NavSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  emit();
  try { await AsyncStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
}

export function useNavSettings(): NavSettings {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); if (!loaded) loadNavSettings(); return () => { subs.delete(cb); }; },
    () => settings, () => settings,
  );
}

export default {};
