// lib/spaces/shift.ts — the shift window editor's validation, and the copy of
// the last shift this device saved.
//
// PATCH /chats/{id}/shift writes the shift, and the server uses it at once for
// the "late today" count in the ops summary. There is NO endpoint that reads it
// back, so the on-device attendance view (app/space-attendance.tsx) cannot ask
// the server for it.
// ponytail: the saved copy is device-local, so another administrator's change
// is not seen here and a new device starts with none. Replace loadSavedShift
// with a server read once GET /chats/{id}/shift (or shift fields in
// /ops/summary) exists.

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
