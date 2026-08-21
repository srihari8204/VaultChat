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
import { sendMessage, getMessages, decryptFromChat, type Message } from '../chatService';
import { type Geofence } from './geofence';
import { getPlaces, getDefaultRef } from './store';
import { refDistancesFor } from './distance';
import { planFor, shouldRearm, type LocationPlan } from './adaptive';
import { getGroupPrivacy } from '../groups/store';
import { applyPrivacy, isPublishing, type GroupPrivacy } from '../groups/privacy';
import { readBattery } from './battery';
import { processFix } from './fixPipeline';
import { recordSample } from './history';
import {
  startBackgroundPresence, stopBackgroundPresence, updateBackgroundKey,
  hasBackgroundPermission, isBackgroundRunning,
} from './background';
import { type FamilyPing, type MemberPresence } from './types';
import { type LatLng } from '../nav/geo';
import { publishPoint, publishStart, publishStop, stopPublisher } from '../location/publisher';
import { currentTrip, publishTripState } from '../groups/tripSession';

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
// Which of MY places leads the reference distances I publish, per circle.
// Cached beside `places` for the same reason: onFix runs on an 8s cadence and
// must not hit AsyncStorage every time.
const defaultRefs = new Map<string, string | null>();
// Per-group privacy, loaded at start and refreshed by reloadPrivacy(). Absent
// means "not loaded yet", which publishes nothing — failing closed.
const privacy = new Map<string, GroupPrivacy>();
// NOTE: the "inside" fence state used to live here and died with the screen, so
// every restart re-announced wherever you already were. It is now persisted by
// fixPipeline.ts, which is also what lets the background task continue the run.
let selfCb: ((p: MemberPresence) => void) | null = null;

// ── stationary keepalive ──
// A phone that does not move gets no watcher callbacks (the fused provider
// deduplicates identical fixes), so it publishes exactly ONE ping on entry.
// Any member who joins the room after that ping sees nothing, forever — the
// relay stores nothing to replay, by design. While sharing is on and the
// watcher is alive, re-assert the latest fix on a slow pulse: "still here"
// is a true statement, and the receiver's freshness stays honest because it
// reflects a device that is genuinely still reporting from that position.
let keepalive: ReturnType<typeof setInterval> | null = null;
let lastLoc: Location.LocationObject | null = null;

// ── adaptive cadence (AdaptiveFamilyLocationEngine) ──
// The watcher's interval is no longer a constant. `plan` is the cadence
// currently armed; after each fix the engine re-decides from movement,
// battery, charge, GPS quality and foreground state, and the watcher is
// re-armed only when the numbers actually change (shouldRearm).
let plan: LocationPlan | null = null;
/**
 * What the OS watcher is ACTUALLY armed with — distinct from `plan`, which is
 * the cadence the engine currently WANTS (and what the diagnostics row shows).
 *
 * They diverge whenever a re-arm is deferred by REARM_FLOOR_MS, and conflating
 * the two silently disabled adaptation entirely (see replan). Only armWatcher
 * may write this.
 */
let armedPlan: LocationPlan | null = null;
let foreground = true;
let lastRearmAt = 0;
/** Bumped by every startPresence; a call whose generation is stale aborts
 *  rather than overwriting a newer one's state. See startPresence. */
let startGen = 0;
/**
 * Floor between watcher re-arms. Speed hovering either side of the 10 km/h
 * moving threshold — stop-start traffic, a slow walk — would otherwise flip the
 * tier on alternate fixes and tear down the OS watcher every few seconds, which
 * costs more than the cadence saves and risks the platform refusing one.
 */
const REARM_FLOOR_MS = 30_000;
/**
 * Speed fed to the engine for the OPENING arm only, so it selects its fastest
 * tier before any real fix exists. Not a claim that the device is moving —
 * nothing is published from it, and the first genuine fix replaces the plan.
 */
