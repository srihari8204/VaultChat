// lib/lock/lockService.ts — the live Location Lock session. Orchestration only:
// the reasoning lives in the pure modules (zoneMachine, lockEngine,
// alarmController) that pass their self-checks; this wires them to real GPS,
// real alarm channels, the notification layer, and the navigate-back seam.
//
// Lifecycle: arm() → foreground watcher (adaptive cadence) + optional kill-safe
// background task → onFix pipeline → alarm controller → unlock(). restore()
// resumes an armed lock after a process restart from the persisted ActiveLock.

import * as Location from 'expo-location';
import { AppState, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import notifee, { EventType } from '@notifee/react-native';
import { router } from 'expo-router';
import { type LatLng } from '../nav/geo';
import { startNavigation, stopNavigation } from '../nav/navigationService';
import { getNavSettings } from '../nav/navSettings';
import { type Costing } from '../nav/routing';
import { initialSnapshot, zoneColor, MODE_COSTING, type ZoneState } from './zoneMachine';
import { gpsQuality, type GpsQuality } from './format';
import { readBattery } from '../family/battery';
import { advanceActiveLock, persistAdvance, toZoneFix } from './lockEngine';
import {
  createSession, endSession, addEvent, bumpAggregates,
  saveActiveLock, readActiveLock, clearActiveLock, type ActiveLock,
} from './lockStore';
import { getLockSettings, loadLockSettings, zoneConfigFor } from './lockSettings';
import { createAlarmController, type AlarmController, type AlarmPhase } from './alarmController';
import { realAlarmDrivers } from './alarmChannels';
import {
  showLockStatus, hideLockStatus, showLockAlarm, cancelLockAlarm, showBackInside,
} from './lockNotifications';
import {
  setForegroundHandling, startLockBackground, stopLockBackground,
  hasBackgroundPermission, requestBackgroundPermission,
} from './background';

// ── the view the screens render ──────────────────────────────────────────────

export interface LockView {
  active: boolean;
  center: LatLng | null;
  radius: number;
  armedAt: number;
  state: ZoneState | null;
  distance: number;          // smoothed m from center
  accuracy: number;          // m
  quality: GpsQuality;       // accuracy tier (stands in for satellites/signal)
  speedKmh: number;          // from the fix, derived fallback
  battery: number | null;    // %, null when unavailable
  charging: boolean;
  alarmPhase: AlarmPhase;
  heading: number;           // device compass heading, degrees
  killSafe: boolean;         // background task running (survives app kill)
  navBack: boolean;          // navigate-back session started by the lock
  lastFixAt: number;         // t of the last accepted fix ("updated Ns ago")
  gpsDegraded: boolean;      // sustained poor accuracy (indoors / canyon)
  placeName: string | null;  // saved place this lock is armed on (null = ad-hoc)
}

const IDLE: LockView = {
  active: false, center: null, radius: 30, armedAt: 0, state: null,
  distance: 0, accuracy: 0, quality: 'good', speedKmh: 0, battery: null, charging: false,
  alarmPhase: 'idle', heading: 0, killSafe: false, navBack: false,
  lastFixAt: 0, gpsDegraded: false, placeName: null,
};

// ── engine event hook (v3): any surface can observe lock transitions without
// the engine knowing about it. Family Space's bridge turns these into family-
// styled alerts; the engine stays generic.
export type LockEventKind = 'warning' | 'exit' | 'return' | 'alarm_start' | 'alarm_stop' | 'armed' | 'unlocked';
export interface LockEvent {
  kind: LockEventKind;
  placeName: string | null;
  distance: number;      // m from center at the event
  radius: number;
  at: number;
}
const evSubs = new Set<(e: LockEvent) => void>();
export function onLockEvent(cb: (e: LockEvent) => void): () => void {
  evSubs.add(cb);
  return () => { evSubs.delete(cb); };
}
function emitLockEvent(kind: LockEventKind, a: ActiveLock): void {
  const e: LockEvent = {
    kind, placeName: a.placeName ?? null,
    distance: Math.round(a.snap.rawDistance * 10) / 10, radius: a.radius, at: Date.now(),
  };
  evSubs.forEach((cb) => { try { cb(e); } catch {} });
}

let view: LockView = IDLE;
const subs = new Set<() => void>();
function setView(patch: Partial<LockView>) { view = { ...view, ...patch }; subs.forEach((c) => { try { c(); } catch {} }); }
export function getLockView(): LockView { return view; }
export function useLockView(): LockView {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => view, () => view);
}
export { zoneColor };

// ── session internals ────────────────────────────────────────────────────────

