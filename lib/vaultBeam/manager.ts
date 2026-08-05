// lib/vaultBeam/manager.ts — the one component that owns scheduling.
//
// Session state, the admission queue, retry/cooldown, resume, progress
// notification and transport switching all live here (design §3). Transports
// REGISTER with the manager; none keeps an independent queue, scheduler or
// progress store. Adding a transport — a CDN, Bluetooth, Nearby Share — is
// `manager.registerDriver(...)` and nothing else.
//
// The loop is deliberately boring: re-derive the work-list from the bitmaps,
// hand it to the cheapest available driver, record what comes back. A driver
// failure demotes that driver and continues (R4); it never resets state (R3).
//
// Pure: no react-native / expo imports. Clock and sleep are injectable, so the
// self-check runs deterministically under `npx tsx`.

import { type ChunkRun } from './bitmap';
import { TransferSession } from './session';
import { type TransportDriver, type TransportId, type DriverOutcome } from './drivers/types';
import { type PersistedSession, type SessionStore } from './persistence';

export { type TransportDriver, type TransportId, type DriverOutcome };

export interface ManagerOptions {
  /** Sessions running at once. Auto-download used to cap this at 1 on its own. */
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between rounds when there is nothing to do but the transfer isn't done. */
  idlePollMs?: number;
  /** Consecutive idle rounds before the session parks and waits for a poke. */
  maxIdleRounds?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** Called whenever a session's revision changes — progress + persistence seam. */
  onChange?: (session: TransferSession) => void;
}

interface DriverHealth { failures: number; cooldownUntil: number }

export interface RunResult { state: 'complete' | 'failed' | 'cancelled' | 'parked'; reason?: string }

export class TransferManager {
  private readonly drivers: TransportDriver[] = [];
  private readonly sessions = new Map<string, TransferSession>();
  private readonly running = new Map<string, Promise<RunResult>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly health = new Map<string, Map<TransportId, DriverHealth>>();
  private readonly waiting: string[] = [];
  private readonly opts: Required<Omit<ManagerOptions, 'onChange'>> & { onChange?: (s: TransferSession) => void };

  constructor(options: ManagerOptions = {}) {
    this.opts = {
      concurrency: options.concurrency ?? 1,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      idlePollMs: options.idlePollMs ?? 1500,
      maxIdleRounds: options.maxIdleRounds ?? 20,
      baseCooldownMs: options.baseCooldownMs ?? 3000,
      maxCooldownMs: options.maxCooldownMs ?? 120000,
      onChange: options.onChange,
    };
  }

  /** Set the progress/persistence sink after construction (the engine wires its
   *  write-behind here, so state and disk cannot drift apart). */
  setOnChange(cb: (session: TransferSession) => void): void { this.opts.onChange = cb; }

  registerDriver(d: TransportDriver): void {
    if (this.drivers.some((x) => x.id === d.id)) throw new Error(`driver ${d.id} already registered`);
    this.drivers.push(d);
    this.drivers.sort((a, b) => a.cost - b.cost);
  }

  driverIds(): TransportId[] { return this.drivers.map((d) => d.id); }

  /** Single-flight: one session object per transferId, process-wide. */
  adopt(session: TransferSession): TransferSession {
    const existing = this.sessions.get(session.transferId);
    if (existing) return existing;
    this.sessions.set(session.transferId, session);
    this.health.set(session.transferId, new Map());
    return session;
  }

  get(transferId: string): TransferSession | undefined { return this.sessions.get(transferId); }
  activeCount(): number { return this.running.size; }
  queuedCount(): number { return this.waiting.length; }

  /**
   * Admit a session and run it. Calling twice for the same transferId returns
   * the SAME in-flight promise — the single-flight guard that replaces the old
   * ad-hoc `controllers.has()` check and the separate auto-download queue.
   */
  start(session: TransferSession): Promise<RunResult> {
    const s = this.adopt(session);
    const existing = this.running.get(s.transferId);
    if (existing) return existing;
    const p = this.admitAndRun(s).finally(() => {
      this.running.delete(s.transferId);
      this.aborts.delete(s.transferId);
      this.pump();
    });
    this.running.set(s.transferId, p);
    return p;
  }

  private async admitAndRun(s: TransferSession): Promise<RunResult> {
    while (this.running.size > this.opts.concurrency) {
      if (!this.waiting.includes(s.transferId)) this.waiting.push(s.transferId);
      await this.opts.sleep(this.opts.idlePollMs);
    }
    const i = this.waiting.indexOf(s.transferId);
    if (i >= 0) this.waiting.splice(i, 1);
    return this.runSession(s);
  }