const OPENING_SPEED_MS = 15;
/** The screen has told us the app went background/locked. */
export function setPresenceForeground(v: boolean): void {
  if (foreground === v) return;
  foreground = v;
  // Re-plan on the next fix rather than immediately: re-arming the OS watcher
  // during a backgrounding transition is exactly when the platform is least
  // willing to hand one back.
  //
  // Backgrounding is also the moment to land the history write-behind cache:
  // the OS may kill the process any time after this, and a flushed track is
  // the difference between losing nothing and losing the last 30 seconds.
  if (!v) recordFlush();
}
function recordFlush(): void {
  // Lazy require, matching how history is consumed elsewhere in this module's
  // graph — a static import cycle here would be the only thing it could buy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { (require('./history') as typeof import('./history')).flushHistory().catch(() => {}); } catch {}
}

const ACCURACY: Record<LocationPlan['accuracy'], Location.Accuracy> = {
  high: Location.Accuracy.High,
  balanced: Location.Accuracy.Balanced,
  low: Location.Accuracy.Low,
};

function startKeepalive(ms: number) {
  stopKeepalive();
  if (!ms) return;
  keepalive = setInterval(() => {
    if (!sharing || !myKey || !lastLoc || !watcher) return;
    // Re-asserting the LAST REAL FIX with a current timestamp. This is a true
    // statement — the device is still reporting from that position — and is
    // the opposite of fabricating one: no coordinate is invented, ever.
    onFix({ ...lastLoc, timestamp: Date.now() });
  }, ms);
}
function stopKeepalive() { if (keepalive) { clearInterval(keepalive); keepalive = null; } }

/**
 * Arm (or re-arm) the OS watcher at the planned cadence.
 *
 * THE NEW WATCHER IS CREATED BEFORE THE OLD ONE IS REMOVED, and that order is
 * load-bearing. Removing first and then failing to create leaves the device
 * with NO location watcher at all — sharing silently dead until the screen is
 * re-entered — and this runs from inside the old watcher's own callback, which
 * is exactly where a platform is most likely to refuse. Overlapping for a few
 * milliseconds is harmless: onFix is idempotent per fix and the extra one is
 * gone before the next tick.
 */
async function armWatcher(next: LocationPlan): Promise<void> {
  const old = watcher;
  const fresh = await Location.watchPositionAsync(
    {
      accuracy: ACCURACY[next.accuracy],
      timeInterval: next.timeIntervalMs,
      distanceInterval: next.distanceIntervalM,
    },
    onFix,
  );
  watcher = fresh;
  try { old?.remove(); } catch {}
  plan = next;
  armedPlan = next;      // the ONLY place the armed cadence is recorded
  lastRearmAt = Date.now();
  if (sharing) startKeepalive(next.keepaliveMs);
}

/**
 * Re-decide the cadence after a fix, and re-arm if it materially changed.
 *
 * Never throws into the fix path: a platform that refuses a new watcher leaves
 * the OLD one running, which is a working state, not a failure. Dropping the
 * watcher on the floor here would stop location entirely — a far worse
 * outcome than an out-of-date cadence.
 */
async function replan(loc: Location.LocationObject, bat: { level?: number; charging?: boolean }): Promise<void> {
  const speed = loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : null;
  const acc = loc.coords.accuracy != null && loc.coords.accuracy >= 0 ? loc.coords.accuracy : null;
  const next = planFor({
    foreground,
    // This module cannot observe the lock screen directly; a backgrounded app
    // is the closest honest proxy, and the background task owns the truly
    // locked case.
    locked: false,
    sharing,
    speedMs: speed,
    batteryPct: bat.level ?? null,
    charging: bat.charging,
    accuracyM: acc,
  });
  // COMPARE AGAINST WHAT IS ACTUALLY ARMED, never against what we last wanted.
  //
  // This used to test `shouldRearm(plan, next)` while both early returns below
  // assigned `plan = next`. One fix inside the re-arm floor was therefore
  // enough to make `plan` describe the DESIRED cadence, after which every
  // later comparison was desired-vs-desired — identical, so `shouldRearm`
  // said no and the watcher never re-armed at all. Measured on the Honor:
  // the opening fast arm (5 s) survived indefinitely while the diagnostics row
  // read "every 15s" — 3x the intended GPS cost, and a UI that stated the
  // opposite of what the device was doing.
  if (!shouldRearm(armedPlan, next)) { plan = next; return; }
  // Hold the current cadence until the floor passes. `plan` still advances so
  // the diagnostics row tells the truth about the SITUATION, while
  // `armedPlan` keeps telling the truth about the WATCHER.
  if (Date.now() - lastRearmAt < REARM_FLOOR_MS) { plan = next; return; }
  // A failure here leaves the EXISTING watcher running — armWatcher creates
  // before it removes, so there is always one.
  try { await armWatcher(next); } catch { /* keep the watcher we have */ }
}

