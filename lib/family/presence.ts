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
import { type Geofence } from './geofence';
import { getPlaces, getSettings } from './store';
import { readBattery } from './battery';
import { processFix } from './fixPipeline';
import { recordSample } from './history';
import {
  startBackgroundPresence, stopBackgroundPresence, updateBackgroundKey,
  hasBackgroundPermission, isBackgroundRunning,
} from './background';
import { nextMotion, shouldPublish, type MotionState } from './cadence';
import { DEFAULT_FAMILY_SETTINGS, type FamilyPing, type MemberPresence } from './types';
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
// NOTE: the "inside" fence state used to live here and died with the screen, so
// every restart re-announced wherever you already were. It is now persisted by
// fixPipeline.ts, which is also what lets the background task continue the run.
let selfCb: ((p: MemberPresence) => void) | null = null;

// ── publish cadence (F1.4 / F2.3) ────────────────────────────────────────────
// The watcher still fires every 8 s / 15 m and every fix is still fed to the
// geofence engine and the history store — only the network emit is rate-limited,
// by motion state. `lastPublishAt = 0` means "publish the next fix immediately",
// which is what makes toggling sharing on (and an SOS) feel instant.
//
// The BACKGROUND publisher is deliberately left alone: it already runs at
// timeInterval 60 s / distanceInterval 75 m with pausesUpdatesAutomatically, so
// it is coarser than anything this throttle would impose.
let motion: MotionState = 'stationary';
let lastPublishAt = 0;
let baseIntervalMs = DEFAULT_FAMILY_SETTINGS.intervalMs;

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
  const bat = await readBattery();

  // always show myself, now with the battery the roster chip was already drawing
  selfCb?.({ userId: myId, pos, speed: spd, ts, battery: bat.level, charging: bat.charging });

  motion = nextMotion(motion, spd);
  const now = Date.now();
  const due = shouldPublish(lastPublishAt, now, motion, baseIntervalMs);

  const blob = sharing && myKey && due
    ? sealJSON(myKey, { lat: pos.lat, lng: pos.lng, spd, ts, bat: bat.level, chg: bat.charging } as FamilyPing)
    : null;
  if (blob) lastPublishAt = now;   // stamped once per fix, not once per circle
  const u = until();

  for (const cid of circleIds) {
    if (blob) emit('live_location_update', { chatId: cid, blob, until: u }).catch(() => {});
    // History and geofence alerts are LOCAL, so they run whether or not I am
    // broadcasting — but the circle is only told about a crossing when I am.
    await processFix(cid, {
      userId: myId, name: myName, pos, ts, speed: spd,
      battery: bat.level, charging: bat.charging,
    }, {
      self: true,
      fences: places.get(cid) ?? [],
      announce: sharing ? (text) => { sendMessage(cid, text, 'system').catch(() => {}); } : undefined,
    });
  }
}

export interface StartPresenceOpts { circleIds: string[]; myId: string; myName?: string; share: boolean; onSelf: (p: MemberPresence) => void; }

/** Start watching my location for the family map. Broadcasts to circles only if `share`. */
export async function startPresence(o: StartPresenceOpts): Promise<void> {
  await stopPresence();
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location permission is required for Family Circle.');
  circleIds = o.circleIds; myId = o.myId; myName = o.myName || 'A member'; selfCb = o.onSelf; sharing = o.share;
  // Fresh session: publish the very first fix, and honour the user's configured
  // moving cadence as the floor. A bad/missing setting falls back in cadence.ts.
  motion = 'stationary';
  lastPublishAt = 0;
  baseIntervalMs = (await getSettings().catch(() => DEFAULT_FAMILY_SETTINGS)).intervalMs;
  for (const cid of circleIds) places.set(cid, await getPlaces(cid));
  if (sharing) { myKey = newLiveKey(); await deliverKeys(); await handOffToBackground(); }
  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, timeInterval: 8000, distanceInterval: 15 },
    onFix,
  );
}

/**
 * Mirror the current publishing context into the background task so sharing
 * survives leaving the screen. A refused always-on permission is not an error:
 * we simply stay foreground-only, which is the old behaviour.
 */
async function handOffToBackground(): Promise<boolean> {
  if (!sharing || !circleIds.length) return false;
  try { return await startBackgroundPresence({ circleIds, myId, myName, key: myKey }); }
  catch { return false; }
}

/** Is the always-on background publisher currently running? */
export async function isBackgroundSharing(): Promise<boolean> { return isBackgroundRunning(); }
export async function canShareInBackground(): Promise<boolean> { return hasBackgroundPermission(); }

/** Toggle broadcast without tearing down the watcher/map. */
export async function setSharing(share: boolean): Promise<void> {
  if (share === sharing) return;
  sharing = share;
  if (share) {
    myKey = newLiveKey();
    lastPublishAt = 0;   // turning sharing on (incl. via SOS) publishes the next fix at once
    await deliverKeys();
    await handOffToBackground();
  } else {
    myKey = null;
    await stopBackgroundPresence();
    for (const cid of circleIds) emit('live_location_stop', { chatId: cid }).catch(() => {});
  }
}

/**
 * Tear down the FOREGROUND watcher only.
 *
 * This deliberately no longer stops sharing: app/family.tsx calls it whenever the
 * screen loses focus, and stopping there was exactly the bug — location sharing
 * died the moment you looked at anything else. When the background publisher is
 * running, sharing continues; only setSharing(false) is a real "stop".
 */
export async function stopPresence(): Promise<void> {
  try { watcher?.remove(); } catch {}
  watcher = null;
  selfCb = null;

  if (sharing && await isBackgroundRunning()) {
    await updateBackgroundKey(myKey);   // hand the live key over and let it run
    return;
  }
  if (sharing) for (const cid of circleIds) emit('live_location_stop', { chatId: cid }).catch(() => {});
  sharing = false; myKey = null; circleIds = []; places.clear();
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
      const uid = String(e.userId);
      const ts = ping.ts || Date.now();
      onEvent({ userId: uid, presence: {
        userId: uid, pos: { lat: ping.lat, lng: ping.lng }, speed: ping.spd,
        battery: ping.bat, charging: ping.chg, ts,
      } });
      // Keep this member's local history. Their geofences are evaluated on THEIR
      // device, so this records the track only — see fixPipeline.processFix.
      recordSample(circleId, { u: uid, lat: ping.lat, lng: ping.lng, ts, bat: ping.bat, spd: ping.spd })
        .catch(() => {});
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
