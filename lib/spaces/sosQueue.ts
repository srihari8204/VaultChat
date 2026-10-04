// lib/spaces/sosQueue.ts — the rules for a driver's emergency alert that has
// not reached the server yet. Pure, so sosQueue.selftest.ts runs under tsx; the
// runtime that stores and sends is lib/spaces/sosOutbox.ts.
//
// The panic button (app/space-run-driver.tsx) used to retry only while its
// Alert was on screen: a driver who dismissed it, or whose app was closed,
// lost the alert. Now each press is kept on the phone until the server
// accepts it, and retried while crazzychat is open, across restarts.
//
// What an entry may NOT do is go quietly wrong:
//   - It is sent only by the account that pressed it (a shared phone signed in
//     as someone else must not file an emergency under their name).
//   - It is never sent once it is SOS_MAX_AGE_MS old. The server pushes "an
//     emergency has been reported on this run" to the riders' guardians; hours
//     later that is a false alarm, not a late warning. It is marked dead
//     instead, so the driver sees it was never delivered.
//   - A refusal that retrying cannot fix (403, 400, a run that is gone: 404) is
//     marked dead with the server's words, not retried forever and not dropped.

export interface PendingSos {
  /** Local id, for dismissing one entry. */
  id: string;
  spaceId: string;
  runId: string;
  /** The account that pressed it. Only that account sends it. */
  reporterId: string;
  /** When it was pressed (epoch ms). */
  at: number;
  /** Why it will never be sent, once that is known. The driver dismisses it. */
  dead?: string;
}

/** Past this, a queued alert is not sent: see the header. */
export const SOS_MAX_AGE_MS = 2 * 60 * 60_000;

export const EXPIRED_TEXT = 'Not delivered within 2 hours, so it was not sent: arriving this late it would raise a false alarm.';

/** Stored entries are data read back from disk: keep only well-formed rows. */
export function parseSosQueue(raw: string | null): PendingSos[] {
  try {
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const out: PendingSos[] = [];
    for (const x of list as unknown[]) {
      if (!x || typeof x !== 'object') continue;
      const r = x as Record<string, unknown>;
      const str = (k: string) => (typeof r[k] === 'string' && r[k] ? (r[k] as string) : '');
      const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : NaN;
      if (!str('id') || !str('spaceId') || !str('runId') || !str('reporterId') || Number.isNaN(at)) continue;
      out.push({
        id: str('id'), spaceId: str('spaceId'), runId: str('runId'), reporterId: str('reporterId'), at,
        ...(str('dead') ? { dead: str('dead') } : null),
      });
    }
    return out;
  } catch { return []; }
}

/** A failure worth retrying: no answer (offline, status 0), an expired
 *  session (fixed by signing in again), a timeout, rate limit or server error. */
export function retryable(status: number): boolean {
  return status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
}

/** What a flush by `me` at `now` should send, and what is now too old to. */
export function dueSos(q: PendingSos[], me: string, now: number): { send: PendingSos[]; expire: PendingSos[] } {
  const mine = q.filter((e) => !e.dead && !!me && e.reporterId === me);
  return {
    send: mine.filter((e) => now - e.at <= SOS_MAX_AGE_MS),
    expire: mine.filter((e) => now - e.at > SOS_MAX_AGE_MS),
  };
}

/** `null`: the server accepted it. Otherwise the failure's status and words. */
export type SosOutcome = null | { status: number; message?: string };

/** The queue after one send attempt: accepted → gone; retryable → kept; refused → dead. */
export function afterAttempt(q: PendingSos[], id: string, r: SosOutcome): PendingSos[] {
  if (!r) return q.filter((e) => e.id !== id);
  if (retryable(r.status)) return q;
  const why = r.message || `The server refused it (${r.status}).`;
  return q.map((e) => (e.id === id ? { ...e, dead: why } : e));
}

export function markExpired(q: PendingSos[], ids: ReadonlySet<string>): PendingSos[] {
  return q.map((e) => (ids.has(e.id) && !e.dead ? { ...e, dead: EXPIRED_TEXT } : e));
}

/** This driver's entries for one run, oldest first: what the driver screen shows. */
export function sosForRun(q: PendingSos[], spaceId: string, runId: string, me: string): PendingSos[] {
  return q.filter((e) => e.spaceId === spaceId && e.runId === runId && e.reporterId === me)
    .sort((a, b) => a.at - b.at);
}