/** The cadence currently in force, for the diagnostics row. Null = not watching. */
export function currentPlan(): LocationPlan | null { return plan; }

/** Re-plan from the last known fix — used when sharing is toggled, which
 *  changes the tier without a new position arriving. */
async function replanNow(): Promise<void> {
  if (!watcher) return;
  if (lastLoc) { await replan(lastLoc, await readBattery()); return; }
  const next = planFor({ foreground, locked: false, sharing });
  if (shouldRearm(armedPlan, next)) { try { await armWatcher(next); } catch {} }
  else { plan = next; if (sharing) startKeepalive(next.keepaliveMs); }
}

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
  lastLoc = loc;
  const pos: LatLng = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const spd = loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : undefined;
  const acc = loc.coords.accuracy != null && loc.coords.accuracy >= 0 ? Math.round(loc.coords.accuracy) : undefined;
  const ts = loc.timestamp || Date.now();
  const bat = await readBattery();

  // always show myself, now with the battery the roster chip was already drawing
  selfCb?.({ userId: myId, pos, speed: spd, accuracy: acc, ts, battery: bat.level, charging: bat.charging });

  const u = until();
  const now = Date.now();
  const raw = { lat: pos.lat, lng: pos.lng, spd, acc, ts, bat: bat.level, chg: bat.charging };

  for (const cid of circleIds) {
    // Seal PER GROUP, not once for all of them. Each group may be entitled to a
    // different reduction — precise for family, approximate for a riders club —
    // so a single shared blob would leak the most precise version to everyone.
    const priv = privacy.get(cid);
    if (sharing && myKey && priv) {
      const reduced = applyPrivacy(raw, priv, now);
      if (reduced) {
        const ping = reduced as FamilyPing;
        // Reference distances ("1.2 km from Home") are derived HERE, on the
        // device that owns the places, and only the derived metres travel — no
        // place coordinate is ever published, synced or stored server-side.
        //
        // Computed from the REDUCED position, not the precise fix: publishing
        // an exact distance-from-Home next to a grid-snapped coordinate would
        // hand back the precision that "approximate" exists to withhold.
        const refs = refDistancesFor({ lat: ping.lat, lng: ping.lng }, places.get(cid) ?? [], defaultRefs.get(cid));
        if (refs.length) ping.refs = refs;
        const blob = sealJSON(myKey, ping);
        if (blob) emit('live_location_update', { chatId: cid, blob, until: u }).catch(() => {});
        // Additive server ingest (all-space location platform, migration 103):
        // the SAME privacy-reduced point, batched with offline queue + dedupe.
        // The server enforces per-space read authorization; uploading is the
        // act of sharing, so this rides exactly the sealed-publish gate above.
        //
        // `refs` are deliberately NOT sent here. They ride the sealed relay
        // only; the server stores positions, never a member's reference places
        // or the distances derived from them.
        publishPoint(cid, {
          lat: ping.lat, lng: ping.lng, ts: ping.ts || ts, spd: ping.spd,
          acc: ping.acc, bat: ping.bat, src: 'fused',
        }).catch(() => {});
      }
    }

    // LOCAL state uses the PRECISE fix on purpose. Privacy governs what leaves
    // this device; my own history and my own geofences are mine, and blurring
    // them would break arrive/leave detection for no privacy gain.
    const announcing = sharing && !!priv && isPublishing(priv, now);
    await processFix(cid, {
      userId: myId, name: myName, pos, ts, speed: spd, accuracy: acc,
      battery: bat.level, charging: bat.charging,
    }, {
      self: true,
      fences: places.get(cid) ?? [],
      // Only tell a group about a crossing if I am actually visible to it.
      announce: announcing ? (text) => { sendMessage(cid, text, 'system').catch(() => {}); } : undefined,
    });
  }

  // An active group trip rides the SAME fix pulse. This was the missing link:
  // publishTripState existed with zero callers, so every trip screen said
  // "Waiting for ETAs…" forever. Not gated on `sharing` — joining a trip is
  // itself consent to share the DERIVED numbers (remaining distance, ETA,
  // arrival), and the position itself never rides the trip channel.
  const trip = currentTrip();
  if (trip && circleIds.includes(trip.groupId)) {
    publishTripState(pos, spd, myName).catch(() => {});
  }

  // Re-decide the cadence now that this fix has told us whether the device is
  // moving, how good the GPS is and where the battery stands. Last, and
  // awaited-but-guarded, so a re-arm can never delay or break publishing.
  await replan(loc, bat);
}

