/**
 * Crypto benchmark for services/crypto/e2ee.ts — run with:
 *   npx tsx services/crypto/e2ee.bench.ts        (npm run bench:e2ee)
 *
 * Fills the `tap→encrypt` rows of SPEEDLOG.md with measured numbers instead of
 * guesses. Same primitives the app runs (pure @noble, no native module), so the
 * only gap to a real device is CPU speed — see the note SPEEDLOG carries.
 *
 * Dev-only, never imported by the app.
 */
import {
  generateDH, generateSigningKey, sign,
  x3dhInitiator, x3dhResponder,
  ratchetInitAlice, ratchetInitBob, ratchetEncrypt, ratchetDecrypt,
  utf8,
  type PreKeyBundle,
} from './e2ee';

const MSG = utf8('hey, are we still on for tomorrow?');   // ~33 B, typical chat line

function bench(name: string, iters: number, fn: () => void): number {
  fn();                                                    // warm JIT
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const per = (performance.now() - t0) / iters;
  console.log(`  ${name.padEnd(34)} ${per.toFixed(3)} ms/op   (${(1000 / per).toFixed(0)}/s)`);
  return per;
}

// Fresh identities + a bundle, exactly as bootstrapping a new peer does.
function makeBundle() {
  const bobIK = generateDH(), bobSPK = generateDH(), bobSign = generateSigningKey();
  const bundle: PreKeyBundle = {
    identityKey: bobIK.pub,
    signedPreKey: bobSPK.pub,
    signedPreKeySig: sign(bobSPK.pub, bobSign.priv),
    signingKey: bobSign.pub,
  };
  return { bobIK, bobSPK, bundle };
}

console.log(`\ncrazzychat E2EE benchmark — node ${process.version} on ${process.platform}/${process.arch}\n`);

// ── X3DH: the first message to a NEW peer pays this once ───────────────
// The peer's bundle comes off the wire, so generating it is NOT part of what a
// sender pays — hoist it out and time only the work x3dhInitiator does.
const aliceIK = generateDH();
const peerBundle = makeBundle().bundle;
const x3dhMs = bench('X3DH initiator (new peer)', 500, () => { x3dhInitiator(aliceIK, peerBundle); });

{
  const { bobIK, bobSPK, bundle } = makeBundle();
  const { sk, header } = x3dhInitiator(generateDH(), bundle);
  bench('X3DH responder (first inbound)', 200, () => x3dhResponder(bobIK, bobSPK, undefined, header));
  void sk;
}

// ── Double Ratchet: every subsequent message pays this ─────────────────
const { bobSPK, bundle } = makeBundle();
const { sk } = x3dhInitiator(generateDH(), bundle);
const alice = ratchetInitAlice(sk, bundle.signedPreKey);
const bob = ratchetInitBob(sk, bobSPK);

// A DH-ratchet step happens on the FIRST message of each direction turn; the
// rest of a burst rides the symmetric chain. Measure the steady-state chain.
ratchetDecrypt(bob, ratchetEncrypt(alice, MSG));
const encMs = bench('ratchetEncrypt (warm session)', 2000, () => { ratchetEncrypt(alice, MSG); });

// Fresh pair: the decrypt corpus must stay in-order from message 0, or the
// ratchet's skipped-key window (MAX_SKIP) trips on the backlog we just sent.
const { bobSPK: spk2, bundle: bundle2 } = makeBundle();
const { sk: sk2 } = x3dhInitiator(generateDH(), bundle2);
const alice2 = ratchetInitAlice(sk2, bundle2.signedPreKey);
const bob2 = ratchetInitBob(sk2, spk2);
const decPairs = Array.from({ length: 2001 }, () => ratchetEncrypt(alice2, MSG));
let di = 0;   // bench() burns one on its own warm-up call, hence 2001 envelopes
const decMs = bench('ratchetDecrypt (warm session)', 2000, () => { ratchetDecrypt(bob2, decPairs[di++]); });

console.log(`
  ── derived ──────────────────────────────────────────────
  first message to a new peer   ${(x3dhMs + encMs).toFixed(1)} ms  (X3DH + 1 encrypt, excl. bundle fetch RTT)
  1,000 warm encrypts           ${(encMs * 1000).toFixed(0)} ms
  1,000 warm decrypts           ${(decMs * 1000).toFixed(0)} ms
`);