  private pump(): void { /* waiters re-check on their own tick */ }

  cancel(transferId: string): void {
    this.aborts.get(transferId)?.abort();
    const s = this.sessions.get(transferId);
    if (s && s.state === 'active') { s.finish('cancelled'); this.opts.onChange?.(s); }
  }

  /**
   * Rebuild every non-terminal session from durable state on launch (design §6).
   * There is no separate "resume mode": a restored session goes through exactly
   * the same loop as a fresh one, because the work-list is always re-derived
   * from the bitmaps.
   *
   * Returns the adopted sessions; the caller decides which to start (auto-start
   * a sender, wait for user intent on a recipient, …).
   */
  async recoverAll(opts: {
    store: SessionStore;
    /** Per-transfer secrets, which live in the E2EE manifest message, never in
     *  the durable row. Returning null drops the record — without the key there
     *  is nothing the session could do. */
    secretsFor: (rec: PersistedSession) => Promise<{ fileId: string; keyB64: string } | null>;
    /** Sender-side source validation (exists + size/mtime match). A mismatch
     *  means the cached file was evicted or replaced, so uploading it would
     *  produce bytes that do not match the manifest. */
    validateSource?: (rec: PersistedSession) => Promise<boolean>;
    onDropped?: (rec: PersistedSession, reason: string) => void;
  }): Promise<TransferSession[]> {
    let rows: PersistedSession[] = [];
    try { rows = await opts.store.loadAll(); } catch { return []; }
    const out: TransferSession[] = [];

    for (const rec of rows) {
      if (rec.state !== 'active') { continue; }              // terminal rows are history, not work
      if (this.sessions.has(rec.transferId)) {               // a live session always wins
        out.push(this.sessions.get(rec.transferId)!);
        continue;
      }
      const secrets = await opts.secretsFor(rec).catch(() => null);
      if (!secrets) {
        opts.onDropped?.(rec, 'no key material');
        await opts.store.remove(rec.transferId).catch(() => {});
        continue;
      }
      if (rec.role === 'sender' && opts.validateSource) {
        const ok = await opts.validateSource(rec).catch(() => false);
        if (!ok) {
          opts.onDropped?.(rec, 'source file missing or changed');
          await opts.store.remove(rec.transferId).catch(() => {});
          continue;
        }
      }
      let session: TransferSession;
      try { session = TransferSession.restore(rec, secrets); }
      catch (e: any) {
        opts.onDropped?.(rec, e?.message ?? 'unrestorable record');
        await opts.store.remove(rec.transferId).catch(() => {});
        continue;
      }
      this.adopt(session);
      // Restore backoff so a resume does not immediately re-probe a transport
      // that just failed, and does not lose an exponential cooldown.
      if (rec.driverState) {
        try { this.restoreDriverState(rec.transferId, JSON.parse(rec.driverState)); } catch { /* ignore bad JSON */ }
      }
      out.push(session);
    }
    return out;
  }

  /** Resume a parked session (peer came online, a poll saw new staged blocks…). */
  poke(transferId: string): Promise<RunResult> | undefined {
    const s = this.sessions.get(transferId);
    if (!s || s.state !== 'active') return undefined;
    return this.start(s);
  }

  private healthFor(transferId: string, id: TransportId): DriverHealth {
    let m = this.health.get(transferId);
    if (!m) { m = new Map(); this.health.set(transferId, m); }
    let h = m.get(id);
    if (!h) { h = { failures: 0, cooldownUntil: 0 }; m.set(id, h); }
    return h;
  }

  /** Serializable per-driver cooldown state — persisted so backoff survives a restart. */
  driverState(transferId: string): Record<string, DriverHealth> {
    const out: Record<string, DriverHealth> = {};
    for (const [id, h] of this.health.get(transferId) ?? []) out[id] = { ...h };
    return out;
  }

  restoreDriverState(transferId: string, state: Record<string, DriverHealth> | undefined): void {
    if (!state) return;
    const m = new Map<TransportId, DriverHealth>();
    for (const [id, h] of Object.entries(state)) m.set(id, { failures: h.failures | 0, cooldownUntil: h.cooldownUntil | 0 });
    this.health.set(transferId, m);
  }