export interface StartPresenceOpts {
  circleIds: string[]; myId: string; myName?: string; share: boolean;
  onSelf: (p: MemberPresence) => void;
  /**
   * Ask the OS for location permission if it is not already granted.
   *
   * Default FALSE, and that default is the whole point. Opening a space needs
   * no location: a parent watching a school bus, an employee checking a task
   * and a manager reading attendance all publish nothing. Prompting them on
   * entry asked for a permission the screen did not use, and refusing it took
   * the entire module down with it.
   *
   * Pass true only from an action that genuinely needs the device's own
   * position — turning sharing on, or centring the map on yourself.
   */
  requestPermission?: boolean;
}

/** What startPresence managed to do. `denied` is normal, not a failure. */
export interface PresenceStart { watching: boolean; denied: boolean }

/**
 * Start watching my own location. Broadcasts to circles only if `share`.
 *
 * NEVER THROWS ON A REFUSED PERMISSION, and callers must not treat one as an
 * error. This used to throw, which meant the caller's whole setup path
 * unwound — including the subscription that receives OTHER people's positions.
 * So a parent who declined location did not merely stop publishing: they
 * stopped receiving, and the space rendered as an empty map behind a dead-end
 * alert. Receiving needs no permission at all; the two must not share a fate.
 */
export async function startPresence(o: StartPresenceOpts): Promise<PresenceStart> {
  // GENERATION GUARD. Every field below is module-level, and this function is
  // full of awaits, so two overlapping calls interleave and the one that
  // finishes LAST wins — regardless of which was asked for last.
  //
  // That is not hypothetical. app/family.tsx loads settings with
  //   setActive(...);  await getSettings();  setShare(s.sharing);
  // and the await between them splits those into TWO renders, so the presence
  // effect fires twice: once with share=false, then with share=true. The
  // stale share=false call could land second and set `sharing = false` while
  // the switch on screen read ON — a device that published nothing all
  // session with sharing apparently enabled. Found on the Honor via the
  // adaptive diagnostics line ("Not sharing location" under a checked switch).
  //
  // A superseded call now bails at every point where it would otherwise
  // mutate shared state.
  const gen = ++startGen;
  const stale = () => gen !== startGen;

  await stopPresence();
  if (stale()) return { watching: false, denied: false };

  let status = (await Location.getForegroundPermissionsAsync()).status;
  if (status !== 'granted' && o.requestPermission) {
    status = (await Location.requestForegroundPermissionsAsync()).status;
  }
  if (stale()) return { watching: false, denied: false };

  // Circle context is recorded either way, so enabling sharing later needs no
  // re-entry into this function.
  circleIds = o.circleIds; myId = o.myId; myName = o.myName || 'A member'; selfCb = o.onSelf;
  sharing = o.share && status === 'granted';

  if (status !== 'granted') {
    for (const cid of circleIds) {
      places.set(cid, await getPlaces(cid));
      defaultRefs.set(cid, await getDefaultRef(cid));
      privacy.set(cid, await getGroupPrivacy(cid));
    }
    return { watching: false, denied: true };
  }
  for (const cid of circleIds) {
    places.set(cid, await getPlaces(cid));
    // defaultRefs was missing from THIS branch — the granted path, i.e. the
    // only one that ever publishes. The chosen reference place was therefore
    // never loaded, so refDistancesFor fell back to "first place wins" and a
    // member who picked Business was published as measured from Home.
    defaultRefs.set(cid, await getDefaultRef(cid));
    privacy.set(cid, await getGroupPrivacy(cid));
  }
  if (stale()) return { watching: false, denied: false };
  if (sharing) {
    myKey = newLiveKey();
    await deliverKeys();
    await handOffToBackground();
    // Clear any explicit server-side stop so the platform ingest admits
    // uploads again (the guard exists so a stale publisher cannot outlive a
    // stop — re-enabling must therefore announce itself).
    for (const cid of circleIds) publishStart(cid).catch(() => {});
  }
  // OPEN FAST, THEN STEP DOWN. The engine cannot know whether this device is
  // moving until a fix has told it, and its stationary guess (20 s / 25 m) is
  // the wrong bet for the very first one: a phone on a desk may produce nothing
  // for a long time behind a 25 m distance gate, and the screen sits on
  // "Waiting for GPS fix…" with no dot and no distances. Seen on the Honor.
  //
  // So the opening arm always uses the fast tier; the first real fix calls
  // replan(), which immediately settles it to whatever the situation warrants.
  // The cost is one accurate fix, paid once per start — which is exactly what
  // someone opening the screen is waiting for.
  await armWatcher(planFor({ foreground, locked: false, sharing, speedMs: OPENING_SPEED_MS }));
  return { watching: true, denied: false };
}

