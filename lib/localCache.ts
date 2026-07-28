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
