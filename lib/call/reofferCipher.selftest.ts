// lib/call/reofferCipher.selftest.ts
// run: npx tsx lib/call/reofferCipher.selftest.ts
//
// WHICH cipher opens an incoming offer. Two wire shapes arrive on the same
// handler and they are NOT interchangeable:
//
//   sig1   ratchet envelope — STARTS a call, carries the wrapped call key.
//          Opened by openCallOffer(), which derives the call cipher from it.
//   sig1f  frame sealed with the call cipher already in use — a RE-offer
//          (ICE restart). There is no key to derive; the call key does not
//          change across an ICE restart.
//
// Running a sig1f through openCallOffer() looked harmless: it does not throw,
// it falls through to the legacy-plaintext path and returns `passthrough`.
// Assigning that DESTROYED the live call cipher, after which nothing sealed
// could be opened again. Measured on device during a Wi-Fi→mobile handover:
//
//   20:04:58  disconnected → sending ICE-restart offer
//   20:04:59  gathered {"host":2,"srflx":2,"relay":4}     candidates were fine
//   20:05:06  re-opening 12 early candidates
//   20:05:10  re-opening 12 early candidates              ...forever, silent call
//
// Mirrors onMeshOffer's re-offer branch. Pure, runs in Node.

/** Stands in for the per-call GCM cipher. */
const callCipher = {
  enc: true,
  seal: (o: any) => ({ v: 'sig1f', p: JSON.stringify(o) }),
  open: (w: any) => (w?.v === 'sig1f' ? JSON.parse(w.p) : w ?? null),
};

/** Stands in for plainCipher: sig1f is opaque to it. */
const passthrough = {
  enc: false,
  seal: (o: any) => o,
  open: (w: any) => (w?.v === 'sig1f' ? null : w ?? null),
};

/** Mirrors openCallOffer's dispatch on the wire tag. */
function openCallOffer(wire: any): { cipher: any; offer: any } {
  if (!wire || typeof wire !== 'object' || wire.v !== 'sig1') {
    return { cipher: passthrough, offer: wire ?? null };   // legacy plaintext path
  }
  return { cipher: callCipher, offer: callCipher.open(wire.p) };
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nRe-offer cipher handling\n');

const sdp = { type: 'offer', sdp: 'v=0 ice-ufrag:NEW' };
const reoffer = callCipher.seal(sdp);          // what renegotiate() sends

// ── the bug ───────────────────────────────────────────────────────────
const wrong = openCallOffer(reoffer);
check('openCallOffer does NOT throw on a re-offer (why it went unnoticed)', wrong.offer !== undefined);
check('...it returns the passthrough cipher', wrong.cipher.enc === false);
check('...and an object with no .type, so the re-offer is dropped', !wrong.offer?.type);
check('adopting that cipher makes sealed frames unopenable',
  wrong.cipher.open(callCipher.seal({ candidate: 'x' })) === null);

// ── the fix ───────────────────────────────────────────────────────────
const right = callCipher.open(reoffer);
check('the CALL cipher opens the re-offer', right?.type === 'offer');
check('...preserving the SDP exactly', right.sdp === sdp.sdp);

// ── the call cipher must survive a re-offer ───────────────────────────
let live: any = callCipher;
const applied = live.open(reoffer);            // fix: open, never reassign
check('the live cipher is unchanged after a re-offer', live === callCipher);
check('...so later candidates still open',
  live.open(callCipher.seal({ candidate: 'after' }))?.candidate === 'after');
check('and the answer is sealed with that same cipher',
  callCipher.open(live.seal({ type: 'answer' }))?.type === 'answer');
void applied;

// ── starting a call still uses the ratchet envelope ───────────────────
const initial = { v: 'sig1', h: '<ratchet>', p: callCipher.seal(sdp) };
const start = openCallOffer(initial);
check('a sig1 envelope still derives the call cipher', start.cipher.enc === true);
check('...and yields the real offer', start.offer?.type === 'offer');

// ── a legacy peer's plaintext re-offer still works ────────────────────
check('plaintext re-offer passes through the call cipher', callCipher.open(sdp)?.type === 'offer');
check('a null wire is handled', callCipher.open(null) === null);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all re-offer cipher checks passed\n');
process.exit(failures ? 1 : 0);