/**
 * Mirror the current publishing context into the background task so sharing
 * survives leaving the screen. A refused always-on permission is not an error:
 * we simply stay foreground-only, which is the old behaviour.
 */
async function handOffToBackground(): Promise<boolean> {
  if (!sharing || !circleIds.length) {
    console.warn('[family/bg] not handing off — sharing:', sharing, 'circles:', circleIds.length);
    return false;
  }
  try {
    const ok = await startBackgroundPresence({ circleIds, myId, myName, key: myKey });
    // console.WARN, not log: release builds strip console.log (babel.config.js),
    // and this silently returning false is exactly the failure that made
    // locked-screen sharing look unimplemented while foreground worked fine.
    // On the Honor there was no service and no notification, and NOTHING said why.
    console.warn('[family/bg] startBackgroundPresence →', ok);
    return ok;
  } catch (e: any) {
    console.warn('[family/bg] startBackgroundPresence THREW:', e?.message ?? String(e));
    return false;
  }
}

/** Is the always-on background publisher currently running? */
export async function isBackgroundSharing(): Promise<boolean> { return isBackgroundRunning(); }
export async function canShareInBackground(): Promise<boolean> { return hasBackgroundPermission(); }

/**
 * Toggle broadcast without tearing down the watcher/map.
 *
 * THIS is where location permission is asked for, because this is the first
 * moment it is actually needed — the user has just said "share my location".
 * A prompt here explains itself; the same prompt on entering a space did not.
 *
 * Returns false if sharing could not be enabled, so the caller can leave its
 * switch off rather than showing a lie.
 */
export async function setSharing(share: boolean): Promise<boolean> {
  if (share === sharing) return sharing;
  if (share) {
    let status = (await Location.getForegroundPermissionsAsync()).status;
    if (status !== 'granted') {
      status = (await Location.requestForegroundPermissionsAsync()).status;
    }
    if (status !== 'granted') return false;
    // Entering a space no longer starts a watcher, so turning sharing on may be
    // the first thing that needs one.
    // Same fast opening as startPresence: turning sharing on is a moment
    // someone is watching for their own dot to appear.
    if (!watcher) await armWatcher(planFor({ foreground, locked: false, sharing: true, speedMs: OPENING_SPEED_MS }));
  }
  sharing = share;
  if (share) {
    myKey = newLiveKey();
    await deliverKeys();
    await handOffToBackground();
    // Sharing changes the plan (notSharing → a real tier), so re-arm rather
    // than keeping the idle cadence a non-sharing watcher was opened with.
    await replanNow();
    for (const cid of circleIds) publishStart(cid).catch(() => {});
  } else {
    myKey = null;
    stopKeepalive();
    await stopBackgroundPresence();
    for (const cid of circleIds) {
      emit('live_location_stop', { chatId: cid }).catch(() => {});
      publishStop(cid).catch(() => {}); // platform mirror of the stop signal
    }
    stopPublisher();
  }
  return sharing;
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
  plan = null;          // the next start re-plans from scratch, never from a stale tier
  armedPlan = null;     // …and must not believe a dead watcher's cadence is armed
  stopKeepalive();

  if (sharing && await isBackgroundRunning()) {
    await updateBackgroundKey(myKey);   // hand the live key over and let it run
    return;
  }
  if (sharing) for (const cid of circleIds) emit('live_location_stop', { chatId: cid }).catch(() => {});
  sharing = false; myKey = null; circleIds = []; places.clear(); defaultRefs.clear(); privacy.clear();
}

