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
import { getPlaces } from './store';
import { getGroupPrivacy } from '../groups/store';
import { applyPrivacy, isPublishing } from '../groups/privacy';
import { publishPoint } from '../location/publisher';
import { readBattery } from './battery';
import { processFix } from './fixPipeline';
import { type FamilyPing } from './types';

export const BG_TASK = 'vc-family-bg-location';

const K_CTX = 'vc_family_bg_ctx';        // AsyncStorage: {circleIds, myId, myName}
const S_KEY = 'vc_family_bg_key';        // SecureStore: the live session key
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
  const raw = { lat: pos.lat, lng: pos.lng, spd, acc, ts, bat: bat.level, chg: bat.charging };

  for (const cid of ctx.circleIds) {
    // The background publisher MUST honour privacy too. Applying it only in the
    // foreground would mean a member set to "approximate" leaked their precise
    // position for as long as their phone was in a pocket — which is most of
    // the time, and is exactly when the setting matters.
    const priv = await getGroupPrivacy(cid);
    const visible = isPublishing(priv, now);

    if (key && visible) {
      const reduced = applyPrivacy(raw, priv, now);
      if (reduced) {
        const blob = sealJSON(key, reduced as FamilyPing);
        // Best-effort: in a headless start the socket may not be connected. The
        // fix is still recorded locally, so history stays complete either way.
        if (blob) emit('live_location_update', { chatId: cid, blob, until: now + LIVE_WINDOW_MS }).catch(() => {});
        // Platform ingest rides the SAME privacy-reduced point and the same
        // visibility gate — this is what keeps Life360-style sharing alive
        // with the app backgrounded or the screen locked: the queue persists
        // and uploads on the pulse, and the server refuses it anyway if the
        // member explicitly stopped (the flag outranks a stale task).
        const rp = reduced as FamilyPing;
        publishPoint(cid, {
          lat: rp.lat, lng: rp.lng, ts: rp.ts || ts, spd: rp.spd,
          acc: rp.acc, bat: rp.bat, src: 'fused',
        }).catch(() => {});
      }
    }

    // Local state keeps the precise fix — see the same note in presence.onFix.
    await processFix(cid, {
      userId: ctx.myId, name: ctx.myName, pos, ts, speed: spd, accuracy: acc,
      battery: bat.level, charging: bat.charging,
    }, {
      self: true,
      fences: await getPlaces(cid),
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
  if (!await hasBackgroundPermission()) return false;

  await AsyncStorage.setItem(K_CTX, JSON.stringify({
    circleIds: o.circleIds, myId: o.myId, myName: o.myName,
  } satisfies BgCtx));
  try {
    if (o.key) await SecureStore.setItemAsync(S_KEY, o.key);
    else await SecureStore.deleteItemAsync(S_KEY).catch(() => {});
  } catch { /* key unavailable → history-only background, still better than nothing */ }

  if (await isBackgroundRunning()) return true;

  await Location.startLocationUpdatesAsync(BG_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000,          // far slower than the 8s foreground cadence
    distanceInterval: 75,          // …and distance-gated, so a parked phone is quiet
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Family Space',
      notificationBody: 'Sharing your location with your family circle',
      notificationColor: '#9D6FD0',
    },
  });
  return true;
}

/** Stop background publishing and forget the persisted key + context. */
export async function stopBackgroundPresence(): Promise<void> {
  try { if (await isBackgroundRunning()) await Location.stopLocationUpdatesAsync(BG_TASK); } catch {}
  try { await AsyncStorage.removeItem(K_CTX); } catch {}
  try { await SecureStore.deleteItemAsync(S_KEY); } catch {}
}

/** Rotate the persisted session key without restarting the task. */
export async function updateBackgroundKey(key: string | null): Promise<void> {
  try {
    if (key) await SecureStore.setItemAsync(S_KEY, key);
    else await SecureStore.deleteItemAsync(S_KEY);
  } catch {}
}
