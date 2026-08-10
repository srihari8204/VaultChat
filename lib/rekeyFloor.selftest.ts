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

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all re-key rate-limit checks passed\n');
process.exit(failures ? 1 : 0);
