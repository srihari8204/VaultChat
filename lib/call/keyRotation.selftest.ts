// lib/call/keyRotation.selftest.ts
// run: npx tsx lib/call/keyRotation.selftest.ts
//
// A call's key can change WHILE frames sealed with the previous one are in
// flight. Re-sealing mid-ring mints a new call key, but the peer may already
// have opened the ORIGINAL offer and replied under the old key — that reply
// arrives after the changeover. Measured on device one second apart:
//
//   21:17:51  session re-keyed mid-ring — re-sealed the offer
//   21:17:52  could NOT open answer — call key mismatch
//
// Losing the answer means no remote description, so every candidate that
// follows is buffered forever and the call never connects. Keeping a couple of
// superseded keys makes the changeover lossless in both directions.
//
// Mirrors CallPeer.openAny / setCipher. Pure, runs in Node.

type Cipher = { enc: boolean; seal(o: any): any; open(w: any): any };

/** A key that only opens what it sealed. */
const keyed = (id: string): Cipher => ({
  enc: true,
  seal: (o: any) => ({ v: 'sig1f', k: id, p: JSON.stringify(o) }),
  open: (w: any) => (w?.v === 'sig1f' && w.k === id ? JSON.parse(w.p) : null),
});

const plain: Cipher = {
  enc: false,
  seal: (o: any) => o,
  open: (w: any) => (w?.v === 'sig1f' ? null : w ?? null),
};

class Peer {
  cipher: Cipher = plain;
  stale: Cipher[] = [];

  setCipher(c: Cipher): void {
    if (c !== this.cipher && this.cipher.enc) {
      this.stale.unshift(this.cipher);
      if (this.stale.length > 2) this.stale.pop();
    }
    this.cipher = c;
  }
  openAny(wire: any): any {
    const o = this.cipher.open(wire);
    if (o != null) return o;
    for (const s of this.stale) {
      const alt = s.open(wire);
      if (alt != null) return alt;
    }
    return null;
  }
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nCall-key rotation mid-call\n');

const K1 = keyed('K1'), K2 = keyed('K2'), K3 = keyed('K3');

// ── the device bug ────────────────────────────────────────────────────
const p = new Peer();
p.setCipher(K1);
const answerUnderK1 = K1.seal({ type: 'answer', sdp: 'A' });   // peer replies to the FIRST offer
p.setCipher(K2);                                               // ...we re-seal mid-ring
check('an in-flight answer under the OLD key still opens', p.openAny(answerUnderK1)?.type === 'answer');
check('...with its content intact', p.openAny(answerUnderK1).sdp === 'A');

// ── the current key obviously still works ─────────────────────────────
check('the current key opens its own frames', p.openAny(K2.seal({ type: 'answer' }))?.type === 'answer');

// ── candidates sealed under the old key too ───────────────────────────
check('an old-key ICE candidate opens',
  p.openAny(K1.seal({ candidate: 'c1' }))?.candidate === 'c1');

// ── two rotations: the oldest is still reachable ──────────────────────
p.setCipher(K3);
check('after two rotations, K2 frames open', p.openAny(K2.seal({ candidate: 'c2' }))?.candidate === 'c2');
check('...and K1 frames still open', p.openAny(K1.seal({ candidate: 'c3' }))?.candidate === 'c3');

// ── the history is bounded ────────────────────────────────────────────
const q = new Peer();
for (const k of ['a','b','c','d','e','f']) q.setCipher(keyed(k));
check('superseded keys are capped at 2', q.stale.length === 2);

// ── a foreign frame is still rejected ─────────────────────────────────
const foreign = keyed('OTHER-CALL').seal({ type: 'answer' });
check('a frame from another call does NOT open', p.openAny(foreign) === null);

// ── no spurious rotation ──────────────────────────────────────────────
const r = new Peer();
r.setCipher(K1); r.setCipher(K1);
check('setting the same key twice keeps no stale copy', r.stale.length === 0);

// ── legacy plaintext peer is unaffected ───────────────────────────────
const l = new Peer();
check('plaintext frames pass through with no key', l.openAny({ type: 'answer' })?.type === 'answer');
l.setCipher(K1);
check('...and plainCipher is never retained as stale', l.stale.length === 0);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all key-rotation checks passed\n');
process.exit(failures ? 1 : 0);
