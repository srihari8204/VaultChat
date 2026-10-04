// lib/spaces/sosOutboxCore.ts — the driver SOS outbox with its storage, user,
// clock and server handed in, so sosOutboxCore.selftest.ts can drive it
// through stubs. The rules are sosQueue.ts; the app's wiring (AsyncStorage,
// lib/api, the alerts it shows) is sosOutbox.ts.
//
// What this must never do, whatever fails:
//   - say an alert was delivered without a 2xx for it (press result `sent`,
//     event `sent`). A storage read that fails is "unknown", never "gone";
//   - write the queue from a read that failed (every change re-reads the list
//     and writes nothing when that read throws — as lib/family/store
//     updatePlaces and lib/media/scanRecent do);
//   - keep an alert with no reporter: with nobody to send it as, the press is
//     refused here (SosNotKept) and the caller sends it once, directly;
//   - queue a second alert for a run whose alert is still waiting.

import { errMsg, errStatus } from './errors';
import {
  parseSosQueue, dueSos, afterAttempt, markExpired, sosForRun, liveFor, pruneOthers, retryable, runEnded,
  SOS_FRESH_MS, RUN_ENDED_TEXT, EXPIRED_TEXT, type PendingSos,
} from './sosQueue';

export const SOS_QUEUE_KEY = 'vc_space_sos_queue_v1';

export interface SosDeps {
  store: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };
  /** The signed-in account: '' for nobody. Throws when it cannot be read. */
  me(): Promise<string>;
  /** File one alert as `expectedUserId`. Resolves only on a 2xx; rejects with
   *  lib/api's error (its `status`, 0 for no answer). */
  send(e: PendingSos, expectedUserId: string): Promise<{ runEnded?: boolean } | void>;
  /** The run's status. Rejects like `send`. */
  runStatus(spaceId: string, runId: string): Promise<string | undefined>;
  now(): number;
  newId(): string;
}

/** The press could not be kept on the phone (no known account, or storage
 *  failed): the caller sends it once, directly, and says how that went. */
export class SosNotKept extends Error {
  /** `key`: the id and press time to send it under, so a save that did land
   *  after all is the same incident on a server with migration 146. */
  constructor(readonly reason: 'no-reporter' | 'storage', readonly key: { id: string; at: number }) {
    super(reason === 'no-reporter' ? 'No signed-in account to keep the alert for' : 'The alert could not be saved');
  }
}

/** Couldn't read the queue or who is signed in: neither "none" nor "sent". */
export class SosUnknown extends Error {
  constructor() { super('Could not check the emergency alerts on this phone'); }
}

export type PressResult =
  | { kind: 'sent'; id: string; at: number; runEnded?: boolean }
  | { kind: 'waiting'; id: string; at: number; reused: boolean }
  | { kind: 'dead'; id: string; at: number; why: string };

/** `by`: the press that is waiting for its own answer, or a retry nobody is
 *  waiting on (the app says those, sosOutbox watchSosOutcomes). */
export type SosEvent =
  | { type: 'sent'; entry: PendingSos; by: 'press' | 'retry'; at: number; runEnded?: boolean }
  | { type: 'dead'; entry: PendingSos; by: 'press' | 'retry' };

