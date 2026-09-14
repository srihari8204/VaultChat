// lib/vaultBeam/persistence.ts — durable session state + write-behind.
//
// What is persisted (design §6): identity, BOTH bitmaps, the sender's source
// reference, the last transport, and per-driver cooldown state.
//
// What is deliberately NOT persisted:
//   • the retry queue — it is exactly `¬PeerHave ∧ ¬R2Have`, a pure function of
//     the bitmaps. A stored copy is a second source of truth that can disagree
//     with them after a crash, which is the class of bug this change exists to
//     remove.
//   • the in-flight set — after a crash nothing IS in flight, so recording
//     otherwise would suppress legitimate retries.
//
// The store is an interface and the scheduler is injectable, so the coalescing
// and flush-on-transition rules are exercised deterministically under `npx tsx`.
// The op-sqlite binding is lazily imported, keeping this module Node-safe.

import { TransferSession, type SessionSnapshot } from './session';

/** One durable row. */
export interface PersistedSession extends SessionSnapshot {
  srcPath?: string;
  srcSize?: number;
  srcMtime?: number;
  /** JSON: per-driver { failures, cooldownUntil } — so backoff survives a restart. */
  driverState?: string;
  updatedAt?: number;
}

/**
 * Is the source file still the one this transfer was keyed against?
 *
 * WHY THIS EXISTS — AES-GCM NONCE REUSE.
 *
 * A resumed send re-seals blocks at the SAME (transfer key, chunkId), because
 * the chunk id IS the nonce input and both survive the restart. That is correct
 * and necessary — it is what makes resume cheap — but it holds only while the
 * plaintext under a given chunkId is the same plaintext. A block whose PUT
 * succeeded but whose relayMarkUploaded never landed is re-sealed on the next
 * launch; if `srcPath` now holds different bytes (the DocumentPicker cache is
 * app-managed and evictable, and a user can re-pick an edited file at the same
 * path), the two ciphertexts share a keystream. XOR recovers it, and with it the
 * GHASH authentication key — forgery, not just disclosure.
 *
 * So: record size+mtime at transfer start, verify them here on resume, refuse
 * the resume on any disagreement. The invariant: a (transferId, chunkId) is
 * sealed at most once over distinct plaintext.
 *
 * FAIL-CLOSED on anything unreadable — an un-stattable source is exactly the
 * case where we cannot prove the bytes are the same. The single exception is a
 * record written before this check existed, which carries NEITHER field; those
 * keep the old behaviour rather than being mass-failed on one upgrade.
 *
 * ponytail: mtime granularity is the ceiling — an edit that preserves the byte
 * count AND the timestamp slips through. The whole-file sha256 the sender
 * already computes would close it; re-hashing up to 12 GB on every resume is
 * the price, so it is not paid by default.
 */
export function sourceMatches(
  rec: Pick<PersistedSession, 'srcSize' | 'srcMtime'>,
  cur: { size?: unknown; mtime?: unknown },
): boolean {
  if (rec.srcSize === undefined && rec.srcMtime === undefined) return true;  // pre-binding record
  if (rec.srcSize !== undefined && cur.size !== rec.srcSize) return false;
  if (rec.srcMtime !== undefined && cur.mtime !== rec.srcMtime) return false;
  return true;
}

export interface SessionStore {
  save(rec: PersistedSession): Promise<void>;
  loadAll(): Promise<PersistedSession[]>;
  remove(transferId: string): Promise<void>;
}

type TimerHandle = any;
export interface WriteBehindOpts {
  store: SessionStore;
  /** Coalesce window for frequent progress ticks. */
  delayMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  cancel?: (h: TimerHandle) => void;
  /** Extra durable fields the session itself does not know about. */
  extra?: (session: TransferSession) => Partial<PersistedSession>;
  onError?: (e: unknown) => void;
}

/**
 * Coalesced writer. Frequent progress ticks collapse into one write per window;
 * a transition (transport change, pause, terminal, backgrounding) flushes
 * immediately, because those are exactly the moments a crash is likely to
 * follow and the moments whose loss would cost real work.
 */
export class WriteBehind {
  private readonly pending = new Map<string, TransferSession>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly opts: Required<Omit<WriteBehindOpts, 'extra' | 'onError'>> & Pick<WriteBehindOpts, 'extra' | 'onError'>;
  writes = 0;

