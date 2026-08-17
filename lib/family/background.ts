// lib/family/background.ts — keep Family Space sharing alive off-screen.
//
// The problem this fixes: presence.ts watches location with a FOREGROUND
// watcher, and app/family.tsx tore it down on blur. Sharing therefore only
// worked while you were staring at the map — the one moment you don't need it.
// Every "left School at 15:30" style feature is impossible without this.
//
// Design notes
//  * The task is defined at MODULE SCOPE (TaskManager requires it registered
//    before the OS can deliver a headless invocation).
//  * A headless cold start gets a FRESH JS context: nothing from the screen's
//    memory survives. So the publishing context (circle ids + the live session
//    key) is persisted — key in SecureStore, ids in AsyncStorage.
//  * Persisting the live key is a deliberate, scoped trade: it is a per-session
//    symmetric key that already exists in this process, it never leaves the
//    device, it lives in the OS keystore, and it is deleted the moment sharing
//    stops. The alternative — no background sharing at all — is what we have now.
//  * The server still only ever receives a sealed blob. This changes WHEN we
//    publish, never WHAT the server can read.

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { emit } from '../socket';
import { sealJSON } from '../liveLocationCrypto';
import { sendMessage } from '../chatService';
import { getPlaces, getDefaultRef } from './store';
import { refDistancesFor } from './distance';
import { planFor } from './adaptive';
import { getGroupPrivacy } from '../groups/store';
import { applyPrivacy, isPublishing } from '../groups/privacy';
import { publishPoint } from '../location/publisher';
import { haversine } from '../nav/geo';
import { readBattery } from './battery';
import { processFix } from './fixPipeline';
import { type FamilyPing } from './types';

export const BG_TASK = 'vc-family-bg-location';

const K_CTX = 'vc_family_bg_ctx';        // AsyncStorage: {circleIds, myId, myName}
const S_KEY = 'vc_family_bg_key';        // SecureStore: the live session key
const K_LASTPUB = 'vc_family_bg_lastpub'; // AsyncStorage: epoch ms of the last publish
/** Last position we published from, for the adaptive distance gate. In-memory
 *  only: losing it on a cold start just means the next batch publishes, which
 *  is the safe direction to fail. */
let lastBgPos: { lat: number; lng: number } | null = null;
const LIVE_WINDOW_MS = 24 * 3600 * 1000;

interface BgCtx { circleIds: string[]; myId: string; myName: string }

async function readCtx(): Promise<BgCtx | null> {
  try {
    const raw = await AsyncStorage.getItem(K_CTX);
    const c = raw ? JSON.parse(raw) as BgCtx : null;
    return c && Array.isArray(c.circleIds) && c.circleIds.length ? c : null;
  } catch { return null; }
}

async function readKey(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(S_KEY); } catch { return null; }
}

