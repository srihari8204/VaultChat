// lib/vaultBeam/bitmap.ts — the chunk bitmap, VaultBeam's unit of truth.
//
// One bit per CANONICAL LOGICAL CHUNK (512 KiB). Because a chunk's identity is
// its global logical index on every transport (see vaultBeamSegments v2), one
// bitmap is meaningful across LAN, P2P and the R2 relay — which is the whole
// reason a transport switch no longer restarts a transfer.
//
// Size is bounded by construction: 12 GiB / 512 KiB = 24 576 chunks = 3 072 B.
//
// DELIBERATELY NO `clear()`. `PeerHave` must be monotonic (design rule R2) — no
// code path may unset a verified chunk, or a transport switch could move the
// progress bar backwards. `R2Have` is not mutated either; it is rebuilt from the
// server's mask on each poll, so a server-side purge is expressed as a fresh
// bitmap rather than as bits being taken away.
//
// Pure: no react-native / expo imports, so it runs under `npx tsx`.

/** A contiguous run of logical chunks — the shape a transport batches on. */
export interface ChunkRun { start: number; count: number }

const CHUNK_BYTES = 512 * 1024;

export class ChunkBitmap {
  readonly chunkCount: number;
  private readonly bytes: Uint8Array;
  private _popcount = 0;

  constructor(chunkCount: number, bytes?: Uint8Array) {
    if (!Number.isInteger(chunkCount) || chunkCount < 0) throw new Error('chunkCount must be a non-negative integer');
    this.chunkCount = chunkCount;
    const width = (chunkCount + 7) >> 3;
    this.bytes = new Uint8Array(width);
    if (bytes) {
      this.bytes.set(bytes.subarray(0, width));
      this.maskTail();
      this._popcount = this.recount();
    }
  }

  /** Zero any bits past chunkCount so a wide input can't inflate popcount. */
  private maskTail(): void {
    const rem = this.chunkCount & 7;
    if (rem !== 0 && this.bytes.length > 0) this.bytes[this.bytes.length - 1] &= (1 << rem) - 1;
  }

  private recount(): number {
    let c = 0;
    for (let i = 0; i < this.bytes.length; i++) {
      let b = this.bytes[i];
      while (b) { b &= b - 1; c++; }
    }
    return c;
  }

  test(i: number): boolean {
    if (i < 0 || i >= this.chunkCount) return false;
    return ((this.bytes[i >> 3] >> (i & 7)) & 1) === 1;
  }

  /** Set bit i. Returns true if it was newly set (idempotent otherwise). */
  set(i: number): boolean {
    if (i < 0 || i >= this.chunkCount) return false;
    const idx = i >> 3, bit = 1 << (i & 7);
    if ((this.bytes[idx] & bit) !== 0) return false;
    this.bytes[idx] |= bit;
    this._popcount++;
    return true;
  }

  setRun(run: ChunkRun): number {
    let n = 0;
    for (let i = run.start; i < run.start + run.count; i++) if (this.set(i)) n++;
    return n;
  }

  popcount(): number { return this._popcount; }
  isFull(): boolean { return this._popcount >= this.chunkCount; }
  isEmpty(): boolean { return this._popcount === 0; }

  /** In-place union (merge rule: union-only, never replace). Returns bits gained. */
  union(other: ChunkBitmap): number {
    const n = Math.min(this.bytes.length, other.bytes.length);
    let gained = 0;
    for (let i = 0; i < n; i++) {
      const add = other.bytes[i] & ~this.bytes[i];
      if (add === 0) continue;
      this.bytes[i] |= add;
      let b = add;
      while (b) { b &= b - 1; gained++; }
    }
    this.maskTail();
    this._popcount += gained;
    return gained;
  }

  clone(): ChunkBitmap { return new ChunkBitmap(this.chunkCount, this.bytes); }

  /**
   * Runs of chunks that are set in NONE of `exclude` and not set here.
   * This is the work-list primitive: `work = ¬PeerHave ∧ ¬R2Have ∧ ¬inflight`,
   * emitted in ascending order and coalesced into contiguous runs.
   *
   * `maxRun` caps a run's length so a caller can batch at its transport's
   * physical unit without post-splitting.
   */
  missingRuns(exclude: ReadonlyArray<ChunkBitmap | ReadonlySet<number>> = [], maxRun = Infinity): ChunkRun[] {
    const out: ChunkRun[] = [];
    const held = (i: number): boolean => {
      if (this.test(i)) return true;
      for (const e of exclude) {
        if (e instanceof ChunkBitmap ? e.test(i) : e.has(i)) return true;
      }
      return false;
    };
    let start = -1;
    for (let i = 0; i < this.chunkCount; i++) {
      if (!held(i)) {
        if (start < 0) start = i;
        if (i - start + 1 >= maxRun) { out.push({ start, count: i - start + 1 }); start = -1; }
      } else if (start >= 0) {
        out.push({ start, count: i - start });
        start = -1;
      }
    }
    if (start >= 0) out.push({ start, count: this.chunkCount - start });
    return out;
  }

