// services/crypto/rekeyGlare.selftest.ts
// run: npx tsx services/crypto/rekeyGlare.selftest.ts
//
// SIMULTANEOUS RE-KEY — the session-layer twin of ICE glare.
//
// Recovery is mutual: a peer that cannot decrypt resets its own session AND
// asks the other to reset. So both sides routinely re-key at the same moment,
// both become X3DH initiators, and both receive an X3DH-headed message.
//
// The old rule was "if it carries an X3DH header, adopt it". Applied by BOTH
// sides at once, they SWAP: each lands on the other's session, neither can
// decrypt, both reset, and it repeats. On device:
//
//   19:11:46  FORCED re-key ×2
//   19:11:53  FORCED re-key ×2      8 resets in 22s, aes/gcm: invalid ghash tag
//
// The fix is a deterministic tie-break on the identity keys both sides already
// hold. What matters is not which session survives, but that both pick the
// SAME one — so the rule must give opposite answers to the two peers, for every
// possible pair of keys.

/** Mirrors the rule in decryptFromPeer: the LOWER identity key yields. */
function adopts(myIk: string, peerIk: string, iAmFreshInitiator: boolean): boolean {
  if (!iAmFreshInitiator) return true;      // not a collision — adopt as before
  return myIk.toLowerCase() < peerIk.toLowerCase();
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nSimultaneous re-key tie-break\n');

const A = 'aa11';
const B = 'ff99';

// ── the bug: both adopt and swap ──────────────────────────────────────
check('exactly ONE side adopts in a collision',
  adopts(A, B, true) !== adopts(B, A, true));
check('the lower key yields', adopts(A, B, true) === true);
check('the higher key holds', adopts(B, A, true) === false);

// ── a normal re-key is unaffected ─────────────────────────────────────
check('a responder still adopts a re-keying peer', adopts(B, A, false) === true);
check('an established initiator still adopts', adopts(A, B, false) === true);

// ── the rule must never tie ───────────────────────────────────────────
// A tie means both hold, both fail forever — worse than both adopting.
const keys = ['00', '01', '0f', '7f', '80', 'a0', 'fe', 'ff', 'abc', 'abd'];
let ties = 0, swaps = 0;
for (const x of keys) {
  for (const y of keys) {
    if (x === y) continue;
    const mine = adopts(x, y, true);
    const theirs = adopts(y, x, true);
    if (mine === theirs) { if (mine) swaps++; else ties++; }
  }
}
check('no key pair produces a deadlock (both hold)', ties === 0);
check('no key pair produces a swap (both adopt)', swaps === 0);

// ── case-insensitive: hex from two sources may differ in case ─────────
check('case does not change the winner',
  adopts('ABCD', 'abce', true) === adopts('abcd', 'ABCE', true));

// ── the outcome both sides converge on ────────────────────────────────
// Simulate: A and B each hold their own session, then apply the rule.
let sessionA = 'A-session';
let sessionB = 'B-session';
if (adopts(A, B, true)) sessionA = 'B-session';
if (adopts(B, A, true)) sessionB = 'A-session';
check('both peers end up on the SAME session', sessionA === sessionB);
check('...specifically the higher key\'s session', sessionA === 'B-session');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all re-key glare checks passed\n');
process.exit(failures ? 1 : 0);