export function isSharing(): boolean { return sharing; }

/**
 * This device's current live-location sealing key, or null when not sharing.
 *
 * Exposed for the run relay (Spaces & Operations, S2.8), which seals a vehicle's
 * position with the SAME key presence already delivered to the space. Reusing it
 * means a run needs no second key exchange and posts no extra message to the
 * thread — and it makes the audience automatically correct: anyone who can
 * already open this driver's presence pings can open their run pings.
 *
 * It also means a driver who is not sharing location cannot broadcast a vehicle
 * position, which is the right answer rather than a limitation.
 */
export function currentLiveKey(): string | null { return myKey; }

/**
 * Refresh a circle's geofences into the live broadcaster (call after editing
 * Places). Also re-reads the chosen reference place, because renaming or
 * deleting a place is exactly the edit that can invalidate it — and a stale
 * choice would keep publishing a reference the member no longer has.
 */
export async function reloadPlaces(circleId: string): Promise<void> {
  if (!circleIds.includes(circleId)) return;
  places.set(circleId, await getPlaces(circleId));
  defaultRefs.set(circleId, await getDefaultRef(circleId));
}

/** Refresh a group's privacy into the live publisher (call after editing it). */
export async function reloadPrivacy(groupId: string): Promise<void> {
  if (circleIds.includes(groupId)) privacy.set(groupId, await getGroupPrivacy(groupId));
}

// ── receive others' positions for one circle ──
export interface PresenceEvent { userId: string; presence: MemberPresence | null } // null = stopped

function lkFromPlaintext(text: string | null): string | null {
  if (!text) return null;
  try { const c = JSON.parse(text); return (c.live && typeof c.lk === 'string') ? c.lk : null; } catch { return null; }
}

/**
 * Extract the live key from one 'location' message — DECRYPTING IT FIRST.
 *
 * The old code JSON.parsed the RAW fetched content. In an E2EE circle that
 * content is a sender-key envelope, so the parse failed silently for every
 * key message and no key was ever harvested — meaning member-to-member live
 * location could not have worked in any properly encrypted circle. Found on
 * two physical phones: the server relayed blobs into the room (verified at
 * the Redis adapter), both sides had delivered fresh key messages (verified
 * in the DB), and the receiver still rendered nothing.
 */
async function lkFromMessage(circleId: string, m: Message): Promise<string | null> {
  if (m?.type !== 'location' || !m.content) return null;
  // Legacy plaintext circles parse directly; E2EE circles need the decrypt.
  const direct = lkFromPlaintext(m.content);
  if (direct) return direct;
  if (!m.senderId) return null;
  try {
    const plain = await decryptFromChat(circleId, String(m.senderId), m.content, m.id);
    return lkFromPlaintext(plain);
  } catch { return null; }
}

