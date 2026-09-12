// lib/remoteFlags.ts — fetch the kill switches once per launch.
//
// AUDIT F11. The decision lives in ./remoteFlagPolicy (no react-native,
// unit-testable); this is the plumbing.
//
// SYNCHRONOUS READS, ASYNCHRONOUS FETCH. Call sites are render paths — a tile
// list, a menu — and making them await would turn every one of them into a
// loading state for an answer that is "unchanged" essentially always. So the
// snapshot is fetched once at boot into a module-level value, and `flagEnabled`
// reads it synchronously. Before the fetch lands the snapshot is null, which
// resolves to the build's own intent: the app behaves exactly as shipped until
// the server says otherwise, which is the correct default at every instant.
//
// The last answer is persisted, so a cold start with no network still honours a
// kill switch set yesterday — the case that matters most, since a feature bad
// enough to switch off is usually bad on a bad connection too.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { SERVER_URL } from '../constants/server';
import { resolveFlag, sanitizeFlags, type RemoteFlags } from './remoteFlagPolicy';

export { resolveFlag, sanitizeFlags } from './remoteFlagPolicy';
export type { RemoteFlags } from './remoteFlagPolicy';

const CACHE_KEY = 'vaultchat.remoteFlags.v1';
const FLAGS_TIMEOUT_MS = 6000;

let snapshot: RemoteFlags | null = null;

/**
 * Is this feature on, for this build, right now?
 *
 * `buildTimeDefault` is the constant from constants/flags.ts (or a literal
 * `true` for a feature that has no build-time flag). The server can only lower
 * it — see remoteFlagPolicy for why that asymmetry is deliberate.
 */
export function flagEnabled(name: string, buildTimeDefault = true): boolean {
  return resolveFlag(name, buildTimeDefault, snapshot);
}

/** The current snapshot, for diagnostics screens. Never null after load(). */
export function remoteFlagSnapshot(): RemoteFlags {
  return snapshot ?? {};
}

/**
 * Load the kill switches. Call once, early, and do not await it on the render
 * path: it resolves to the persisted answer within milliseconds and to the
 * server's answer within a few seconds, and until then the app is simply
 * behaving as built.
 *
 * Never throws.
 */
export async function loadRemoteFlags(): Promise<RemoteFlags> {
  // Persisted answer first, so a kill switch survives a cold start with no
  // network. Applied immediately rather than after the fetch resolves.
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw) snapshot = sanitizeFlags(JSON.parse(raw));
  } catch {
    // A corrupt cache is not worth a failure — the server is about to answer.
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FLAGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/app/flags`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (res.ok) {
      const body = await res.json();
      snapshot = sanitizeFlags(body?.flags);
      try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(snapshot)); } catch {}
    }
  } catch {
    // Offline, an outage, or a server predating this endpoint. Keep whatever
    // the cache gave us; a failed request must never re-enable something an
    // operator switched off, nor switch off something they did not.
  } finally {
    clearTimeout(timer);
  }
  return snapshot ?? {};
}

export default { flagEnabled, loadRemoteFlags, remoteFlagSnapshot };