  /** Runs of chunks set here (the inverse view — used for publishing/debug). */
  setRuns(): ChunkRun[] {
    const out: ChunkRun[] = [];
    let start = -1;
    for (let i = 0; i < this.chunkCount; i++) {
      if (this.test(i)) { if (start < 0) start = i; }
      else if (start >= 0) { out.push({ start, count: i - start }); start = -1; }
    }
    if (start >= 0) out.push({ start, count: this.chunkCount - start });
    return out;
  }

  /**
   * Plaintext bytes covered by the set bits. Every chunk is CHUNK_BYTES except
   * possibly the last, so this is exact without iterating.
   */
  bytesCovered(totalBytes: number): number {
    if (this._popcount === 0) return 0;
    const last = this.chunkCount - 1;
    const lastLen = totalBytes - last * CHUNK_BYTES;
    const full = this.test(last) ? this._popcount - 1 : this._popcount;
    const tail = this.test(last) ? Math.max(0, Math.min(CHUNK_BYTES, lastLen)) : 0;
    return Math.min(totalBytes, full * CHUNK_BYTES + tail);
  }

  // ── serialization ────────────────────────────────────────────────
  // Two encodings; `encode()` picks the smaller and tags it. A resume bitmap is
  // usually a contiguous prefix, where RLE is dramatically smaller than raw —
  // but RLE is worse in the pathological alternating case, so we never force it.

  toBase64(): string {
    let bin = '';
    for (let i = 0; i < this.bytes.length; i++) bin += String.fromCharCode(this.bytes[i]);
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(this.bytes).toString('base64');
  }

  static fromBase64(b64: string, chunkCount: number): ChunkBitmap {
    if (!b64) return new ChunkBitmap(chunkCount);
    let raw: Uint8Array;
    try {
      if (typeof atob === 'function') {
        const bin = atob(b64);
        raw = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
      } else {
        raw = new Uint8Array(Buffer.from(b64, 'base64'));
      }
    } catch { return new ChunkBitmap(chunkCount); }
    return new ChunkBitmap(chunkCount, raw);
  }

  /** Alternating run lengths, starting with the count of UNSET bits. */
  toRLE(): string {
    const runs: number[] = [];
    let i = 0, want = false;
    while (i < this.chunkCount) {
      let n = 0;
      while (i < this.chunkCount && this.test(i) === want) { n++; i++; }
      runs.push(n);
      want = !want;
    }
    return runs.join('.');
  }

  static fromRLE(s: string, chunkCount: number): ChunkBitmap {
    const bm = new ChunkBitmap(chunkCount);
    if (!s) return bm;
    let i = 0, isSet = false;
    for (const part of s.split('.')) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0) return new ChunkBitmap(chunkCount); // malformed → empty, never partial
      if (isSet) for (let k = 0; k < n && i + k < chunkCount; k++) bm.set(i + k);
      i += n;
      isSet = !isSet;
    }
    return bm;
  }

  /** Tagged, self-describing, smallest-of-two encoding for the wire. */
  encode(): string {
    const rle = 'r:' + this.toRLE();
    const raw = 'b:' + this.toBase64();
    return rle.length <= raw.length ? rle : raw;
  }

  static decode(s: string, chunkCount: number): ChunkBitmap {
    if (!s) return new ChunkBitmap(chunkCount);
    if (s.startsWith('r:')) return ChunkBitmap.fromRLE(s.slice(2), chunkCount);
    if (s.startsWith('b:')) return ChunkBitmap.fromBase64(s.slice(2), chunkCount);
    return ChunkBitmap.fromBase64(s, chunkCount); // untagged legacy = raw
  }
}

export const chunkCountFor = (totalBytes: number): number => Math.ceil(totalBytes / CHUNK_BYTES);
export const runLength = (runs: ReadonlyArray<ChunkRun>): number => runs.reduce((n, r) => n + r.count, 0);
export { CHUNK_BYTES };

