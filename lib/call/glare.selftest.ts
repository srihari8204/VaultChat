// lib/call/glare.selftest.ts — run: npx tsx lib/call/glare.selftest.ts
//
// Signalling-state handling during recovery. Both sides restart ICE after a
// handover, so both can end up holding an unanswered local offer at the same
// time ("glare"). Observed on device as a total deadlock:
//
//   17:58:54  sending ICE-restart offer
//   17:59:10  skip ICE-restart offer — signalingState is have-local-offer
//   17:59:14  skip ICE-restart offer — signalingState is have-local-offer
//
// The connection never left have-local-offer, so every retry for the whole 30s
// grace window was skipped and the call could not recover. Both directions need
// to break it: the offering side rolls back a stale unanswered offer, and the
// receiving side yields its own offer rather than refusing to answer.
//
// Mirrors createIceRestartOffer / applyReoffer. Pure, runs in Node.

type Sig = 'stable' | 'have-local-offer' | 'have-remote-offer';

class Signalling {
  state: Sig = 'stable';
  offersSent = 0;
  answersSent = 0;
  rollbacks = 0;

  /** Mirrors createIceRestartOffer. */
  tryRestartOffer(): boolean {
    if (this.state === 'have-local-offer') { this.rollback(); }
    if (this.state !== 'stable') return false;
    this.state = 'have-local-offer';
    this.offersSent++;
    return true;
  }

  /** Mirrors applyReoffer. */
  applyReoffer(): boolean {
    if (this.state === 'have-local-offer') { this.rollback(); }   // yield
    this.state = 'stable';        // remote offer applied, answer created
    this.answersSent++;
    return true;
  }

  /** Mirrors the answer arriving for our own offer. */
  applyAnswer(): void { if (this.state === 'have-local-offer') this.state = 'stable'; }

  private rollback(): void { this.state = 'stable'; this.rollbacks++; }
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nICE-restart signalling: deadlock and glare\n');

// ── the deadlock: our offer is never answered ─────────────────────────
const a = new Signalling();
check('the first restart offer goes out', a.tryRestartOffer());
check('...leaving an offer outstanding', a.state === 'have-local-offer');
check('a retry is NOT skipped forever', a.tryRestartOffer());
check('the stale offer was rolled back', a.rollbacks === 1);
check('and a second offer actually went out', a.offersSent === 2);

// ── the happy path is untouched ───────────────────────────────────────
const b = new Signalling();
b.tryRestartOffer();
b.applyAnswer();
check('an answered offer returns to stable', b.state === 'stable');
check('...with no rollback needed', b.rollbacks === 0);

// ── glare: both sides offer at once ───────────────────────────────────
const c = new Signalling();
c.tryRestartOffer();                       // our offer is in flight...
check('a remote offer during glare is still answered', c.applyReoffer());
check('we yielded our own offer', c.rollbacks === 1);
check('exactly one answer was sent', c.answersSent === 1);
check('and we end up stable', c.state === 'stable');

// ── two peers in true simultaneous glare must converge ────────────────
const p = new Signalling(), q = new Signalling();
p.tryRestartOffer();
q.tryRestartOffer();
p.applyReoffer();                          // each receives the other's offer
q.applyReoffer();
check('both peers converge to stable', p.state === 'stable' && q.state === 'stable');
check('both answered rather than deadlocking', p.answersSent === 1 && q.answersSent === 1);

// ── a normal offer with nothing outstanding never rolls back ──────────
const d = new Signalling();
d.applyReoffer();
check('answering from stable needs no rollback', d.rollbacks === 0 && d.answersSent === 1);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all glare checks passed\n');
process.exit(failures ? 1 : 0);
