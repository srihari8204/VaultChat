// lib/spaces/runPlan.ts — pure helpers for building a run's stop list and
// manifest in app/space-runs-admin.tsx.
//
// The stop list is saved as a WHOLE LIST (PUT). A stop sent WITH its id is
// updated in place by a current server (spaces_runs.go runStopsSet), keeping
// its arrival mark and every rider's stop_id. An older server ignores the id,
// re-creates every stop with a NEW id, and its ON DELETE SET NULL foreign key
// nulls run_riders.stop_id — so against that server the rider→stop
// assignments must be re-sent against the new ids (remapRiders), or every
// rider silently falls back to "no stop". idsPreserved() tells the two apart
// from the PUT's answer. Self-checked in lib/spaces/runPlan.selftest.ts.
//
// Pure — no react-native imports.

import type { Run, RunStop, RunRider } from './runs';
export { parseClock } from './attendance';

export interface StopPayload { id?: string; label: string; lat?: number; lng?: number; plannedAt?: string }

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

/** "2026-10-05" → local midnight of that calendar day (ms), else null. */
export function parseDay(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const t = new Date(y, mo, d);
  // Rejects 2026-02-30 and the like, which Date would roll into March.
  if (t.getFullYear() !== y || t.getMonth() !== mo || t.getDate() !== d) return null;
  return t.getTime();
}

/** The local "YYYY-MM-DD" of an instant, for pre-filling a date field. */
export function dayOf(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The day a stop's planned time belongs to: the run's scheduled day, else the
 * day the admin typed, else null (ask).
 *
 * Never "today": planned_at is a full instant and the server's delay check
 * (runCheckDelays) fires once it has passed, so a time saved the evening
 * before an unscheduled run would make every stop overdue the moment it starts.
 */
export function stopDay(scheduledAt: string | null, typedDay: string): number | null {
  const t = scheduledAt ? Date.parse(scheduledAt) : NaN;
  return Number.isFinite(t) ? t : parseDay(typedDay);
}

/**
 * Where the stop's date+time picker starts: the stop's own planned time, else
 * a sibling stop's planned instant (same run, so usually the same day), else
 * the run's scheduled or start time, else tomorrow 07:00 local. The picker
 * shows the day, so this is only a starting point — never a silent "today"
 * (see stopDay for why today is the wrong default).
 */
export function plannedPickStart(
  own: string | null, sibling: string | null, scheduledAt: string | null, startedAt: string | null, nowMs: number,
): Date {
  for (const iso of [own, sibling, scheduledAt, startedAt]) {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t)) return new Date(t);
  }
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d;
}

/**
 * One entry of `GET /chats/{id}/runs?include=riders[,stops]` split into the
 * run and its manifest — or null when the server did not include them (an
 * older server ignores `include`), so the caller falls back to getRun.
 */
export function splitListedRun(
  r: Run & { riders?: unknown; stops?: unknown }, needStops: boolean,
): { run: Run; riders: RunRider[]; stops: RunStop[] } | null {
  if (!Array.isArray(r.riders) || (needStops && !Array.isArray(r.stops))) return null;
  const { riders, stops, ...run } = r;
  return { run, riders: riders as RunRider[], stops: Array.isArray(stops) ? stops as RunStop[] : [] };
}

/**
 * On a TIMER re-read against a server without `include=` (one getRun per run),
 * the manifest of a run that is not on the road and whose status has not
 * changed since the previous read is kept instead of read again: its rider
 * states are not moving. Started runs, runs that changed status, and runs whose
 * last read failed are always re-read. Focus and pull-to-refresh pass no
 * previous list, so they re-read everything, and so does a timer read once the
 * last full read is MANIFEST_MAX_AGE_MS old (previousForTimerRead).
 */
export function reusableManifest<T extends { run: Pick<Run, 'id' | 'status'>; failed: boolean }>(
  previous: readonly T[] | undefined, run: Pick<Run, 'id' | 'status'>,
): T | null {
  if (!previous || run.status === 'started') return null;
  const p = previous.find((x) => x.run.id === run.id);
  return p && !p.failed && p.run.status === run.status ? p : null;
}

/**
 * How long a timer re-read may keep a not-started run's manifest
 * (reusableManifest). After this, the next timer read passes no previous list
 * and re-reads every run, so a board left open catches riders added to or
 * removed from a SCHEDULED run elsewhere within a few minutes, not only on the
 * next focus or pull.
 */
export const MANIFEST_MAX_AGE_MS = 5 * 60_000;

/** The `previous` list for a timer re-read: none once the last full read is MANIFEST_MAX_AGE_MS old. */
export function previousForTimerRead<T>(previous: T | undefined, lastFullReadAt: number, now: number): T | undefined {
  return now - lastFullReadAt >= MANIFEST_MAX_AGE_MS ? undefined : previous;
}

/**
 * A stop's planned time for a list row: the clock alone when it falls on the
 * run's scheduled day, else the day too — a stop planned for another day (or on
 * a run with no scheduled day) must not read as a time on the run's day.
 */
export function stopWhenText(plannedAt: string | null, scheduledAt: string | null, withDay: (d: Date) => string): string {
  const clock = clockOf(plannedAt);
  if (!clock || !plannedAt) return '';
  const sched = dayOf(scheduledAt);
  return sched && dayOf(plannedAt) === sched ? clock : withDay(new Date(Date.parse(plannedAt)));
}

/** The local "HH:MM" of an instant, for pre-filling an edit form. */
export function clockOf(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The PUT body for a stop list, keeping each stop's place and time, and the
 *  existing stop's id (`prevId`) so a current server updates it in place. */
export function stopPayload(
  stops: (Pick<RunStop, 'label' | 'lat' | 'lng' | 'plannedAt'> & { prevId?: string | null })[],
): StopPayload[] {
  return stops.map((s) => ({
    ...(s.prevId ? { id: s.prevId } : {}),
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

/**
 * Did the server keep the stop ids it was sent? True only when its answer lists
 * `stopIds` and every stop sent with an id came back with that same id at its
 * position — the in-place update, after which riders still point at their
 * stops and need no remap. An older server's answer has no `stopIds`.
 */
export function idsPreserved(previousIds: (string | null)[], stopIds: unknown): boolean {
  if (!Array.isArray(stopIds) || stopIds.length !== previousIds.length) return false;
  return previousIds.every((old, i) => old == null || stopIds[i] === old);
}
