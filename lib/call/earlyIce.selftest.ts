// lib/call/earlyIce.selftest.ts — run: npx tsx lib/call/earlyIce.selftest.ts
//
// A callee's peer is created with plainCipher and only learns the real per-call
// key once openCallOffer() has finished a ratchet decrypt. The caller is already
// sending candidates by then, so they arrive sealed and unopenable. Dropping
// them leaves the callee with no route back to the caller — observed on coturn
// as 79 packets out, 0 in, and a call that fails with an empty log.
//
// Mirrors CallPeer.addRemoteIce / setCipher. Pure, so it runs in Node.

class IceGate {
  private cipher: { open(w: any): any } = { open: (w: any) => (w?.v === 'sig1f' ? null : w ?? null) };
  private undecrypted: any[] = [];
  added: any[] = [];
  dropped = 0;

  addRemoteIce(wire: any): void {
    if (!wire) return;
    const c = this.cipher.open(wire);
    if (!c) {
      if (wire?.v === 'sig1f' && this.undecrypted.length < 64) this.undecrypted.push(wire);
      else this.dropped++;
      return;
    }
    this.added.push(c);
  }
  setCipher(c: { open(w: any): any }): void {
    this.cipher = c;
    const queued = this.undecrypted;
    this.undecrypted = [];
    for (const w of queued) this.addRemoteIce(w);
  }
  get held(): number { return this.undecrypted.length; }
}

/** Stands in for the real per-call GCM cipher. */
const realCipher = { open: (w: any) => (w?.v === 'sig1f' ? { candidate: w.p } : w ?? null) };
const sealed = (p: string) => ({ v: 'sig1f', p });

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nEarly-ICE buffering (candidates that beat the call key)\n');

const g = new IceGate();

// ── the window: sealed candidates arrive before the key ────────────────
g.addRemoteIce(sealed('cand-1'));
g.addRemoteIce(sealed('cand-2'));
check('sealed candidates are not applied before the key', g.added.length === 0);
check('...and are not dropped either', g.dropped === 0);
check('they are held', g.held === 2);

// ── the key lands ──────────────────────────────────────────────────────
g.setCipher(realCipher);
check('every held candidate is applied once the key lands', g.added.length === 2);
check('the hold queue is emptied', g.held === 0);
check('candidates survive intact', g.added[0].candidate === 'cand-1' && g.added[1].candidate === 'cand-2');

// ── after the key, the normal path is direct ───────────────────────────
g.addRemoteIce(sealed('cand-3'));
check('later candidates apply immediately', g.added.length === 3);
check('nothing is held afterwards', g.held === 0);

// ── a legacy plaintext peer must still work ────────────────────────────
const g2 = new IceGate();
g2.addRemoteIce({ candidate: 'plain' });
check('plaintext candidates apply with no key at all', g2.added.length === 1 && g2.held === 0);

// ── junk must not be retried forever ───────────────────────────────────
const g3 = new IceGate();
g3.addRemoteIce(null);
check('null is ignored, not held', g3.held === 0 && g3.dropped === 0);

// A frame that is neither sealed nor a candidate opens to null via
// passthrough and is genuinely undeliverable — count it, do not queue it.
const g4 = new IceGate();
g4.setCipher({ open: () => null });
g4.addRemoteIce({ candidate: 'x' });
check('an unopenable non-sig1f frame is dropped, not queued', g4.dropped === 1 && g4.held === 0);

// ── the queue is bounded against a hostile peer ────────────────────────
const g5 = new IceGate();
for (let i = 0; i < 200; i++) g5.addRemoteIce(sealed(`flood-${i}`));
check('the hold queue is capped at 64', g5.held === 64);
check('the overflow is counted as dropped', g5.dropped === 136);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all early-ICE checks passed\n');
process.exit(failures ? 1 : 0);
