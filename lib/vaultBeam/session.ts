// lib/vaultBeam/session.ts — the transport-independent transfer session.
//
// One session per transfer, for the life of the transfer. It owns the identity,
// both bitmaps, the derived work-lists, and progress. Transports do not: a
// driver is handed a work-list and reports verified chunks back, and holds no
// counters of its own (design §3). That is what makes a transport switch a
// no-op on state — which is the whole fix.
//
// Design rules enforced here:
//   R1  bitmaps are session state; a driver may only APPEND via markVerified
//   R2  PeerHave is monotonic within a session version — nothing clears a bit
//   R3  a transport change does not touch state; the work-list is re-derived
//   R4  a failed driver is demoted, the session stays active
//   R5  terminal only on an empty work-list or an unrecoverable error
//
// Pure: no react-native / expo imports, so it runs under `npx tsx`.

import { ChunkBitmap, type ChunkRun, CHUNK_BYTES, chunkCountFor } from './bitmap';

export type TransferRole = 'sender' | 'recipient';
export type SessionState = 'active' | 'complete' | 'failed' | 'cancelled';

export interface SessionInit {
  transferId: string;
  sessionVersion: number;
  fileId: string;
  keyB64: string;
  role: TransferRole;
  totalBytes: number;
  name?: string;
}

/** Durable shape (op-sqlite row) — see design §6. */
export interface SessionSnapshot {
  transferId: string;
  sessionVersion: number;
  role: TransferRole;
  totalBytes: number;
  chunkCount: number;
  peerHave: string;        // tagged encoding
  r2Have: string;
  state: SessionState;
  lastTransport?: string;
  name?: string;
}

/** Build ascending, coalesced runs from a per-chunk predicate. */
function runsWhere(chunkCount: number, pred: (i: number) => boolean, maxRun: number): ChunkRun[] {
  const out: ChunkRun[] = [];
  let start = -1;
  for (let i = 0; i < chunkCount; i++) {
    if (pred(i)) {
      if (start < 0) start = i;
      if (i - start + 1 >= maxRun) { out.push({ start, count: i - start + 1 }); start = -1; }
    } else if (start >= 0) {
      out.push({ start, count: i - start });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start, count: chunkCount - start });
  return out;
}

export class TransferSession {
  readonly transferId: string;
  readonly fileId: string;
  readonly role: TransferRole;
  readonly totalBytes: number;
  readonly chunkCount: number;
  name?: string;

  /** Server-held monotonic version (design §7). */
  private _sessionVersion: number;
  /**
   * K_t. Not readonly, because a session-version bump REQUIRES a new one: the
   * nonce is `4B(transferId prefix) ‖ u64_be(chunkId)` and a version bump resets
   * the chunk grid to 0, so keeping K_t would re-seal different plaintext under
   * an already-used (key, nonce) pair. For AES-GCM that is not a weakening, it
   * is a total break — an attacker who sees both ciphertexts recovers the XOR of
   * the plaintexts and can forge tags for that key. Hence `adoptVersion` demands
   * fresh material and there is no setter that does not.
   */
  private _keyB64: string;
  /** Receiver-authoritative: GCM-verified + written + durable. */
  private _peerHave: ChunkBitmap;
  /** Server-authoritative: staged on R2. Rebuilt from the server mask, never mutated. */
  private _r2Have: ChunkBitmap;
  /** In memory ONLY — after a crash nothing is in flight, so persisting it would be a lie. */
  private readonly _inflight = new Set<number>();

  /**
   * DURABILITY WATERMARK (P0). Two holding tiers between "the bytes decrypted
   * and write() returned" and "PeerHave says we have it":
   *
   *   _written  — GCM-verified and written, but only as far as the page cache.
   *   _syncing  — handed to an in-flight fsync barrier; not yet promoted.
   *
   * Both are MEMORY ONLY and never persisted, for the same reason `_inflight`
   * is not: after a crash neither is true. A chunk that was in either tier is
   * simply re-fetched, which is the whole point — the alternative is a bitmap
   * bit claiming durability for bytes the power cut took, and a resume that
   * correctly skips them, leaving a silently corrupt file.
   *
   * Both tiers count as HELD, so a chunk waiting on a barrier is never handed
   * to a driver a second time.
   */
  private readonly _written = new Set<number>();
  private readonly _syncing = new Set<number>();

