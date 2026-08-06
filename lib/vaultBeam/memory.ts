// lib/vaultBeam/memory.ts — the one place that decides how much VaultBeam may hold.
//
// Every transport used to size itself independently: the relay picked 4 workers
// from a battery reading, the P2P receiver picked nothing at all. Nobody added
// the numbers up, so the real peak was whatever the widest path happened to
// allocate — and one of them had no ceiling at all.
//
// This module is the sum. It is deliberately small: a budget, the worker
// formula derived from it, and a live tally of what is currently held. There is
// no allocator here, no pooling, no new layer between the drivers and their
// buffers. Drivers still allocate their own memory; they just have to say so.
//
// WHY WORKERS COME FROM MEMORY AND NOT FROM CORES
// -----------------------------------------------
// Concurrency on a phone is not bounded by how many things can compute at once
// — it is bounded by how many buffers can exist at once. `cores - 1` workers
// each holding two physical units of a 4 MiB block is 24 MiB on a 4-core device
// and 56 MiB on an 8-core one, for the same file, on the same network, with the
// same throughput. The core count is the wrong input; it only survives as a
// ceiling because there is no point running more workers than can be scheduled.
//
// STORAGE SPEED IS DELIBERATELY NOT AN INPUT
// ------------------------------------------
// It was proposed and then removed: nothing on the device reports it, and
// inferring it from observed write latency measures congestion (how many
// workers are already running) as much as the medium. A signal that moves with
// the thing it is meant to control is a feedback loop, not a measurement. If
// this is ever wanted, it needs a real startup micro-benchmark.
//
// Pure: no react-native imports, so `npx tsx lib/vaultBeam/memory.ts` runs it.

/**
 * Total bytes VaultBeam may hold in flight across every transport at once.
 *
 * 32 MiB is the number the 4 MiB physical-block cap was accepted against:
 * 4 MiB × 4 workers × 2 buffers. It is a CEILING for the whole engine, not a
 * per-driver allowance, which is the property that was missing before.
 */
export const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024;

/** Never fewer than one worker — zero workers is a stall, not a saving. */
const MIN_WORKERS = 1;

export interface WorkerPlan {
  workers: number;
  /** Bytes this plan expects to hold: workers × 2 × physicalUnit. */
  projectedBytes: number;
  /** Which constraint actually decided the number — for telemetry, not logic. */
  boundBy: 'memory' | 'cores' | 'floor';
}

/**
 * The approved formula: workers = clamp(1, floor(budget / (2 × unit)), cores − 1).
 *
 * The factor of two is not padding. A worker holds the buffer it is writing AND
 * the one it is reading into next; sizing for one is how a "safe" limit turns
 * out to be exactly half of what actually gets allocated.
 */
export function planWorkers(opts: {
  physicalUnitBytes: number;
  cores: number;
  budgetBytes?: number;
}): WorkerPlan {
  const budget = Math.max(1, opts.budgetBytes ?? DEFAULT_BUDGET_BYTES);
  const unit = Math.max(1, Math.floor(opts.physicalUnitBytes));
  const byMemory = Math.floor(budget / (2 * unit));
  // A machine reporting 1 core still gets 1 worker: `cores - 1` would be zero.
  const byCores = Math.max(MIN_WORKERS, Math.floor(opts.cores) - 1);

  let workers = Math.min(byMemory, byCores);
  let boundBy: WorkerPlan['boundBy'] = byMemory <= byCores ? 'memory' : 'cores';
  if (workers < MIN_WORKERS) { workers = MIN_WORKERS; boundBy = 'floor'; }

  return { workers, projectedBytes: workers * 2 * unit, boundBy };
}

/**
 * Live accounting for bytes currently held in transfer buffers.
 *
 * `reserve` is a REQUEST, not a reservation that queues: it either succeeds now
 * or is refused, and the caller's answer to a refusal is to not allocate. There
 * is no waiting list, because a waiting list is a queue, and an unbounded queue
 * of things waiting to allocate is the same bug in a different place.
 */
export class MemoryWatchdog {
  private held = 0;
  private peak = 0;
  private refusals = 0;

  constructor(private budget: number = DEFAULT_BUDGET_BYTES) {}

  get budgetBytes(): number { return this.budget; }
  get heldBytes(): number { return this.held; }
  get peakBytes(): number { return this.peak; }
  get refusalCount(): number { return this.refusals; }
  get availableBytes(): number { return Math.max(0, this.budget - this.held); }

  /** Raise or lower the ceiling (a device-informed budget at boot). */
  setBudget(bytes: number): void { this.budget = Math.max(1, Math.floor(bytes)); }

  /** True if the bytes were charged to the budget; false means DO NOT allocate. */
  reserve(bytes: number): boolean {
    if (bytes <= 0) return true;
    if (this.held + bytes > this.budget) { this.refusals++; return false; }
    this.held += bytes;
    if (this.held > this.peak) this.peak = this.held;
    return true;
  }

