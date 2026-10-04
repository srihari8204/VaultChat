// services/cache/cacheManager.ts — cache measurement + deletion (device side).
//
// ⚠️ DEVICE-ONLY (imports expo-file-system / AsyncStorage / the local DB): not
// run under the Node self-tests. It executes the plans that cachePlan.ts (pure,
// Node-tested) produces. The safety guarantee lives in the planner — this file
// only ever receives real cache-category ids and only ever touches CACHE_DIRS,
// which are cache locations, never user data.
//
// SEPARATION OF CACHE vs USER DATA (the key correctness property):
//   • CACHE_DIRS live under FileSystem.cacheDirectory — OS-evictable scratch.
//   • Chats, saved media, document ORIGINALS, backups (.vcbak), encryption keys
//     (SecureStore), settings, and OFFLINE downloads live under
//     documentDirectory / SecureStore and are NOT in this map, so no code path
//     here can reach them.
//   ⚠️ The exact sub-paths below are sensible defaults; confirm each against how
//   the corresponding subsystem (expo-image cache, media store, doc viewer, …)
//   actually writes its cache before enabling in production.
//
// Interruption-safe: deletion is per-file and idempotent (deleting an
// already-gone file is a no-op), so a killed cleanup simply resumes on the next
// run — it never leaves a half-deleted, corrupt cache.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { planCleanup, dueForAutoClean, type CacheCategoryId, type CleanupPlan } from './cachePlan';

const LAST_CLEAN_KEY = 'vc_cache_last_clean';
const AUTO_DAYS_KEY = 'vc_cache_auto_days';        // 0 = off, else 7/15/30
const CLEAR_LOGOUT_KEY = 'vc_cache_clear_logout';  // '1' = on

// Cache-category → directories to measure/clear (all under cacheDirectory).
// dbCache has no directory — it is handled by a VACUUM (see below).
function cacheDirs(): Record<Exclude<CacheCategoryId, 'dbCache'>, string[]> {
  const c = FileSystem.cacheDirectory ?? '';
  return {
    image:     [c + 'images/', c + 'ExponentImageCache/'],
    thumbnail: [c + 'thumbnails/'],
    video:     [c + 'videos/', c + 'video-cache/'],
    audio:     [c + 'audio/', c + 'voice-cache/'],
    document:  [c + 'doc-cache/'],
    ai:        [c + 'ai-cache/'],
    search:    [c + 'search-index/'],
    temp:      [c + 'tmp/', c + 'logs/'],
  };
}

async function dirSize(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return 0;
    if (!info.isDirectory) return (info as any).size ?? 0;
    const base = uri.endsWith('/') ? uri : uri + '/';
    const names = await FileSystem.readDirectoryAsync(base);
    let total = 0;
    for (const n of names) total += await dirSize(base + n);   // files return size, dirs recurse
    return total;
  } catch {
    return 0;
  }
}

/** Measure per-category cache size (bytes). Feeds cachePlan.summarizeSizes. */
export async function measureCacheSizes(): Promise<Record<string, number>> {
  const dirs = cacheDirs();
  const out: Record<string, number> = {};
  for (const id of Object.keys(dirs) as (keyof typeof dirs)[]) {
    let sum = 0;
    for (const d of dirs[id]) sum += await dirSize(d);
    out[id] = sum;
  }
  out.dbCache = 0;   // reclaimed by VACUUM; size shown as free-able, not scanned
  return out;
}

async function deleteDir(uri: string): Promise<void> {
  // idempotent: absent → no-op; present → remove the whole cache subtree.
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* keep going */ }
}

async function vacuumDbCache(): Promise<void> {
  // Rebuild/compact the local SQLite file. VACUUM rewrites free pages only — it
  // never drops rows, so messages/chats are untouched. Best-effort.
  try {
    const { getLocalDb } = require('../../lib/localDb');
    const db = await getLocalDb();
    await db.execAsync('VACUUM');
  } catch { /* best-effort */ }
}

export interface CleanupResult { freedBytes: number; clearedIds: CacheCategoryId[]; }

/**
 * Execute a plan produced by cachePlan.planCleanup. Only the plan's items are
 * touched (the planner already guaranteed they are cache). Returns the freed
 * bytes and which categories were cleared, and stamps the last-clean time.
 */
export async function executeCleanup(plan: CleanupPlan): Promise<CleanupResult> {
  const dirs = cacheDirs();
  const cleared: CacheCategoryId[] = [];

  for (const item of plan.items) {
    if (item.id === 'dbCache') {
      await vacuumDbCache();
    } else {
      for (const d of dirs[item.id as keyof typeof dirs] ?? []) await deleteDir(d);
    }
    cleared.push(item.id);
  }

  await AsyncStorage.setItem(LAST_CLEAN_KEY, String(Date.now())).catch(() => {});
  return { freedBytes: plan.totalBytes, clearedIds: cleared };
}

/** Last automatic/manual cleanup time (ms), or null if never. */
export async function getLastCleanAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_CLEAN_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Automatic-cleanup interval in days (0 = off). */
export async function getAutoCleanDays(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(AUTO_DAYS_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
/** Rejects when the setting could not be stored, so the caller can revert and say so. */
export async function setAutoCleanDays(days: number): Promise<void> {
  await AsyncStorage.setItem(AUTO_DAYS_KEY, String(days | 0));
}

/** Whether to clear cache automatically on logout. */
export async function getClearOnLogout(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(CLEAR_LOGOUT_KEY)) === '1'; } catch { return false; }
}
/** Rejects when the setting could not be stored, so the caller can revert and say so. */
export async function setClearOnLogout(on: boolean): Promise<void> {
  await AsyncStorage.setItem(CLEAR_LOGOUT_KEY, on ? '1' : '0');
}

// ─── Orchestration (boot + logout) ───────────────────────────────────────────

/**
 * Run automatic Smart Cleanup if it's due per the configured interval. Call from
 * the app-launch deferred pass. Safe/no-op when automatic cleanup is off or not
 * yet due. Runs in the background (the caller does not await UI-critically).
 */
export async function maybeAutoClean(): Promise<CleanupResult | null> {
  const days = await getAutoCleanDays();
  if (days <= 0) return null;
  const last = await getLastCleanAt();
  if (!dueForAutoClean(last, Date.now(), days)) return null;
  const sizes = await measureCacheSizes();
  return executeCleanup(planCleanup(sizes, { smart: true }));
}

/** Clear ALL cache on logout when the setting is enabled. No-op otherwise. */
export async function clearCacheOnLogout(): Promise<CleanupResult | null> {
  if (!(await getClearOnLogout())) return null;
  const sizes = await measureCacheSizes();
  return executeCleanup(planCleanup(sizes, { all: true }));
}