  private _state: SessionState = 'active';
  private _lastTransport?: string;
  /** Bumped on every state change so a caller can cheaply detect staleness. */
  private _revision = 0;

  constructor(init: SessionInit) {
    if (!(init.totalBytes > 0)) throw new Error('totalBytes must be positive');
    this.transferId = init.transferId;
    this._sessionVersion = init.sessionVersion;
    this.fileId = init.fileId;
    this._keyB64 = init.keyB64;
    this.role = init.role;
    this.totalBytes = init.totalBytes;
    this.name = init.name;
    this.chunkCount = chunkCountFor(init.totalBytes);
    this._peerHave = new ChunkBitmap(this.chunkCount);
    this._r2Have = new ChunkBitmap(this.chunkCount);
  }

  get keyB64(): string { return this._keyB64; }
  get sessionVersion(): number { return this._sessionVersion; }
  get state(): SessionState { return this._state; }
  get revision(): number { return this._revision; }
  get lastTransport(): string | undefined { return this._lastTransport; }
  get peerHave(): ChunkBitmap { return this._peerHave; }
  get r2Have(): ChunkBitmap { return this._r2Have; }
  get inflightCount(): number { return this._inflight.size; }
  /** Written but not yet handed to a barrier — the amount a barrier would take. */
  get pendingDurableCount(): number { return this._written.size; }
  /** Written + in-barrier: everything decrypted that PeerHave cannot yet claim. */
  get heldDurableCount(): number { return this._written.size + this._syncing.size; }

  /** A chunk a driver must not be handed again: in flight, or awaiting durability. */
  private held(i: number): boolean {
    return this._inflight.has(i) || this._written.has(i) || this._syncing.has(i);
  }

  // ── R1: the only way a driver mutates state ──────────────────────
  /** A chunk is verified: GCM tag ok, written at its offset, durable. */
  markVerified(chunk: number): boolean {
    const gained = this._peerHave.set(chunk);
    this._inflight.delete(chunk);
    this._written.delete(chunk);
    this._syncing.delete(chunk);
    if (gained) this._revision++;
    return gained;
  }

  // ── durability watermark: written → barrier → verified ───────────

  /**
   * GCM tag ok and write() returned — but the bytes are in the page cache, not
   * on stable storage. Explicitly NOT progress: nothing here reaches PeerHave
   * until a barrier says the storage layer has them.
   */
  markWritten(chunk: number): boolean {
    if (this._peerHave.test(chunk)) { this._inflight.delete(chunk); return false; }
    this._inflight.delete(chunk);
    if (this._written.has(chunk) || this._syncing.has(chunk)) return false;
    this._written.add(chunk);
    return true;
  }

  /**
   * Start a barrier: take everything written so far. Chunks written WHILE the
   * fsync runs are deliberately left behind — an fsync only promises the writes
   * that preceded it, so promoting a concurrent write on its completion would
   * be exactly the lie this tier exists to prevent.
   */
  beginDurable(): number[] {
    const ids = [...this._written];
    this._written.clear();
    for (const c of ids) this._syncing.add(c);
    return ids;
  }

  /** The barrier succeeded: these chunks are on stable storage. */
  commitDurable(ids: ReadonlyArray<number>): number {
    let gained = 0;
    for (const c of ids) {
      this._syncing.delete(c);
      if (this._peerHave.set(c)) gained++;
    }
    if (gained) this._revision++;
    return gained;
  }

  /** The barrier failed: not durable, so back to the work-list to be re-fetched. */
  releaseDurable(ids: ReadonlyArray<number>): void {
    for (const c of ids) this._syncing.delete(c);
  }

  /** Abandon every un-durable write (cancel, teardown). They are re-fetched. */
  dropDurable(): number {
    const n = this._written.size + this._syncing.size;
    this._written.clear();
    this._syncing.clear();
    return n;
  }

