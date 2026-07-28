// lib/family/geofence.ts — on-device geofence evaluation for Family Circle
// "Places". Definitions AND crossing decisions stay on the device; only the
// RESULT (arrived at / left <place>) is surfaced by the caller as an E2EE system
// message. Pure + self-checked: `npx tsx lib/family/geofence.ts`.
//
// Hysteresis: you're "in" once within radius, and only "out" once past radius +
// EXIT_MARGIN. That stops a member parked on the boundary from flapping
// enter/leave every GPS jitter.

import { haversine, type LatLng } from '../nav/geo';

export interface Geofence { id: string; name: string; center: LatLng; radiusM: number; }
export interface FenceEvent { id: string; name: string; type: 'enter' | 'leave' }

export const EXIT_MARGIN_M = 40;

/**
 * Fold a new position into the set of fences we're currently inside, returning
 * the transitions that just happened. Mutates `inside` (the caller persists it).
 */
export function evaluateFences(fences: Geofence[], pos: LatLng, inside: Set<string>): FenceEvent[] {
  const events: FenceEvent[] = [];
  for (const f of fences) {
    const d = haversine(f.center, pos);
    const was = inside.has(f.id);
    if (!was && d <= f.radiusM) { inside.add(f.id); events.push({ id: f.id, name: f.name, type: 'enter' }); }
    else if (was && d > f.radiusM + EXIT_MARGIN_M) { inside.delete(f.id); events.push({ id: f.id, name: f.name, type: 'leave' }); }
  }
  // Drop fences that no longer exist so a deleted place can't linger as "inside".
  const live = new Set(fences.map((f) => f.id));
  for (const id of [...inside]) if (!live.has(id)) inside.delete(id);
  return events;
}

// self-check
if (require.main === module) {
  const home: Geofence = { id: 'home', name: 'Home', center: { lat: 12.9716, lng: 77.5946 }, radiusM: 100 };
  const inside = new Set<string>();
  const near = home.center;                                  // dead centre → enter
  const far = { lat: 12.9800, lng: 77.5946 };                // ~930 m north → leave
  const edge = { lat: 12.9716 + 0.0005, lng: 77.5946 };      // ~55 m: inside radius+margin, no leave

  let ev = evaluateFences([home], near, inside);
  if (ev.length !== 1 || ev[0].type !== 'enter') throw new Error('expected enter, got ' + JSON.stringify(ev));
  ev = evaluateFences([home], edge, inside);
  if (ev.length !== 0) throw new Error('hysteresis: should NOT leave at 55m, got ' + JSON.stringify(ev));
  if (!inside.has('home')) throw new Error('should still be inside at the edge');
  ev = evaluateFences([home], far, inside);
  if (ev.length !== 1 || ev[0].type !== 'leave') throw new Error('expected leave, got ' + JSON.stringify(ev));
  ev = evaluateFences([home], near, inside);                 // re-enter
  if (ev.length !== 1 || ev[0].type !== 'enter') throw new Error('expected re-enter');
  // deleted fence shouldn't linger
  evaluateFences([], near, inside);
  if (inside.size !== 0) throw new Error('deleted fence lingered in inside set');
  console.log('geofence self-check OK');
}
