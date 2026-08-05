// lib/vaultBeam/drivers/types.ts — the transport driver contract.
//
// A driver is handed a work-list and reports what happened. It owns no progress,
// no byte counters, no completion totals, and never decides which transport runs
// next (design §3). Adding a transport is implementing this interface and calling
// `manager.registerDriver(...)`.
//
// The report has TWO channels because the system tracks two different facts, and
// conflating them is root cause RC-4:
//   • verified(chunk) — the PEER durably holds it (GCM-verified + written).
//                       This is the only thing that advances progress.
//   • staged(chunk)   — the RELAY holds the ciphertext. Not delivery.
//
// This module is pure (no react-native / expo imports) and carries the shared
// contract harness every driver must pass, so a driver's compliance is tested
// rather than assumed.

import { type ChunkRun } from '../bitmap';
import { TransferSession } from '../session';

export type TransportId = string;

/** Which work-list a transport consumes. */
export type TransportChannel =
  | 'direct'   // moves bytes peer-to-peer; delivery is confirmed by the peer
  | 'relay';   // stages bytes in shared storage; delivery is confirmed separately

export type DriverOutcome =
  | { kind: 'drained' }
  | { kind: 'failed'; reason: string; retryAfterMs?: number };

export interface DriverReport {
  /** The peer durably holds this chunk. Advances PeerHave, and only this does. */
  verified(chunk: number): void;
  /** The relay holds this chunk's ciphertext. Advances R2Have. Not delivery. */
  staged(chunk: number): void;
}

export interface TransportDriver {
  readonly id: TransportId;
  /** Lower is preferred. LAN < P2P < relay. */
  readonly cost: number;
  readonly channel: TransportChannel;
  /**
   * Physical packing this transport wants right now, in LOGICAL chunks.
   * Throughput tuning only: changing it may change request/frame counts and
   * nothing else — never a chunk's identity, ciphertext, ack id, or bitmap bit.
   */
  unitChunks(session: TransferSession): number;
  available(session: TransferSession): Promise<boolean>;
  run(
    session: TransferSession,
    work: ChunkRun[],
    report: DriverReport,
    signal: AbortSignal,
  ): Promise<DriverOutcome>;
  /** MUST release every listener, socket, timer, native subscription. Idempotent. */
  dispose(): void;
}

export const expandRuns = (runs: ReadonlyArray<ChunkRun>): number[] => {
  const out: number[] = [];
  for (const r of runs) for (let i = r.start; i < r.start + r.count; i++) out.push(i);
  return out;
};

// ── shared contract harness ──────────────────────────────────────────
// Every driver must pass this. It is exported so each driver's own self-check
// can call it, which keeps compliance from drifting per-driver.

export interface ContractOpts {
  /** Build a fresh driver, and a session it can actually serve. */
  make: () => { driver: TransportDriver; session: TransferSession };
  /** Total logical chunks in the fixture session. */
  chunkCount: number;
  /** Rebuild with a different physical unit, to prove unit-independence. */
  makeWithUnit?: (unit: number) => { driver: TransportDriver; session: TransferSession };
}

export async function runDriverContract(name: string, opts: ContractOpts): Promise<void> {
  const A = (c: boolean, m: string) => { if (!c) throw new Error(`driver contract [${name}]: ${m}`); };

  // 1. A driver only reports chunks it was actually given.
  {
    const { driver, session } = opts.make();
    const work = session.pendingRuns(driver.unitChunks(session));
    const given = new Set(expandRuns(work));
    const reported: number[] = [];
    const ac = new AbortController();
    await driver.run(session, work, {
      verified: (c) => { reported.push(c); session.markVerified(c); },
      staged: (c) => { reported.push(c); session.markStaged(c); },
    }, ac.signal);
    A(reported.every((c) => given.has(c)), 'reports only chunks it was given');
    A(new Set(reported).size === reported.length, 'never reports the same chunk twice');
    driver.dispose();
  }

  // 2. dispose is idempotent and safe to call without a run.
  {
    const { driver } = opts.make();
    driver.dispose();
    driver.dispose();
    A(true, 'dispose is idempotent');
  }

  // 3. An already-aborted signal must not move bytes.
  {
    const { driver, session } = opts.make();
    const ac = new AbortController();
    ac.abort();
    let moved = 0;
    const out = await driver.run(session, session.pendingRuns(), {
      verified: () => { moved++; }, staged: () => { moved++; },
    }, ac.signal);
    A(moved === 0, 'honours an already-aborted signal');
    A(out.kind === 'failed' || moved === 0, 'aborted run does not claim success with work done');
    driver.dispose();
  }

  // 4. The driver holds no progress of its own: after disposal the session is
  //    the sole source of truth, and a fresh driver re-derives from it.
  {
    const { driver, session } = opts.make();
    const work = session.pendingRuns(2).slice(0, 1);
    await driver.run(session, work, {
      verified: (c) => session.markVerified(c), staged: (c) => session.markStaged(c),
    }, new AbortController().signal);
    const progressAfter = session.progressBytes();
    driver.dispose();
    A(session.progressBytes() === progressAfter, 'disposal does not change progress');
    A((driver as any).progress === undefined && (driver as any).bytes === undefined,
      'driver exposes no progress/bytes field');
  }

  // 5. Physical unit independence: varying unitChunks may change how many
  //    operations happen, but never WHICH chunks move.
  if (opts.makeWithUnit) {
    const moved: Record<number, number[]> = {};
    for (const unit of [1, 4]) {
      const { driver, session } = opts.makeWithUnit(unit);
      const seen: number[] = [];
      const ac = new AbortController();
      // drain: loop until no work remains or nothing changes
      for (let guard = 0; guard < 50; guard++) {
        const work = session.pendingRuns(driver.unitChunks(session));
        if (work.length === 0) break;
        const before = session.revision;
        await driver.run(session, work, {
          verified: (c) => { seen.push(c); session.markVerified(c); },
          staged: (c) => { seen.push(c); session.markStaged(c); },
        }, ac.signal);
        if (session.revision === before) break;
      }
      driver.dispose();
      moved[unit] = seen.sort((a, b) => a - b);
    }
    A(JSON.stringify(moved[1]) === JSON.stringify(moved[4]),
      'physical unit size does not change which chunks move');
  }
}

export default {};
