// lib/vaultBeamJob.ts — the Android 14+ user-initiated data transfer job.
//
// WHAT THIS FIXES
// ---------------
// Transfers ride the shared Notifee foreground service, whose type is
// `dataSync`. From Android 15 (targetSdk 35) `dataSync` is capped at six hours
// per 24-hour period ACROSS THE WHOLE APP: past that the system calls
// Service.onTimeout() and the service must stop. That budget is shared with the
// no-GMS socket connection, so a long transfer does not even get six hours — and
// a 12 GB file on a slow link can want more than what is left.
//
// A user-initiated data transfer job is the mechanism Android provides for this
// exact case. It is outside the dataSync cap, it shows a system notification the
// user can cancel, and it may only be scheduled while the app is visible —
// which is precisely when someone starts a file transfer.
//
// DEGRADES, NEVER FAILS
// ---------------------
// Below API 34, on a device with no JobScheduler, or when the app is not visible
// enough to qualify, `start()` returns false and the caller keeps the existing
// foreground service. Nothing here can make a transfer worse than it is today;
// the worst case is that it is exactly as good.
//
// Pure enough to self-check: the native module is injected, so
// `npx tsx lib/vaultBeamJob.ts` exercises the whole policy.

export interface JobNative {
  isSupported(): Promise<boolean>;
  start(estimatedBytes: number, upload: boolean, title: string, text: string, progressPct: number): Promise<boolean>;
  /** Refresh the running job's notification. Required: a user-initiated data
   *  transfer job that does not call setNotification is stopped by the system,
   *  so while the job carries the transfer it OWNS the progress notification. */
  updateNotification(title: string, text: string, progressPct: number): Promise<boolean>;
  stop(): Promise<boolean>;
  status(): Promise<{ supported: boolean; scheduled: boolean; running: boolean; lastStopReason: number }>;
}

export interface JobHostDeps {
  native: JobNative | null;
  isAndroid: boolean;
  warn?: (msg: string) => void;
}

/** What the active transfer set looks like to the scheduler. */
export interface TransferLoad {
  count: number;
  /** Bytes still to move. Zero/unknown is passed through honestly, not faked. */
  remainingBytes: number;
  /** True when sending dominates — it changes which direction is estimated. */
  upload: boolean;
  /** Notification title/body. The job owns the notification while it runs. */
  title?: string;
  text?: string;
  /** 0..100, or negative for "not known yet" (an indeterminate bar). */
  progressPct?: number;
}

/**
 * Owns the job's lifetime against the active transfer set.
 *
 * Deliberately NOT a queue or a scheduler of its own: it holds one boolean's
 * worth of state (is a job wanted?) and reflects it into the platform. The
 * Transfer Manager remains the only thing that decides what runs.
 */
export class TransferJobHost {
  private wanted = false;
  private active = false;
  /** Set once the platform has told us it cannot help, so we stop asking. */
  private unavailable = false;
  private lastBytes = -1;

  constructor(private readonly deps: JobHostDeps) {}

  /** True when the platform job is holding the process (not the FGS). */
  get holding(): boolean { return this.active; }
  /** True when the caller must fall back to the dataSync foreground service. */
  get needsForegroundService(): boolean { return this.wanted && !this.active; }

  /**
   * Reflect the current load. Idempotent and cheap to call on every progress
   * tick: a re-schedule only happens when the estimate has moved materially,
   * because the native id is constant and re-scheduling replaces the job.
   */
  async sync(load: TransferLoad | null): Promise<void> {
    const want = !!load && load.count > 0;
    if (!want) { await this.release(); return; }
    this.wanted = true;

    const n = this.deps.native;
    if (!this.deps.isAndroid || !n || this.unavailable) return;

    const bytes = Math.max(0, Math.floor(load!.remainingBytes));
    const title = load!.title ?? 'Transferring file';
    const text = load!.text ?? '';
    const pct = typeof load!.progressPct === 'number' ? load!.progressPct : -1;

    // Only RE-SCHEDULE when the estimate has moved materially — that number is
    // a hint to the scheduler and churning it buys nothing. The NOTIFICATION is
    // a different matter: it is what the user is looking at, so it updates on
    // every tick, and it is a required part of a user-initiated job rather than
    // a decoration.
    if (this.active && this.lastBytes >= 0 && Math.abs(bytes - this.lastBytes) < 16 * 1024 * 1024) {
      try { await n.updateNotification(title, text, pct); } catch { /* job gone */ }
      return;
    }

    try {
      const ok = await n.start(bytes, !!load!.upload, title, text, pct);
      if (ok) { this.active = true; this.lastBytes = bytes; return; }
      // A refusal while the app is not visible is expected and temporary, so it
      // must NOT latch `unavailable` — the next transfer starts from a visible
      // app and will succeed. Only an unsupported platform latches.
      if (!(await n.isSupported().catch(() => false))) {
        this.unavailable = true;
        this.deps.warn?.('user-initiated transfer jobs unavailable — using the dataSync foreground service');
      }
      this.active = false;
    } catch {
      this.active = false;
    }
  }

