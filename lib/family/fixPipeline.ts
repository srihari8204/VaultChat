// lib/family/fixPipeline.ts — everything that must happen for ONE position fix,
// in one place so the foreground watcher (presence.ts) and the background task
// (background.ts) can never drift apart.
//
// Per fix we: record history, and — for MY OWN fixes only — evaluate geofences
// and raise the resulting alerts. Other members' geofences are evaluated on
// THEIR device; re-evaluating a received ping here would double-fire and would
// need their Places, which we deliberately never have.
//
// The "inside" set is persisted. It used to live in a Map that died with the
// screen, so every cold start re-announced "arrived at Home" for wherever the
// user already was. Persisting it makes a crossing a real edge, not a restart.

import { evaluateFences, isZoneActive, type Geofence } from './geofence';
import { recordSample } from './history';
import { recordAlert } from './alerts';
import { isLowBattery } from './battery';
import { shouldSpeedAlert, KMH_PER_MS } from './status';
import { type LatLng } from '../nav/geo';

// Lazy-required so activeFences() and the self-check stay clear of the
// react-native graph — see lib/nav/routing.ts for the same pattern.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const placeStore = () => require('./store') as typeof import('./store');

const kInside = (cid: string) => `vc_family_inside_${cid}`;
// Last time a high-speed alert fired for this circle. Persisted, like the
// inside-set: one motorway drive must be one alert, including across a
// background-task cold start.
const kSpeedAt = (cid: string) => `vc_family_spdalert_${cid}`;

export interface Fix {
  userId: string;
  name: string;
  pos: LatLng;
  ts: number;
  speed?: number;
  battery?: number;
  charging?: boolean;
  accuracy?: number;   // GPS accuracy m of this fix
}

export interface ProcessOpts {
  /** True when this is my own fix — only then do we evaluate geofences. */
  self: boolean;
  /** Post the "arrived at / left" system message into the circle thread. */
  announce?: (text: string) => void;
  /** Override the fence list (background task passes a preloaded set). */
  fences?: Geofence[];
}

async function readInside(circleId: string): Promise<Set<string>> {
  try {
    const raw = await storage().getItem(kInside(circleId));
    const arr = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(arr) ? arr as string[] : []);
  } catch { return new Set(); }
}

async function writeInside(circleId: string, inside: Set<string>): Promise<void> {
  try { await storage().setItem(kInside(circleId), JSON.stringify([...inside])); } catch {}
}

/**
 * Only zones that are switched on, unexpired and inside their schedule take
 * part in evaluation.
 *
 * `at` is injected so this stays testable and so one fix evaluates every zone
 * against a single instant — reading the clock per zone could straddle a
 * boundary and fire a spurious crossing.
 */
export function activeFences(fences: Geofence[], at: Date = new Date()): Geofence[] {
  return fences.filter((f) => isZoneActive(f, at));
}

/**
 * Fold one fix into a circle's local state. Safe to call on every GPS tick —
 * history throttles internally and alerts dedupe.
 */
export async function processFix(circleId: string, fix: Fix, opts: ProcessOpts): Promise<void> {
  await recordSample(circleId, {
    u: fix.userId, lat: fix.pos.lat, lng: fix.pos.lng, ts: fix.ts,
    bat: fix.battery, spd: fix.speed, acc: fix.accuracy,
  });

  if (!opts.self) return;

  // low battery is a property of MY device, so it is raised alongside my own fix
  if (isLowBattery({ level: fix.battery, charging: fix.charging })) {
    await recordAlert({
      circleId, kind: 'battery', actorId: fix.userId, actorName: fix.name,
      text: `${fix.name}'s phone is at ${fix.battery}%`, at: fix.ts,
    });
  }

  // High-speed alert — MY OWN device only, same edge-detection philosophy as
  // geofences: the emitting device is the only thing that can read the speed.
  // Opt-in, and debounced through a persisted timestamp so one drive is one
  // alert. The announce path is the circle's, so recipients follow the same
  // permissions as every other family announcement.
  try {
    const sa = (await placeStore().getSettings()).speedAlert;
    if (sa?.enabled) {
      const rawAt = await storage().getItem(kSpeedAt(circleId));
      const lastAt = rawAt ? Number(rawAt) || null : null;
      if (shouldSpeedAlert(fix.speed, sa.thresholdKmh, lastAt, fix.ts)) {
        await storage().setItem(kSpeedAt(circleId), String(fix.ts));
        const kmh = Math.round((fix.speed ?? 0) * KMH_PER_MS);
        const text = `${fix.name} is moving at ${kmh} km/h`;
        await recordAlert({
          circleId, kind: 'overspeed', actorId: fix.userId, actorName: fix.name, text, at: fix.ts,
        });
        opts.announce?.(text);
      }
    }
  } catch { /* a failed speed check must never block the fix fold */ }

  const fences = activeFences(opts.fences ?? await placeStore().getPlaces(circleId), new Date(fix.ts));
  if (!fences.length) return;

  const inside = await readInside(circleId);
  const events = evaluateFences(fences, fix.pos, inside);
  await writeInside(circleId, inside);

  for (const ev of events) {
    const verb = ev.type === 'enter' ? 'arrived at' : 'left';
    const text = `${fix.name} ${verb} ${ev.name}`;
    await recordAlert({
      circleId, kind: ev.type, actorId: fix.userId, actorName: fix.name, text, at: fix.ts,
    });
    opts.announce?.(text);
  }
}

/** Forget a circle's fence state (leave/delete). */
export async function clearInside(circleId: string): Promise<void> {
  try { await storage().removeItem(kInside(circleId)); } catch {}
}

// ── self-check ──
if (require.main === module) {
  const on: Geofence = { id: 'a', name: 'Home', center: { lat: 1, lng: 1 }, radiusM: 100 };
  const off: Geofence = { id: 'b', name: 'Gym', center: { lat: 2, lng: 2 }, radiusM: 100, enabled: false };
  const legacy: Geofence = { id: 'c', name: 'Work', center: { lat: 3, lng: 3 }, radiusM: 100 };

  const act = activeFences([on, off, legacy]).map((f) => f.id);
  if (act.join(',') !== 'a,c') throw new Error('disabled fence must be excluded, legacy kept: ' + act);
  if (activeFences([]).length !== 0) throw new Error('empty in, empty out');

  // schedule + expiry are honoured through isZoneActive
  const noon = new Date(2026, 7, 3, 12, 0, 0);
  const expired: Geofence = { id: 'x', name: 'Pop-up', center: { lat: 1, lng: 1 }, radiusM: 50, expiresAt: noon.getTime() - 1 };
  const asleep: Geofence = { id: 'y', name: 'Night', center: { lat: 1, lng: 1 }, radiusM: 50, schedule: { fromMin: 22 * 60, toMin: 23 * 60 } };
  const awake: Geofence = { id: 'z', name: 'Day', center: { lat: 1, lng: 1 }, radiusM: 50, schedule: { fromMin: 9 * 60, toMin: 17 * 60 } };
  const live = activeFences([on, expired, asleep, awake], noon).map((f) => f.id);
  if (live.join(',') !== 'a,z') throw new Error('expired/out-of-schedule zones must be excluded: ' + live);
  console.log('family/fixPipeline self-check OK');
}
