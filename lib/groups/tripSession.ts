// lib/groups/tripSession.ts — the live half of a group trip (Groups & Circles, G5).
//
// Trip state rides the SAME sealed relay as presence: the session key is
// delivered E2E once through a group message, and every subsequent update is a
// sealed blob the server fans out without reading. A trip therefore leaks no
// more than live location already does — the server sees that a group is busy,
// never where anyone is going.
//
// The pure reasoning (ETA, deviation, arrival, ordering) lives in
// lib/groups/trips.ts and is tested there. This file is the plumbing: publish
// my own state, receive everyone else's, and raise the two alerts a trip owes
// the group — a deviation and an arrival.

import { emit, getSocket, joinChatRoom, leaveChatRoom } from '../socket';
import { newLiveKey, sealJSON, openJSON, putLiveKey, getLiveKey } from '../liveLocationCrypto';
import { sendMessage, getMessages, type Message } from '../chatService';
import { recordAlert } from '../family/alerts';
import { haversine, type LatLng } from '../nav/geo';
import {
  estimateEta, hasArrived, distanceFromRoute, isDeviating, simplifyRoute,
  type Trip, type TripPing,
} from './trips';

/** Socket events. Distinct from live_location_* so a trip never disturbs presence. */
const EV_UPDATE = 'trip_update';
const EV_END = 'trip_end';
/** Marker for the message that carries the trip's key and destination. */
const TRIP_PREFIX = 'VCTRIP1:';

interface Announce {
  trip: Omit<Trip, 'id'> & { id: string };
  key: string;
}

let active: Trip | null = null;
let myKey: string | null = null;
let myId = '';
let routeShape: LatLng[] = [];
/** Alerts are raised on the EDGE, so a member who stays off-route is reported once. */
let wasDeviating = false;
let announcedArrival = false;
/** When the leader last put its route on the wire. */
let lastRouteAt = 0;

/** How often the leader re-sends its route, for devices that joined late. */
const ROUTE_REBROADCAST_MS = 60_000;

export function currentTrip(): Trip | null { return active; }

/**
 * Start a trip and tell the group. The destination travels inside an E2EE
 * message, not in the socket envelope, so the relay never learns it.
 */
export async function startTrip(
  groupId: string,
  me: string,
  destination: LatLng,
  destinationName: string,
  opts: { leaderId?: string | null } = {},
): Promise<Trip> {
  const trip: Trip = {
    id: `trip_${Date.now().toString(36)}`,
    groupId, destination, destinationName,
    startedBy: me, startedAt: Date.now(),
    leaderId: opts.leaderId ?? null,
  };
  myId = me;
  myKey = newLiveKey();
  active = trip;
  wasDeviating = false;
  announcedArrival = false;
  lastRouteAt = 0;

  const announce: Announce = { trip, key: myKey };
  await sendMessage(groupId, TRIP_PREFIX + JSON.stringify(announce), 'system');
  await joinChatRoom(groupId);
  return trip;
}

/** Adopt a trip announced by someone else. */
export async function joinTrip(trip: Trip, me: string, key: string): Promise<void> {
  myId = me;
  active = trip;
  // Each participant seals with the key the starter published, so everyone in
  // the group can open everyone else's updates and nobody outside can.
  myKey = key;
  wasDeviating = false;
  announcedArrival = false;
  lastRouteAt = 0;
  // A follower's own route is irrelevant once there is a leader — theirs
  // arrives on the next ping and replaces it.
  if (trip.leaderId && trip.leaderId !== me) routeShape = [];
  await joinChatRoom(trip.groupId);
}

/** The route this device is following, used for deviation checks. */
export function setTripRoute(shape: LatLng[]): void { routeShape = shape; }

/**
 * Publish my own state for one position fix.
 *
 * Everything shared here is DERIVED — a remaining distance, an ETA, a flag.
 * The position itself is never put on the trip channel; presence already
 * governs whether the group may see it, and duplicating it here would quietly
 * bypass a member's per-group privacy setting.
 */