/** Subscribe to a circle's live member positions. Captures E2E keys from history + live 'location' messages. */
export async function subscribeCircle(circleId: string, meId: string, onEvent: (e: PresenceEvent) => void): Promise<() => void> {
  await joinChatRoom(circleId);
  let disposed = false;

  // One shared in-flight fetch: a second caller AWAITS the same promise
  // rather than returning early — its `.then(flushStash)` must not fire
  // before the keys are actually in.
  let harvesting: Promise<void> | null = null;
  const captureFromHistory = (): Promise<void> => {
    if (harvesting) return harvesting;
    harvesting = (async () => {
      try {
        const msgs = await getMessages(circleId, { limit: 60 });
        // THE NEWEST KEY PER SENDER WINS — explicitly, not by iteration order.
        // The server returns messages newest-first (ORDER BY m.id DESC), and
        // the old `for … putLiveKey(…)` overwrote on every hit, so the OLDEST
        // key in the window won. Every sharing toggle re-keys, so after a few
        // sessions both sides of a circle held each other's ancient keys and
        // every live blob failed to open — two phones on one desk, each LIVE
        // to itself, permanently invisible to each other.
        const newest = new Map<string, { id: number; lk: string }>();
        for (const m of msgs) {
          if (m?.type !== 'location' || !m.senderId) continue;
          const uid = String(m.senderId);
          const prev = newest.get(uid);
          if (prev && Number(m.id) <= prev.id) continue; // an older message cannot win — skip the decrypt
          const lk = await lkFromMessage(circleId, m);
          if (lk) newest.set(uid, { id: Number(m.id), lk });
        }
        for (const [uid, v] of newest) putLiveKey(circleId, uid, v.lk);
      } catch {} finally { harvesting = null; }
    })();
    return harvesting;
  };
  await captureFromHistory();

  const s = await getSocket();
  // Blobs that arrived before their sender's key message was harvested.
  // A MOVING member re-pings within seconds, so dropping was harmless for
  // them — but a STATIONARY member pings exactly once on entry, and if that
  // one blob loses the race against the key fetch they stay invisible until
  // they physically move. Observed on two real devices sitting on a desk.
  // Keyed by member id; only the newest blob per member is worth keeping.
  const stash = new Map<string, any>();

  /** Decode + deliver one relayed event. False = stash it and retry after the
   *  next key harvest — the key may be missing OR older than the blob's. */
  const decode = (e: any): boolean => {
    const uid = String(e.userId);
    const key = getLiveKey(circleId, uid);
    if (!key) return false;
    const ping = openJSON<FamilyPing>(key, e.blob);
    if (!ping) return false; // wrong/old key for this blob — a harvest may fix it
    if (typeof ping.lat === 'number' && typeof ping.lng === 'number') {
      const ts = ping.ts || Date.now();
      onEvent({ userId: uid, presence: {
        userId: uid, pos: { lat: ping.lat, lng: ping.lng }, speed: ping.spd,
        battery: ping.bat, charging: ping.chg, accuracy: ping.acc, ts,
        // Derived on THEIR device; we receive names and metres, never the
        // coordinates behind them. Absent on pings from older builds.
        refs: Array.isArray(ping.refs) ? ping.refs : undefined,
      } });
      // Keep this member's local history. Their geofences are evaluated on THEIR
      // device, so this records the track only — see fixPipeline.processFix.
      recordSample(circleId, { u: uid, lat: ping.lat, lng: ping.lng, ts, bat: ping.bat, spd: ping.spd, acc: ping.acc })
        .catch(() => {});
    }
    return true; // opened (or opened-but-malformed, which retrying cannot fix)
  };

  /** Retry every stashed blob; keys may have just been harvested. */
  const flushStash = () => {
    if (disposed) return;
    for (const [uid, e] of [...stash]) if (decode(e)) stash.delete(uid);
  };

  const onUpd = (e: any) => {
    if (disposed || !e?.userId || !e.blob || String(e.userId) === String(meId)) return;
    if (e.chatId != null && String(e.chatId) !== String(circleId)) return;
    if (!decode(e)) {
      stash.set(String(e.userId), e);                 // keep THIS blob, not just hope for a next one
      captureFromHistory().then(flushStash);
    }
  };
  const onStop = (e: any) => {
    if (disposed || !e?.userId) return;
    clearLiveKey(circleId, String(e.userId));
    stash.delete(String(e.userId));
    onEvent({ userId: String(e.userId), presence: null });
  };
  const onNewMsg = (e: any) => {
    if (!disposed && e && String(e.chatId) === String(circleId) && e.type === 'location') {
      captureFromHistory().then(flushStash);          // a fresh key may unlock a stashed blob
    }
  };

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
