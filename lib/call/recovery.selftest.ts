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
  private graceOpen = false;

  /** Mirrors CallPeer.onconnectionstatechange. */
  onState(st: State): void {
    if (st === 'connected' || st === 'closed') this.clearGrace();
    if (st === 'closed') { this.ended = true; return; }
    if (st === 'failed' || st === 'disconnected') this.begin();
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
    if (st !== 'disconnected' && st !== 'failed') { this.clearGrace(); return; }
    this.restarts++;
  }

  /** Mirrors the DISCONNECT_GRACE_MS timeout firing. */
  graceExpires(st: State): void {
    if (!this.graceOpen) return;
    this.graceOpen = false;
    if (st === 'disconnected' || st === 'failed') this.ended = true;
  }

  private clearGrace(): void { this.graceOpen = false; this.recovering = false; }
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

// ── network-change restarts ───────────────────────────────────────────
check('network change restarts ICE when failed', restartsOnNetworkChange('failed'));
check('...when disconnected', restartsOnNetworkChange('disconnected'));
check('...and when still connected (path can linger dead)', restartsOnNetworkChange('connected'));
check('but not during initial setup', !restartsOnNetworkChange('connecting'));
check('and not once closed', !restartsOnNetworkChange('closed'));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all recovery checks passed\n');
process.exit(failures ? 1 : 0);
