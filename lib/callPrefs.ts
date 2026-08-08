// lib/callPrefs.ts — call preferences that survive restarts.
//
// Today: low-data mode (Phase 6 of openspec/changes/calls-sfu-platform).
//
// Same shape as lib/mediaPrefs.ts — a cached value so the call screen can read
// it synchronously while placing a call, AsyncStorage behind it. A call cannot
// wait on disk I/O to decide its encoder ceiling.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vc_call_low_data';

let cached = false;
AsyncStorage.getItem(KEY).then(v => { if (v != null) cached = v === '1'; }).catch(() => {});

/** Synchronous read for the call setup path. */
export function getLowDataModeCached(): boolean { return cached; }

export async function getLowDataMode(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v != null) cached = v === '1';
  } catch {}
  return cached;
}

export async function setLowDataMode(on: boolean): Promise<void> {
  cached = on;
  try { await AsyncStorage.setItem(KEY, on ? '1' : '0'); } catch {}
}

export default {};
