// lib/call/reseal.selftest.ts — run: npx tsx lib/call/reseal.selftest.ts
//
// The ring loop re-sends its offer every 3s for up to 27s. It used to capture
// the SEALED wire once, so when the callee could not open it — reset its
// session and asked us to re-key — all nine repeats carried the same rejected
// envelope. On device:
//
//   18:46:52  FORCED re-key — reset session          (the heal worked)
//   18:47:26  openCallOffer failed — invalid ghash tag
//   18:47:28  openCallOffer failed — invalid ghash tag
//   18:47:36  openCallOffer failed — invalid ghash tag
//   18:47:56  openCallOffer failed — invalid ghash tag
//
// The only recourse was to hang up and redial. Re-sealing must happen when the
// session epoch moves — and ONLY then, because callCrypto's design depends on
// one ratchet wrap per call, not one per ring.
//
// Mirrors ringAndOffer + the reseal closure in startOutgoing. Pure, runs in Node.

let epoch = 0;
const bump = () => { epoch++; };

/** Mirrors the reseal closure: async re-seal, delivered on the NEXT tick. */
class Resealer {
  sealedAt = epoch;
  wraps = 0;                       // ratchet wraps performed
  private pending: any = null;
  private busy = false;

  /** The synchronous hook ringAndOffer calls each tick. */
  hook(): any | null {
    const w = this.pending;
    this.pending = null;
    if (w) return w;
    if (this.busy) return null;
    if (epoch === this.sealedAt) return null;
    this.sealedAt = epoch;
    this.busy = true;
    return null;                   // this tick sends the old wire; next carries the new
  }
  /** Stands in for newCallCipher resolving. */
  completeReseal(wire: any): void { this.pending = wire; this.wraps++; this.busy = false; }
}

/** Mirrors ringAndOffer's emit loop. */
function ring(r: Resealer, initial: any, ticks: number, onTick?: (i: number) => void): any[] {
  const sent = [initial];
  let offer = initial;
  for (let i = 0; i < ticks; i++) {
    onTick?.(i);
    const fresh = r.hook();
    if (fresh) offer = fresh;
    sent.push(offer);
  }
  return sent;
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nRing-loop re-seal on session re-key\n');

// ── unchanged session: byte-identical repeats, one wrap ────────────────
epoch = 0;
const a = new Resealer();
const sentA = ring(a, 'WIRE-1', 5);
check('an unchanged session re-sends the identical wire', sentA.every(w => w === 'WIRE-1'));
check('...and performs NO extra ratchet wraps', a.wraps === 0);

// ── the device bug: re-key lands mid-ring ──────────────────────────────
epoch = 0;
const b = new Resealer();
const sentB = ring(b, 'WIRE-1', 6, i => {
  if (i === 1) bump();                       // callee reset our session
  if (i === 2) b.completeReseal('WIRE-2');   // newCallCipher resolved
});
check('the stale wire stops being sent after the re-key', sentB.slice(4).every(w => w === 'WIRE-2'));
check('a fresh wire IS eventually sent', sentB.includes('WIRE-2'));
check('exactly one re-seal happened', b.wraps === 1);

// ── one wrap per re-key, not one per ring ──────────────────────────────
epoch = 0;
const c = new Resealer();
ring(c, 'WIRE-1', 9, i => {
  if (i === 0) bump();
  if (i === 1) c.completeReseal('WIRE-2');
});
check('a single re-key causes a single re-wrap', c.wraps === 1);

// ── two separate re-keys → two re-seals ────────────────────────────────
epoch = 0;
const d = new Resealer();
ring(d, 'WIRE-1', 9, i => {
  if (i === 0) bump();
  if (i === 1) d.completeReseal('WIRE-2');
  if (i === 4) bump();
  if (i === 5) d.completeReseal('WIRE-3');
});
check('a second re-key re-seals again', d.wraps === 2);

// ── a slow re-seal must not queue duplicates ───────────────────────────
epoch = 0;
const e = new Resealer();
ring(e, 'WIRE-1', 6, i => {
  if (i === 0) bump();
  if (i === 2) bump();          // another bump while still in flight
  if (i === 4) e.completeReseal('WIRE-2');
});
check('overlapping re-keys do not stack up wraps', e.wraps === 1);

// ── plaintext (legacy peer) path is untouched ──────────────────────────
epoch = 0;
const f = new Resealer();
const sentF = ring(f, 'PLAIN', 4);
check('a legacy plaintext call re-sends unchanged', sentF.every(w => w === 'PLAIN') && f.wraps === 0);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all re-seal checks passed\n');
process.exit(failures ? 1 : 0);
