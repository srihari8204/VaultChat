// lib/rekeyFloor.selftest.ts — run: npx tsx lib/rekeyFloor.selftest.ts
//
// Rate limiting on E2EE session resets. Two failure modes sit on either side of
// this, and BOTH were hit on device within one hour:
//
//   too slow  — a 60s cooldown refused the heal a failed call needed, so four
//               call attempts over 40s all failed ("rekey request ignored —
//               reset 43s ago") with both phones waiting on each other.
//   too fast  — removing the limit for calls let both sides force resets at
//               each other, each destroying the session the other had just
//               rebuilt: EIGHT resets in 22 seconds, call never connected.
//
// The floor has to be short enough to heal a retry and long enough that a reset
// survives to be used. Mirrors requestPeerRekey / handleRekeyRequest.

const FORCED_FLOOR_MS = 15_000;
const NORMAL_COOLDOWN_MS = 60_000;
const SEND_COOLDOWN_MS = 30_000;

class Rekey {
  private lastReset = new Map<string, number>();
  private lastSend = new Map<string, number>();
  resets = 0;
  sends = 0;

  /** Mirrors handleRekeyRequest. */
  receive(peer: string, now: number, force: boolean): boolean {
    const since = now - (this.lastReset.get(peer) ?? -Infinity);
    if (since < (force ? FORCED_FLOOR_MS : NORMAL_COOLDOWN_MS)) return false;
    this.lastReset.set(peer, now);
    this.resets++;
    return true;
  }

  /** Mirrors requestPeerRekey. */
  send(peer: string, now: number, force: boolean): boolean {
    const since = now - (this.lastSend.get(peer) ?? -Infinity);
    if (since < (force ? FORCED_FLOOR_MS : SEND_COOLDOWN_MS)) return false;
    this.lastSend.set(peer, now);
    this.sends++;
    return true;
  }
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nE2EE re-key rate limiting\n');

const P = 'peer-1';

// ── the storm this exists to prevent ──────────────────────────────────
const a = new Rekey();
// The device burst: pairs of requests at 0s, 7s, 20s, 22s.
for (const t of [0, 0, 7_000, 7_000, 20_000, 20_000, 22_000, 22_000]) a.receive(P, t, true);
check('a burst of 8 forced requests does not cause 8 resets', a.resets < 8);
check('...it causes exactly 2 (t=0 and t=20s)', a.resets === 2);

// ── duplicates from the ring + offer paths collapse ───────────────────
const b = new Rekey();
check('the first forced request is honoured', b.receive(P, 0, true));
check('an immediate duplicate is ignored', !b.receive(P, 5, true));
check('...and one 3s later (a ring repeat) too', !b.receive(P, 3_000, true));

// ── but a real retry still heals quickly ──────────────────────────────
check('a retry after the floor IS honoured', b.receive(P, FORCED_FLOOR_MS, true));
check('the user does not wait a full minute', FORCED_FLOOR_MS < NORMAL_COOLDOWN_MS);

// ── the original bug: a call must not wait 60s ────────────────────────
const c = new Rekey();
c.receive(P, 0, false);                       // a background text reset
check('a CALL failure 20s later is not blocked by the text cooldown',
  c.receive(P, 20_000, true));

// ── background text recovery is UNCHANGED ─────────────────────────────
const d = new Rekey();
check('a background reset is honoured', d.receive(P, 0, false));
check('...and still blocked for the full 60s', !d.receive(P, 59_000, false));
check('...then allowed again', d.receive(P, 60_000, false));

// ── send side mirrors the receive side ────────────────────────────────
const e = new Rekey();
check('the first forced send goes out', e.send(P, 0, true));
check('a burst does not flood the socket', !e.send(P, 100, true) && !e.send(P, 3_000, true));
check('exactly one send from the burst', e.sends === 1);

// ── peers are independent ─────────────────────────────────────────────
const f = new Rekey();
f.receive('a', 0, true);
check('one peer\'s floor does not block another', f.receive('b', 0, true));

// ── CONVERGENCE ───────────────────────────────────────────────────────
//
// The rate limits above bound how OFTEN a reset happens. They cannot make the
// resets stop, because both devices run the same function: A resets, which
// breaks the session B just built, so B resets, which breaks A's. A cooldown
// only sets the period of that flip-flop — measured on device as resets
// alternating between two phones every ~113s, with "unable to decrypt" the
// whole time and sending still working, which is the signature of the loop.
//
// Two rules end it, and this models both against the mutual-failure case:
//   1. exactly one side is the designated resetter (lower user id)
//   2. a repeat of an already-answered complaint (same epoch) is dropped

class Device {
  complaint = new Map<string, number>();   // mirrors _complaintEpoch
  inEpisode = new Set<string>();           // mirrors _inEpisode
  selfReset = new Map<string, number>();   // mirrors _selfResetEpoch
  handled = new Map<string, number>();     // mirrors _handledRekeyEpoch
  lastReset = new Map<string, number>();
  resets = 0;

