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
import { sendMessage, getMessages, decryptFromChat, type Message } from '../chatService';
import { recordAlert } from '../family/alerts';
import { haversine, type LatLng } from '../nav/geo';
import {
  estimateEta, hasArrived, distanceFromRoute, isDeviating, simplifyRoute, tripLive,
  type Trip, type TripPing,
} from './trips';

/** Socket events. Distinct from live_location_* so a trip never disturbs presence. */
const EV_UPDATE = 'trip_update';
const EV_END = 'trip_end';
/** Marker for the message that carries the trip's key and destination. */
const TRIP_PREFIX = 'VCTRIP1:';
/** Marker for the message that ENDS a trip for the whole group. Announcements
 *  are harvested from history, so without a durable end marker a finished trip
 *  kept re-appearing as active on every fresh subscribe. */
const TRIP_END_PREFIX = 'VCTRIPEND1:';

interface Announce {
  trip: Omit<Trip, 'id'> & { id: string };
  key: string;
}

/** Latest live announcement seen per group, so a joiner can adopt the
 *  starter's sealing key without every screen threading it through. */
const lastAnnounce = new Map<string, Announce>();

// ── server-backed trips (migration 113) ──────────────────────────────
// The trip itself lives on the server now: one authorized GET discovers it,
// so a family never depends on decrypting group history (the path that
// silently breaks when a member pair's sender-key session wedges). Pings for
// a server trip travel as PLAINTEXT derived numbers over the same relay —
// space activities are exempt from E2EE by owner directive — while legacy
// message-announced trips keep their sealed blobs. A 404 from the trip
// endpoints means an older server: everything falls back to the legacy
// announce path, so this client works against both.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const apiOf = () => (require('../api') as typeof import('../api')).api;

function tripFromServer(t: any): Trip | null {
  if (!t || typeof t.lat !== 'number' || typeof t.lng !== 'number') return null;
  return {
    id: `srv_${t.id}`,
    groupId: String(t.chatId),
    destination: { lat: t.lat, lng: t.lng },
    destinationName: String(t.destinationName || 'Destination'),
    startedBy: String(t.startedBy),
    startedAt: Number(t.startedAt) || Date.now(),
    leaderId: t.leaderId ? String(t.leaderId) : null,
  };
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
  // SERVER FIRST. The database's one-active-trip index resolves a racing
  // family: a 409 hands back the trip that won, and this device joins it.
  try {
    const resp: any = await apiOf()(`/chats/${groupId}/trip`, {
      method: 'POST',
      json: { destinationName, lat: destination.lat, lng: destination.lng, leader: opts.leaderId === me },
    });
    const t = tripFromServer(resp?.trip);
    if (t) {
      myId = me; myKey = null; active = t;
      wasDeviating = false; announcedArrival = false; lastRouteAt = 0;
      return t;
    }
  } catch (e: any) {
    if (e?.status === 409) {
      const t = tripFromServer(e.body?.trip);
      if (t) { await joinTrip(t, me); return t; }
    }
    if (e?.status !== 404) throw e;
    // 404 = server predates migration 113 — fall through to the legacy path.
  }

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
  lastAnnounce.set(groupId, announce);
  await sendMessage(groupId, TRIP_PREFIX + JSON.stringify(announce), 'system');
  // No joinChatRoom here: subscribeTrip owns the room (refcounted join/leave
  // pair). An unpaired join would pin the room past the last unsubscribe.
  return trip;
}

