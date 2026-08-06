// lib/vaultBeam/matrix.selftest.ts — the transport-transition matrix, automated
// as far as it honestly can be.
//
// tasks.md §8.2 defines 14 rows and calls the whole thing device-only, because
// NAT traversal and LAN sockets are. That is true of the RADIO. It is not true
// of the STATE MACHINE, and the state machine is where every bug in this project
// so far has actually lived: a bitmap that reset, a work-list that re-derived
// wrongly, a driver that re-sent what the peer already had.
//
// So each row below is split. What runs here is the part that does not need a
// second handset: real TransferSession, real TransferManager, real driver
// contract, fake transports that can be made to fail exactly when the row says.
// What needs hardware is named as such and left to the device pass — this file
// makes that list SHORTER and explicit, it does not pretend to replace it.
//
// Every automated row asserts the same three invariants as the manual one:
//   (a) progress never decreases
//   (b) no chunk already in PeerHave is transferred again
//   (c) the reassembled bytes equal the source bytes, exactly
//
// Run: `npx tsx lib/vaultBeam/matrix.selftest.ts`

import { CHUNK_BYTES, type ChunkRun, ChunkBitmap } from './bitmap';
import { TransferSession } from './session';
import { TransferManager } from './manager';
import { type TransportDriver, type DriverOutcome, type DriverReport } from './drivers/types';
import { type PersistedSession, type SessionStore } from './persistence';

let failures = 0;
let checks = 0;
function check(cond: boolean, label: string) {
  checks++;
  if (cond) { console.log(`    ✓ ${label}`); return; }
  failures++;
  console.log(`    ✗ ${label}`);
}
function row(n: number, title: string, mode: 'automated' | 'partial') {
  resetLedger();
  const tag = mode === 'automated' ? 'state machine' : 'state machine only — radio needs hardware';
  console.log(`\n  Row ${n}: ${title}  [${tag}]`);
}

// ── the fixture ──────────────────────────────────────────────────────
// A "file" is chunk i ↦ byte (i * 31 + 7) mod 256. The receiver's "disk" is a
// Map<chunk, byte>. That is enough to catch a chunk written at the wrong index,
// written twice with different content, or never written — which is what
// invariant (c) is actually about.

const CHUNKS = 40;
const TOTAL = CHUNKS * CHUNK_BYTES;
const sourceByte = (i: number) => (i * 31 + 7) & 0xff;

interface Disk { written: Map<number, number>; writeCount: Map<number, number> }
const mkDisk = (): Disk => ({ written: new Map(), writeCount: new Map() });

/**
 * A single chronological log of every offer and every delivery, across all
 * transports.
 *
 * Chronological is the whole point. Checking invariant (b) by walking a list of
 * driver objects compares them in whatever order that array happens to be in —
 * cost order, usually — and cost order is not time order: in row 2 the expensive
 * transport runs FIRST and the cheap one takes over. Reading it out of order
 * turned a correct fallback into a phantom violation.
 */
const ledger: Array<{ driver: string; kind: 'ask' | 'deliver'; chunk: number }> = [];
function resetLedger(): void { ledger.length = 0; }

function landChunk(disk: Disk, i: number): void {
  disk.written.set(i, sourceByte(i));
  disk.writeCount.set(i, (disk.writeCount.get(i) ?? 0) + 1);
}

/** Invariant (c): every chunk present, correct, and none written twice. */
function fileIsExact(disk: Disk): { ok: boolean; why: string } {
  for (let i = 0; i < CHUNKS; i++) {
    if (!disk.written.has(i)) return { ok: false, why: `chunk ${i} missing` };
    if (disk.written.get(i) !== sourceByte(i)) return { ok: false, why: `chunk ${i} has wrong bytes` };
  }
  return { ok: true, why: '' };
}

/** Invariant (b), measured rather than asserted by construction. */
function noRedundantTransfer(disk: Disk): { ok: boolean; worst: number } {
  let worst = 0;
  for (const n of disk.writeCount.values()) worst = Math.max(worst, n);
  return { ok: worst <= 1, worst };
}