// ── the task ──
// Registered unconditionally at import. It is inert until startBackgroundPresence
// persists a context, so importing this module has no side effect on its own.
TaskManager.defineTask(BG_TASK, async ({ data, error }: any) => {
  if (error) return;
  const locations: Location.LocationObject[] = data?.locations ?? [];
  if (!locations.length) return;

  const ctx = await readCtx();
  if (!ctx) return;                       // sharing was stopped — nothing to publish
  const key = await readKey();

  const loc = locations[locations.length - 1];   // only the freshest matters
  const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const spd = loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : undefined;
  const acc = loc.coords.accuracy != null && loc.coords.accuracy >= 0 ? Math.round(loc.coords.accuracy) : undefined;
  const ts = loc.timestamp || Date.now();
  const bat = await readBattery();

  const now = Date.now();

  // Adaptive gate. The OS decides WHEN to hand us a batch; the engine decides
  // whether this one is worth putting on the network. A phone locked on a
  // bedside table produces deliveries all night that say nothing new — the
  // stationary/battery-saver tiers stretch the publish interval so those cost
  // nothing, while a locked phone in a moving car keeps the fast tier.
  //
  // The timestamp is PERSISTED because a headless cold start gets a fresh JS
  // context: an in-memory value would reset to zero on every wake and gate
  // nothing at all.
  const plan = planFor({
    foreground: false,
    locked: true,
    sharing: true,
    speedMs: spd ?? null,
    batteryPct: bat.level ?? null,
    charging: bat.charging,
    accuracyM: acc ?? null,
  });
  let lastPub = 0;
  try { lastPub = Number(await AsyncStorage.getItem(K_LASTPUB)) || 0; } catch {}
  // A real move always gets through regardless of the clock — the gate is
  // about silence, not about suppressing news.
  const moved = lastBgPos ? haversine(lastBgPos, pos) >= plan.distanceIntervalM : true;
  const due = now - lastPub >= plan.timeIntervalMs;
  const publishNow = due || moved;
  if (publishNow) {
    lastBgPos = pos;
    try { await AsyncStorage.setItem(K_LASTPUB, String(now)); } catch {}
  }

  const raw = { lat: pos.lat, lng: pos.lng, spd, acc, ts, bat: bat.level, chg: bat.charging };

  for (const cid of ctx.circleIds) {
    // Read once and share with the fence evaluation below — a headless start
    // has no warm cache, and this is the slow path anyway (60s, distance-gated).
    const fences = await getPlaces(cid);
    // The background publisher MUST honour privacy too. Applying it only in the
    // foreground would mean a member set to "approximate" leaked their precise
    // position for as long as their phone was in a pocket — which is most of
    // the time, and is exactly when the setting matters.
    const priv = await getGroupPrivacy(cid);
    const visible = isPublishing(priv, now);

    if (key && visible && publishNow) {
      const reduced = applyPrivacy(raw, priv, now);
      if (reduced) {
        const ping = reduced as FamilyPing;
        // Same derived reference distances the foreground publishes — without
        // this, "1.2 km from Home" would vanish from everyone else's screen the
        // moment this phone went into a pocket, which is most of the time.
        // Derived from the reduced position, exactly as in presence.onFix.
        const refs = refDistancesFor({ lat: ping.lat, lng: ping.lng }, fences, await getDefaultRef(cid));
        if (refs.length) ping.refs = refs;
        const blob = sealJSON(key, ping);
        // Best-effort: in a headless start the socket may not be connected. The
        // fix is still recorded locally, so history stays complete either way.
        if (blob) emit('live_location_update', { chatId: cid, blob, until: now + LIVE_WINDOW_MS }).catch(() => {});
        // Platform ingest rides the SAME privacy-reduced point and the same
        // visibility gate — this is what keeps Life360-style sharing alive
        // with the app backgrounded or the screen locked: the queue persists
        // and uploads on the pulse, and the server refuses it anyway if the
        // member explicitly stopped (the flag outranks a stale task).
        // refs stay off this path on purpose — the server stores positions,
        // never reference places or the distances derived from them.
        publishPoint(cid, {
          lat: ping.lat, lng: ping.lng, ts: ping.ts || ts, spd: ping.spd,
          acc: ping.acc, bat: ping.bat, src: 'fused',
        }).catch(() => {});
      }
    }

    // Local state keeps the precise fix — see the same note in presence.onFix.
    await processFix(cid, {
      userId: ctx.myId, name: ctx.myName, pos, ts, speed: spd, accuracy: acc,
      battery: bat.level, charging: bat.charging,
    }, {
      self: true,
      fences,
      announce: visible ? (text) => { sendMessage(cid, text, 'system').catch(() => {}); } : undefined,
    });
  }
});

/** Did the user grant "Allow all the time"? */
export async function hasBackgroundPermission(): Promise<boolean> {
  try { return (await Location.getBackgroundPermissionsAsync()).status === 'granted'; }
  catch { return false; }
}

/**
 * Ask for background location. Must be called AFTER foreground permission is
 * already granted — both Android and iOS reject the background prompt otherwise.
 */
export async function requestBackgroundPermission(): Promise<boolean> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (asked.status !== 'granted') return false;
    }
    return (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
  } catch { return false; }
}

export async function isBackgroundRunning(): Promise<boolean> {
  try { return await Location.hasStartedLocationUpdatesAsync(BG_TASK); }
  catch { return false; }
}