  /** Give the bytes back. Never goes negative, whatever the caller does. */
  release(bytes: number): void {
    this.held = Math.max(0, this.held - Math.max(0, bytes));
  }

  /** Fraction of the budget in use — the number a pressure signal reads. */
  pressure(): number { return this.budget > 0 ? this.held / this.budget : 0; }

  /** Reset the accounting between transfers (peak/refusals are diagnostics). */
  resetCounters(): void { this.peak = this.held; this.refusals = 0; }
}

/** Process-wide watchdog. One engine, one ceiling. */
let _watchdog: MemoryWatchdog | null = null;
export function watchdog(): MemoryWatchdog {
  if (!_watchdog) _watchdog = new MemoryWatchdog();
  return _watchdog;
}

// ── self-check: `npx tsx lib/vaultBeam/memory.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('memory: ' + m); };
  const MiB = 1024 * 1024;

  // ── the worker formula ──
  // The case the cap was accepted against: 4 MiB blocks, 32 MiB budget.
  {
    const p = planWorkers({ physicalUnitBytes: 4 * MiB, cores: 8 });
    A(p.workers === 4, `4 MiB blocks on 8 cores ⇒ 4 workers (got ${p.workers})`);
    A(p.projectedBytes === 32 * MiB, 'and the projection is exactly the budget');
    A(p.boundBy === 'memory', 'memory is the binding constraint, not the core count');
  }

  // THE regression this formula exists to prevent: more cores must NOT mean
  // more memory. A 16-core device gets the same allocation as an 8-core one.
  {
    const a = planWorkers({ physicalUnitBytes: 4 * MiB, cores: 8 });
    const b = planWorkers({ physicalUnitBytes: 4 * MiB, cores: 16 });
    A(a.projectedBytes === b.projectedBytes, 'core count does not change the memory footprint');
  }

  // A weak device is still bounded by its cores, because running more workers
  // than can be scheduled buys nothing.
  {
    const p = planWorkers({ physicalUnitBytes: 512 * 1024, cores: 4 });
    A(p.workers === 3, `small blocks on 4 cores ⇒ cores bind (got ${p.workers})`);
    A(p.boundBy === 'cores', 'and the plan says so');
  }
  {
    const p = planWorkers({ physicalUnitBytes: 512 * 1024, cores: 1 });
    A(p.workers === 1, 'a single-core device still gets one worker, never zero');
  }

  // A physical unit larger than the whole budget must not yield zero workers —
  // one worker that exceeds the ceiling is still better than a stalled transfer,
  // and the ceiling is what the per-driver refusals then enforce.
  {
    const p = planWorkers({ physicalUnitBytes: 64 * MiB, cores: 8 });
    A(p.workers === 1, 'an oversized unit floors at one worker');
    A(p.boundBy === 'floor', 'and reports that it hit the floor');
  }

  // Every block size at or under the approved 4 MiB cap must project within
  // budget. This is the assertion that would have caught the 512 MiB peak the
  // 64 MiB recommendation implied.
  for (const unit of [1, 2, 4]) {
    const p = planWorkers({ physicalUnitBytes: unit * MiB, cores: 8 });
    A(p.projectedBytes <= DEFAULT_BUDGET_BYTES,
      `${unit} MiB blocks project ${p.projectedBytes / MiB} MiB — over budget`);
  }

  // ── the watchdog ──
  {
    const w = new MemoryWatchdog(10 * MiB);
    A(w.reserve(4 * MiB) === true, 'a reservation inside the budget succeeds');
    A(w.reserve(4 * MiB) === true, 'and so does a second');
    A(w.heldBytes === 8 * MiB, 'held is the sum');
    A(w.reserve(4 * MiB) === false, 'a reservation that would exceed the budget is REFUSED');
    A(w.heldBytes === 8 * MiB, 'a refusal charges nothing');
    A(w.refusalCount === 1, 'refusals are counted');
    A(w.availableBytes === 2 * MiB, 'available is what is left');

    w.release(4 * MiB);
    A(w.heldBytes === 4 * MiB, 'release gives the bytes back');
    A(w.reserve(4 * MiB) === true, 'and the refused allocation now fits');
    A(w.peakBytes === 8 * MiB, 'peak survives the release');

    // Over-releasing is a caller bug; it must not corrupt the accounting into a
    // negative held, which would silently RAISE the ceiling.
    w.release(999 * MiB);
    A(w.heldBytes === 0, 'held never goes negative');
    A(w.reserve(10 * MiB) === true, 'and the budget is intact afterwards');
    A(w.pressure() === 1, 'a full budget reads as pressure 1');
  }

  // A zero/negative request is free — callers should not have to special-case it.
  {
    const w = new MemoryWatchdog(1024);
    A(w.reserve(0) === true && w.heldBytes === 0, 'a zero reservation is a no-op');
  }

  console.log('vaultBeam/memory self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