  constructor(readonly id: string) {}

  /** The number this device puts on the wire when it asks for a re-key. */
  epochFor(peer: string): number { return this.complaint.get(peer) ?? 0; }

  /** Mirrors maybeAutoRecoverSession once the fail streak trips. */
  decryptFailed(peer: string, now: number): void {
    if (!this.inEpisode.has(peer)) {                 // beginComplaintEpisode
      this.inEpisode.add(peer);
      this.complaint.set(peer, this.epochFor(peer) + 1);
    }
    if (now - (this.lastReset.get(peer) ?? -Infinity) < NORMAL_COOLDOWN_MS) return;
    if (this.id > peer) return;                      // not the designated initiator → ask only
    if (this.selfReset.get(peer) === this.epochFor(peer)) return;  // one tear-down per breakage
    this.selfReset.set(peer, this.epochFor(peer));
    this.reset(peer, now);
  }

  /** Mirrors handleRekeyRequest for a background (non-forced) request. */
  rekeyRequested(peer: string, now: number, peerEpoch: number): void {
    if (this.handled.get(peer) === peerEpoch) return;          // same complaint as before
    if (now - (this.lastReset.get(peer) ?? -Infinity) < NORMAL_COOLDOWN_MS) return;
    this.handled.set(peer, peerEpoch);
    this.reset(peer, now);
  }

  /** A message from this peer decrypted — the breakage is over. */
  decryptSucceeded(peer: string): void { this.inEpisode.delete(peer); }

  private reset(peer: string, now: number): void {
    this.lastReset.set(peer, now);
    this.resets++;
  }
}

// Both sides stuck, both failing to decrypt every 5s for ten minutes — the
// device scenario, run long enough that a 60s flip-flop would show ~10 resets
// per side.
const A = new Device('aaaa-1111');
const B = new Device('bbbb-2222');
for (let t = 0; t <= 600_000; t += 5_000) {
  A.decryptFailed(B.id, t);
  B.rekeyRequested(A.id, t, A.epochFor(B.id));
  B.decryptFailed(A.id, t);
  A.rekeyRequested(B.id, t, B.epochFor(A.id));
}
check('the loop converges instead of beating forever', A.resets + B.resets <= 3);
check('...and at least one heal actually happened', A.resets + B.resets >= 1);
check('ten minutes of mutual failure costs at most one reset each way', A.resets <= 2 && B.resets <= 2);

// Liveness: after the pair recovers, a LATER breakage must still be healed.
// Suppressing duplicates is only safe if it cannot turn into deafness.
A.decryptSucceeded(B.id); B.decryptSucceeded(A.id);
const before = A.resets + B.resets;
for (let t = 900_000; t <= 1_000_000; t += 5_000) {
  A.decryptFailed(B.id, t);
  B.rekeyRequested(A.id, t, A.epochFor(B.id));
}
check('a NEW breakage after a recovery is still acted on', A.resets + B.resets > before);

// A repeat of the SAME complaint is dropped even after the timer has expired —
// this is the half a clock alone cannot do.
const C = new Device('cccc');
C.rekeyRequested('dddd', 0, 7);
check('a first complaint is acted on', C.resets === 1);
C.rekeyRequested('dddd', 120_000, 7);
check('the same epoch two minutes later is still a duplicate', C.resets === 1);
C.rekeyRequested('dddd', 240_000, 8);
check('a genuinely new epoch IS acted on', C.resets === 2);

// The peer reinstalled: its in-memory epoch restarts at 0, BELOW what we have
// recorded. A `<=` rule would ignore that peer until one of the two processes
// died; `!==` treats any change as news.
const E = new Device('eeee');
E.rekeyRequested('ffff', 0, 5);
E.rekeyRequested('ffff', 120_000, 0);
check('a peer that restarted at epoch 0 is not ignored forever', E.resets === 2);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all re-key rate-limit checks passed\n');
process.exit(failures ? 1 : 0);