/** Watches progress across a whole scenario. Invariant (a). */
class ProgressMonitor {
  private last = -1;
  private drops = 0;
  observe(s: TransferSession): void {
    const b = s.progressBytes();
    if (b < this.last) this.drops++;
    this.last = b;
  }
  get droppedCount(): number { return this.drops; }
  get peak(): number { return this.last; }
}

// ── a configurable transport ─────────────────────────────────────────
// Real driver contract; fake bytes. `budget` is how many chunks it will move
// before it stops or fails, which is how a row says "die at 90%".

interface FakeOpts {
  id: string;
  cost: number;
  channel?: 'direct' | 'relay';
  /** Chunks it can move over its LIFETIME before giving out. Infinity = healthy.
   *  Lifetime, not per-run: a transport that recovered its full budget every
   *  round would never actually die, so no row could express "it failed at 90%". */
  budget?: number;
  /** Fail after moving its budget. */
  failAfter?: boolean;
  /** Unavailable until flipped — a transport that has not come up yet. */
  up?: () => boolean;
  /** Drop every Nth chunk silently (a lossy link). */
  dropEvery?: number;
  /** A relay-channel SENDER stages instead of verifying. */
  stageOnly?: boolean;
  disk?: Disk;
}

class FakeTransport implements TransportDriver {
  readonly id: string;
  readonly cost: number;
  readonly channel: 'direct' | 'relay';
  /** Every chunk this transport was ASKED to move, across all runs. */
  asked: number[] = [];
  /** Every chunk it actually DELIVERED (verified or staged). */
  delivered: number[] = [];
  runs = 0;
  disposals = 0;
  private seen = 0;
  private remaining: number;

  constructor(private cfg: FakeOpts) {
    this.id = cfg.id;
    this.cost = cfg.cost;
    this.channel = cfg.channel ?? 'direct';
    this.remaining = cfg.budget ?? Infinity;
  }

  unitChunks(): number { return Infinity; }
  async available(): Promise<boolean> { return this.cfg.up ? this.cfg.up() : true; }
  dispose(): void { this.disposals++; }

  async run(_s: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal): Promise<DriverOutcome> {
    if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
    this.runs++;
    for (const r of work) {
      for (let i = r.start; i < r.start + r.count; i++) {
        this.asked.push(i);
        ledger.push({ driver: this.id, kind: 'ask', chunk: i });
        if (this.remaining-- <= 0) {
          return this.cfg.failAfter ? { kind: 'failed', reason: `${this.id} died` } : { kind: 'drained' };
        }
        this.seen++;
        if (this.cfg.dropEvery && this.seen % this.cfg.dropEvery === 0) continue;  // lost in flight
        this.delivered.push(i);
        ledger.push({ driver: this.id, kind: 'deliver', chunk: i });
        if (this.cfg.stageOnly) { report.staged(i); continue; }
        if (this.cfg.disk) landChunk(this.cfg.disk, i);
        report.verified(i);
      }
    }
    return this.cfg.failAfter ? { kind: 'failed', reason: `${this.id} died` } : { kind: 'drained' };
  }
}

const mkMgr = (extra: Record<string, unknown> = {}) => new TransferManager({
  now: () => 0, sleep: async () => {}, idlePollMs: 1, maxIdleRounds: 4, baseCooldownMs: 1, ...extra,
});

const mkSession = (id: string, role: 'sender' | 'recipient' = 'recipient') => new TransferSession({
  transferId: id, sessionVersion: 1, fileId: 'F', keyB64: 'k', role, totalBytes: TOTAL,
});

/** Assert the three invariants for a completed scenario. */
function assertInvariants(s: TransferSession, disk: Disk, mon: ProgressMonitor, drivers: FakeTransport[]) {
  check(mon.droppedCount === 0, 'progress never decreased');
  const exact = fileIsExact(disk);
  check(exact.ok, `the reassembled file is byte-exact${exact.ok ? '' : ' — ' + exact.why}`);
  const red = noRedundantTransfer(disk);
  check(red.ok, `no chunk was written twice (worst ${red.worst})`);
  // Invariant (b) precisely, read in TIME order. NOT "no chunk was offered
  // twice" — a chunk offered to a transport that then died was never delivered,
  // so re-offering it is exactly what the work-list is for. What must never
  // happen is a transport being handed a chunk another one ALREADY DELIVERED:
  // that is the re-upload this whole project exists to eliminate.
  const deliveredSoFar = new Set<number>();
  let reoffered = 0;
  for (const e of ledger) {
    if (e.kind === 'ask') { if (deliveredSoFar.has(e.chunk)) reoffered++; }
    else deliveredSoFar.add(e.chunk);
  }
  check(reoffered === 0, `no already-delivered chunk was handed to another transport (${reoffered})`);
  const allDelivered = drivers.flatMap((d) => d.delivered);
  check(new Set(allDelivered).size === allDelivered.length,
    `nothing was delivered twice (${allDelivered.length} deliveries, ${new Set(allDelivered).size} distinct)`);
  check(s.progressBytes() === TOTAL, 'progress equals the file size');
}

