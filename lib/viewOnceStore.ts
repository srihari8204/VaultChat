// lib/viewOnceStore.ts — remembers which view-once messages this device has
// already opened, so they stay "viewed" forever (across re-renders, scrolls, and
// app restarts). Without this, the ephemeral bubble state reset and the
// view-once shield kept reappearing — letting the media be viewed again.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vc_viewed_once';
let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = new Set<string>(raw ? JSON.parse(raw) : []);
  } catch { cache = new Set<string>(); }
  return cache;
}

/** Warm the cache so isViewedOnceSync works during the first render pass. */
export async function preloadViewedOnce(): Promise<void> { await load(); }

/** Synchronous check (valid after preloadViewedOnce). */
export function isViewedOnceSync(id: string): boolean {
  return cache ? cache.has(id) : false;
}

export async function isViewedOnce(id: string): Promise<boolean> {
  return (await load()).has(id);
}

export async function markViewedOnce(id: string): Promise<void> {
  const s = await load();
  if (s.has(id)) return;
  s.add(id);
  try { await AsyncStorage.setItem(KEY, JSON.stringify([...s])); } catch {}
}

export default {};