let active: ActiveLock | null = null;
let controller: AlarmController | null = null;
let watcher: Location.LocationSubscription | null = null;
let headingSub: Location.LocationSubscription | null = null;
let watchProfile: 'tight' | 'relaxed' | null = null;
let navStartedByLock = false;
let fixQueue: Promise<void> = Promise.resolve();
let alertRouted = false;
let poorRun = 0;    // consecutive raw fixes with poor accuracy (indoor detection)
let stillRun = 0;   // consecutive near-zero-speed fixes (stationary tracking)

// Cadence by distance-to-boundary, movement, and the user's tracking-frequency
// setting: deep in the green (or parked) a slow, cheap watch is enough; near
// the boundary or in high-precision mode we run the nav-grade cadence. This is
// the main battery lever (see design.md).
function profileFor(a: ActiveLock): 'tight' | 'relaxed' {
  const cad = getLockSettings().cadence;
  if (cad === 'high') return 'tight';
  if (cad === 'saver') return a.snap.state === 'safe' ? 'relaxed' : 'tight';
  const margin = a.radius - a.snap.distance;
  const need = stillRun >= 5 ? Math.max(15, a.radius * 0.15) : Math.max(40, a.radius * 0.25);
  return a.snap.state === 'safe' && margin > need ? 'relaxed' : 'tight';
}

// Short spoken status lines (indoor / recovered) — gated on the voice channel.
// Lazy require (family/battery pattern): degrades to silence where TTS is absent.
function speakStatus(text: string): void {
  if (!getLockSettings().alerts.voice) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const S = require('expo-speech');
    S.stop(); S.speak(text, { rate: 1.0 });
  } catch {}
}

const WATCH_OPTS = {
  tight: { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 4 },
  relaxed: { accuracy: Location.Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 25 },
} as const;

async function startWatcher(profile: 'tight' | 'relaxed'): Promise<void> {
  if (watchProfile === profile && watcher) return;
  try { watcher?.remove(); } catch {}
  watchProfile = profile;
  watcher = await Location.watchPositionAsync(WATCH_OPTS[profile], (loc) => {
    fixQueue = fixQueue.then(() => onFix(loc)).catch(() => {});
  });
}

async function startHeading(): Promise<void> {
  if (headingSub || Platform.OS === 'web') return;
  try {
    let last = 0;
    headingSub = await Location.watchHeadingAsync((h) => {
      const now = Date.now();
      if (now - last < 250) return;                      // ~4 Hz is plenty for a needle
      last = now;
      const deg = (h.trueHeading ?? -1) >= 0 ? h.trueHeading : h.magHeading;
      setView({ heading: Math.round(deg) });
    });
  } catch { /* no magnetometer — compass simply stays north */ }
}

function stopSensors(): void {
  try { watcher?.remove(); } catch {}
  try { headingSub?.remove(); } catch {}
  watcher = null; headingSub = null; watchProfile = null;
}

// ── alarm phase plumbing (event records + notification + alert screen) ──────

function onPhase(p: AlarmPhase): void {
  setView({ alarmPhase: p });
  const a = active;
  if (!a) return;

  if (p === 'alarming') {
    (async () => {
      if (!a.alarmStartedAt) {
        active = { ...a, alarmStartedAt: Date.now() };
        await saveActiveLock(active);
        await addEvent(a.sessionId, 'alarm_start', Date.now(), a.snap.rawDistance);
        emitLockEvent('alarm_start', active);
      }
      await showLockAlarm(Math.max(0, a.snap.rawDistance - a.radius));
    })().catch(() => {});
    // Bring the full-screen alert up when the user is looking at the app.
    if (!alertRouted && AppState.currentState === 'active') {
      alertRouted = true;
      try { router.push('/lock-alert'); } catch {}
    }
    return;
  }

  // idle / silenced / grace → the loud notification must not persist
  if (p === 'idle' || p === 'silenced') {
    (async () => {
      if (active?.alarmStartedAt) {
        await bumpAggregates(active.sessionId, { alarmMs: Date.now() - active.alarmStartedAt });
        await addEvent(active.sessionId, 'alarm_stop', Date.now(), active.snap.rawDistance);
        active = { ...active, alarmStartedAt: null };
        await saveActiveLock(active);
        emitLockEvent('alarm_stop', active);
      }
      await cancelLockAlarm();
    })().catch(() => {});
    alertRouted = false;
  }
}

// ── the fix pipeline ─────────────────────────────────────────────────────────