/** Adopt a trip announced by someone else. */
export async function joinTrip(trip: Trip, me: string, key?: string): Promise<void> {
  myId = me;
  active = trip;
  // Each participant seals with the key the starter published, so everyone in
  // the group can open everyone else's updates and nobody outside can.
  //
  // An empty/absent key resolves from the harvested announcement — the old
  // code accepted '' verbatim, so a joiner sealed with a key nobody else held
  // and their ETA was noise to the whole group. A server-backed trip
  // (srv_ id) has NO key by design: its pings travel as plaintext derived
  // numbers, so a missing announcement is normal there, not a failure.
  myKey = trip.id.startsWith('srv_') ? null : (key || lastAnnounce.get(trip.groupId)?.key || null);
  wasDeviating = false;
  announcedArrival = false;
  lastRouteAt = 0;
  // A follower's own route is irrelevant once there is a leader — theirs
  // arrives on the next ping and replaces it.
  if (trip.leaderId && trip.leaderId !== me) routeShape = [];
  // Room membership belongs to subscribeTrip — see startTrip.
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
  // Legacy trips need the sealing key; server-backed trips (srv_ id) publish
  // plaintext derived numbers and need none.
  if (!active) return;
  const serverTrip = active.id.startsWith('srv_');
  if (!serverTrip && !myKey) return;
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

  if (serverTrip) {
    // Only DERIVED numbers ride here (remaining metres, ETA, arrived flag) —
    // never a position — so plaintext discloses nothing presence doesn't.
    emit(EV_UPDATE, { chatId: active.groupId, tripId: active.id, plain: ping }).catch(() => {});
  } else {
    const blob = sealJSON(myKey!, ping);
    if (blob) emit(EV_UPDATE, { chatId: active.groupId, tripId: active.id, blob }).catch(() => {});
  }

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
 * The plaintext of one system message, decrypting when the circle is E2EE.
 *
 * The old harvest prefix-checked the RAW content — in an E2EE circle that is a
 * sender-key envelope, so the check failed silently for every announcement and
 * no member ever discovered a trip they did not start. The exact bug class the
 * presence key-harvest already fixed (see lkFromMessage in family/presence).
 */
async function tripTextOf(groupId: string, m: Message): Promise<string | null> {
  if (m?.type !== 'system' || !m.content || typeof m.content !== 'string' || (m as any).deletedAt) return null;
  if (m.content.startsWith(TRIP_PREFIX) || m.content.startsWith(TRIP_END_PREFIX)) return m.content;
  if (!m.senderId) return null;
  try { return await decryptFromChat(groupId, String(m.senderId), m.content, m.id); } catch { return null; }
}

/**
 * Subscribe to the group's trip updates. Returns an unsubscribe.
 *
 * The trip key is captured from group history the same way presence captures
 * its live-location key, so a member who joins late can still open updates.
 * `onTrip` reports the group's live trip — or NULL when there is none (ended,
 * or expired past TRIP_TTL_MS), so a banner can clear itself.
 */
export async function subscribeTrip(
  groupId: string,
  meId: string,
  onEvent: (e: TripEvent) => void,
  onTrip?: (t: Trip | null, key: string) => void,
): Promise<() => void> {
  await joinChatRoom(groupId);
  let disposed = false;
  /** The server answered the trip endpoint — it is the source of truth and
   *  the legacy message harvest stays off. False on 404 (older server). */
  let serverMode = false;

  const fetchServerTrip = async (): Promise<boolean> => {
    try {
      const resp: any = await apiOf()(`/chats/${groupId}/trip`, { method: 'GET' });
      serverMode = true;
      const t = tripFromServer(resp?.trip);
      if (t) {
        // Someone else's server trip ends any legacy state this device held.
        if (!disposed) onTrip?.(t, '');
      } else if (active?.groupId === groupId && active.id.startsWith('srv_')) {
        // Our server trip vanished (ended elsewhere) — clear it.
        active = null; myKey = null; routeShape = [];
        if (!disposed) onTrip?.(null, '');
      } else if (!disposed) {
        onTrip?.(active?.groupId === groupId && myKey ? active : null, myKey ?? '');
      }
      return true;
    } catch (e: any) {
      if (e?.status === 404) serverMode = false;
      return false;
    }
  };

  // One shared in-flight harvest, same reason as the presence key-harvest: a
  // second caller must wait for the keys to actually land, not race past them.
  // Server mode makes this a no-op: the GET above is the discovery.
  let harvesting: Promise<void> | null = null;
  const captureFromHistory = (): Promise<void> => {
    if (serverMode) return Promise.resolve();
    if (harvesting) return harvesting;
    harvesting = (async () => {
      try {
        const msgs = await getMessages(groupId, { limit: 60 });
        const ends: string[] = [];
        const announces: { senderId: string; a: Announce }[] = [];
        for (const m of msgs) {
          const text = await tripTextOf(groupId, m);
          if (!text) continue;
          if (text.startsWith(TRIP_END_PREFIX)) {
            try { ends.push(String(JSON.parse(text.slice(TRIP_END_PREFIX.length)).id)); } catch {}
            continue;
          }
          const a = announceFromText(text);
          if (a && m.senderId) announces.push({ senderId: String(m.senderId), a });
        }
        const now = Date.now();
        let found: Announce | null = null;
        for (const { senderId, a } of announces) {
          if (!tripLive(a.trip, ends, now)) continue;
          putLiveKey(groupId, senderId, a.key);
          // The NEWEST live trip is the group's trip — an older concurrent
          // announce lost the race and must not flap the banner.
          if (!found || a.trip.startedAt > found.trip.startedAt) found = a;
        }
        // Someone else ended the trip this device is participating in.
        if (active?.groupId === groupId && ends.includes(active.id)) {
          active = null; myKey = null; routeShape = [];
        }
        if (found) {
          lastAnnounce.set(groupId, found);
          if (!disposed) onTrip?.(found.trip, found.key);
        } else {
          lastAnnounce.delete(groupId);
          // My own just-started trip may not be in fetched history yet — the
          // starter's device knows its trip; only report "none" when there
          // genuinely is none.
          if (active?.groupId === groupId && myKey && tripLive(active, ends, now)) {
            if (!disposed) onTrip?.(active, myKey);
          } else if (!disposed) onTrip?.(null, '');
        }
      } catch { /* offline: a later message will carry it */ }
      finally { harvesting = null; }
    })();
    return harvesting;
  };
  if (!(await fetchServerTrip())) await captureFromHistory();

  const s = await getSocket();
  const deliver = (from: string, ping: TripPing) => {
    if (typeof ping.remainingM !== 'number') return;
    // Adopt the leader's route, and ONLY the leader's. Taking a route from
    // any sender would let one member off on a detour silently redefine
    // "on route" for the whole group.
    if (ping.route && active && active.leaderId === from && from !== meId) {
      routeShape = ping.route;
    }
    onEvent({ userId: from, ping: { ...ping, userId: from } });
  };
  const onUpd = (e: any) => {
    if (disposed || !e?.userId || String(e.userId) === String(meId)) return;
    if (e.chatId != null && String(e.chatId) !== String(groupId)) return;
    const from = String(e.userId);
    // Server-backed trips ping in the clear (derived numbers only).
    if (e.plain && typeof e.plain === 'object') {
      deliver(from, e.plain as TripPing);
      // A plain ping for a trip we don't know yet — the start event may have
      // been missed; the server has the truth.
      if (!active || active.groupId !== groupId) fetchServerTrip();
      return;
    }
    if (!e.blob) return;
    const key = getLiveKey(groupId, from);
    if (!key) { captureFromHistory(); return; }
    const ping = openJSON<TripPing>(key, e.blob);
    if (ping) deliver(from, ping);
  };
  // Server trip lifecycle: on either event, re-read the truth rather than
  // trusting the payload — one code path, no stale-event edge cases.
  const onSrvTrip = (e: any) => {
    if (!disposed && e && String(e.chatId) === String(groupId)) fetchServerTrip();
  };
  const onEnd = (e: any) => {
    if (disposed || !e?.userId) return;
    onEvent({ userId: String(e.userId), ping: null });
  };
  // A trip can start or end while this screen is open: both travel as system
  // messages, so a fresh one triggers a re-harvest — this is how a banner
  // appears without pings and disappears when the starter ends the trip.
  const onNewMsg = (e: any) => {
    if (!disposed && e && String(e.chatId) === String(groupId) && e.type === 'system') {
      captureFromHistory();
    }
  };

  s.on(EV_UPDATE, onUpd);
  s.on(EV_END, onEnd);
  s.on('new_message', onNewMsg);
  s.on('space_trip', onSrvTrip);
  s.on('space_trip_end', onSrvTrip);
  return () => {
    disposed = true;
    s.off(EV_UPDATE, onUpd);
    s.off(EV_END, onEnd);
    s.off('new_message', onNewMsg);
    s.off('space_trip', onSrvTrip);
    s.off('space_trip_end', onSrvTrip);
    leaveChatRoom(groupId).catch(() => {});
  };
}

function announceFromText(text: string): Announce | null {
  if (!text.startsWith(TRIP_PREFIX)) return null;
  try {
    const a = JSON.parse(text.slice(TRIP_PREFIX.length)) as Announce;
    if (!a?.trip?.id || !a.key || !a.trip.destination) return null;
    return a;
  } catch { return null; }
}

/** Read a trip announcement out of a group message, if it is one.
 *  Plaintext circles only — E2EE content needs the async harvest above. */
export function announceFromMessage(m: Message): Announce | null {
  if (!m?.content || typeof m.content !== 'string') return null;
  return announceFromText(m.content);
}

/** Leave the trip. Others see me drop out; the trip itself continues. */
export async function leaveTrip(): Promise<void> {
  if (!active) return;
  emit(EV_END, { chatId: active.groupId, tripId: active.id }).catch(() => {});
  active = null; myKey = null; routeShape = []; wasDeviating = false; announcedArrival = false;
}

/**
 * End the trip FOR THE WHOLE GROUP — a durable end marker in the thread, so
 * every device (including ones offline right now) stops showing it as active.
 */
export async function endTrip(): Promise<void> {
  if (!active) return;
  const { groupId, id } = active;
  lastAnnounce.delete(groupId);
  emit(EV_END, { chatId: groupId, tripId: id }).catch(() => {});
  if (id.startsWith('srv_')) {
    // The server broadcasts space_trip_end to the room; a failure here is
    // eventually corrected by the TTL, so ending locally is never blocked.
    try { await apiOf()(`/chats/${groupId}/trip/end`, { method: 'POST', json: {} }); } catch { /* TTL cleans up */ }
  } else {
    sendMessage(groupId, TRIP_END_PREFIX + JSON.stringify({ id }), 'system').catch(() => {});
  }
  active = null; myKey = null; routeShape = []; wasDeviating = false; announcedArrival = false;
}
