// lib/localCache.ts — generic local-first cache (WhatsApp model).
//
// Screens that read server data should paint the last-known value INSTANTLY
// from this cache, then fetch fresh in the background and reconcile. That gives
// instant re-opens + offline read, instead of a spinner-then-network wait.
//
// Usage (hook):
//   const { data, loading, error, reload } = useCachedResource(
//     'communities', () => listCommunities());
//
// Usage (manual, inside an existing load()):
//   const cached = await readCache<Foo[]>('foo:'+id);
//   if (cached) { setFoo(cached); setLoading(false); }
//   const fresh = await getFoo(id); setFoo(fresh); writeCache('foo:'+id, fresh);

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheKeyReady, decField, encField } from './cacheCrypto';

const PREFIX = 'vc_cache_';

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const v = await AsyncStorage.getItem(PREFIX + key);
    return v ? (JSON.parse(v) as T) : null;
  } catch { return null; }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try { await AsyncStorage.setItem(PREFIX + key, JSON.stringify(data)); } catch {}
}

export async function clearCache(key: string): Promise<void> {
  try { await AsyncStorage.removeItem(PREFIX + key); } catch {}
}

// ─── Sealed-or-nothing cache ────────────────────────────────────────────
//
// For data that must not sit in plain AsyncStorage — who you hide from (Ghost
// Mode), the IP addresses and user agents of your signed-in devices. It is
// sealed with the same at-rest key as the message cache (lib/cacheCrypto), and
// when that key is not loaded (VAULT_CACHE_ENCRYPTED off, or the app locked)
// NOTHING is written: the entry is removed instead, and the screen loads from
// the network like a cold start. Plaintext entries left by older builds are
// deleted on first read.
//
// ponytail: with VAULT_CACHE_ENCRYPTED off (the current default) these screens
// lose their offline first paint. That is the price of not storing the data in
// the clear; it comes back by itself once the cache key is provisioned.
const SEALED_MARK = 'enc:v1:';   // lib/cacheCrypto's sealed-field prefix

export async function writeSealedCache<T>(key: string, data: T): Promise<void> {
  try {
    const sealed = cacheKeyReady() ? encField(JSON.stringify(data)) : null;
    if (sealed && sealed.startsWith(SEALED_MARK)) await AsyncStorage.setItem(PREFIX + key, sealed);
    else await AsyncStorage.removeItem(PREFIX + key);
  } catch {}
}

export async function readSealedCache<T>(key: string): Promise<T | null> {
  try {
    const v = await AsyncStorage.getItem(PREFIX + key);
    if (!v) return null;
    if (!v.startsWith(SEALED_MARK)) {            // plaintext from an older build
      await AsyncStorage.removeItem(PREFIX + key);
      return null;
    }
    const pt = decField(v);
    if (!pt || pt === v) return null;            // locked, or sealed under another key
    return JSON.parse(pt) as T;
  } catch { return null; }
}

/**
 * Local-first resource hook. Paints cached data immediately (no spinner on a
 * warm cache), then fetches fresh and persists. `loading` is only true on the
 * very first cold load. Works offline (shows cache, surfaces a soft error).
 */
export function useCachedResource<T>(
  key: string,
  fetcher: () => Promise<T>,
): { data: T | null; loading: boolean; error: string | null; reload: () => Promise<void>; setData: (d: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    try {
      const fresh = await fetcherRef.current();
      setData(fresh);
      setError(null);
      writeCache(key, fresh);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const cached = await readCache<T>(key);
      if (!cancel && cached != null) { setData(cached); setLoading(false); }
      if (!cancel) await reload();
    })();
    return () => { cancel = true; };
  }, [key, reload]);

  return { data, loading, error, reload, setData };
}

export default {};
