// components/chat/socketPayloads.ts — the shapes of the socket events
// components/chat/useChatSocket.ts takes as untyped `any` before, and the checks
// on the ones whose fields reach the screen. Pure (no React Native), so
// socketPayloads.selftest.ts runs it.
//
// A socket payload is input from the network: typed as optional fields and
// narrowed here, never trusted as-is.

import { inLatLngRange } from '../../lib/nav/urlCoords';

/** 'live_location_update': `blob` (E2E, preferred) or the legacy plaintext fields. */
export type LiveLocationEvent = {
  userId?: string;
  blob?: string;
  latitude?: unknown;
  longitude?: unknown;
  address?: unknown;
};

/** 'live_location_stop'. */
export type LiveLocationStopEvent = { userId?: string };

/** 'message_pinned': the server sends the id as a string, null when unpinned. */
export type PinnedEvent = { messageId?: string | number | null };

/**
 * The legacy plaintext position (an older sender), or null. The coordinates
 * used to be copied as whatever arrived; a string or an out-of-range pair then
 * landed in the live-location banner and the map pin. The server checks them
 * too (vaultchat-backend-go realtime handlers latLng), but not every server
 * this client talks to is that one.
 */
export function legacyLivePosition(e: LiveLocationEvent): { latitude: number; longitude: number; address?: string } | null {
  const { latitude, longitude, address } = e;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !inLatLngRange(latitude, longitude)) return null;
  return { latitude, longitude, address: typeof address === 'string' && address ? address : undefined };
}

/**
 * The pinned message id as the screen keeps it (a string, like
 * ChatSummary.pinnedMessageId), or null. PinnedBar matches it with
 * `String(m.id) === pinnedId`, so a numeric id must not be stored as a number.
 */
export function pinnedIdOf(e: PinnedEvent | null | undefined): string | null {
  const id = e?.messageId;
  return typeof id === 'string' ? (id || null) : typeof id === 'number' && Number.isFinite(id) ? String(id) : null;
}