  private async selectDriver(s: TransferSession): Promise<TransportDriver | null> {
    const now = this.opts.now();
    for (const d of this.drivers) {                       // pre-sorted by cost
      const h = this.healthFor(s.transferId, d.id);
      if (h.cooldownUntil > now) continue;                // demoted, still cooling
      let ok = false;
      try { ok = await d.available(s); } catch { ok = false; }
      if (ok) return d;
    }
    return null;
  }

  private demote(s: TransferSession, d: TransportDriver, retryAfterMs?: number): void {
    const h = this.healthFor(s.transferId, d.id);
    h.failures++;
    const backoff = retryAfterMs ?? Math.min(this.opts.baseCooldownMs * 2 ** (h.failures - 1), this.opts.maxCooldownMs);
    h.cooldownUntil = this.opts.now() + backoff;
  }

  private promote(s: TransferSession, d: TransportDriver): void {
    const h = this.healthFor(s.transferId, d.id);
    h.failures = 0;
    h.cooldownUntil = 0;
  }

  /**
   * Role- and channel-appropriate work. The session derives it; the manager only
   * slices it to the driver's physical unit. Keying off the declared CHANNEL
   * rather than the driver id is what lets a future CDN driver ('relay') or a
   * Bluetooth driver ('direct') drop in with no change here.
   */
  private workFor(s: TransferSession, d: TransportDriver): ChunkRun[] {
    const raw = d.unitChunks(s);
    const unit = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : Infinity;
    if (d.channel === 'direct') return s.directWork(unit);
    return s.role === 'sender' ? s.uploadWork(unit) : s.relayFetch(unit);
  }

  private async runSession(s: TransferSession): Promise<RunResult> {
    const ac = new AbortController();
    this.aborts.set(s.transferId, ac);
    let idleRounds = 0;
    let lastRevision = -1;

    while (s.state === 'active' && !ac.signal.aborted) {
      // R5: terminal only when the work is genuinely done.
      if (s.isComplete()) { s.finish('complete'); this.opts.onChange?.(s); return { state: 'complete' }; }

      const driver = await this.selectDriver(s);
      if (!driver) {
        if (++idleRounds > this.opts.maxIdleRounds) return { state: 'parked', reason: 'no transport available' };
        await this.opts.sleep(this.opts.idlePollMs);
        continue;
      }

      const work = this.workFor(s, driver);
      if (work.length === 0) {
        // Nothing this transport can move right now (e.g. a receiver waiting for
        // the sender to stage more). Not an error, not terminal — park and retry.
        if (++idleRounds > this.opts.maxIdleRounds) return { state: 'parked', reason: 'no work available' };
        await this.opts.sleep(this.opts.idlePollMs);
        continue;
      }

      s.noteTransport(driver.id);
      s.claim(work);
      let outcome: DriverOutcome;
      try {
        // Two channels, because they are two different facts (RC-4): `verified`
        // means the PEER holds it and is the only thing that moves progress;
        // `staged` means the RELAY holds it and moves nothing user-visible.
        outcome = await driver.run(s, work, {
          verified: (c) => {
            s.markVerified(c);
            if (s.revision !== lastRevision) { lastRevision = s.revision; this.opts.onChange?.(s); }
          },
          staged: (c) => { s.markStaged(c); },
        }, ac.signal);
      } catch (e: any) {
        outcome = { kind: 'failed', reason: e?.message ?? 'driver threw' };
      } finally {
        s.release(work);                 // R3: nothing verified is lost by releasing
        try { driver.dispose(); } catch { /* dispose must never break the loop */ }
      }

      if (outcome.kind === 'failed') {
        this.demote(s, driver, outcome.retryAfterMs);
        // R4: demote the driver, keep the session — the next round re-derives the
        // work-list from the bitmaps and tries the next transport.
      } else {
        this.promote(s, driver);
      }

      // Progress in this round resets the idle counter.
      if (s.revision !== lastRevision) { lastRevision = s.revision; idleRounds = 0; this.opts.onChange?.(s); }
      else idleRounds++;
      if (idleRounds > this.opts.maxIdleRounds) return { state: 'parked', reason: 'no forward progress' };
    }

    if (ac.signal.aborted && s.state === 'active') { s.finish('cancelled'); this.opts.onChange?.(s); }
    return { state: s.state === 'active' ? 'parked' : (s.state as RunResult['state']) };
  }
}

