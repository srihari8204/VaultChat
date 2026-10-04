// lib/spaces/shift.ts — the shift window editor's validation, and where the
// shift is read from.
//
// PATCH /chats/{id}/shift writes the shift; GET /chats/{id}/shift reads it back
// (edit_settings or view_space_ops). loadShift() asks the server first and
// keeps a copy on this device; the copy is used only when the server cannot
// answer — a 403 for a member without those permissions, a 404 from an older
// server without the read, or no connection.

import { parseClock } from './attendance';

export interface ShiftForm { start: string; end: string; grace: string; delay: string }

export interface ShiftBody {
  shiftStart: string; shiftEnd: string; shiftGraceMinutes: number;
  runDelayThresholdMinutes?: number;
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Validate the editor's fields into the PATCH body. Blank start AND end clears
 * the shift (the server stores NULL); one without the other is refused, since
 * attendance needs both ends to say "late" or "left early".
 */
export function shiftBody(f: ShiftForm): { ok: true; body: ShiftBody } | { ok: false; error: string } {
  const start = f.start.trim(), end = f.end.trim();
  const s = start ? parseClock(start) : null;
  const e = end ? parseClock(end) : null;
  if ((start && s == null) || (end && e == null)) return { ok: false, error: 'Use 24-hour times such as 09:00 and 17:30.' };
  if ((s == null) !== (e == null)) return { ok: false, error: 'Set both a start and an end, or clear both.' };
  const grace = f.grace.trim() === '' ? 10 : Number(f.grace.trim());
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) return { ok: false, error: 'Grace must be 0 to 240 minutes.' };
  const delayText = f.delay.trim();
  const delay = delayText === '' ? undefined : Number(delayText);
  if (delay !== undefined && (!Number.isInteger(delay) || delay < 1 || delay > 240)) {
    return { ok: false, error: 'The late-run warning must be 1 to 240 minutes.' };
  }
  return {
    ok: true,
    body: {
      shiftStart: s == null ? '' : hhmm(s),
      shiftEnd: e == null ? '' : hhmm(e),
      shiftGraceMinutes: grace,
      ...(delay !== undefined ? { runDelayThresholdMinutes: delay } : {}),
    },
  };
}

// Storage is lazy-required so the validator above stays importable under tsx.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;
const key = (spaceId: string) => `vc_space_shift_v1:${spaceId}`;

/**
 * Normalise GET /chats/{id}/shift. Empty start/end is the server saying "no
 * shift" — a real answer, kept as such (makeShift turns it into null). Anything
 * malformed is null, so the caller falls back rather than trusting it.
 */
export function shiftFromServer(o: unknown): ShiftBody | null {
  const r = o as Record<string, unknown> | null;
  if (!r || typeof r.shiftStart !== 'string' || typeof r.shiftEnd !== 'string') return null;
  const grace = Number(r.shiftGraceMinutes);
  const delay = Number(r.runDelayThresholdMinutes);
  return {
    shiftStart: r.shiftStart, shiftEnd: r.shiftEnd,
    shiftGraceMinutes: Number.isFinite(grace) ? grace : 10,
    ...(Number.isFinite(delay) && delay > 0 ? { runDelayThresholdMinutes: delay } : {}),
  };
}

/**
 * The space's shift: the server's answer (cached here), else this device's
 * last copy. `source` says which, so a screen can say when it is showing the
 * device copy.
 */
export async function loadShift(spaceId: string): Promise<{ shift: ShiftBody | null; source: 'server' | 'device' }> {
  try {
    // Lazy, like storage: keeps this module importable under tsx.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getShift } = require('./api') as typeof import('./api');
    const body = shiftFromServer(await getShift(spaceId));
    if (body) {
      await rememberShift(spaceId, body);
      return { shift: body, source: 'server' };
    }
  } catch { /* 403 / 404 (older server) / offline: fall back to the device copy */ }
  return { shift: await loadSavedShift(spaceId), source: 'device' };
}

export async function loadSavedShift(spaceId: string): Promise<ShiftBody | null> {
  try {
    const raw = await storage().getItem(key(spaceId));
    const o = raw ? JSON.parse(raw) : null;
    return o && typeof o.shiftStart === 'string' && typeof o.shiftEnd === 'string' ? o as ShiftBody : null;
  } catch { return null; }
}

export async function rememberShift(spaceId: string, body: ShiftBody): Promise<void> {
  try { await storage().setItem(key(spaceId), JSON.stringify(body)); } catch { /* best-effort */ }
}
