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
import { type Costing } from '../nav/routing';
import { initialSnapshot, zoneColor, type ZoneState } from './zoneMachine';
import { advanceActiveLock, persistAdvance, toZoneFix } from './lockEngine';
import {
  createSession, endSession, addEvent, bumpAggregates,
  saveActiveLock, readActiveLock, clearActiveLock, type ActiveLock,
} from './lockStore';
import { getLockSettings, loadLockSettings } from './lockSettings';
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
  alarmPhase: AlarmPhase;
  heading: number;           // device compass heading, degrees
  killSafe: boolean;         // background task running (survives app kill)
  navBack: boolean;          // navigate-back session started by the lock
}

const IDLE: LockView = {
  active: false, center: null, radius: 30, armedAt: 0, state: null,
  distance: 0, accuracy: 0, alarmPhase: 'idle', heading: 0, killSafe: false, navBack: false,
};

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

// Cadence by distance-to-boundary: deep in the green a slow, cheap watch is
// enough; near the boundary (or outside) we need the nav-grade cadence. This
// is the main battery lever (see design.md).
function profileFor(a: ActiveLock): 'tight' | 'relaxed' {
  const margin = a.radius - a.snap.distance;
  return a.snap.state === 'safe' && margin > Math.max(40, a.radius * 0.25) ? 'relaxed' : 'tight';
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
      }
      await cancelLockAlarm();
    })().catch(() => {});
    alertRouted = false;
  }
}

// ── the fix pipeline ─────────────────────────────────────────────────────────

async function onFix(loc: Location.LocationObject): Promise<void> {
  if (!active) return;
  const r = advanceActiveLock(active, toZoneFix(loc));
  if (!r.accepted) return;
  active = r.next;
  await persistAdvance(r);

  setView({
    state: active.snap.state,
    distance: Math.round(active.snap.distance * 10) / 10,
    accuracy: Math.round(active.snap.accuracy * 10) / 10,
  });

  for (const ev of r.events) {
    controller?.onZoneEvent(ev);
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

/** Arm a lock at `center` with `radius` metres. Resolves once monitoring runs. */
export async function armLock(center: LatLng, radius: number): Promise<ArmResult> {
  await unlockInternal(false);             // safety: never two sessions
  await loadLockSettings();

  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') return { ok: false, killSafe: false, reason: 'Location permission is required to lock a location.' };

  const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const fix = toZoneFix(cur);
  const alerts = { ...getLockSettings().alerts };
  const sessionId = await createSession(center, radius, fix.t);

  active = {
    sessionId, center, radius, armedAt: fix.t,
    snap: initialSnapshot(fix, { center, radius }),
    alerts, lastPos: fix.pos, graceUntil: null, alarmStartedAt: null, alarmSilenced: false,
  };
  await saveActiveLock(active);

  controller = createAlarmController(realAlarmDrivers(onPhase), alerts);
  setForegroundHandling(true);
  const killSafe = await startLockBackground();

  setView({
    active: true, center, radius, armedAt: fix.t,
    state: active.snap.state, distance: Math.round(active.snap.distance * 10) / 10,
    accuracy: Math.round(fix.accuracy * 10) / 10,
    alarmPhase: 'idle', killSafe, navBack: false,
  });

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
    alarmPhase: 'idle', killSafe, navBack: false,
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

/** Live-update alert settings on an armed lock (spec: editable while armed). */
export async function applyAlertSettings(): Promise<void> {
  const alerts = { ...getLockSettings().alerts };
  controller?.configure(alerts);
  if (active) {
    active = { ...active, alerts };
    await saveActiveLock(active);
  }
}

/** One tap back to the locked point via the existing Valhalla navigation. */
export async function navigateBackToLock(costing: Costing = 'pedestrian'): Promise<void> {
  if (!active) return;
  await startNavigation({
    to: active.center, costing,
    profile: 'standard', mode: 'everything', timing: 'normal',
  });
  navStartedByLock = true;
  setView({ navBack: true });
}

/** Unlock: end monitoring, finalize the session, clean every surface. */
export async function unlockLock(): Promise<void> {
  await unlockInternal(true);
}

async function unlockInternal(record: boolean): Promise<void> {
  const a = active;
  active = null;
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