  markRunVerified(run: ChunkRun): number {
    let n = 0;
    for (let i = run.start; i < run.start + run.count; i++) if (this.markVerified(i)) n++;
    return n;
  }

  /** Union-only merge of a peer/server-published bitmap. Never replaces (R2). */
  mergePeerHave(other: ChunkBitmap | string): number {
    const bm = typeof other === 'string' ? ChunkBitmap.decode(other, this.chunkCount) : other;
    const gained = this._peerHave.union(bm);
    if (gained) this._revision++;
    return gained;
  }

  /**
   * Replace R2Have from the server's authoritative mask. This is a rebuild, not
   * a mutation: the relay may legitimately purge staged blocks (on completion),
   * and R2Have must be able to shrink. PeerHave is the monotonic one.
   */
  setR2Have(bm: ChunkBitmap): void {
    this._r2Have = bm.clone();
    this._revision++;
  }

  /**
   * A chunk is now STAGED on the relay. Distinct from verified: staging means
   * the relay holds the ciphertext, NOT that the peer has it. Conflating the two
   * is root cause RC-4 — `uploaded_mask` means "on R2" and was being used as the
   * completion oracle. Only `markVerified` may advance progress.
   */
  markStaged(chunk: number): boolean {
    const gained = this._r2Have.set(chunk);
    this._inflight.delete(chunk);
    if (gained) this._revision++;
    return gained;
  }

  markRunStaged(run: ChunkRun): number {
    let n = 0;
    for (let i = run.start; i < run.start + run.count; i++) if (this.markStaged(i)) n++;
    return n;
  }

  // ── in-flight bookkeeping (memory only) ──────────────────────────
  claim(runs: ReadonlyArray<ChunkRun>): void {
    for (const r of runs) for (let i = r.start; i < r.start + r.count; i++) this._inflight.add(i);
  }

  release(runs: ReadonlyArray<ChunkRun>): void {
    for (const r of runs) for (let i = r.start; i < r.start + r.count; i++) this._inflight.delete(i);
  }

  /** Abandon everything outstanding, including un-durable writes. Teardown only —
   *  `release(runs)` is the per-round call, and it must NOT discard a batch that
   *  is waiting on a barrier. */
  releaseAll(): void { this._inflight.clear(); this.dropDurable(); }

  // ── derived work-lists (design §4.3) ─────────────────────────────

  /** Everything still outstanding, regardless of transport. */
  pendingRuns(maxRun = Infinity): ChunkRun[] {
    return runsWhere(this.chunkCount, (i) => !this._peerHave.test(i) && !this.held(i), maxRun);
  }

  /** SENDER → relay: stage only what the peer lacks AND R2 does not already hold. */
  uploadWork(maxRun = Infinity): ChunkRun[] {
    return runsWhere(this.chunkCount,
      (i) => !this._peerHave.test(i) && !this._r2Have.test(i) && !this.held(i), maxRun);
  }

  /** Either side over a direct transport: everything the peer still lacks. */
  directWork(maxRun = Infinity): ChunkRun[] { return this.pendingRuns(maxRun); }

  /** RECIPIENT ← relay: only chunks that are actually staged can be fetched. */
  relayFetch(maxRun = Infinity): ChunkRun[] {
    return runsWhere(this.chunkCount,
      (i) => !this._peerHave.test(i) && this._r2Have.test(i) && !this.held(i), maxRun);
  }

  // ── progress: VERIFIED bytes only (design §4.3) ──────────────────
  progressBytes(): number { return this._peerHave.bytesCovered(this.totalBytes); }
  progressRatio(): number { return this.totalBytes > 0 ? this.progressBytes() / this.totalBytes : 0; }
  isComplete(): boolean { return this._peerHave.isFull(); }

  /** Tagged encoding for `vaultbeam_have` / `POST /relay/received`. */
  publishHave(): string { return this._peerHave.encode(); }

  // ── lifecycle ────────────────────────────────────────────────────
  noteTransport(id: string): void { this._lastTransport = id; this._revision++; }