async function onFix(loc: Location.LocationObject): Promise<void> {
  if (!active) return;

  // Indoor / degraded-GPS detection runs on RAW fixes — a truly degraded
  // environment produces mostly gate-rejected fixes, which must still count.
  const rawAcc = loc.coords.accuracy ?? 15;
  poorRun = rawAcc > 30 ? poorRun + 1 : 0;
  if (!view.gpsDegraded && poorRun >= 4) {
    setView({ gpsDegraded: true });
    speakStatus('GPS signal is weak. Location may be indoors.');
  } else if (view.gpsDegraded && rawAcc < 15) {
    setView({ gpsDegraded: false });
    speakStatus('GPS signal recovered.');
  }

  const prevPos = active.lastPos;
  const prevT = active.snap.t;
  const r = advanceActiveLock(active, toZoneFix(loc));
  if (!r.accepted) return;
  active = r.next;
  await persistAdvance(r);

  // Diagnostics: sensor speed, else derive from the last accepted fix (same
  // fallback the nav loop uses); battery reads are cached 60 s in the helper.
  let speedMs = loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : 0;
  const dt = (active.snap.t - prevT) / 1000;
  if (speedMs === 0 && prevPos && dt > 0) speedMs = r.deltas.traveled / dt;
  stillRun = speedMs < 0.3 ? stillRun + 1 : 0;
  const bat = await readBattery();

  setView({
    state: active.snap.state,
    distance: Math.round(active.snap.distance * 10) / 10,
    accuracy: Math.round(active.snap.accuracy * 10) / 10,
    quality: gpsQuality(active.snap.accuracy),
    speedKmh: Math.round(speedMs * 3.6),
    battery: bat.level ?? null,
    charging: !!bat.charging,
    lastFixAt: active.snap.t,
  });

  for (const ev of r.events) {
    controller?.onZoneEvent(ev);
    emitLockEvent(ev === 'enterWarning' ? 'warning' : ev, active);
    if (ev === 'return') {
      if (navStartedByLock) { navStartedByLock = false; setView({ navBack: false }); stopNavigation().catch(() => {}); }
      await showBackInside();
    }
  }

  // Keep the silent status card honest (skip while the bg task's own FGS
  // notification is showing — one persistent card is enough).
  if (!view.killSafe) {
    await showLockStatus(active.radius, active.snap.state, active.snap.distance);
  }

  const want = profileFor(active);
  if (want !== watchProfile) await startWatcher(want);
}

// ── public API ───────────────────────────────────────────────────────────────

export interface ArmResult { ok: boolean; killSafe: boolean; reason?: string }

/** Arm a lock at `center` with `radius` metres. Resolves once monitoring runs.
 *  `opts.placeName` tags the session with a saved place (any surface). */
export async function armLock(center: LatLng, radius: number, opts?: { placeName?: string }): Promise<ArmResult> {
  await unlockInternal(false);             // safety: never two sessions
  await loadLockSettings();

  // Reliability (v2.1): clear guidance for GPS-off and permission-denied.
  try {
    if (!(await Location.hasServicesEnabledAsync())) {
      return { ok: false, killSafe: false, reason: 'Location (GPS) is turned off. Enable Location in system settings, then lock again.' };
    }
  } catch { /* API unavailable → let the permission/fix path report */ }
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') return { ok: false, killSafe: false, reason: 'Location permission is required to lock a location.' };

  const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const fix = toZoneFix(cur);
  const s = getLockSettings();
  const alerts = { ...s.alerts };
  const placeName = opts?.placeName ?? null;
  const sessionId = await createSession(center, radius, fix.t, placeName);

  active = {
    sessionId, center, radius, armedAt: fix.t,
    snap: initialSnapshot(fix, { center, radius }),
    alerts, zone: zoneConfigFor(s), placeName,
    lastPos: fix.pos, graceUntil: null, alarmStartedAt: null, alarmSilenced: false,
  };
  await saveActiveLock(active);

  controller = createAlarmController(realAlarmDrivers(onPhase), alerts);
  setForegroundHandling(true);
  const killSafe = await startLockBackground();

  setView({
    active: true, center, radius, armedAt: fix.t,
    state: active.snap.state, distance: Math.round(active.snap.distance * 10) / 10,
    accuracy: Math.round(fix.accuracy * 10) / 10,
    alarmPhase: 'idle', killSafe, navBack: false, placeName,
  });
  emitLockEvent('armed', active);

  if (!killSafe) await showLockStatus(radius, active.snap.state, active.snap.distance);
  await startWatcher(profileFor(active));
  await startHeading();
  return { ok: true, killSafe };
}

/** Resume an armed lock after app relaunch. No-op without a persisted lock. */
export async function restoreLock(): Promise<boolean> {
  if (active) return true;
  const a = await readActiveLock();
  if (!a) return false;
  await loadLockSettings();

  active = a;
  controller = createAlarmController(realAlarmDrivers(onPhase), a.alerts);
  setForegroundHandling(true);
  const killSafe = await hasBackgroundPermission() ? await startLockBackground() : false;

  setView({
    active: true, center: a.center, radius: a.radius, armedAt: a.armedAt,
    state: a.snap.state, distance: Math.round(a.snap.distance * 10) / 10,
    accuracy: Math.round(a.snap.accuracy * 10) / 10,
    alarmPhase: 'idle', killSafe, navBack: false, placeName: a.placeName ?? null,
  });

  // The alarm was live (or due) when the process died → resume it. The
  // controller re-fires through a synthetic exit with zero grace (the real
  // grace already elapsed); onPhase dedupes the alarm_start event via
  // alarmStartedAt.
  if (a.snap.state === 'outside' && !a.alarmSilenced && a.graceUntil != null && Date.now() >= a.graceUntil) {
    controller.configure({ ...a.alerts, graceS: 0 });
    controller.onZoneEvent('exit');
    controller.configure(a.alerts);
  }

  await startWatcher(profileFor(a));
  await startHeading();
  return true;
}

