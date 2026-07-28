// lib/family/presence.ts — the Family Circle presence engine.
//
// REUSES the exact live-location relay the app already ships: a session key is
// delivered E2E once via a 'location' message (content.lk), then each position is
// sealed and relayed over the socket event 'live_location_update' as an OPAQUE
// blob — the server stamps the sender's userId and fans it out to the circle's
// group room, never seeing coordinates. Family pings carry a bit more (speed, ts)
// so they seal with sealJSON/openJSON instead of encryptPosition.
//
// One watcher: I always see MYSELF on the map; I only BROADCAST when sharing is on.
// On-device geofences post "X arrived at / left <place>" as E2EE system messages.

import * as Location from 'expo-location';
import { emit, getSocket, joinChatRoom, leaveChatRoom } from '../socket';
import { newLiveKey, sealJSON, openJSON, putLiveKey, getLiveKey, clearLiveKey } from '../liveLocationCrypto';
import { sendMessage, getMessages, type Message } from '../chatService';
import { evaluateFences, type Geofence } from './geofence';
import { getPlaces } from './store';
import { type FamilyPing, type MemberPresence } from './types';
import { type LatLng } from '../nav/geo';

const LIVE_WINDOW_MS = 24 * 3600 * 1000;
const until = () => Date.now() + LIVE_WINDOW_MS;

// ── broadcast state (my location → my circles) ──
let watcher: Location.LocationSubscription | null = null;
let sharing = false;
let myKey: string | null = null;
let myId = '';
let myName = 'A member';
let circleIds: string[] = [];
const places = new Map<string, Geofence[]>();
const inside = new Map<string, Set<string>>();
let selfCb: ((p: MemberPresence) => void) | null = null;

async function deliverKeys() {
  if (!myKey) return;
  let seed: Location.LocationObject | null = null;
  try { seed = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }); } catch {}
  const lat = seed?.coords.latitude ?? 0, lng = seed?.coords.longitude ?? 0;
  for (const cid of circleIds) {
    // key delivered E2E, exactly like the chat live-location key exchange
    sendMessage(cid, JSON.stringify({ lat, lng, live: true, lk: myKey, until: until(), family: true }), 'location').catch(() => {});
  }
}

async function onFix(loc: Location.LocationObject) {
  const pos: LatLng = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const spd = loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : undefined;
  const ts = loc.timestamp || Date.now();

  selfCb?.({ userId: myId, pos, speed: spd, ts });   // always show myself

  if (!sharing || !myKey) return;
  const blob = sealJSON(myKey, { lat: pos.lat, lng: pos.lng, spd, ts } as FamilyPing);
  const u = until();
  for (const cid of circleIds) {
    if (blob) emit('live_location_update', { chatId: cid, blob, until: u }).catch(() => {});
    const fences = places.get(cid) ?? [];
    if (fences.length) {
      const set = inside.get(cid) ?? new Set<string>();
      inside.set(cid, set);
      for (const ev of evaluateFences(fences, pos, set)) {
        sendMessage(cid, `${myName} ${ev.type === 'enter' ? 'arrived at' : 'left'} ${ev.name}`, 'system').catch(() => {});
      }
    }
  }
}

export interface StartPresenceOpts { circleIds: string[]; myId: string; myName?: string; share: boolean; onSelf: (p: MemberPresence) => void; }

/** Start watching my location for the family map. Broadcasts to circles only if `share`. */
export async function startPresence(o: StartPresenceOpts): Promise<void> {
  await stopPresence();
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location permission is required for Family Circle.');
  circleIds = o.circleIds; myId = o.myId; myName = o.myName || 'A member'; selfCb = o.onSelf; sharing = o.share;
  for (const cid of circleIds) { places.set(cid, await getPlaces(cid)); inside.set(cid, new Set()); }
  if (sharing) { myKey = newLiveKey(); await deliverKeys(); }
  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, timeInterval: 8000, distanceInterval: 15 },
    onFix,
  );
}

/** Toggle broadcast without tearing down the watcher/map. */
export async function setSharing(share: boolean): Promise<void> {
  if (share === sharing) return;
  sharing = share;
  if (share) { myKey = newLiveKey(); await deliverKeys(); }
  else { myKey = null; for (const cid of circleIds) emit('live_location_stop', { chatId: cid }).catch(() => {}); }
}

export async function stopPresence(): Promise<void> {
  try { watcher?.remove(); } catch {}
  watcher = null;
  if (sharing) for (const cid of circleIds) emit('live_location_stop', { chatId: cid }).catch(() => {});
  sharing = false; myKey = null; circleIds = []; selfCb = null; places.clear(); inside.clear();
}

export function isSharing(): boolean { return sharing; }

/** Refresh a circle's geofences into the live broadcaster (call after editing Places). */
export async function reloadPlaces(circleId: string): Promise<void> {
  if (circleIds.includes(circleId)) places.set(circleId, await getPlaces(circleId));
}

// ── receive others' positions for one circle ──
export interface PresenceEvent { userId: string; presence: MemberPresence | null } // null = stopped

function lkFromMessage(m: Message): string | null {
  if (m?.type !== 'location' || !m.content) return null;
  try { const c = JSON.parse(m.content); return (c.live && typeof c.lk === 'string') ? c.lk : null; } catch { return null; }
}

/** Subscribe to a circle's live member positions. Captures E2E keys from history + live 'location' messages. */
export async function subscribeCircle(circleId: string, meId: string, onEvent: (e: PresenceEvent) => void): Promise<() => void> {
  await joinChatRoom(circleId);
  let disposed = false, refreshing = false;

  const captureFromHistory = async () => {
    if (refreshing) return; refreshing = true;
    try {
      const msgs = await getMessages(circleId, { limit: 60 });
      for (const m of msgs) { const lk = lkFromMessage(m); if (lk && m.senderId) putLiveKey(circleId, String(m.senderId), lk); }
    } catch {} finally { refreshing = false; }
  };
  await captureFromHistory();

  const s = await getSocket();
  const onUpd = (e: any) => {
    if (disposed || !e?.userId || !e.blob || String(e.userId) === String(meId)) return;
    if (e.chatId != null && String(e.chatId) !== String(circleId)) return;
    const key = getLiveKey(circleId, String(e.userId));
    if (!key) { captureFromHistory(); return; }         // key not captured yet → refetch; next blob decrypts
    const ping = openJSON<FamilyPing>(key, e.blob);
    if (ping && typeof ping.lat === 'number' && typeof ping.lng === 'number') {
      onEvent({ userId: String(e.userId), presence: { userId: String(e.userId), pos: { lat: ping.lat, lng: ping.lng }, speed: ping.spd, battery: ping.bat, ts: ping.ts || Date.now() } });
    }
  };
  const onStop = (e: any) => {
    if (disposed || !e?.userId) return;
    clearLiveKey(circleId, String(e.userId));
    onEvent({ userId: String(e.userId), presence: null });
  };
  const onNewMsg = (e: any) => { if (!disposed && e && String(e.chatId) === String(circleId) && e.type === 'location') captureFromHistory(); };

  s.on('live_location_update', onUpd);
  s.on('live_location_stop', onStop);
  s.on('new_message', onNewMsg);
  return () => {
    disposed = true;
    s.off('live_location_update', onUpd);
    s.off('live_location_stop', onStop);
    s.off('new_message', onNewMsg);
    leaveChatRoom(circleId).catch(() => {});
  };
}