  /** R5: terminal only when the work is genuinely done, or unrecoverably not. */
  finish(state: Exclude<SessionState, 'active'>): void {
    if (state === 'complete' && !this.isComplete()) {
      throw new Error('refusing to complete a session with outstanding chunks');
    }
    this._state = state;
    this._inflight.clear();
    // Un-durable writes die with the session: they were never progress, and a
    // terminal session has no barrier left to promote them.
    this.dropDurable();
    this._revision++;
  }

  /**
   * Adopt a NEWER server session version (design §7). This is the ONLY path that
   * drops PeerHave, and it is not a monotonicity violation: monotonicity holds
   * *within* a version, and a bumped version means the transfer was materially
   * reset (re-init, or a replaced source file), so the old bits describe a
   * different file layout and must not be carried forward.
   *
   * FRESH K_t IS MANDATORY (P0). Resetting the grid restarts chunk ids at 0,
   * which restarts the nonce sequence. Adopting under the old key would seal new
   * plaintext at nonces already used for different plaintext — a total AES-GCM
   * break, not a degradation. So the key is a required argument, and reusing the
   * current one throws rather than returning false: a caller that reaches here
   * without new material has a bug that must be loud, not silently ignored.
   */
  adoptVersion(version: number, keyB64: string): boolean {
    if (version <= this._sessionVersion) return false;
    if (!keyB64) {
      throw new Error('adoptVersion requires fresh key material — a version bump restarts the nonce sequence');
    }
    if (keyB64 === this._keyB64) {
      throw new Error('adoptVersion refused: K_t is unchanged, which would reuse (key, nonce) pairs');
    }
    this._sessionVersion = version;
    this._keyB64 = keyB64;
    this._peerHave = new ChunkBitmap(this.chunkCount);
    this._r2Have = new ChunkBitmap(this.chunkCount);
    this._inflight.clear();
    this.dropDurable();
    this._state = 'active';
    this._revision++;
    return true;
  }

  /** Is an incoming message from a live peer stale? */
  isStaleVersion(version: number): boolean { return version < this._sessionVersion; }

  // ── persistence ──────────────────────────────────────────────────
  snapshot(): SessionSnapshot {
    return {
      transferId: this.transferId,
      sessionVersion: this._sessionVersion,
      role: this.role,
      totalBytes: this.totalBytes,
      chunkCount: this.chunkCount,
      peerHave: this._peerHave.encode(),
      r2Have: this._r2Have.encode(),
      state: this._state,
      lastTransport: this._lastTransport,
      name: this.name,
    };
  }

  static restore(snap: SessionSnapshot, secrets: { fileId: string; keyB64: string }): TransferSession {
    const s = new TransferSession({
      transferId: snap.transferId, sessionVersion: snap.sessionVersion,
      fileId: secrets.fileId, keyB64: secrets.keyB64,
      role: snap.role, totalBytes: snap.totalBytes, name: snap.name,
    });
    s._peerHave = ChunkBitmap.decode(snap.peerHave, s.chunkCount);
    s._r2Have = ChunkBitmap.decode(snap.r2Have, s.chunkCount);
    s._state = snap.state;
    s._lastTransport = snap.lastTransport;
    return s;
  }
}