// ── self-check: `npx tsx lib/vaultBeam/manager.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('manager: ' + m); };
  const CHUNK = 512 * 1024;

  // Deterministic clock + instant sleep.
  let clock = 0;
  const mkMgr = (o: Partial<ManagerOptions> = {}) => new TransferManager({
    now: () => clock, sleep: async (ms) => { clock += ms; }, idlePollMs: 100, maxIdleRounds: 3,
    baseCooldownMs: 1000, ...o,
  });
  const mkSession = (chunks: number, role: 'sender' | 'recipient' = 'sender') => new TransferSession({
    transferId: 'T' + Math.random().toString(36).slice(2, 8), sessionVersion: 1,
    fileId: 'F', keyB64: 'k', role, totalBytes: chunks * CHUNK,
  });

  /** A driver that verifies up to `verifyLimit` of the chunks it is asked for,
   *  then drains or fails. Records everything it was asked to move. */
  class FakeDriver implements TransportDriver {
    asked: number[] = [];
    disposals = 0;
    runs = 0;
    readonly channel: 'direct' | 'relay';
    constructor(
      readonly id: string,
      readonly cost: number,
      private cfg: { verifyLimit?: number; fail?: boolean; unit?: number; unavailable?: boolean; channel?: 'direct' | 'relay' } = {},
    ) { this.channel = cfg.channel ?? 'direct'; }
    unitChunks() { return this.cfg.unit ?? Infinity; }
    async available() { return !this.cfg.unavailable; }
    async run(_s: TransferSession, work: ChunkRun[], report: { verified: (c: number) => void }): Promise<DriverOutcome> {
      this.runs++;
      let budget = this.cfg.verifyLimit ?? Infinity;
      for (const r of work) {
        for (let i = r.start; i < r.start + r.count; i++) {
          this.asked.push(i);
          if (budget-- <= 0) break;
          report.verified(i);
        }
      }
      return this.cfg.fail ? { kind: 'failed', reason: 'synthetic' } : { kind: 'drained' };
    }
    dispose() { this.disposals++; }
  }

  const run = async () => {
    // 1. one driver drains everything → complete
    let mgr = mkMgr();
    let d = new FakeDriver('relay', 30);
    mgr.registerDriver(d);
    let s = mkSession(10);
    let res = await mgr.start(s);
    A(res.state === 'complete', 'single driver completes the transfer');
    A(s.progressBytes() === s.totalBytes, 'progress reaches the total');
    A(d.disposals === d.runs, 'dispose called once per run');
    A(new Set(d.asked).size === d.asked.length, 'no chunk asked for twice');

    // 2. driver fails midway → session stays active, bitmaps kept, next driver
    //    picks up EXACTLY the remainder (R3 + R4)
    mgr = mkMgr();
    const p2p = new FakeDriver('p2p', 20, { verifyLimit: 6, fail: true });
    const relay = new FakeDriver('relay', 30);
    mgr.registerDriver(relay); mgr.registerDriver(p2p);
    A(JSON.stringify(mgr.driverIds()) === JSON.stringify(['p2p', 'relay']), 'drivers ordered by cost');
    s = mkSession(10);
    res = await mgr.start(s);
    A(res.state === 'complete', 'falls back and completes');
    A(p2p.asked.length >= 6, 'p2p moved what it could');
    A(relay.asked.every((c) => c >= 6), 'relay transferred ONLY the chunks p2p had not verified');
    A(new Set(relay.asked).size === 4, 'exactly the 4 missing chunks were re-transferred');
    A(s.progressBytes() === s.totalBytes, 'nothing was lost across the switch');

    // 3. THE headline case: everything verified, then the driver fails (lost
    //    final ack). The fallback must transfer ZERO bytes.
    mgr = mkMgr();
    const allThenFail = new FakeDriver('p2p', 20, { fail: true });   // verifies all, then fails
    const relay2 = new FakeDriver('relay', 30);
    mgr.registerDriver(relay2); mgr.registerDriver(allThenFail);
    s = mkSession(10);
    res = await mgr.start(s);
    A(res.state === 'complete', 'completes despite the failure');
    A(relay2.asked.length === 0, 'lost final ack costs ZERO re-transfer');
    A(relay2.runs === 0, 'the relay driver never even ran');

    // 4. cooldown: a failed driver is skipped until its cooldown expires
    mgr = mkMgr();
    const flaky = new FakeDriver('p2p', 20, { verifyLimit: 2, fail: true });
    const backup = new FakeDriver('relay', 30, { verifyLimit: 2 });
    mgr.registerDriver(backup); mgr.registerDriver(flaky);
    s = mkSession(10);
    await mgr.start(s);
    const st = mgr.driverState(s.transferId);
    A(st['p2p'] !== undefined && st['p2p'].failures > 0, 'failed driver recorded failures');
    A(st['relay'].failures === 0, 'successful driver has no failures');
    A(st['p2p'].cooldownUntil > 0, 'failed driver has a cooldown deadline');

    // cooldown state survives a restart (design §6)
    const mgr2 = mkMgr();
    mgr2.registerDriver(new FakeDriver('p2p', 20));
    mgr2.restoreDriverState(s.transferId, st);
    A(mgr2.driverState(s.transferId)['p2p'].cooldownUntil === st['p2p'].cooldownUntil,
      'driver cooldown restores across a restart');

    // 5. single-flight: two starts share one run, one session
    mgr = mkMgr();
    mgr.registerDriver(new FakeDriver('relay', 30));
    s = mkSession(4);
    const a = mgr.start(s);
    const b = mgr.start(s);
    A(a === b, 'concurrent starts share the same in-flight promise');
    await a;
    const dup = new TransferSession({
      transferId: s.transferId, sessionVersion: 1, fileId: 'F', keyB64: 'k',
      role: 'sender', totalBytes: 4 * CHUNK,
    });
    A(mgr.adopt(dup) === s, 'adopting a duplicate transferId returns the original session');

    // 6. physical unit slices work without changing what moves
    mgr = mkMgr();
    const unit2 = new FakeDriver('relay', 30, { unit: 2 });
    mgr.registerDriver(unit2);
    s = mkSession(7);
    await mgr.start(s);
    A(s.isComplete(), 'unit-sliced transfer completes');
    A(new Set(unit2.asked).size === 7, 'every chunk moved exactly once regardless of unit size');

    // 7. no driver available → parks rather than failing (R5)
    mgr = mkMgr();
    mgr.registerDriver(new FakeDriver('relay', 30, { unavailable: true }));
    s = mkSession(3);
    res = await mgr.start(s);
    A(res.state === 'parked', 'no transport ⇒ parked, not failed');
    A(s.state === 'active', 'a parked session is still active');
    A(s.peerHave.popcount() === 0 && s.progressBytes() === 0, 'parking does not touch state');

    // 8. a receiver with nothing staged parks, then a poke resumes it
    mgr = mkMgr();
    const relayRecv = new FakeDriver('relay', 30, { channel: 'relay' });
    mgr.registerDriver(relayRecv);
    s = mkSession(5, 'recipient');           // r2Have empty ⇒ relayFetch is empty
    res = await mgr.start(s);
    A(res.state === 'parked', 'receiver with nothing staged parks');
    A(relayRecv.asked.length === 0, 'nothing fetched while nothing is staged');
    const staged = s.r2Have.clone();
    for (let i = 0; i < 5; i++) staged.set(i);
    s.setR2Have(staged);                      // sender staged everything
    res = await (mgr.poke(s.transferId) as Promise<RunResult>);
    A(res.state === 'complete', 'poke resumes a parked session to completion');
    A(new Set(relayRecv.asked).size === 5, 'the receiver fetched exactly the staged chunks');

    // 9. cancel is terminal and releases in-flight
    mgr = mkMgr();
    mgr.registerDriver(new FakeDriver('relay', 30, { unavailable: true }));
    s = mkSession(3);
    const pending = mgr.start(s);
    mgr.cancel(s.transferId);
    await pending;
    A(s.state === 'cancelled', 'cancel is terminal');
    A(s.inflightCount === 0, 'cancel releases in-flight chunks');

    // 10. a relay-channel SENDER stages everything and then PARKS — staging is
    //     not delivery, so the session must not claim completion (RC-4).
    mgr = mkMgr();
    class StagingDriver extends FakeDriver {
      async run(_s: TransferSession, work: ChunkRun[], report: any): Promise<DriverOutcome> {
        this.runs++;
        for (const r of work) for (let i = r.start; i < r.start + r.count; i++) { this.asked.push(i); report.staged(i); }
        return { kind: 'drained' };
      }
    }
    const stager = new StagingDriver('relay', 30, { channel: 'relay' });
    mgr.registerDriver(stager);
    s = mkSession(6);
    res = await mgr.start(s);
    A(res.state === 'parked', 'a sender that only staged parks, it does not complete');
    A(s.r2Have.popcount() === 6, 'everything staged');
    A(s.peerHave.popcount() === 0 && s.progressBytes() === 0, 'staging moved no progress');
    A(s.uploadWork().length === 0, 'nothing left to stage');
    // …and once the peer confirms (stage 4 delivers this via recv_mask), it completes
    for (let i = 0; i < 6; i++) s.markVerified(i);
    res = await (mgr.poke(s.transferId) as Promise<RunResult>);
    A(res.state === 'complete', 'peer confirmation completes the session');
    A(stager.asked.length === 6, 'the sender never re-staged anything');

    // 11. recoverAll: restore from durable state and continue, with no separate
    //     "resume mode" — the same loop, because work is always re-derived.
    {
      const rows: PersistedSession[] = [];
      const store: SessionStore = {
        async save(r) { const i = rows.findIndex((x) => x.transferId === r.transferId); if (i >= 0) rows[i] = r; else rows.push(r); },
        async loadAll() { return [...rows]; },
        async remove(id) { const i = rows.findIndex((x) => x.transferId === id); if (i >= 0) rows.splice(i, 1); },
      };
      // a half-done recipient, a terminal row, a keyless row, and a sender whose
      // source vanished
      const half = mkSession(10, 'recipient');
      for (let i = 0; i < 4; i++) half.markVerified(i);
      await store.save({ ...half.snapshot(), driverState: '{"p2p":{"failures":2,"cooldownUntil":99}}' });
      const finished = mkSession(4, 'recipient');
      for (let i = 0; i < 4; i++) finished.markVerified(i);
      finished.finish('complete');
      await store.save(finished.snapshot());
      const keyless = mkSession(4, 'recipient');
      await store.save(keyless.snapshot());
      const evicted = mkSession(4, 'sender');
      await store.save({ ...evicted.snapshot(), srcPath: '/gone.bin' });

      const dropped: string[] = [];
      mgr = mkMgr();
      mgr.registerDriver(new FakeDriver('relay', 30));
      const recovered = await mgr.recoverAll({
        store,
        secretsFor: async (r) => (r.transferId === keyless.transferId ? null : { fileId: 'F', keyB64: 'k' }),
        validateSource: async (r) => r.srcPath !== '/gone.bin',
        onDropped: (r, why) => dropped.push(`${r.transferId}:${why}`),
      });
      const ids = recovered.map((r) => r.transferId);
      A(ids.includes(half.transferId), 'an in-progress session is recovered');
      A(!ids.includes(finished.transferId), 'a terminal session is NOT resurrected');
      A(!ids.includes(keyless.transferId), 'a session with no key material is dropped');
      A(!ids.includes(evicted.transferId), 'a sender whose source vanished is dropped');
      A(dropped.length === 2, `two records dropped with a reason (got ${dropped.length})`);
      A(rows.length === 2, 'dropped records are removed from the store');

      const back = recovered.find((r) => r.transferId === half.transferId)!;
      A(back.peerHave.popcount() === 4, 'the bitmap survived');
      A(back.pendingRuns()[0].start === 4, 'resume continues from the first missing chunk');
      A(mgr.driverState(half.transferId)['p2p'].cooldownUntil === 99, 'driver backoff survived the restart');

      // …and it runs to completion WITHOUT re-transferring the first 4
      const rd = new FakeDriver('relay', 30);
      const mgr3 = mkMgr();
      mgr3.registerDriver(rd);
      mgr3.adopt(back);
      res = await mgr3.start(back);
      A(res.state === 'complete', 'a recovered session completes');
      A(rd.asked.every((c) => c >= 4), 'recovery re-transferred NOTHING that was already verified');
      A(new Set(rd.asked).size === 6, 'exactly the 6 missing chunks moved');
    }

    // 12. a live session always wins over its durable snapshot
    {
      const live = mkSession(8, 'recipient');
      live.markVerified(0); live.markVerified(1); live.markVerified(2);
      const stale = { ...live.snapshot(), peerHave: '' };   // an older, emptier row
      const store: SessionStore = {
        async save() {}, async remove() {},
        async loadAll() { return [stale as PersistedSession]; },
      };
      mgr = mkMgr();
      mgr.adopt(live);
      const rec = await mgr.recoverAll({ store, secretsFor: async () => ({ fileId: 'F', keyB64: 'k' }) });
      A(rec[0] === live, 'the live session object is returned, not a rebuilt one');
      A(live.peerHave.popcount() === 3, 'a stale snapshot cannot roll back live progress');
    }

    // 13. onChange fires on real progress and is the persistence seam
    let changes = 0;
    mgr = mkMgr({ onChange: () => { changes++; } });
    mgr.registerDriver(new FakeDriver('relay', 30));
    s = mkSession(5);
    await mgr.start(s);
    A(changes > 0, 'onChange fired during the transfer');

    console.log('vaultBeam/manager self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
