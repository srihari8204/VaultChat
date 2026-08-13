// lib/call/reoffer.selftest.ts — run: npx tsx lib/call/reoffer.selftest.ts
//
// The rule that decides whether an incoming offer is a genuine ICE restart or
// a ring repeat. Getting it wrong is not cosmetic:
//   • treat a ring repeat as a restart  -> a WORKING call is torn down
//   • treat a restart as a ring repeat  -> a handover can never recover
// Both were observed on device, so the rule is asserted here rather than
// trusted. Pure string logic, so it runs in Node with no WebRTC.

/** Mirrors CallPeer.isNewOffer / lastRemoteOfferSdp. */
class OfferGate {
  private lastRemoteOfferSdp = '';
  hasNegotiated = false;
  isNewOffer(offer: any): boolean {
    const sdp = String(offer?.sdp ?? '');
    return sdp !== '' && sdp !== this.lastRemoteOfferSdp;
  }
  apply(offer: any): void {
    this.hasNegotiated = true;
    this.lastRemoteOfferSdp = String(offer?.sdp ?? '');
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('\nICE-restart vs ring-repeat gate\n');

const sdp = (ufrag: string) =>
  `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:pw${ufrag}\r\n`;

const g = new OfferGate();
const first = { type: 'offer', sdp: sdp('AAAA') };

// ── before any negotiation ────────────────────────────────────────────
check('a fresh peer has not negotiated', !g.hasNegotiated);

// The engine only consults isNewOffer AFTER hasNegotiated, so the initial
// offer must never reach the re-offer branch at all.
g.apply(first);
check('after the initial offer, the peer is negotiated', g.hasNegotiated);

// ── the bug that broke live calls ─────────────────────────────────────
check('an IDENTICAL ring repeat is NOT a new offer',
  !g.isNewOffer({ type: 'offer', sdp: sdp('AAAA') }));
check('a second identical repeat is still not new',
  !g.isNewOffer({ type: 'offer', sdp: sdp('AAAA') }));

// ── the bug that broke handover ───────────────────────────────────────
const restart = { type: 'offer', sdp: sdp('BBBB') };   // fresh ufrag
check('an ICE restart (new ufrag) IS a new offer', g.isNewOffer(restart));

g.apply(restart);
check('after applying the restart, repeats of IT are ignored',
  !g.isNewOffer({ type: 'offer', sdp: sdp('BBBB') }));
check('but a SECOND restart is accepted', g.isNewOffer({ type: 'offer', sdp: sdp('CCCC') }));

// ── malformed input must never look like a restart ────────────────────
check('empty sdp is not a new offer', !g.isNewOffer({ type: 'offer', sdp: '' }));
check('missing sdp is not a new offer', !g.isNewOffer({ type: 'offer' }));
check('null offer is not a new offer', !g.isNewOffer(null));

// A handover mid-ring: the callee has answered (negotiated), the caller's ring
// loop is still repeating the ORIGINAL offer, and a real restart arrives.
const g2 = new OfferGate();
g2.apply({ type: 'offer', sdp: sdp('RING') });
check('restart is accepted even while ring repeats continue',
  g2.isNewOffer({ type: 'offer', sdp: sdp('NEW1') }));
check('and the interleaved ring repeat is still rejected',
  !g2.isNewOffer({ type: 'offer', sdp: sdp('RING') }));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all re-offer gate checks passed\n');
process.exit(failures ? 1 : 0);