async function main() {
  console.log('VaultBeam transport-transition matrix (tasks.md §8.2)');
  console.log('══════════════════════════════════════════════════════');

  // ── Row 1 ──────────────────────────────────────────────────────────
  row(1, 'Wi-Fi → Mobile mid-transfer', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    // The link changes underneath: the P2P driver dies partway, the relay
    // finishes. What the device pass adds is whether ICE actually restarts.
    const p2p = new FakeTransport({ id: 'p2p', cost: 20, budget: 17, failAfter: true, disk });
    const relay = new FakeTransport({ id: 'relay', cost: 30, disk });
    mgr.registerDriver(p2p); mgr.registerDriver(relay);
    const s = mkSession('Trow01');
    const res = await mgr.start(s);
    check(res.state === 'complete', 'the transfer completed across the link change');
    check(p2p.asked.length > 0 && relay.asked.length > 0, 'both transports carried part of it');
    check(Math.min(...relay.asked) >= 17, 'the relay started at the first chunk P2P had NOT delivered');
    assertInvariants(s, disk, mon, [p2p, relay]);
    console.log('    · device pass still required: ICE restart keeps the datachannel, or falls to relay');
  }

  // ── Row 2 ──────────────────────────────────────────────────────────
  row(2, 'Mobile → Wi-Fi mid-transfer (cheaper transport returns)', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    let lanUp = false;
    const lan = new FakeTransport({ id: 'lan', cost: 10, up: () => lanUp, disk });
    const relay = new FakeTransport({ id: 'relay', cost: 30, budget: 12, disk });
    mgr.registerDriver(lan); mgr.registerDriver(relay);
    const s = mkSession('Trow02');
    // First pass: only the relay exists.
    await mgr.start(s);
    check(s.progressBytes() > 0 && !s.isComplete(), 'the expensive transport made partial progress');
    const before = s.progressBytes();
    lanUp = true;                                     // Wi-Fi comes back
    const res = await (mgr.poke(s.transferId) as Promise<any>);
    check(res.state === 'complete', 'the cheaper transport finished it');
    check(s.progressBytes() >= before, 'progress did not roll back when the transport changed');
    check(lan.asked.every((c) => c >= 12), 'the cheaper transport was handed ONLY the remainder');
    assertInvariants(s, disk, mon, [lan, relay]);
  }

  // ── Row 3 ──────────────────────────────────────────────────────────
  row(3, 'LAN → Relay: only the missing tail is uploaded', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    const lan = new FakeTransport({ id: 'lan', cost: 10, budget: 31, failAfter: true, disk });
    const relay = new FakeTransport({ id: 'relay', cost: 30, disk });
    mgr.registerDriver(lan); mgr.registerDriver(relay);
    const s = mkSession('Trow03');
    await mgr.start(s);
    check(relay.asked.length === CHUNKS - 31, `the relay moved exactly the ${CHUNKS - 31}-chunk tail (got ${relay.asked.length})`);
    check(Math.min(...relay.asked) === 31, 'starting at the first chunk LAN did not deliver');
    assertInvariants(s, disk, mon, [lan, relay]);
  }

  // ── Row 4 ──────────────────────────────────────────────────────────
  row(4, 'Relay → P2P: staged chunks are not re-sent over P2P', 'automated');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    // A recipient: R2 holds a prefix, and P2P must not be asked for it once the
    // relay has delivered it.
    const relay = new FakeTransport({ id: 'relay', cost: 30, channel: 'relay', budget: 20, disk });
    let p2pUp = false;
    const p2p = new FakeTransport({ id: 'p2p', cost: 20, up: () => p2pUp, disk });
    mgr.registerDriver(relay); mgr.registerDriver(p2p);
    const s = mkSession('Trow04');
    const staged = new ChunkBitmap(CHUNKS);
    for (let i = 0; i < CHUNKS; i++) staged.set(i);
    s.setR2Have(staged);
    await mgr.start(s);
    const viaRelay = new Set(relay.delivered);
    p2pUp = true;
    await (mgr.poke(s.transferId) as Promise<any>);
    const overlap = p2p.delivered.filter((c) => viaRelay.has(c));
    check(overlap.length === 0, `zero DELIVERY overlap between the two transports (${overlap.length})`);
    check(p2p.delivered.length + relay.delivered.length === CHUNKS,
      'between them they delivered each chunk exactly once');
    assertInvariants(s, disk, mon, [relay, p2p]);
  }

  // ── Row 5 ──────────────────────────────────────────────────────────
  row(5, 'P2P at 90% → kill Wi-Fi: relay uploads only the tail, bar holds', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    const ninety = Math.floor(CHUNKS * 0.9);
    const p2p = new FakeTransport({ id: 'p2p', cost: 20, budget: ninety, failAfter: true, disk });
    const relay = new FakeTransport({ id: 'relay', cost: 30, disk });
    mgr.registerDriver(p2p); mgr.registerDriver(relay);
    const s = mkSession('Trow05');
    await mgr.start(s);
    check(mon.droppedCount === 0, 'the bar HELD at 90% — it did not reset to zero (the original bug)');
    check(relay.asked.length === CHUNKS - ninety, `the relay moved only the ${CHUNKS - ninety}-chunk tail`);
    assertInvariants(s, disk, mon, [p2p, relay]);
  }

  // ── Row 6 ──────────────────────────────────────────────────────────
  row(6, 'P2P at 100% → the final ack is lost: ZERO bytes re-transferred', 'automated');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    // Delivers everything, THEN reports failure — the lost-ack shape exactly.
    const p2p = new FakeTransport({ id: 'p2p', cost: 20, failAfter: true, disk });
    const relay = new FakeTransport({ id: 'relay', cost: 30, disk });
    mgr.registerDriver(p2p); mgr.registerDriver(relay);
    const s = mkSession('Trow06');
    const res = await mgr.start(s);
    check(res.state === 'complete', 'the transfer completed despite the lost ack');
    check(relay.asked.length === 0, 'the relay moved ZERO chunks');
    check(relay.runs === 0, 'the relay driver never even ran');
    assertInvariants(s, disk, mon, [p2p, relay]);
  }

  // ── Rows 7 / 9 ─────────────────────────────────────────────────────
  console.log('\n  Row 7: App background → foreground, each tier  [DEVICE ONLY]');
  console.log('    · needs a real FGS / user-initiated job and a real OEM. See lib/vaultBeamJob.ts.');
  console.log('  Row 9: Device reboot mid-transfer  [covered at state level by Row 8]');

  // ── Row 8 ──────────────────────────────────────────────────────────
  row(8, 'App force close mid-transfer: resumes from the bitmap', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const rows: PersistedSession[] = [];
    const store: SessionStore = {
      async save(r) { const i = rows.findIndex((x) => x.transferId === r.transferId); if (i >= 0) rows[i] = r; else rows.push(r); },
      async loadAll() { return [...rows]; },
      async remove(id) { const i = rows.findIndex((x) => x.transferId === id); if (i >= 0) rows.splice(i, 1); },
    };

    // Session one: moves part of the file, then the process dies.
    const mgr1 = mkMgr({ onChange: (s: TransferSession) => { mon.observe(s); void store.save(s.snapshot()); } });
    const t1 = new FakeTransport({ id: 'relay', cost: 30, budget: 23, failAfter: true, disk });
    mgr1.registerDriver(t1);
    const s1 = mkSession('Trow08');
    await mgr1.start(s1);
    await store.save(s1.snapshot());
    const before = s1.progressBytes();
    check(before > 0 && !s1.isComplete(), 'the first run made partial progress');

    // Session two: a brand-new process. Nothing is carried over but the row.
    const mgr2 = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    const t2 = new FakeTransport({ id: 'relay', cost: 30, disk });
    mgr2.registerDriver(t2);
    const recovered = await mgr2.recoverAll({ store, secretsFor: async () => ({ fileId: 'F', keyB64: 'k' }) });
    check(recovered.length === 1, 'the interrupted transfer was recovered');
    const s2 = recovered[0];
    check(s2.progressBytes() === before, 'it resumed at exactly the progress it had');
    const res = await mgr2.start(s2);
    check(res.state === 'complete', 'and ran to completion');
    check(t2.asked.every((c) => c >= 23), 'the second process re-transferred NOTHING already durable');
    assertInvariants(s2, disk, mon, [t1, t2]);
    console.log('    · device pass still required: a real process kill, and Row 9 across a cold boot');
  }

  // ── Row 10 ─────────────────────────────────────────────────────────
  row(10, 'Receiver offline for hours, then accepts', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s) });
    // Sender stages everything while the receiver is away. Staging is NOT
    // delivery, so the sender must not claim completion.
    const stager = new FakeTransport({ id: 'relay', cost: 30, channel: 'relay', stageOnly: true });
    const smgr = mkMgr();
    smgr.registerDriver(stager);
    const sender = mkSession('Trow10s', 'sender');
    const sres = await smgr.start(sender);
    check(sres.state === 'parked', 'a sender that only STAGED parks — it does not claim delivery');
    check(sender.progressBytes() === 0, 'staged bytes are not progress');
    check(sender.r2Have.popcount() === CHUNKS, 'but everything is on the relay');

    // Hours later the receiver accepts, and pulls what is staged.
    //
    // New ledger: invariant (b) is about ONE session's transports not repeating
    // each other's work. The sender staging to R2 and the receiver fetching from
    // it are two different sessions on two different devices, and the receiver
    // fetching what the sender staged is the transfer working, not a repeat.
    resetLedger();
    const recv = new FakeTransport({ id: 'relay', cost: 30, channel: 'relay', disk });
    mgr.registerDriver(recv);
    const s = mkSession('Trow10r');
    s.setR2Have(sender.r2Have);
    const res = await mgr.start(s);
    check(res.state === 'complete', 'the receiver completed from staged blocks alone');
    assertInvariants(s, disk, mon, [recv]);
    console.log('    · device pass still required: the 24 h relay-object expiry window');
  }

  // ── Row 11 ─────────────────────────────────────────────────────────
  row(11, '12 GB file: bitmap and memory stay bounded', 'partial');
  {
    const big = new TransferSession({
      transferId: 'Trow11', sessionVersion: 1, fileId: 'F', keyB64: 'k',
      role: 'recipient', totalBytes: 12 * 1024 ** 3,
    });
    check(big.chunkCount === Math.ceil((12 * 1024 ** 3) / CHUNK_BYTES), '12 GB maps to the expected chunk count');
    for (let i = 0; i < big.chunkCount; i += 2) big.markVerified(i);      // worst case for RLE
    const encoded = big.publishHave();
    check(encoded.length < 8192, `the worst-case bitmap encodes to ${encoded.length} bytes, not megabytes`);
    const round = ChunkBitmap.decode(encoded, big.chunkCount);
    check(round.popcount() === big.peerHave.popcount(), 'and it round-trips exactly');
    const { planWorkers, DEFAULT_BUDGET_BYTES } = require('./memory');
    const plan = planWorkers({ physicalUnitBytes: 4 * 1024 * 1024, cores: 8 });
    check(plan.projectedBytes <= DEFAULT_BUDGET_BYTES, 'and the worker plan stays inside the memory budget');
    console.log('    · device pass still required: real peak JS heap over a real 12 GB transfer');
  }

  // ── Row 12 ─────────────────────────────────────────────────────────
  row(12, 'Multiple simultaneous transfers: no cross-session bleed', 'automated');
  {
    const mgr = mkMgr({ concurrency: 2 });
    const disks = [mkDisk(), mkDisk(), mkDisk()];
    const sessions: TransferSession[] = [];
    const drivers: FakeTransport[] = [];
    for (let k = 0; k < 3; k++) {
      const s = mkSession(`Trow12_${k}`);
      const d = new FakeTransport({ id: 'relay', cost: 30, disk: disks[k] });
      // Per-transfer drivers: a process-wide registry served the wrong file once.
      mgr.setDriversFor(s.transferId, [d]);
      sessions.push(s); drivers.push(d);
    }
    await Promise.all(sessions.map((s) => mgr.start(s)));
    check(sessions.every((s) => s.isComplete()), 'all three transfers completed');
    for (let k = 0; k < 3; k++) {
      const ex = fileIsExact(disks[k]);
      check(ex.ok, `transfer ${k} landed its OWN bytes exactly${ex.ok ? '' : ' — ' + ex.why}`);
    }
    const ids = new Set(sessions.map((s) => s.transferId));
    check(ids.size === 3, 'three distinct sessions');
    check(mgr.activeCount() === 0, 'nothing left running');
  }

  // ── Row 13 ─────────────────────────────────────────────────────────
  row(13, 'Weak network + packet loss: per-chunk retry isolates failures', 'partial');
  {
    const disk = mkDisk();
    const mon = new ProgressMonitor();
    const mgr = mkMgr({ onChange: (s: TransferSession) => mon.observe(s), maxIdleRounds: 20 });
    // Loses one chunk in three, every round. The session must converge anyway,
    // because the work-list is re-derived from what actually landed.
    const lossy = new FakeTransport({ id: 'p2p', cost: 20, dropEvery: 3, disk });
    mgr.registerDriver(lossy);
    const s = mkSession('Trow13');
    const res = await mgr.start(s);
    check(res.state === 'complete', 'a lossy link still converges');
    check(lossy.runs > 1, `it took several rounds (${lossy.runs}) — the losses were real`);
    check(mon.droppedCount === 0, 'and progress never went backwards while retrying');
    const exact = fileIsExact(disk);
    check(exact.ok, `the file is byte-exact after loss + retry${exact.ok ? '' : ' — ' + exact.why}`);
    const red = noRedundantTransfer(disk);
    check(red.ok, `no chunk was written twice despite the retries (worst ${red.worst})`);
    console.log('    · device pass still required: the physical unit adapting down on a real link');
  }

  // ── Row 14 ─────────────────────────────────────────────────────────
  row(14, 'Old build ⇄ new build: a clean reject, never a corrupt decrypt', 'automated');
  {
    const { newPlan, appendSegment, SEGMENT_PLAN_V1, SEGMENT_PLAN_V2, idSchemeForPlan } = require('../vaultBeamSegments');
    const { blockChunkRun } = require('./blockMap');
    // A fresh plan has no segments — geometry is appended reactively — so grow
    // each one by a segment before asking it to address block 0.
    const v1 = appendSegment(newPlan(TOTAL, SEGMENT_PLAN_V1), 4 * 1024 * 1024);
    const v2 = appendSegment(newPlan(TOTAL, SEGMENT_PLAN_V2), 4 * 1024 * 1024);
    check(idSchemeForPlan(v1) === 'legacyOffset', 'a v1 plan declares the legacy id scheme');
    check(idSchemeForPlan(v2) === 'canonical', 'a v2 plan declares the canonical one');
    // The refusal that makes this a reject rather than a corrupt decrypt: the
    // canonical block map will not address a legacy plan at all.
    check(blockChunkRun(v1, 0, CHUNKS) === null, 'the canonical block map REFUSES a v1 plan (no silent reinterpretation)');
    check(blockChunkRun(v2, 0, CHUNKS) !== null, 'and addresses a v2 plan normally');
    console.log('    · device pass still required: a real old-build ⇄ new-build pair');
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`${checks} checks, ${failures} failed`);
  console.log('Automated here: rows 4, 6, 12, 14 in full; rows 1, 2, 3, 5, 8, 10, 11, 13 at the state-machine level.');
  console.log('DEVICE ONLY: row 7, row 9 (cold boot), and the radio/OEM half of every "partial" row.');
  console.log(failures === 0
    ? '\nMATRIX (state machine) PASSED ✓ — the on-device pass in tasks.md §8.2 is still required'
    : `\n✗ ${failures} MATRIX CHECK(S) FAILED`);
  if (failures) process.exit(1);
}

declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export default {};
