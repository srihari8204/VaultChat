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
//   - A refusal that retrying cannot fix (403, 400, 404) is marked dead with
//     the server's words, not retried forever and not dropped.
//   - A retry (anything older than SOS_FRESH_MS) is sent only while its run is
//     still going: once the run has finished it is marked dead, not sent.
//   - It carries its press time and its own key (`id`, a uuid), so a server
//     with migration 146 says when it was pressed and files one incident per
//     press however often the request is repeated. Today's server ignores both.

export interface PendingSos {
  /** A uuid: the local id, and the idempotency key sent as `clientKey`. */
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

/** Younger than this, an alert is sent without first checking its run: the
 *  press happened on that run's screen while it was going. */
export const SOS_FRESH_MS = 60_000;

export const RUN_ENDED_TEXT = 'The run had finished before it could be sent, so it was not sent.';

/** Another account's entries this session can never send are removed after
 *  this (they stopped being sendable at SOS_MAX_AGE_MS). */
export const SOS_PRUNE_MS = 24 * 60 * 60_000;

export const runEnded = (status: string | undefined): boolean => status === 'completed' || status === 'cancelled';

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

/** The alert still waiting for this run, if any: a repeat press retries it
 *  instead of queueing a second alert. One too old to send is not reused. */
export function liveFor(q: PendingSos[], spaceId: string, runId: string, me: string, now: number): PendingSos | undefined {
  return q.find((e) => !e.dead && e.spaceId === spaceId && e.runId === runId && e.reporterId === me
    && now - e.at <= SOS_MAX_AGE_MS);
}

/** Drop other accounts' entries older than SOS_PRUNE_MS. Mine always stay
 *  (a dead one stays until the driver dismisses it). */
export function pruneOthers(q: PendingSos[], me: string, now: number): PendingSos[] {
  if (!me) return q;
  const keep = q.filter((e) => e.reporterId === me || now - e.at <= SOS_PRUNE_MS);
  return keep.length === q.length ? q : keep;
}

/** 24-hour "HH:MM" of a press, in this phone's time. */
export function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "just now", "12 min ago", "2 h 5 min ago". */
export function ageText(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min ago` : `${h} h ago`;
}

/** The incident request for one alert. `note` stays empty: it is reserved for
 *  ciphertext. `clientKey`, `pressedAt` and `pressedClock` are read by a
 *  server with migration 146 and ignored by one without. */
export function sosBody(e: PendingSos) {
  return {
    category: 'sos', runId: e.runId, note: '',
    clientKey: e.id, pressedAt: new Date(e.at).toISOString(), pressedClock: clockOf(e.at),
  };
}

/** This driver's entries for one run, oldest first: what the driver screen shows. */
export function sosForRun(q: PendingSos[], spaceId: string, runId: string, me: string): PendingSos[] {
  return q.filter((e) => e.spaceId === spaceId && e.runId === runId && e.reporterId === me)
    .sort((a, b) => a.at - b.at);
}

const ENDED_NOTE = ' The run had already finished, so the families on it were not alerted.';

/** The press's own answer, after a 2xx. `runEnded`: the server (migration
 *  146) filed it for the office only. */
export function sentText(runEndedAtServer?: boolean): string {
  return `The office has your emergency alert.${runEndedAtServer ? ENDED_NOTE : ''}`;
}

/** Said app-wide when a retry, not the press, delivered an alert. */
export function deliveredText(e: PendingSos, now: number, runEndedAtServer?: boolean): string {
  return `Your emergency alert from ${clockOf(e.at)} reached the office at ${clockOf(now)}.`
    + `${runEndedAtServer ? ENDED_NOTE : ''}`;
}

/** Said app-wide for alerts that will never be delivered. */
export function undeliveredText(list: PendingSos[]): string {
  if (list.length === 1) {
    return `Your emergency alert from ${clockOf(list[0].at)} was not delivered: ${list[0].dead} Call your transport office.`;
  }
  return `${list.length} emergency alerts (from ${list.map((e) => clockOf(e.at)).join(', ')}) were not delivered. `
    + 'Call your transport office.';
}
