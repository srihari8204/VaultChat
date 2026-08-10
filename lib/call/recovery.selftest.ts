// lib/call/recovery.selftest.ts — run: npx tsx lib/call/recovery.selftest.ts
//
// Which connection states get the 30s recovery budget, and which end the call.
//
// This was wrong in a way that exactly matched the reported symptom ("the call
// disconnects suddenly when I switch to Wi-Fi"): only `disconnected` got the
// grace window, while `failed` hung up instantly. On Android a Wi-Fi↔mobile
// handover usually tears the old path down hard enough that ICE goes straight
// to `failed`, so the recovery budget never applied to the one case it was
// built for.
//
// Mirrors the onconnectionstatechange branch in CallPeer. Pure, runs in Node.

type State = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

class Recovery {
  recovering = false;
  ended = false;
  restarts = 0;
  stallArmed = false;
  private graceOpen = false;
  private everConnected = false;

  /** Mirrors CallPeer.onconnectionstatechange. */
  onState(st: State): void {
    if (st === 'connected' || st === 'closed') this.clearGrace();
    if (st === 'connected') this.everConnected = true;
    if (st === 'closed') { this.ended = true; return; }
    if (st === 'failed' || st === 'disconnected') this.begin();
    // A regression to `connecting` after having been connected arms the stall
    // watchdog rather than recovering immediately — an ICE restart passes
    // through this state legitimately on its way back.
    if (st === 'connecting' && this.everConnected && !this.graceOpen && !this.stallArmed) {
      this.stallArmed = true;
    }
  }

  /** Mirrors the CONNECTING_STALL_MS watchdog firing. */
  stallExpires(st: State): void {
    if (!this.stallArmed) return;
    this.stallArmed = false;
    if (st === 'connecting') this.begin();
  }

  private begin(): void {
    if (this.graceOpen) return;          // one budget per outage, not one per event
    this.graceOpen = true;
    this.recovering = true;
    this.restarts++;                     // first attempt is immediate
  }

  /** Mirrors the ICE_RETRY_MS interval. */
  tick(st: State): void {
    if (!this.graceOpen) return;
    if (st === 'connected') { this.clearGrace(); return; }   // the only success
    this.restarts++;
  }

  /** Mirrors the DISCONNECT_GRACE_MS timeout firing. */
  graceExpires(st: State): void {
    if (!this.graceOpen) return;
    this.graceOpen = false;
    if (st !== 'connected' && st !== 'closed') this.ended = true;
  }

  private clearGrace(): void {
    this.graceOpen = false; this.recovering = false; this.stallArmed = false;
  }
}

/** Mirrors CallPeer.onNetworkChanged. */
const restartsOnNetworkChange = (st: State): boolean =>
  st === 'connected' || st === 'disconnected' || st === 'failed';

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nCall recovery state machine\n');

// ── the reported bug ──────────────────────────────────────────────────
const a = new Recovery();
a.onState('connected');
a.onState('failed');
check('`failed` does NOT end the call immediately', !a.ended);
check('`failed` enters recovery', a.recovering);
check('`failed` triggers an immediate ICE restart', a.restarts === 1);

// ── recovery within the window ────────────────────────────────────────
a.tick('failed');
check('a retry fires while still failed', a.restarts === 2);
a.onState('connected');
check('reconnecting keeps the call alive', !a.ended);
check('...and stops the retries', !a.recovering);
a.graceExpires('connected');
check('a stale grace timer cannot kill a recovered call', !a.ended);

// ── recovery that never happens ───────────────────────────────────────
const b = new Recovery();
b.onState('failed');
b.graceExpires('failed');
check('the call ends only when the grace window expires', b.ended);

// ── disconnected keeps working as before ──────────────────────────────
const c = new Recovery();
c.onState('disconnected');
check('`disconnected` still enters recovery', c.recovering && !c.ended);
c.graceExpires('disconnected');
check('`disconnected` still ends after the window', c.ended);

// ── disconnected -> failed is ONE outage, not two ─────────────────────
const d = new Recovery();
d.onState('disconnected');
d.onState('failed');
check('a disconnected→failed slide does not restart the budget', d.restarts === 1);
check('...and does not end the call', !d.ended);

// ── closed is terminal ────────────────────────────────────────────────
const e = new Recovery();
e.onState('connected');
e.onState('closed');
check('`closed` ends the call immediately', e.ended);

// ── normal setup must not trip recovery ───────────────────────────────
const f = new Recovery();
f.onState('new'); f.onState('connecting'); f.onState('connected');
check('a clean connect never enters recovery', !f.recovering && !f.ended && f.restarts === 0);

// ── a call stuck in `connecting` after being connected ────────────────
//
// Captured on device: `connected` at 13:24:00, `connecting` at 13:24:16, then
// NOTHING — no retry, no failure, no log. Recovery ran only for `disconnected`
// and `failed`, so this call hung silently with no media until the user gave
// up. The user reported it simply as "calls not working".
const g = new Recovery();
g.onState('connecting'); g.onState('connected');
check('a healthy connect arms no watchdog', !g.stallArmed);
g.onState('connecting');
check('sliding BACK to connecting arms the stall watchdog', g.stallArmed);
check('...but does not recover immediately (an ICE restart passes through here)',
  !g.recovering && g.restarts === 0);
g.stallExpires('connecting');
check('...and recovers once the watchdog expires', g.recovering && g.restarts === 1);
g.graceExpires('connecting');
check('a call still connecting when the budget runs out ENDS, not hangs', g.ended);

// ── the watchdog must not fire on a call that came back ───────────────
const h2 = new Recovery();
h2.onState('connected'); h2.onState('connecting');
h2.onState('connected');                       // recovered on its own
h2.stallExpires('connected');
check('a recovered call is not dragged into recovery by a stale watchdog',
  !h2.recovering && !h2.ended);

// ── recovery survives its OWN restart passing through connecting ──────
//
// The retry loop used to treat "not disconnected and not failed" as recovered,
// so it cancelled the budget the moment its own ICE restart moved the state to
// `connecting` — abandoning the call mid-recovery.
const i = new Recovery();
i.onState('connected'); i.onState('failed');
i.tick('connecting');
check('a retry is not cancelled by the transient connecting of its own restart',
  i.recovering && i.restarts === 2);
i.onState('connected');
check('...and stops properly once actually connected', !i.recovering);

// ── network-change restarts ───────────────────────────────────────────
check('network change restarts ICE when failed', restartsOnNetworkChange('failed'));
check('...when disconnected', restartsOnNetworkChange('disconnected'));
check('...and when still connected (path can linger dead)', restartsOnNetworkChange('connected'));
check('but not during initial setup', !restartsOnNetworkChange('connecting'));
check('and not once closed', !restartsOnNetworkChange('closed'));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all recovery checks passed\n');
process.exit(failures ? 1 : 0);
