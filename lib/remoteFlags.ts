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
import {
  resolveFlag, sanitizeFlags, flagsFromProtobuf, APP_FLAGS_ACCEPT,
  type RemoteFlags,
} from './remoteFlagPolicy';

export { resolveFlag, sanitizeFlags } from './remoteFlagPolicy';
export type { RemoteFlags } from './remoteFlagPolicy';

const CACHE_KEY = 'vaultchat.remoteFlags.v1';
const FLAGS_TIMEOUT_MS = 6000;

let snapshot: RemoteFlags | null = null;
let loading: Promise<RemoteFlags> | null = null;
let cacheReadyResolve: () => void;
const cacheReady = new Promise<void>((resolve) => { cacheReadyResolve = resolve; });

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
async function loadRemoteFlagsOnce(): Promise<RemoteFlags> {
  // Persisted answer first, so a kill switch survives a cold start with no
  // network. Applied immediately rather than after the fetch resolves.
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw) snapshot = sanitizeFlags(JSON.parse(raw));
  } catch {
    // A corrupt cache is not worth a failure — the server is about to answer.
  } finally {
    cacheReadyResolve();
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FLAGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/app/flags`, {
      headers: { Accept: APP_FLAGS_ACCEPT },
      signal: ctl.signal,
    });
    if (res.ok) {
      // Whichever representation came back. A server that does not know the
      // typed response — or a proxy that rewrites the content type — lands on
      // the JSON branch, which is the same parse this function always did.
      const binary = (res.headers.get('content-type') || '').includes('application/protobuf');
      const next = binary
        ? await flagsFromProtobuf(new Uint8Array(await res.arrayBuffer()))
        : sanitizeFlags((await res.json())?.flags);
      // ONLY ON A REAL ANSWER. flagsFromProtobuf returns null for bytes it
      // cannot decode, and overwriting the snapshot with `{}` there would
      // re-enable a feature an operator killed — the one outcome this endpoint
      // exists to prevent. sanitizeFlags never returns null, so the JSON branch
      // is unaffected by this guard.
      if (next) {
        snapshot = next;
        try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(snapshot)); } catch {}
      }
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

export function loadRemoteFlags(): Promise<RemoteFlags> {
  if (!loading) loading = loadRemoteFlagsOnce();
  return loading;
}

/** Wait only for the persisted kill switch; the network refresh continues. */
export function remoteFlagsCacheReady(): Promise<void> {
  void loadRemoteFlags();
  return cacheReady;
}

export default { flagEnabled, loadRemoteFlags, remoteFlagsCacheReady, remoteFlagSnapshot };