export interface StartBackgroundOpts {
  circleIds: string[];
  myId: string;
  myName: string;
  /** The live session key sealing the pings. Omit to record history only. */
  key?: string | null;
}

/**
 * Begin publishing from the background. Returns false when the user declined
 * the always-on permission — the caller stays on the foreground watcher, which
 * is a real (if narrower) working state, not an error.
 */
export async function startBackgroundPresence(o: StartBackgroundOpts): Promise<boolean> {
  if (!o.circleIds.length) return false;
  if (!await hasBackgroundPermission()) {
    // The single most common reason locked-screen sharing does nothing, and it
    // used to fail completely silently: "Allow all the time" is a SEPARATE
    // grant from "While using the app", and the app can be happily publishing
    // in the foreground without it.
    console.warn('[family/bg] refused — no ALWAYS (background) location permission');
    return false;
  }

  await AsyncStorage.setItem(K_CTX, JSON.stringify({
    circleIds: o.circleIds, myId: o.myId, myName: o.myName,
  } satisfies BgCtx));
  try {
    if (o.key) await SecureStore.setItemAsync(S_KEY, o.key);
    else await SecureStore.deleteItemAsync(S_KEY).catch(() => {});
  } catch { /* key unavailable → history-only background, still better than nothing */ }

  // ALWAYS STOP BEFORE STARTING. hasStartedLocationUpdatesAsync reports expo's
  // PERSISTED task registration, not a live service — and that record survives
  // app restarts and OS service kills. The old `if (running) return true` was
  // therefore a trap: once the record went stale the app reported success
  // forever and never actually started anything. Verified on the Honor —
  // startBackgroundPresence returned true while dumpsys showed zero
  // LocationTaskService entries and no notification existed. Foreground
  // sharing looked perfect the whole time, which is what hid it.
  try {
    if (await isBackgroundRunning()) await Location.stopLocationUpdatesAsync(BG_TASK);
  } catch { /* nothing registered, or already gone — starting fresh regardless */ }

  // Opening cadence from the adaptive engine's locked-and-moving tier — the
  // case background location exists for. The OS owns delivery from here (it
  // batches and defers as it sees fit); the task itself re-plans per batch and
  // simply publishes less often when the situation does not warrant it, which
  // is cheaper and far more reliable than restarting the platform task.
  const opening = planFor({ foreground: false, locked: true, sharing: true, speedMs: 20 });
  await Location.startLocationUpdatesAsync(BG_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: opening.timeIntervalMs,
    distanceInterval: opening.distanceIntervalM,
    // FALSE, deliberately. `pausesUpdatesAutomatically` lets the OS suspend
    // updates when it decides you have stopped moving — and it does not
    // reliably resume. For a family tracker that reads as "they vanished",
    // which is the exact failure this whole feature exists to prevent.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Family Space',
      notificationBody: 'Sharing your location with your family circle',
      notificationColor: '#9D6FD0',
      // SURVIVE THE APP BEING CLOSED. Without this the service dies with the
      // task when the user swipes the app away — which is precisely when a
      // family still expects to see where someone is.
      killServiceOnDestroy: false,
    },
  });

  // Report what is ACTUALLY running, not what we asked for. Returning an
  // unverified true is how this failed silently the first time.
  const live = await isBackgroundRunning();
  if (!live) console.warn('[family/bg] startLocationUpdatesAsync did not take effect');
  return live;
}

/** Stop background publishing and forget the persisted key + context. */
export async function stopBackgroundPresence(): Promise<void> {
  try { if (await isBackgroundRunning()) await Location.stopLocationUpdatesAsync(BG_TASK); } catch {}
  try { await AsyncStorage.removeItem(K_CTX); } catch {}
  try { await AsyncStorage.removeItem(K_LASTPUB); } catch {}
  lastBgPos = null;   // a fresh start must not inherit the old adaptive gate
  try { await SecureStore.deleteItemAsync(S_KEY); } catch {}
}

/** Rotate the persisted session key without restarting the task. */
export async function updateBackgroundKey(key: string | null): Promise<void> {
  try {
    if (key) await SecureStore.setItemAsync(S_KEY, key);
    else await SecureStore.deleteItemAsync(S_KEY);
  } catch {}
}
