// lib/mediaPrefs.ts — media auto-download policy (WhatsApp-style, on-device).
//
// 'always'  → download on any network (default; current behaviour)
// 'wifi'    → only auto-download on Wi-Fi; on cellular show tap-to-download
// 'never'   → never auto-download; always tap-to-download

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

export type AutoDownloadPolicy = 'always' | 'wifi' | 'never';
const KEY = 'vc_media_autodownload';

let cached: AutoDownloadPolicy = 'always';
AsyncStorage.getItem(KEY).then(v => { if (v === 'wifi' || v === 'never' || v === 'always') cached = v; }).catch(() => {});

export function getAutoDownloadCached(): AutoDownloadPolicy { return cached; }

export async function getAutoDownload(): Promise<AutoDownloadPolicy> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v === 'wifi' || v === 'never' || v === 'always') { cached = v; return v; }
  } catch {}
  return cached;
}

export async function setAutoDownload(p: AutoDownloadPolicy): Promise<void> {
  cached = p;
  try { await AsyncStorage.setItem(KEY, p); } catch {}
}

/** Should an un-cached attachment auto-download right now (policy + network)? */
export async function shouldAutoDownloadNow(): Promise<boolean> {
  if (cached === 'always') return true;
  if (cached === 'never') return false;
  try { const s = await NetInfo.fetch(); return s.type === 'wifi'; } catch { return true; }
}
