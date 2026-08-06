// lib/vaultBeam/audit.selftest.ts — the memory + concurrency audit, as a test.
//
// The review asked for an audit of leaks and duplicate workers. An audit done by
// reading code is true on the day it is written; these assertions stay true, and
// fail the build when they stop being.
//
// What is asserted (design §12 R6/R8, tasks §6.4/§6.5):
//   • repeated transport fallback returns resources to steady state
//   • every driver is disposed exactly once per run, on every exit path
//   • at most ONE driver runs at a time for a session (one upload worker, one
//     download worker, one transport controller)
//   • a chunk already in PeerHave is never read, encrypted or transferred again
//   • the manager's per-session maps do not grow without bound
//   • write-behind leaves no timers or pending entries behind
//
// Run: npx tsx lib/vaultBeam/audit.selftest.ts   (also picked up by npm test)

import { type ChunkRun } from './bitmap';
import { TransferSession } from './session';
import { TransferManager } from './manager';
import { type TransportDriver, type DriverOutcome, type DriverReport } from './drivers/types';
import { WriteBehind, type SessionStore, type PersistedSession } from './persistence';

const CHUNK = 512 * 1024;
let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) { console.log(`  ✓ ${label}`); } else { console.log(`  ✗ FAIL  ${label}`); failures++; }
}

/** Tracks disposal, concurrency and everything it was ever asked to move. */
class AuditDriver implements TransportDriver {
  readonly channel = 'direct' as const;
  disposals = 0;
  runs = 0;
  asked: number[] = [];
  static live = 0;
  static peakLive = 0;
  constructor(
    readonly id: string,
    readonly cost: number,
    private cfg: { verifyLimit?: number; fail?: boolean; unavailable?: boolean } = {},
  ) {}
  unitChunks() { return Infinity; }
  async available() { return !this.cfg.unavailable; }
  async run(_s: TransferSession, work: ChunkRun[], report: DriverReport): Promise<DriverOutcome> {
    this.runs++;
    AuditDriver.live++;
    AuditDriver.peakLive = Math.max(AuditDriver.peakLive, AuditDriver.live);
    try {
      let budget = this.cfg.verifyLimit ?? Infinity;
      for (const r of work) {
        for (let i = r.start; i < r.start + r.count; i++) {
          this.asked.push(i);
          if (budget-- <= 0) break;
          report.verified(i);
        }
      }
      return this.cfg.fail ? { kind: 'failed', reason: 'audit' } : { kind: 'drained' };
    } finally { AuditDriver.live--; }
  }
  dispose() { this.disposals++; }
}

const mkSession = (chunks: number, id: string, role: 'sender' | 'recipient' = 'sender') =>
  new TransferSession({
    transferId: id, sessionVersion: 1, fileId: 'F', keyB64: 'k', role, totalBytes: chunks * CHUNK,
  });