// ── self-check: `npx tsx lib/vaultBeam/bitmap.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('bitmap: ' + m); };

  // basic set/test/popcount + idempotence
  const b = new ChunkBitmap(20);
  A(b.isEmpty() && b.popcount() === 0, 'starts empty');
  A(b.set(3) === true, 'set returns true when newly set');
  A(b.set(3) === false, 'set is idempotent');
  A(b.test(3) && !b.test(4), 'test reads back');
  A(b.popcount() === 1, 'popcount tracks');
  A(b.set(-1) === false && b.set(20) === false, 'out-of-range set is a no-op');
  A(b.test(-1) === false && b.test(999) === false, 'out-of-range test is false');

  // tail masking: a wide input must not inflate popcount past chunkCount
  const wide = new ChunkBitmap(4, new Uint8Array([0xff]));
  A(wide.popcount() === 4, 'bits past chunkCount are masked off');
  A(wide.isFull(), 'masked bitmap reports full');

  // union is monotone + returns bits gained
  const x = new ChunkBitmap(16), y = new ChunkBitmap(16);
  x.set(0); x.set(1);
  y.set(1); y.set(2);
  A(x.union(y) === 1, 'union returns newly gained bits only');
  A(x.popcount() === 3, 'union merged');
  A(x.union(y) === 0, 'union is idempotent');
  // union can never REMOVE a bit — the monotonicity guarantee (design rule R2)
  const before = x.popcount();
  x.union(new ChunkBitmap(16));
  A(x.popcount() === before, 'union with empty keeps every bit');

  // missingRuns: coalescing, exclusion, ascending order, maxRun capping
  const m = new ChunkBitmap(10);
  m.set(0); m.set(1); m.set(5);
  const runs = m.missingRuns();
  A(JSON.stringify(runs) === JSON.stringify([{ start: 2, count: 3 }, { start: 6, count: 4 }]), 'missingRuns coalesces');
  const excl = new ChunkBitmap(10); excl.set(2); excl.set(3);
  A(JSON.stringify(m.missingRuns([excl])) === JSON.stringify([{ start: 4, count: 1 }, { start: 6, count: 4 }]),
    'missingRuns honours an excluding bitmap');
  A(JSON.stringify(m.missingRuns([new Set([6, 7, 8, 9])])) === JSON.stringify([{ start: 2, count: 3 }]),
    'missingRuns honours an excluding Set (inflight)');
  const capped = m.missingRuns([], 2);
  A(capped.every((r) => r.count <= 2), 'maxRun caps run length');
  A(runLength(capped) === runLength(runs), 'capping preserves total coverage');
  A(runLength(m.missingRuns()) === 10 - m.popcount(), 'missing + set == chunkCount');

  // full bitmap has no missing runs — the terminal condition
  const full = new ChunkBitmap(5);
  for (let i = 0; i < 5; i++) full.set(i);
  A(full.missingRuns().length === 0 && full.isFull(), 'full bitmap has no work');

  // bytesCovered: exact tail handling
  const total = 3 * CHUNK_BYTES + 1000;      // 4 chunks, last is 1000 B
  const cov = new ChunkBitmap(4);
  cov.set(0);
  A(cov.bytesCovered(total) === CHUNK_BYTES, 'one full chunk');
  cov.set(3);
  A(cov.bytesCovered(total) === CHUNK_BYTES + 1000, 'partial tail chunk counts its real length');
  cov.set(1); cov.set(2);
  A(cov.bytesCovered(total) === total, 'full bitmap covers exactly totalBytes');
  A(new ChunkBitmap(4).bytesCovered(total) === 0, 'empty covers nothing');

  // round-trips
  const r = new ChunkBitmap(100);
  for (const i of [0, 1, 2, 3, 40, 41, 99]) r.set(i);
  A(ChunkBitmap.fromBase64(r.toBase64(), 100).popcount() === r.popcount(), 'base64 round-trips');
  A(ChunkBitmap.fromRLE(r.toRLE(), 100).toRLE() === r.toRLE(), 'RLE round-trips');
  A(ChunkBitmap.decode(r.encode(), 100).toRLE() === r.toRLE(), 'tagged encode round-trips');
  for (const i of [0, 1, 2, 3, 40, 41, 99]) A(ChunkBitmap.decode(r.encode(), 100).test(i), 'decoded bit preserved @' + i);

  // a contiguous prefix — the common resume shape — must RLE far smaller than raw
  const prefix = new ChunkBitmap(24576);
  for (let i = 0; i < 20000; i++) prefix.set(i);
  A(prefix.encode().startsWith('r:'), 'prefix bitmap encodes as RLE');
  A(prefix.encode().length < 20, 'prefix RLE is tiny');
  A(ChunkBitmap.decode(prefix.encode(), 24576).popcount() === 20000, 'large prefix round-trips');

  // 12 GiB cap: the size claim in the design
  const cap = new ChunkBitmap(chunkCountFor(12 * 1024 ** 3));
  A(cap.chunkCount === 24576, '12 GiB → 24 576 chunks');
  A(ChunkBitmap.fromBase64(cap.toBase64(), cap.chunkCount).chunkCount === 24576, 'cap bitmap round-trips');
  A(cap.toBase64().length < 4200, 'raw encoding stays ~3 KB');

  // malformed input degrades to empty, never to a wrong partial state
  A(ChunkBitmap.fromRLE('1.x.3', 10).popcount() === 0, 'malformed RLE → empty');
  A(ChunkBitmap.fromBase64('!!!not base64!!!', 10).popcount() >= 0, 'malformed base64 does not throw');
  A(ChunkBitmap.decode('', 10).popcount() === 0, 'empty decode → empty');

  // zero-length transfer is representable and immediately full
  A(new ChunkBitmap(0).isFull(), 'zero chunks is trivially full');

  console.log('vaultBeam/bitmap self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