export async function publishTripState(pos: LatLng, speed: number | undefined, name: string): Promise<void> {
  if (!active || !myKey) return;
  const now = Date.now();

  const remainingM = haversine(pos, active.destination);
  const arrived = hasArrived(pos, active.destination);
  const offRouteM = routeShape.length ? distanceFromRoute(pos, routeShape) : undefined;

  const ping: TripPing = {
    userId: myId,
    remainingM: Math.round(remainingM),
    speed,
    etaAt: arrived ? now : estimateEta(remainingM, speed, now),
    arrived,
    offRouteM: offRouteM == null ? undefined : Math.round(offRouteM),
    at: now,
  };

  // FOLLOW-THE-LEADER. The leader carries their route in the ping so followers
  // measure deviation against the road the group agreed on rather than against
  // whatever each phone routed for itself. Without it "follow the leader" means
  // nothing — everyone is still navigating independently and merely sharing a
  // destination.
  //
  // Sent on a cadence, not once: a follower who joins late, or reconnects, has
  // no history to replay a socket event from. It is coarse and bounded before
  // sending, because a full-fidelity polyline on every fix would dwarf the ping
  // it rides on.
  if (active.leaderId === myId && routeShape.length > 1 && now - lastRouteAt > ROUTE_REBROADCAST_MS) {
    ping.route = simplifyRoute(routeShape);
    lastRouteAt = now;
  }

  const blob = sealJSON(myKey, ping);
  if (blob) emit(EV_UPDATE, { chatId: active.groupId, tripId: active.id, blob }).catch(() => {});

  // ── the two alerts a trip owes the group ──
  const nowDeviating = isDeviating(ping.offRouteM);
  if (nowDeviating && !wasDeviating) {
    await recordAlert({
      circleId: active.groupId, kind: 'deviation', actorId: myId, actorName: name,
      tripId: active.id,
      // Reports the FACT of leaving the route, never a position — a member
      // sharing approximately or not at all must not be pinpointed by a trip.
      text: `${name} left the route to ${active.destinationName}`,
    });
  }
  wasDeviating = nowDeviating;

  if (arrived && !announcedArrival) {
    announcedArrival = true;
    await recordAlert({
      circleId: active.groupId, kind: 'enter', actorId: myId, actorName: name,
      tripId: active.id,
      text: `${name} arrived at ${active.destinationName}`,
    });
  }
}

export interface TripEvent { userId: string; ping: TripPing | null }

/**
 * Subscribe to the group's trip updates. Returns an unsubscribe.
 *
 * The trip key is captured from group history the same way presence captures
 * its live-location key, so a member who joins late can still open updates.
 */
export async function subscribeTrip(
  groupId: string,
  meId: string,
  onEvent: (e: TripEvent) => void,
  onTrip?: (t: Trip, key: string) => void,
): Promise<() => void> {
  await joinChatRoom(groupId);
  let disposed = false;

  const captureFromHistory = async () => {
    try {
      const msgs = await getMessages(groupId, { limit: 60 });
      for (const m of msgs) {
        const a = announceFromMessage(m);
        if (!a) continue;
        putLiveKey(groupId, String(m.senderId), a.key);
        onTrip?.(a.trip, a.key);
      }
    } catch { /* offline: a later message will carry it */ }
  };
  await captureFromHistory();

  const s = await getSocket();
  const onUpd = (e: any) => {
    if (disposed || !e?.userId || !e.blob || String(e.userId) === String(meId)) return;
    if (e.chatId != null && String(e.chatId) !== String(groupId)) return;
    const key = getLiveKey(groupId, String(e.userId));
    if (!key) { captureFromHistory(); return; }
    const ping = openJSON<TripPing>(key, e.blob);
    if (ping && typeof ping.remainingM === 'number') {
      const from = String(e.userId);
      // Adopt the leader's route, and ONLY the leader's. Taking a route from
      // any sender would let one member off on a detour silently redefine
      // "on route" for the whole group.
      if (ping.route && active && active.leaderId === from && from !== meId) {
        routeShape = ping.route;
      }
      onEvent({ userId: from, ping: { ...ping, userId: from } });
    }
  };
  const onEnd = (e: any) => {
    if (disposed || !e?.userId) return;
    onEvent({ userId: String(e.userId), ping: null });
  };

  s.on(EV_UPDATE, onUpd);
  s.on(EV_END, onEnd);
  return () => {
    disposed = true;
    s.off(EV_UPDATE, onUpd);
    s.off(EV_END, onEnd);
    leaveChatRoom(groupId).catch(() => {});
  };
}

/** Read a trip announcement out of a group message, if it is one. */
export function announceFromMessage(m: Message): Announce | null {
  if (!m?.content || typeof m.content !== 'string') return null;
  if (!m.content.startsWith(TRIP_PREFIX)) return null;
  try {
    const a = JSON.parse(m.content.slice(TRIP_PREFIX.length)) as Announce;
    if (!a?.trip?.id || !a.key || !a.trip.destination) return null;
    return a;
  } catch { return null; }
}

/** Leave the trip. Others see me drop out; the trip itself continues. */
export async function leaveTrip(): Promise<void> {
  if (!active) return;
  emit(EV_END, { chatId: active.groupId, tripId: active.id }).catch(() => {});
  active = null; myKey = null; routeShape = []; wasDeviating = false; announcedArrival = false;
}