async function main() {
  const mkMgr = () => {
    let clock = 0;
    return new TransferManager({
      now: () => clock, sleep: async (ms) => { clock += ms; },
      idlePollMs: 1, maxIdleRounds: 2, baseCooldownMs: 1,
    });
  };

  console.log('Fallback cycles reach steady state:');
  {
    // 50 rounds of "direct fails, relay finishes" — the exact shape the reported
    // crashes would come from if anything accumulated per cycle.
    const CYCLES = 50;
    const disposals: number[] = [];
    const leftRunning: number[] = [];
    const undisposed: number[] = [];
    AuditDriver.peakLive = 0;
    for (let i = 0; i < CYCLES; i++) {
      const mgr = mkMgr();
      const p2p = new AuditDriver('p2p', 20, { verifyLimit: 3, fail: true });
      const relay = new AuditDriver('relay', 30);
      const id = `Taudit${String(i).padStart(10, '0')}`;
      // Scoped, like a real transfer: these drivers hold this transfer's paths
      // and channel, and the manager owns their teardown.
      mgr.setDriversFor(id, [p2p, relay]);
      const s = mkSession(10, id);
      await mgr.start(s);
      disposals.push(p2p.disposals + relay.disposals);
      if (mgr.activeCount() !== 0 || mgr.queuedCount() !== 0) leftRunning.push(i);
      // Disposed once per SESSION now, not once per run.
      if (p2p.disposals !== 1 || relay.disposals !== 1) undisposed.push(i);
      if (!s.isComplete()) undisposed.push(-i);
    }
    check(disposals.length === CYCLES, `${CYCLES} fallback cycles ran`);
    check(leftRunning.length === 0, `no cycle left a session running or queued (bad: ${leftRunning.join(',') || 'none'})`);
    check(undisposed.length === 0, `every cycle disposed every driver and completed (bad: ${undisposed.join(',') || 'none'})`);
    check(disposals.every((d) => d === 2), 'every cycle disposed both of its drivers exactly once');
    check(AuditDriver.peakLive <= 1, `at most ONE driver ran at a time across ${CYCLES} cycles (peak ${AuditDriver.peakLive})`);
  }

  console.log('Driver lifecycle — disposed when the SESSION ends, not per run:');
  {
    // REGRESSION: the manager used to dispose after every run. Real drivers set
    // disposed=true and then report available()===false forever, so any transfer
    // needing more than one round stalled at whatever the first round moved.
    // The audit fake could not catch it because its dispose() only counted, so
    // this driver models the real semantics.
    class RealisticDriver implements TransportDriver {
      readonly channel = 'relay' as const;
      private disposed = false;
      runs = 0; disposals = 0; liveListeners = 0;
      constructor(readonly id: string, readonly cost: number, private perRun: number) {}
      unitChunks() { return this.perRun; }
      async available() { return !this.disposed; }
      async run(_s: TransferSession, work: ChunkRun[], report: DriverReport): Promise<DriverOutcome> {
        this.runs++;
        this.liveListeners++;                    // a per-run subscription…
        try {
          let n = 0;
          for (const r of work) for (let i = r.start; i < r.start + r.count; i++) {
            if (n++ >= this.perRun) break;
            report.verified(i);
          }
          return { kind: 'drained' };
        } finally { this.liveListeners--; }      // …released inside run(), per the contract
      }
      dispose() { this.disposed = true; this.disposals++; }
    }

    const mgr = mkMgr();
    const d = new RealisticDriver('relay', 30, 2);        // only 2 chunks per round
    mgr.setDriversFor('Tmultiround000001', [d]);
    const s = mkSession(10, 'Tmultiround000001');
    const res = await mgr.start(s);
    check(res.state === 'complete', `a multi-round transfer completes (got ${res.state})`);
    check(s.isComplete() && s.peerHave.popcount() === 10, `all 10 chunks moved (got ${s.peerHave.popcount()})`);
    check(d.runs === 5, `the driver was reused across rounds (${d.runs} runs)`);
    check(d.disposals === 1, `disposed exactly once, at session end (${d.disposals})`);
    check(d.liveListeners === 0, 'no per-run subscription outlived its run');

    // scoped drivers are disposed on a terminal session…
    const mgr2 = mkMgr();
    const t = new RealisticDriver('relay', 30, 99);
    mgr2.setDriversFor('Tterm00000000001', [t]);
    await mgr2.start(mkSession(3, 'Tterm00000000001'));
    check(t.disposals === 1, 'terminal session disposes its transports');

    // …but a PARKED session keeps them, because a poke may resume it
    const mgr3 = mkMgr();
    const parked = new RealisticDriver('relay', 30, 0);   // moves nothing → parks
    mgr3.setDriversFor('Tparked000000001', [parked]);
    const ps = mkSession(3, 'Tparked000000001');
    const pres = await mgr3.start(ps);
    check(pres.state === 'parked', 'the session parked');
    check(parked.disposals === 0, 'a parked session keeps its transports for a later poke');
  }

  console.log('Drivers are scoped per transfer:');
  {
    // REGRESSION: the driver registry was process-wide, but real drivers carry
    // per-transfer state (source path, datachannel, LAN endpoint). A second
    // transfer reused the first one's driver — and would have uploaded the
    // WRONG FILE.
    class PathDriver implements TransportDriver {
      readonly channel = 'relay' as const;
      readonly id = 'relay'; readonly cost = 30;
      served: string[] = [];
      constructor(private myPath: string) {}
      unitChunks() { return Infinity; }
      async available() { return true; }
      async run(s: TransferSession, work: ChunkRun[], report: DriverReport): Promise<DriverOutcome> {
        this.served.push(`${s.transferId}<-${this.myPath}`);
        for (const r of work) for (let i = r.start; i < r.start + r.count; i++) report.verified(i);
        return { kind: 'drained' };
      }
      dispose() {}
    }
    const mgr = mkMgr();
    const dA = new PathDriver('/files/A.bin');
    const dB = new PathDriver('/files/B.bin');
    mgr.setDriversFor('TxferAAAAAAAAAAA', [dA]);
    await mgr.start(mkSession(2, 'TxferAAAAAAAAAAA'));
    mgr.setDriversFor('TxferBBBBBBBBBBB', [dB]);
    await mgr.start(mkSession(2, 'TxferBBBBBBBBBBB'));
    check(dA.served.length === 1 && dA.served[0].startsWith('TxferAAA'),
      "transfer A's driver served only transfer A");
    check(dB.served.length === 1 && dB.served[0].endsWith('/files/B.bin'),
      "transfer B was served by ITS OWN driver, with its own source file");
  }

  console.log('One worker per session:');
  {
    AuditDriver.peakLive = 0;
    const mgr = mkMgr();
    const d = new AuditDriver('relay', 30, { verifyLimit: 2 });
    mgr.registerDriver(d);
    const s = mkSession(12, 'Tworker0000000001');
    // two concurrent starts must share ONE run, not open a second worker
    const [a, b] = await Promise.all([mgr.start(s), mgr.start(s)]);
    check(JSON.stringify(a) === JSON.stringify(b), 'concurrent starts share one result');
    check(AuditDriver.peakLive <= 1, `never more than one worker (peak ${AuditDriver.peakLive})`);
  }

  console.log('Completed chunks are never re-encrypted or re-sent:');
  {
    const mgr = mkMgr();
    const first = new AuditDriver('p2p', 20, { verifyLimit: 6, fail: true });
    const second = new AuditDriver('relay', 30);
    mgr.registerDriver(second);
    mgr.registerDriver(first);
    const s = mkSession(10, 'Tnodup00000000001');
    await mgr.start(s);
    const verifiedByFirst = new Set(first.asked.slice(0, 6));
    check(second.asked.every((c) => !verifiedByFirst.has(c)),
      'the fallback driver was never asked for a chunk the first one verified');
    check(new Set(second.asked).size === second.asked.length, 'the fallback asked for no chunk twice');
    check(s.isComplete(), 'and the transfer still completed');
  }

  console.log('Manager per-session state stays bounded:');
  {
    const mgr = mkMgr();
    mgr.registerDriver(new AuditDriver('relay', 30));
    for (let i = 0; i < 30; i++) {
      const s = mkSession(2, `Tbound${String(i).padStart(10, '0')}`);
      await mgr.start(s);
    }
    check(mgr.activeCount() === 0, 'no sessions left running after 30 transfers');
    check(mgr.queuedCount() === 0, 'the admission queue drained');
    // driverState is per transfer; assert it is scoped, not global
    const one = mgr.driverState('Tbound0000000000');
    check(Object.keys(one).length <= 2, 'driver health is scoped per transfer');
  }

  console.log('The durability barrier is bounded and leaves nothing held:');
  {
    // The watermark adds two per-session Sets between "written" and "verified".
    // Neither may accumulate across transfers, and neither may outlive a run —
    // a chunk stuck in one is a chunk that is never re-offered and never
    // becomes progress, i.e. a permanent stall.
    let syncs = 0;
    let peakHeld = 0;
    const mgr = new TransferManager({
      now: () => 0, sleep: async () => {}, idlePollMs: 1, maxIdleRounds: 2, baseCooldownMs: 1,
      durableBatchChunks: 8,
      fsync: async (s) => { syncs++; peakHeld = Math.max(peakHeld, s.heldDurableCount); },
    });
    mgr.registerDriver(new AuditDriver('relay', 30));
    const sessions: TransferSession[] = [];
    for (let i = 0; i < 40; i++) {
      const s = mkSession(16, `Tdur${String(i).padStart(12, '0')}`, 'recipient');
      const all = s.r2Have.clone();
      for (let c = 0; c < s.chunkCount; c++) all.set(c);
      s.setR2Have(all);
      await mgr.start(s);
      sessions.push(s);
    }
    check(syncs > 0, `barriers ran (${syncs} across 40 transfers)`);
    check(sessions.every((s) => s.isComplete()), 'every durable transfer completed');
    check(sessions.every((s) => s.heldDurableCount === 0), 'no session ends with chunks held');
    check(sessions.every((s) => s.pendingDurableCount === 0), 'no session ends with un-flushed writes');
    // Held chunks are capped by the batch threshold plus at most one racing
    // batch — never "everything decrypted so far", which is the unbounded shape.
    check(peakHeld <= 8 * 2, `held chunks stay bounded by the batch size (peak ${peakHeld})`);
    check(mgr.activeCount() === 0, 'no sessions left running');
  }

  console.log('Write-behind leaves nothing behind:');
  {
    const rows = new Map<string, PersistedSession>();
    const store: SessionStore = {
      async save(r) { rows.set(r.transferId, r); },
      async loadAll() { return [...rows.values()]; },
      async remove(id) { rows.delete(id); },
    };
    const wb = new WriteBehind({ store, delayMs: 5 });
    for (let i = 0; i < 50; i++) {
      const s = mkSession(4, `Twb${String(i).padStart(13, '0')}`);
      s.markVerified(0);
      wb.schedule(s);
      await wb.flush(s.transferId);
    }
    check(wb.timerCount() === 0, `no timers left (${wb.timerCount()})`);
    check(wb.pendingCount() === 0, `no pending entries left (${wb.pendingCount()})`);
    check(rows.size === 50, 'every session was written exactly once');

    // a scheduled-but-never-flushed write must still be cancellable
    const s = mkSession(4, 'Tcancel0000000001');
    wb.schedule(s);
    check(wb.timerCount() === 1, 'a pending timer exists');
    await wb.forget(s.transferId);
    check(wb.timerCount() === 0 && wb.pendingCount() === 0, 'forget cancels the pending write');
  }

  console.log(`\n${failures === 0 ? 'ALL VAULTBEAM AUDIT CHECKS PASSED ✓' : `✗ ${failures} AUDIT CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error('audit harness error:', e); process.exit(1); });