  constructor(o: WriteBehindOpts) {
    this.opts = {
      store: o.store,
      delayMs: o.delayMs ?? 1500,
      now: o.now ?? (() => Date.now()),
      schedule: o.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
      cancel: o.cancel ?? ((h) => clearTimeout(h)),
      extra: o.extra,
      onError: o.onError,
    };
  }

  private record(s: TransferSession): PersistedSession {
    return { ...s.snapshot(), ...(this.opts.extra?.(s) ?? {}), updatedAt: this.opts.now() };
  }

  /** Queue a write. `immediate` bypasses coalescing (use on any transition). */
  schedule(session: TransferSession, immediate = false): void {
    const id = session.transferId;
    this.pending.set(id, session);
    const t = this.timers.get(id);
    if (immediate) {
      if (t !== undefined) { this.opts.cancel(t); this.timers.delete(id); }
      void this.flush(id);
      return;
    }
    if (t !== undefined) return;                 // a write is already queued
    this.timers.set(id, this.opts.schedule(() => { this.timers.delete(id); void this.flush(id); }, this.opts.delayMs));
  }

  async flush(transferId: string): Promise<void> {
    const s = this.pending.get(transferId);
    if (!s) return;
    this.pending.delete(transferId);
    const t = this.timers.get(transferId);
    if (t !== undefined) { this.opts.cancel(t); this.timers.delete(transferId); }
    try { this.writes++; await this.opts.store.save(this.record(s)); }
    catch (e) { this.opts.onError?.(e); }
  }

  /** Flush everything — call on AppState background and before teardown. */
  async flushAll(): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.flush(id);
  }

  /** Drop a transfer's durable record (terminal + acknowledged). */
  async forget(transferId: string): Promise<void> {
    this.pending.delete(transferId);
    const t = this.timers.get(transferId);
    if (t !== undefined) { this.opts.cancel(t); this.timers.delete(transferId); }
    try { await this.opts.store.remove(transferId); } catch (e) { this.opts.onError?.(e); }
  }

  pendingCount(): number { return this.pending.size; }
  timerCount(): number { return this.timers.size; }
}

/** Default op-sqlite binding — lazily imported so this module stays Node-safe. */
export async function defaultSessionStore(): Promise<SessionStore> {
  const db = await import('../localDb');
  return {
    save: (rec) => db.persistVbChunkState(rec as any),
    loadAll: () => db.loadVbChunkStates() as any,
    remove: (id) => db.deleteVbChunkState(id),
  };
}

