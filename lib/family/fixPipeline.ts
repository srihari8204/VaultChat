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

import { evaluateFences, type Geofence } from './geofence';
import { formatCrossing } from './events';
import { recordSample } from './history';
import { recordAlert } from './alerts';
import { isLowBattery } from './battery';
import { type LatLng } from '../nav/geo';

// Lazy-required so activeFences() and the self-check stay clear of the
// react-native graph — see lib/nav/routing.ts for the same pattern.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const placeStore = () => require('./store') as typeof import('./store');

const kInside = (cid: string) => `vc_family_inside_${cid}`;

export interface Fix {
  userId: string;
  name: string;
  pos: LatLng;
  ts: number;
  speed?: number;
  battery?: number;
  charging?: boolean;
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

/** Only fences the user has switched on take part in evaluation. */
export function activeFences(fences: Geofence[]): Geofence[] {
  return fences.filter((f) => f.enabled !== false);
}

/**
 * Fold one fix into a circle's local state. Safe to call on every GPS tick —
 * history throttles internally and alerts dedupe.
 */
export async function processFix(circleId: string, fix: Fix, opts: ProcessOpts): Promise<void> {
  await recordSample(circleId, {
    u: fix.userId, lat: fix.pos.lat, lng: fix.pos.lng, ts: fix.ts,
    bat: fix.battery, spd: fix.speed,
  });

  if (!opts.self) return;

  // low battery is a property of MY device, so it is raised alongside my own fix
  if (isLowBattery({ level: fix.battery, charging: fix.charging })) {
    await recordAlert({
      circleId, kind: 'battery', actorId: fix.userId, actorName: fix.name,
      text: `${fix.name}'s phone is at ${fix.battery}%`, at: fix.ts,
    });
  }

  const fences = activeFences(opts.fences ?? await placeStore().getPlaces(circleId));
  if (!fences.length) return;

  const inside = await readInside(circleId);
  const events = evaluateFences(fences, fix.pos, inside);
  await writeInside(circleId, inside);

  for (const ev of events) {
    // The inbox text stays clean; only the message announced to the circle
    // carries the marker, so a RECEIVER can recognise it as a family event
    // instead of matching English (see events.ts).
    const text = `${fix.name} ${ev.type === 'enter' ? 'arrived at' : 'left'} ${ev.name}`;
    await recordAlert({
      circleId, kind: ev.type, actorId: fix.userId, actorName: fix.name, text, at: fix.ts,
    });
    opts.announce?.(formatCrossing(fix.name, ev.type, ev.name));
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
  console.log('family/fixPipeline self-check OK');
}
