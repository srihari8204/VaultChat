// lib/vaultBeamSettings.ts — VaultBeam auto-download preferences (on-device).
//
// Mirrors the lib/mediaPrefs pattern (AsyncStorage + in-memory cache + async
// get/set) but richer, and adds a useSyncExternalStore hook so the settings
// screen re-renders on change. Versioned key; unknown/old shapes fall back to
// the conservative defaults. Nothing here leaves the device.

import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VB_AUTO_MAX_BYTES } from '../constants/flags';

export type VBMode = 'manual' | 'auto';
export type VBNetwork = 'wifi' | 'cellular' | 'any';

export interface VBSettings {
  mode: VBMode;
  network: VBNetwork;
  unmeteredOnly: boolean;
  trustedOnly: boolean;
  maxBytes: number;        // user cap; always clamped to ≤ VB_AUTO_MAX_BYTES
  onlyCharging: boolean;
  notLowBattery: boolean;
  pauseRoaming: boolean;
}

// Defaults keep existing users unchanged (Manual). When a user switches to Auto,
// these conservative sub-settings apply until they change them.
export const DEFAULT_SETTINGS: VBSettings = {
  mode: 'manual',
  network: 'wifi',
  unmeteredOnly: true,
  trustedOnly: true,
  maxBytes: 500 * 1024 * 1024,   // 500 MB
  onlyCharging: false,
  notLowBattery: true,
  pauseRoaming: true,
};

// Selectable auto caps — deliberately no "Unlimited"; 2.5 GB is the hard max.
export const SIZE_OPTIONS: { label: string; bytes: number }[] = [
  { label: '100 MB', bytes: 100 * 1024 * 1024 },
  { label: '500 MB', bytes: 500 * 1024 * 1024 },
  { label: '1 GB',   bytes: 1024 * 1024 * 1024 },
  { label: '2.5 GB (max)', bytes: VB_AUTO_MAX_BYTES },
];

const KEY = 'vc_vaultbeam_settings_v1';

let cached: VBSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
const subs = new Set<() => void>();

function clamp(s: VBSettings): VBSettings {
  return { ...s, maxBytes: Math.min(Math.max(1, s.maxBytes), VB_AUTO_MAX_BYTES) };
}
function normalize(raw: any): VBSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  return clamp({
    mode: raw.mode === 'auto' ? 'auto' : 'manual',
    network: raw.network === 'cellular' || raw.network === 'any' ? raw.network : 'wifi',
    unmeteredOnly: raw.unmeteredOnly !== false,
    trustedOnly: raw.trustedOnly !== false,
    maxBytes: Number(raw.maxBytes) || DEFAULT_SETTINGS.maxBytes,
    onlyCharging: !!raw.onlyCharging,
    notLowBattery: raw.notLowBattery !== false,
    pauseRoaming: raw.pauseRoaming !== false,
  });
}

// Eager load so getSettingsCached() is warm for the ingest fast-path.
AsyncStorage.getItem(KEY).then(v => {
  if (v) { try { cached = normalize(JSON.parse(v)); } catch {} }
  loaded = true;
  for (const cb of subs) { try { cb(); } catch {} }
}).catch(() => { loaded = true; });

export function getSettingsCached(): VBSettings { return cached; }

export async function getSettings(): Promise<VBSettings> {
  if (loaded) return cached;
  try { const v = await AsyncStorage.getItem(KEY); if (v) cached = normalize(JSON.parse(v)); } catch {}
  loaded = true;
  return cached;
}

export async function saveSettings(next: VBSettings): Promise<void> {
  cached = clamp(next);
  loaded = true;
  for (const cb of subs) { try { cb(); } catch {} }
  try { await AsyncStorage.setItem(KEY, JSON.stringify(cached)); } catch {}
}

export async function patchSettings(patch: Partial<VBSettings>): Promise<void> {
  await saveSettings({ ...cached, ...patch });
}

export function useVBSettings(): VBSettings {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => cached,
    () => cached,
  );
}

export default { getSettings, getSettingsCached, saveSettings, patchSettings, useVBSettings };