/** Upgrade a foreground-only lock to kill-safe (asks for "Allow all the time"). */
export async function enableKillSafe(): Promise<boolean> {
  if (!active) return false;
  if (!await requestBackgroundPermission()) return false;
  const ok = await startLockBackground();
  if (ok) { setView({ killSafe: true }); await hideLockStatus(); }
  return ok;
}

/** Manual "Stop Alarm" — silence channels, keep the lock armed. */
export async function stopLockAlarm(): Promise<void> {
  controller?.stopAlarm();
  if (active) {
    active = { ...active, alarmSilenced: true };
    await saveActiveLock(active);
  }
}

/** Play the configured channels briefly (settings screen's Test Alarm). */
export function testAlarm(): void {
  if (controller) { controller.configure(getLockSettings().alerts); controller.test(); return; }
  // No armed lock: a throwaway controller drives the real channels once.
  const c = createAlarmController(realAlarmDrivers(() => {}), getLockSettings().alerts);
  c.test();
}

/** Live-update alert settings + monitoring mode on an armed lock. */
export async function applyAlertSettings(): Promise<void> {
  const s = getLockSettings();
  const alerts = { ...s.alerts };
  controller?.configure(alerts);
  if (active) {
    active = { ...active, alerts, zone: zoneConfigFor(s) };
    await saveActiveLock(active);
  }
}

/** One tap back to the locked point via the existing Valhalla navigation.
 *  Costing defaults to the monitoring mode's travel mode; voice guidance
 *  follows the lock's voice alert setting. */
export async function navigateBackToLock(costing?: Costing): Promise<void> {
  if (!active) return;
  const s = getLockSettings();
  await startNavigation({
    to: active.center,
    costing: costing ?? MODE_COSTING[s.mode],
    profile: 'standard',
    mode: s.alerts.voice ? 'everything' : 'vibrationOnly',
    timing: 'normal',
    routeOpts: getNavSettings().routeOpts,
  });
  navStartedByLock = true;
  setView({ navBack: true });
}

/** Turn kill-safe monitoring OFF (settings hub toggle). Lock stays armed
 *  foreground-only, with the status notification back as the visible surface. */
export async function disableKillSafe(): Promise<void> {
  await stopLockBackground();
  setView({ killSafe: false });
  if (active) await showLockStatus(active.radius, active.snap.state, active.snap.distance);
}

/** Unlock: end monitoring, finalize the session, clean every surface. */
export async function unlockLock(): Promise<void> {
  await unlockInternal(true);
}

async function unlockInternal(record: boolean): Promise<void> {
  const a = active;
  active = null;
  poorRun = 0; stillRun = 0;
  stopSensors();
  controller?.dispose();
  controller = null;
  setForegroundHandling(false);
  if (navStartedByLock) { navStartedByLock = false; stopNavigation().catch(() => {}); }
  await stopLockBackground();
  await hideLockStatus();
  await cancelLockAlarm();
  if (a && record) {
    if (a.alarmStartedAt) {
      await bumpAggregates(a.sessionId, { alarmMs: Date.now() - a.alarmStartedAt });
      await addEvent(a.sessionId, 'alarm_stop', Date.now(), a.snap.rawDistance);
    }
    await endSession(a.sessionId, Date.now());
    emitLockEvent('unlocked', a);
  }
  if (a) await clearActiveLock();
  view = IDLE;
  subs.forEach((c) => { try { c(); } catch {} });
}

// ── notification taps while the app is alive ────────────────────────────────
// (The killed-app path goes through callBackground.ts's single background
// handler, which lazy-requires lib/lock/background helpers.)

notifee.onForegroundEvent(({ type, detail }) => {
  const data: any = detail?.notification?.data;
  if (!data || (data.type !== 'lock-alarm' && data.type !== 'lock-status' && data.type !== 'lock-return')) return;
  if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'lock-stop-alarm') {
    stopLockAlarm().catch(() => {});
    return;
  }
  if (type === EventType.PRESS) {
    try { router.push(data.type === 'lock-alarm' ? '/lock-alert' : '/location-lock'); } catch {}
  }
});

export default {};