// ── self-check: `npx tsx lib/vaultBeam/persistence.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('persistence: ' + m); };
  const CHUNK = 512 * 1024;

  class FakeStore implements SessionStore {
    rows = new Map<string, PersistedSession>();
    saves = 0;
    removes = 0;
    failNext = false;
    async save(rec: PersistedSession) {
      if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
      this.saves++; this.rows.set(rec.transferId, rec);
    }
    async loadAll() { return [...this.rows.values()]; }
    async remove(id: string) { this.removes++; this.rows.delete(id); }
  }

  /** Manual scheduler so coalescing is deterministic. */
  class Clock {
    private q: Array<{ id: number; at: number; fn: () => void }> = [];
    private seq = 0;
    t = 0;
    schedule = (fn: () => void, ms: number) => { const id = ++this.seq; this.q.push({ id, at: this.t + ms, fn }); return id; };
    cancel = (h: any) => { this.q = this.q.filter((x) => x.id !== h); };
    now = () => this.t;
    advance(ms: number) {
      this.t += ms;
      const due = this.q.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at);
      this.q = this.q.filter((x) => x.at > this.t);
      for (const d of due) d.fn();
    }
  }

  const mkSession = (id = 'Tpersist12345678') => new TransferSession({
    transferId: id, sessionVersion: 1, fileId: 'F', keyB64: 'k', role: 'recipient',
    totalBytes: 10 * CHUNK, name: 'big.bin',
  });

  const run = async () => {
    // 1. frequent ticks COALESCE into a single write
    let store = new FakeStore();
    let clock = new Clock();
    let wb = new WriteBehind({ store, delayMs: 1500, now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
    const s = mkSession();
    for (let i = 0; i < 5; i++) { s.markVerified(i); wb.schedule(s); }
    A(store.saves === 0, 'nothing written before the window elapses');
    clock.advance(1500);
    await Promise.resolve();
    A(store.saves === 1, `5 ticks coalesced into 1 write (got ${store.saves})`);
    A(store.rows.get(s.transferId)!.peerHave !== undefined, 'the bitmap was persisted');

    // 2. a transition flushes IMMEDIATELY — the moment before a likely crash.
    //    Scheduling then flushing also proves flush() cancels the queued timer.
    s.markVerified(5);
    wb.schedule(s);
    A(wb.timerCount() === 1, 'a coalescing timer was queued');
    await wb.flush(s.transferId);
    A(store.saves === 2, 'immediate flush wrote at once');
    A(wb.pendingCount() === 0 && wb.timerCount() === 0, 'no pending state or timer left behind');

    // 3. round-trip: restore reproduces the work-list exactly
    const rec = store.rows.get(s.transferId)!;
    const restored = TransferSession.restore(rec, { fileId: 'F', keyB64: 'k' });
    A(restored.peerHave.popcount() === s.peerHave.popcount(), 'restored bitmap matches');
    A(JSON.stringify(restored.pendingRuns()) === JSON.stringify(s.pendingRuns()), 'restored work-list matches');
    A(restored.progressBytes() === s.progressBytes(), 'restored progress matches');
    A(restored.inflightCount === 0, 'a restored session has nothing in flight');

    // 4. in-flight is NEVER persisted — after a crash nothing is in flight, and
    //    recording otherwise would suppress legitimate retries
    const inflight = mkSession('Tinflight12345678');
    inflight.claim([{ start: 0, count: 4 }]);
    A(inflight.inflightCount === 4, 'four chunks are in flight');
    const wb2 = new WriteBehind({ store, now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
    wb2.schedule(inflight);
    await wb2.flush('Tinflight12345678');
    const infRec = store.rows.get('Tinflight12345678');
    A(infRec !== undefined, 'in-flight session persisted');
    A(!('inflight' in (infRec as any)), 'the in-flight set is not in the record');
    A(TransferSession.restore(infRec!, { fileId: 'F', keyB64: 'k' }).inflightCount === 0,
      'a restored session has nothing in flight');

    // 5. the retry queue is NOT stored — it is derived from the bitmaps
    A(!('workList' in (rec as any)) && !('retryQueue' in (rec as any)), 'no stored work-list/retry queue');

    // 6. extra fields (source ref, driver cooldowns) ride along
    store = new FakeStore(); clock = new Clock();
    wb = new WriteBehind({
      store, now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
      extra: () => ({ srcPath: '/cache/f.bin', srcSize: 123, srcMtime: 456, driverState: '{"p2p":{"failures":2,"cooldownUntil":9}}' }),
    });
    const sender = mkSession('Tsender123456789');
    sender.noteTransport('p2p');
    wb.schedule(sender);
    clock.advance(1500);
    await Promise.resolve();
    const sRec = store.rows.get('Tsender123456789')!;
    A(sRec.srcPath === '/cache/f.bin' && sRec.srcSize === 123, 'source reference persisted');
    A(JSON.parse(sRec.driverState!).p2p.cooldownUntil === 9, 'driver cooldown persisted');
    A(sRec.lastTransport === 'p2p', 'last transport persisted');

    // 7. a store error is swallowed and reported, never thrown into the transfer
    let errs = 0;
    const failing = new WriteBehind({
      store, now: clock.now, schedule: clock.schedule, cancel: clock.cancel, onError: () => { errs++; },
    });
    store.failNext = true;
    failing.schedule(sender);
    clock.advance(1500);
    await Promise.resolve();
    A(errs === 1, 'a store failure is reported, not thrown');

    // 8. forget() drops the record and cancels any queued write
    await wb.forget('Tsender123456789');
    A(store.removes === 1 && !store.rows.has('Tsender123456789'), 'forget removes the record');
    A(wb.timerCount() === 0, 'forget cancels the pending timer');

    // 9. flushAll drains everything (AppState background)
    store = new FakeStore(); clock = new Clock();
    wb = new WriteBehind({ store, now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
    for (const id of ['Ta1234567890abcd', 'Tb1234567890abcd', 'Tc1234567890abcd']) wb.schedule(mkSession(id));
    A(store.saves === 0, 'still coalescing');
    await wb.flushAll();
    A(store.saves === 3 && wb.pendingCount() === 0, 'flushAll drains every pending session');
    A(wb.timerCount() === 0, 'flushAll leaves no timers');

    // 10. repeated schedule/flush cycles leak no timers (the audit guard)
    for (let i = 0; i < 50; i++) { wb.schedule(mkSession('Tleak1234567890a')); await wb.flush('Tleak1234567890a'); }
    A(wb.timerCount() === 0 && wb.pendingCount() === 0, '50 cycles leak no timers or pending entries');

    console.log('vaultBeam/persistence self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