export function createSosOutbox(d: SosDeps) {
  const queueListeners = new Set<() => void>();
  const eventListeners = new Set<(e: SosEvent) => void>();
  const emit = (e: SosEvent) => eventListeners.forEach((l) => { try { l(e); } catch { /* a listener's problem */ } });

  /** Throws when storage cannot be read: never "empty" on a failure. */
  const load = async (): Promise<PendingSos[]> => parseSosQueue(await d.store.getItem(SOS_QUEUE_KEY));

  // One chain for every read-modify-write: a press during a flush cannot be
  // overwritten by the flush's older copy, and a failed read writes nothing.
  let chain: Promise<unknown> = Promise.resolve();
  function mutate(fn: (q: PendingSos[]) => PendingSos[]): Promise<PendingSos[]> {
    const next = chain.then(async () => {
      const before = await load();
      const after = fn(before);
      if (after === before) return before;
      await d.store.setItem(SOS_QUEUE_KEY, JSON.stringify(after));
      queueListeners.forEach((l) => { try { l(); } catch { /* a listener's problem */ } });
      return after;
    });
    chain = next.catch(() => {});
    return next;
  }

  const meOrEmpty = () => d.me().catch(() => '');

  // Presses waiting for their own answer, and what the flush found for them.
  const pressing = new Set<string>();
  const outcome = new Map<string, PressResult>();
  // Delivered in this session but not yet removed from storage (the write
  // after the 2xx failed): never sent again from here.
  const delivered = new Set<string>();
  // Dead entries already said to the driver this session.
  const told = new Set<string>();
  let inFlight: string | null = null;

  const by = (id: string) => (pressing.has(id) ? 'press' as const : 'retry' as const);
  const record = (r: PressResult) => { if (pressing.has(r.id)) outcome.set(r.id, r); };
  const died = (e: PendingSos, why: string) => {
    record({ kind: 'dead', id: e.id, at: e.at, why });
    emit({ type: 'dead', entry: { ...e, dead: why }, by: by(e.id) });
  };

  /** Store a failed attempt: retryable → kept; refused → dead, and said. */
  async function settle(e: PendingSos, r: { status: number; message?: string }): Promise<void> {
    const after = await mutate((q) => afterAttempt(q, e.id, r)).catch(() => null);
    if (retryable(r.status)) return;
    if (after && !after.some((x) => x.id === e.id)) return; // withdrawn meanwhile
    died(e, afterAttempt([e], e.id, r)[0].dead!);
  }

  async function sendOne(me: string, e: PendingSos): Promise<void> {
    if (delivered.has(e.id)) { await mutate((q) => afterAttempt(q, e.id, null)).catch(() => {}); return; }
    if (!pressing.has(e.id) && d.now() - e.at > SOS_FRESH_MS) {
      // A retry nobody pressed just now: only while its run is still going.
      // (A repeat press is the driver saying it again on that run's screen.)
      let status: string | undefined;
      try { status = await d.runStatus(e.spaceId, e.runId); } catch (err) {
        const s = errStatus(err);
        if (!retryable(s)) await settle(e, { status: s, message: errMsg(err) });
        return; // offline: the next flush checks again
      }
      if (runEnded(status)) { await settle(e, { status: 410, message: RUN_ENDED_TEXT }); return; }
    }
    // Withdrawn, refused or sent while this flush was busy: leave it.
    const cur = (await load()).find((x) => x.id === e.id);
    if (!cur || cur.dead || cur.reporterId !== me) return;
    inFlight = e.id;
    let res: { runEnded?: boolean } | void;
    try {
      res = await d.send(e, e.reporterId);
    } catch (err) {
      await settle(e, { status: errStatus(err), message: errMsg(err) });
      return;
    } finally { inFlight = null; }
    delivered.add(e.id);
    const ended = !!(res && res.runEnded);
    record({ kind: 'sent', id: e.id, at: e.at, ...(ended ? { runEnded: true } : null) });
    emit({ type: 'sent', entry: e, by: by(e.id), at: d.now(), ...(ended ? { runEnded: true } : null) });
    await mutate((q) => afterAttempt(q, e.id, null)).catch(() => { /* kept; `delivered` stops a resend */ });
  }

  let flushing: Promise<void> | null = null;

  /** Send every waiting alert of the signed-in account. Never throws. */
  function flushSos(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        const me = await meOrEmpty();
        if (!me) return;
        const now = d.now();
        const q = await mutate((x) => pruneOthers(x, me, now));
        const { send, expire } = dueSos(q, me, now);
        if (expire.length) {
          await mutate((x) => markExpired(x, new Set(expire.map((e) => e.id))));
          for (const e of expire) died(e, EXPIRED_TEXT);
        }
        for (const e of send) await sendOne(me, e);
      } catch { /* storage unreadable: nothing was written; the next flush tries again */ } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  /**
   * After the driver confirmed the panic control. Keeps the alert (or reuses
   * the one still waiting for this run), then tries to send it. `sent` only
   * from a 2xx. Throws SosNotKept when it could not be kept.
   */
  async function queueSos(spaceId: string, runId: string): Promise<PressResult> {
    const key = { id: d.newId(), at: d.now() };
    const me = await d.me().catch(() => '');
    if (!me) throw new SosNotKept('no-reporter', key);
    let entry: PendingSos | undefined;
    let reused = false;
    try {
      await mutate((q) => {
        const live = liveFor(q, spaceId, runId, me, key.at);
        if (live) { entry = live; reused = true; return q; }
        entry = { ...key, spaceId, runId, reporterId: me };
        return [...q, entry];
      });
    } catch { throw new SosNotKept('storage', key); }
    const e = entry!;
    pressing.add(e.id);
    outcome.delete(e.id);
    try {
      // A flush already under way read the list before this entry existed.
      if (flushing) await flushing;
      await flushSos();
      // Sent or refused while a flush was busy before this press: its outcome
      // was recorded then. Otherwise it is kept and waiting.
      return outcome.get(e.id) ?? { kind: 'waiting', id: e.id, at: e.at, reused };
    } finally {
      pressing.delete(e.id);
      const o = outcome.get(e.id);
      if (o?.kind === 'dead') told.add(e.id);
      outcome.delete(e.id);
    }
  }

  /** Send once without keeping it (SosNotKept). Same key and press time on
   *  every retry of one press. Rejects like `send`. */
  function sendUnkept(spaceId: string, runId: string, key: { id: string; at: number }) {
    return d.send({ id: key.id, spaceId, runId, reporterId: '', at: key.at }, '');
  }

  /** This driver's waiting and undeliverable alerts for one run. Throws
   *  SosUnknown when the list or the account cannot be read. */
  async function sosForThisRun(spaceId: string, runId: string): Promise<PendingSos[]> {
    let me: string;
    let q: PendingSos[];
    try { me = await d.me(); q = await load(); } catch { throw new SosUnknown(); }
    if (!me) throw new SosUnknown();
    return sosForRun(q, spaceId, runId, me);
  }

  /** My dead alerts not yet said this session; marks them said. Throws
   *  SosUnknown when they cannot be read. */
  async function undeliveredToTell(): Promise<PendingSos[]> {
    let me: string;
    let q: PendingSos[];
    try { me = await d.me(); q = await load(); } catch { throw new SosUnknown(); }
    const fresh = q.filter((e) => !!me && e.reporterId === me && !!e.dead && !told.has(e.id));
    fresh.forEach((e) => told.add(e.id));
    return fresh;
  }

  /** Remove an entry the driver has seen was not delivered. */
  const dismissSos = (id: string): Promise<void> => mutate((q) => q.filter((e) => e.id !== id)).then(() => {});

  /** The driver withdraws a waiting alert. `mayHaveGone`: it was being sent
   *  at that moment, so the office may still get it. Throws when it could not
   *  be removed. */
  async function withdrawSos(id: string): Promise<{ mayHaveGone: boolean }> {
    const mayHaveGone = inFlight === id;
    await mutate((q) => { const k = q.filter((e) => e.id !== id); return k.length === q.length ? q : k; });
    return { mayHaveGone };
  }

  return {
    queueSos, flushSos, sendUnkept, sosForThisRun, undeliveredToTell, dismissSos, withdrawSos,
    /** Called after every change to the stored queue. Returns the unsubscribe. */
    onSosQueueChange(fn: () => void): () => void { queueListeners.add(fn); return () => { queueListeners.delete(fn); }; },
    /** Every 2xx and every final refusal, once. Returns the unsubscribe. */
    onSosEvent(fn: (e: SosEvent) => void): () => void { eventListeners.add(fn); return () => { eventListeners.delete(fn); }; },
  };
}