  /** The last transfer finished (or was cancelled): give the job back. */
  async release(): Promise<void> {
    this.wanted = false;
    this.lastBytes = -1;
    if (!this.active) return;
    this.active = false;
    try { await this.deps.native?.stop(); } catch { /* already gone */ }
  }

  /** Diagnostics only — surfaces why the system stopped a job, if it did. */
  async status(): Promise<{ supported: boolean; scheduled: boolean; running: boolean; lastStopReason: number } | null> {
    try { return (await this.deps.native?.status()) ?? null; } catch { return null; }
  }
}

// ── production binding ───────────────────────────────────────────────

let _host: TransferJobHost | null = null;

export function transferJobHost(): TransferJobHost {
  if (_host) return _host;
  let native: JobNative | null = null;
  let isAndroid = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules, Platform } = require('react-native');
    isAndroid = Platform.OS === 'android';
    const m = NativeModules?.VaultBeamJob;
    if (m && typeof m.start === 'function') native = m as JobNative;
  } catch { /* not react-native (tests) */ }
  _host = new TransferJobHost({
    native, isAndroid,
    warn: (msg) => console.warn(`[vaultbeam] ${msg}`),
  });
  return _host;
}

// ── self-check: `npx tsx lib/vaultBeamJob.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('vaultBeamJob: ' + m); };

  const mkNative = (cfg: { supported?: boolean; startOk?: boolean | (() => boolean) } = {}) => {
    const calls = {
      start: 0, stop: 0, notify: 0,
      bytes: [] as number[], upload: [] as boolean[], pct: [] as number[],
    };
    const native: JobNative = {
      async isSupported() { return cfg.supported ?? true; },
      async start(bytes, upload, _t, _x, pct) {
        calls.start++; calls.bytes.push(bytes); calls.upload.push(upload); calls.pct.push(pct);
        return typeof cfg.startOk === 'function' ? cfg.startOk() : (cfg.startOk ?? true);
      },
      async updateNotification(_t, _x, pct) { calls.notify++; calls.pct.push(pct); return true; },
      async stop() { calls.stop++; return true; },
      async status() { return { supported: cfg.supported ?? true, scheduled: true, running: true, lastStopReason: -1 }; },
    };
    return { native, calls };
  };
  const MiB = 1024 * 1024;

  const run = async () => {
    // 1. an active transfer schedules the job; finishing releases it
    {
      const { native, calls } = mkNative();
      const h = new TransferJobHost({ native, isAndroid: true });
      await h.sync({ count: 1, remainingBytes: 500 * MiB, upload: true });
      A(calls.start === 1, 'an active transfer schedules the job');
      A(calls.bytes[0] === 500 * MiB, 'the byte estimate is passed through');
      A(calls.upload[0] === true, 'direction is passed through');
      A(h.holding === true, 'the job is holding the process');
      A(h.needsForegroundService === false, 'so no foreground service is needed');

      await h.sync(null);
      A(calls.stop === 1, 'the last transfer finishing releases the job');
      A(h.holding === false, 'and it is no longer holding');
    }

    // 2. re-scheduling is throttled: the estimate is a hint, not a stream
    {
      const { native, calls } = mkNative();
      const h = new TransferJobHost({ native, isAndroid: true });
      await h.sync({ count: 1, remainingBytes: 500 * MiB, upload: true, progressPct: 0 });
      for (let i = 0; i < 50; i++) {
        await h.sync({ count: 1, remainingBytes: 500 * MiB - i * MiB, upload: true, progressPct: i });
      }
      A(calls.start <= 4, `small estimate changes do not churn the scheduler (${calls.start} schedules)`);
      // …but the NOTIFICATION must track every tick: it is what the user reads,
      // and a user-initiated job that stops calling setNotification is stopped
      // by the system.
      A(calls.notify >= 45, `the notification still updates on every tick (${calls.notify})`);
      await h.sync({ count: 1, remainingBytes: 100 * MiB, upload: true, progressPct: 80 });
      A(calls.start >= 2, 'a material change DOES reschedule');
      await h.release();
    }

    // 2b. an unknown percentage is passed through as negative, not faked to 0 —
    //     a confident 0% that never moves reads as a stuck transfer.
    {
      const { native, calls } = mkNative();
      const h = new TransferJobHost({ native, isAndroid: true });
      await h.sync({ count: 1, remainingBytes: 0, upload: true });
      A(calls.pct[0] === -1, 'an absent percentage becomes indeterminate, not zero');
      await h.release();
    }

    // 3. NOT Android ⇒ never touches the native module, and the caller is told
    //    it still needs the foreground service
    {
      const { native, calls } = mkNative();
      const h = new TransferJobHost({ native, isAndroid: false });
      await h.sync({ count: 1, remainingBytes: MiB, upload: false });
      A(calls.start === 0, 'iOS never schedules an Android job');
      A(h.needsForegroundService === true, 'and the caller keeps its existing mechanism');
    }

    // 4. an UNSUPPORTED platform latches: we stop asking, and the caller falls
    //    back for good
    {
      const { native, calls } = mkNative({ supported: false, startOk: false });
      const warnings: string[] = [];
      const h = new TransferJobHost({ native, isAndroid: true, warn: (m) => warnings.push(m) });
      await h.sync({ count: 1, remainingBytes: MiB, upload: true });
      A(calls.start === 1, 'it tries once');
      A(h.needsForegroundService === true, 'and reports that the FGS is still required');
      A(warnings.length === 1, 'the downgrade is recorded, not silent');
      await h.sync({ count: 1, remainingBytes: 2 * MiB, upload: true });
      A(calls.start === 1, 'an unsupported platform is not asked again');
    }

    // 5. THE case that must NOT latch: a refusal because the app was not
    //    visible enough. The next transfer starts from a visible app, so
    //    latching here would give up the job permanently after one background
    //    hiccup.
    {
      let allow = false;
      const { native, calls } = mkNative({ supported: true, startOk: () => allow });
      const h = new TransferJobHost({ native, isAndroid: true });
      await h.sync({ count: 1, remainingBytes: MiB, upload: true });
      A(h.holding === false, 'a refused schedule is not holding');
      A(h.needsForegroundService === true, 'so the FGS covers it');
      allow = true;
      await h.sync({ count: 1, remainingBytes: 200 * MiB, upload: true });
      A(calls.start === 2, 'a transient refusal is retried');
      A(h.holding === true, 'and the retry took');
      await h.release();
    }

    // 6. a throwing native module must never break a transfer
    {
      const bad: JobNative = {
        async isSupported() { throw new Error('boom'); },
        async start() { throw new Error('boom'); },
        async updateNotification() { throw new Error('boom'); },
        async stop() { throw new Error('boom'); },
        async status() { throw new Error('boom'); },
      };
      const h = new TransferJobHost({ native: bad, isAndroid: true });
      await h.sync({ count: 1, remainingBytes: MiB, upload: true });
      A(h.needsForegroundService === true, 'a broken module falls back to the FGS');
      await h.release();
      A(await h.status() === null, 'status is null rather than throwing');
    }

    // 7. release is idempotent and never stops a job it does not hold
    {
      const { native, calls } = mkNative();
      const h = new TransferJobHost({ native, isAndroid: true });
      await h.release();
      A(calls.stop === 0, 'releasing without holding stops nothing');
      await h.sync({ count: 2, remainingBytes: 10 * MiB, upload: false });
      await h.release();
      await h.release();
      A(calls.stop === 1, 'release is idempotent');
    }

    console.log('vaultBeamJob self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
