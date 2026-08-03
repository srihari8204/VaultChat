// lib/iceCredentials.ts — pure reasoning about coturn REST credentials.
//
// No react-native / expo imports, so this runs under Node/tsx and is directly
// unit-checkable (same rationale as lib/icePriority.ts and lib/nav/geo.ts).
// lib/iceConfig.ts owns the fetching and the cache slot; the decisions live
// here, where they can be tested.
//
// The credential format is set by vaultchat-backend-go's userTurn():
//     username   = "<expiry-unix>:<user-id>"
//     credential = base64(HMAC-SHA1(TURN_SECRET, username))
// coturn validates the username, so the expiry embedded in it is authoritative —
// more so than the separate `ttl` field in the response body, which is
// informational and could drift from what was actually signed.

/** Minimal shape we need; the real IceServer type lives in lib/chatService. */
export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Longest we will reuse a fetched config, regardless of its stated expiry. */
export const MAX_CACHE_MS = 60 * 60 * 1000;      // 1 hour
/** Refresh this long before the credential actually expires. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;   // 5 minutes

/**
 * Earliest credential expiry in the list, as epoch ms, or 0 when none of the
 * entries carry one (a STUN-only response, or a TURN_SECRET-less backend).
 */
export function credentialExpiryMs(servers: readonly IceServerLike[]): number {
  let earliest = 0;
  for (const s of servers) {
    if (typeof s?.username !== 'string') continue;
    const secs = Number(s.username.split(':')[0]);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    const ms = secs * 1000;
    if (earliest === 0 || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * Epoch ms until which this config may be reused, or 0 for "do not cache".
 *
 * Whichever is sooner: the credential's own expiry less a safety margin, or the
 * MAX_CACHE_MS cap. The cap exists because a rotated TURN_SECRET silently
 * invalidates every outstanding credential — a day of failed relays is a far
 * worse outcome than one extra request per hour.
 */
export function cacheUntil(servers: readonly IceServerLike[], now: number): number {
  const expiry = credentialExpiryMs(servers);
  const byCap = now + MAX_CACHE_MS;
  const until = expiry > 0 ? Math.min(expiry - EXPIRY_MARGIN_MS, byCap) : byCap;
  return until > now ? until : 0;
}

export default {};