// ── self-check: `npx tsx lib/vaultBeam/session.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('session: ' + m); };
  const mk = (totalBytes = 10 * CHUNK_BYTES, role: TransferRole = 'sender') => new TransferSession({
    transferId: 'T1', sessionVersion: 1, fileId: 'F1', keyB64: 'k', role, totalBytes, name: 'f.bin',
  });

  // grid + initial state
  let s = mk();
  A(s.chunkCount === 10, '10 chunks');
  A(s.progressBytes() === 0 && !s.isComplete(), 'starts at zero');
  A(s.pendingRuns().length === 1 && s.pendingRuns()[0].count === 10, 'everything pending');

  // R1: markVerified is the only append path, and it is idempotent
  A(s.markVerified(0) === true, 'first verify gains a bit');
  A(s.markVerified(0) === false, 'verify is idempotent');
  A(s.progressBytes() === CHUNK_BYTES, 'progress counts verified bytes');

  // R2: PeerHave is monotonic — no API reduces it
  const beforeAll = s.peerHave.popcount();
  s.setR2Have(new ChunkBitmap(10));          // R2 purge
  s.mergePeerHave(new ChunkBitmap(10));      // empty merge
  s.releaseAll();
  s.noteTransport('relay');
  A(s.peerHave.popcount() === beforeAll, 'no operation reduces PeerHave');

  // progress is VERIFIED bytes — buffering/staging must not move it
  const staged = new ChunkBitmap(10);
  for (let i = 0; i < 10; i++) staged.set(i);
  s.setR2Have(staged);
  A(s.progressBytes() === CHUNK_BYTES, 'fully staged on R2 ≠ progress');
  s.claim([{ start: 1, count: 5 }]);
  A(s.progressBytes() === CHUNK_BYTES, 'in-flight chunks are not progress');
  s.releaseAll();

  // staging is NOT progress (RC-4): markStaged advances R2Have, never PeerHave
  const stg = mk();
  stg.markStaged(0); stg.markStaged(1);
  A(stg.r2Have.popcount() === 2, 'markStaged advances R2Have');
  A(stg.peerHave.popcount() === 0, 'markStaged does NOT advance PeerHave');
  A(stg.progressBytes() === 0, 'staged bytes are not progress');
  A(stg.uploadWork()[0].start === 2, 'staged chunks drop out of the upload work-list');
  A(!stg.isComplete(), 'a fully staged transfer is not complete until the peer verifies');

  // sender work excludes what is staged; receiver can only fetch what is staged
  A(s.uploadWork().length === 0, 'nothing to upload when everything is staged');
  A(s.relayFetch().length === 1 && s.relayFetch()[0].start === 1, 'receiver may fetch the staged remainder');

  // R3: a transport change is a no-op on state — same work-list before and after
  s = mk();
  s.markVerified(0); s.markVerified(1); s.markVerified(2);
  const beforeSwitch = JSON.stringify(s.pendingRuns());
  const progressBefore = s.progressBytes();
  s.noteTransport('p2p');
  s.releaseAll();                 // driver disposed
  s.noteTransport('relay');       // next driver adopted
  A(JSON.stringify(s.pendingRuns()) === beforeSwitch, 'work-list survives a transport change');
  A(s.progressBytes() === progressBefore, 'progress survives a transport change');
  A(s.peerHave.popcount() === 3, 'verified chunks survive a transport change');

  // THE headline case: the receiver verified everything, the final ack was lost.
  // Work-list must be empty, so the fallback transfers nothing.
  const done = mk();
  for (let i = 0; i < done.chunkCount; i++) done.markVerified(i);
  A(done.isComplete(), 'all chunks verified ⇒ complete');
  A(done.uploadWork().length === 0 && done.directWork().length === 0, 'a fully verified transfer has NO work');
  A(done.progressBytes() === done.totalBytes, 'progress equals the file size');

  // ascending order: the missing tail is offered before anything else
  const tail = mk();
  for (let i = 0; i < 7; i++) tail.markVerified(i);
  const work = tail.uploadWork();
  A(work[0].start === 7, 'work starts at the first MISSING chunk, not at zero');
  A(work.reduce((n, r) => n + r.count, 0) === 3, 'only the missing tail is work');

  // holes, which a scalar high-water mark could never express
  const holed = mk();
  holed.markVerified(0); holed.markVerified(1); holed.markVerified(5); holed.markVerified(9);
  A(JSON.stringify(holed.pendingRuns()) === JSON.stringify([{ start: 2, count: 3 }, { start: 6, count: 3 }]),
    'holes are expressed exactly');

  // maxRun slicing = the physical unit; identity/coverage must not change
  const sliced = holed.pendingRuns(2);
  A(sliced.every((r) => r.count <= 2), 'runs respect the physical unit cap');
  A(sliced.reduce((n, r) => n + r.count, 0) === holed.pendingRuns().reduce((n, r) => n + r.count, 0),
    'physical unit size does not change what is transferred');

  // merge is union-only and idempotent
  const m = mk();
  const peer = new ChunkBitmap(10); peer.set(3); peer.set(4);
  A(m.mergePeerHave(peer) === 2, 'merge gains two');
  A(m.mergePeerHave(peer) === 0, 'merge is idempotent');
  A(m.mergePeerHave(m.publishHave()) === 0, 'merging our own published mask is a no-op');
  const stale = new ChunkBitmap(10); stale.set(3);
  A(m.mergePeerHave(stale) === 0 && m.peerHave.popcount() === 2, 'a stale mask cannot clear a bit');

  // R5: cannot declare complete while work remains
  let threw = false;
  try { mk().finish('complete'); } catch { threw = true; }
  A(threw, 'refuses to complete with outstanding chunks');
  const ok = mk();
  for (let i = 0; i < ok.chunkCount; i++) ok.markVerified(i);
  ok.finish('complete');
  A(ok.state === 'complete', 'completes when the work-list is empty');

  // ── durability watermark (P0) ────────────────────────────────────
  {
    const d = mk(10 * CHUNK_BYTES, 'recipient');

    // a write is NOT progress
    A(d.markWritten(0) === true, 'first write is recorded');
    A(d.markWritten(0) === false, 'markWritten is idempotent');
    A(d.peerHave.popcount() === 0, 'a written chunk does NOT touch PeerHave');
    A(d.progressBytes() === 0, 'a written-but-unsynced chunk is not progress');
    A(!d.isComplete(), 'writes alone can never complete a session');
    A(d.pendingDurableCount === 1, 'the chunk is waiting on a barrier');

    // …and it is not offered to a driver again while it waits
    A(d.pendingRuns()[0].start === 1, 'a written chunk is held out of the work-list');
    A(d.relayFetch().length === 0 || d.relayFetch()[0].start !== 0, 'held chunks stay out of every work-list');

    // the barrier is what makes it progress
    const batch = d.beginDurable();
    A(batch.length === 1 && batch[0] === 0, 'the barrier takes the written batch');
    A(d.pendingDurableCount === 0 && d.heldDurableCount === 1, 'in-barrier chunks are still held');
    A(d.pendingRuns()[0].start === 1, 'an in-barrier chunk is still not re-offered');
    A(d.commitDurable(batch) === 1, 'commit promotes the batch');
    A(d.peerHave.popcount() === 1 && d.progressBytes() === CHUNK_BYTES, 'progress moves only after the barrier');
    A(d.heldDurableCount === 0, 'nothing is held after a commit');

    // a FAILED barrier must return the chunks to the work-list, never promote
    d.markWritten(1); d.markWritten(2);
    const failed = d.beginDurable();
    d.releaseDurable(failed);
    A(d.peerHave.popcount() === 1, 'a failed barrier promotes NOTHING');
    A(d.progressBytes() === CHUNK_BYTES, 'a failed barrier does not move progress');
    A(d.pendingRuns()[0].start === 1, 'released chunks are offered again');

    // writes DURING a barrier are not covered by it — an fsync only promises
    // what preceded it, so promoting a concurrent write would be the exact lie
    // this tier exists to prevent
    d.markWritten(1);
    const inflightBatch = d.beginDurable();
    d.markWritten(2);                       // arrives while the fsync is running
    A(d.commitDurable(inflightBatch) === 1, 'only the taken batch is promoted');
    A(!d.peerHave.test(2), 'a write that raced the barrier is NOT promoted by it');
    A(d.pendingDurableCount === 1, 'the racing write waits for the next barrier');

    // markVerified still works and supersedes the tiers (sender path / peer ack)
    d.markVerified(2);
    A(d.peerHave.test(2) && d.pendingDurableCount === 0, 'markVerified clears the durability tiers');

    // crash semantics: un-durable writes are NEVER persisted, so they come back
    const crash = mk(10 * CHUNK_BYTES, 'recipient');
    crash.markVerified(0);
    crash.markWritten(1); crash.markWritten(2);
    const revived = TransferSession.restore(crash.snapshot(), { fileId: 'F1', keyB64: 'k' });
    A(revived.peerHave.popcount() === 1, 'only durable chunks survive a crash');
    A(revived.pendingRuns()[0].start === 1, 'un-synced writes are re-fetched after a crash');
    A(revived.heldDurableCount === 0, 'nothing is held after a restart');

    // terminal + teardown abandon un-durable writes
    const cx = mk(10 * CHUNK_BYTES, 'recipient');
    cx.markWritten(0); cx.markWritten(1);
    cx.finish('cancelled');
    A(cx.heldDurableCount === 0, 'cancel abandons un-durable writes');
    A(cx.peerHave.popcount() === 0, 'cancel does not promote them on the way out');
  }

  // session versioning (design §7)
  const v = mk();
  v.markVerified(0); v.markVerified(1);
  A(v.isStaleVersion(0) === true, 'older version is stale');
  A(v.isStaleVersion(1) === false, 'equal version is current');
  A(v.adoptVersion(1, 'k2') === false, 'adopting the same version is a no-op');
  A(v.peerHave.popcount() === 2, 'a no-op adopt keeps state');
  A(v.keyB64 === 'k', 'a no-op adopt does not swap the key');
  A(v.adoptVersion(2, 'k2') === true, 'adopts a newer version with fresh key material');
  A(v.peerHave.popcount() === 0, 'a version bump resets state (different file layout)');
  A(v.sessionVersion === 2 && v.state === 'active', 'version adopted, session re-armed');
  A(v.keyB64 === 'k2', 'the session now seals under the NEW K_t');

  // ── fresh K_t is MANDATORY on a version bump (P0) ────────────────
  // A bump restarts chunk ids at 0, and the nonce is derived from the chunk id.
  // Adopting under the old key would re-use (key, nonce) pairs, which is a total
  // AES-GCM break — so this must throw, loudly, not fail soft.
  {
    const reuse = mk();
    reuse.markVerified(0);
    let threwSame = false;
    try { reuse.adoptVersion(2, 'k'); } catch { threwSame = true; }
    A(threwSame, 'adopting a new version under the SAME K_t throws');
    A(reuse.sessionVersion === 1, 'the refused adopt changed nothing');
    A(reuse.peerHave.popcount() === 1, 'the refused adopt did not drop progress');

    let threwEmpty = false;
    try { reuse.adoptVersion(2, ''); } catch { threwEmpty = true; }
    A(threwEmpty, 'adopting with no key material throws');
    A(reuse.sessionVersion === 1, 'the refused adopt changed nothing');

    // and the bump abandons un-durable writes too — they belong to the old grid
    const dv = mk(10 * CHUNK_BYTES, 'recipient');
    dv.markWritten(3);
    dv.adoptVersion(2, 'k-new');
    A(dv.heldDurableCount === 0, 'a version bump abandons writes from the old grid');
  }

  // partial tail chunk accounting
  const odd = new TransferSession({
    transferId: 'T2', sessionVersion: 1, fileId: 'F', keyB64: 'k', role: 'recipient',
    totalBytes: 2 * CHUNK_BYTES + 123,
  });
  A(odd.chunkCount === 3, 'partial tail adds a chunk');
  odd.markVerified(2);
  A(odd.progressBytes() === 123, 'tail chunk counts its real length');
  odd.markVerified(0); odd.markVerified(1);
  A(odd.progressBytes() === odd.totalBytes && odd.isComplete(), 'exact total on completion');

  // persistence round-trip
  const snapSrc = mk(10 * CHUNK_BYTES, 'recipient');
  snapSrc.markVerified(0); snapSrc.markVerified(7); snapSrc.noteTransport('lan');
  const restored = TransferSession.restore(snapSrc.snapshot(), { fileId: 'F1', keyB64: 'k' });
  A(restored.peerHave.popcount() === 2, 'snapshot restores PeerHave');
  A(restored.lastTransport === 'lan', 'snapshot restores the last transport');
  A(restored.sessionVersion === snapSrc.sessionVersion, 'snapshot restores the version');
  A(JSON.stringify(restored.pendingRuns()) === JSON.stringify(snapSrc.pendingRuns()), 'restored work-list matches');
  A(restored.inflightCount === 0, 'in-flight is never restored — nothing is in flight after a crash');

  console.log('vaultBeam/session self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
