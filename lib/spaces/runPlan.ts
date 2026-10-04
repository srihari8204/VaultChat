// lib/spaces/runPlan.ts — pure helpers for building a run's stop list and
// manifest in app/space-runs-admin.tsx.
//
// The server replaces a run's stops as a WHOLE LIST (DELETE + INSERT in
// spaces_runs.go runStopsSet), so every stop gets a NEW id on every save and
// run_riders.stop_id is nulled by its ON DELETE SET NULL foreign key. Any edit
// to the stops must therefore re-send the rider→stop assignments against the
// new ids, or every rider silently falls back to "no stop". These helpers keep
// that bookkeeping out of the screen and under a self-check
// (lib/spaces/runPlan.selftest.ts).
//
// Pure — no react-native imports.

import type { RunStop, RunRider } from './runs';
export { parseClock } from './attendance';

export interface StopPayload { label: string; lat?: number; lng?: number; plannedAt?: string }

/** "12.97, 77.59" → a valid coordinate, else null. */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { lat, lng };
}

/** A local wall-clock time on the LOCAL day of `baseMs`, as an RFC 3339 instant. */
export function plannedAtOn(baseMs: number, minutes: number): string {
  const d = new Date(baseMs);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.toISOString();
}

/** The local "HH:MM" of an instant, for pre-filling an edit form. */
export function clockOf(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The PUT body for a stop list, keeping each stop's place and time. */
export function stopPayload(stops: Pick<RunStop, 'label' | 'lat' | 'lng' | 'plannedAt'>[]): StopPayload[] {
  return stops.map((s) => ({
    label: s.label,
    ...(s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : {}),
    ...(s.plannedAt ? { plannedAt: s.plannedAt } : {}),
  }));
}

/**
 * Re-point riders at the stop ids the server issued after a stop-list save.
 *
 * `previousIds[i]` is the OLD id of the stop now at position i (null for a stop
 * that did not exist before). A rider whose stop was removed gets no stop — it
 * then shows at the driver's first stop rather than vanishing.
 */
export function remapRiders(
  riders: Pick<RunRider, 'riderId' | 'stopId'>[],
  previousIds: (string | null)[],
  savedStops: Pick<RunStop, 'id' | 'seq'>[],
): { riderId: string; stopId: string | null }[] {
  const ordered = [...savedStops].sort((a, b) => a.seq - b.seq);
  const map = new Map<string, string>();
  previousIds.forEach((old, i) => { if (old && ordered[i]) map.set(old, ordered[i].id); });
  return riders.map((r) => ({ riderId: r.riderId, stopId: (r.stopId && map.get(r.stopId)) || null }));
}
