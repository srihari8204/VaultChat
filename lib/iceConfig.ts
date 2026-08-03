// lib/iceConfig.ts — cached ICE/TURN configuration for every WebRTC path.
//
// WHY
// ---
// Every call screen independently did:
//
//     const turn = await getTurnConfig().catch(() => ({ iceServers: [stun] }));
//
// so GET /user/turn sat on the critical path of every single call, before the
// first ICE candidate can even be gathered. On a slow mobile link that is a
// visible delay between tapping call and the phone ringing. The group mesh made
// it worse: joining a room fetches once, but any screen re-mount refetches.
//
// The credentials are cacheable by construction. vaultchat-backend-go's
// userTurn() issues coturn REST credentials as
//     username   = "<expiry-unix>:<user-id>"
//     credential = base64(HMAC-SHA1(TURN_SECRET, username))
// with a 24 h TTL, and returns the same TTL in the body. So the expiry is
// carried IN the credential itself — we parse that rather than trusting a
// separate field, because the username is what coturn actually validates.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It does not cache for the full 24 h. If TURN_SECRET is rotated server-side,
// every cached credential silently stops authenticating until it expires, and a
// day of failed relays is a far worse outcome than one extra request per hour.
// MAX_CACHE_MS caps the window; the credential's own expiry caps it further
// whenever that is sooner.
//
// Behaviour is otherwise identical to what the screens did: the same STUN-only
// list is returned when the request fails, so a call still proceeds on a
// direct/host candidate exactly as before.

import { getTurnConfig, type IceServer } from './chatService';
// Pure, RN-free, and covered by lib/iceCredentials.selftest.ts.
import { cacheUntil } from './iceCredentials';

/** Used when the request fails and we have nothing cached — same as before. */
const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

let cached: IceServer[] | null = null;
let cachedUntil = 0;
let inFlight: Promise<IceServer[]> | null = null;

/**
 * ICE servers for a new RTCPeerConnection. Never throws and never returns an
 * empty list: on failure it falls back to the last good config, then to STUN.
 *
 * Concurrent callers share one request — a mesh call bringing up several peer
 * connections at once issues a single fetch, not one per peer.
 */
export async function getIceServers(): Promise<IceServer[]> {
  const now = Date.now();
  if (cached && now < cachedUntil) return cached;
  if (inFlight) return inFlight;

  inFlight = getTurnConfig()
    .then(cfg => {
      const servers = cfg?.iceServers?.length ? cfg.iceServers : STUN_ONLY;
      const until = cacheUntil(servers, Date.now());   // 0 = do not cache
      if (until) { cached = servers; cachedUntil = until; }
      return servers;
    })
    .catch(() => cached ?? STUN_ONLY)   // last good config beats bare STUN
    .finally(() => { inFlight = null; });

  return inFlight;
}

/**
 * Drop the cache so the next call re-fetches. Intended for sign-out (the
 * credentials are scoped to a user id) and for a deliberate retry after a
 * relay-authentication failure.
 */
export function invalidateIceCache(): void {
  cached = null;
  cachedUntil = 0;
}

export default {};
