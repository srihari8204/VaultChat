// lib/family/escalation.ts — the guardian escalation ladder (F6.1), as a pure
// state machine.
//
// A guardian asks a member to check in. If nothing comes back the ladder
// retries at +5 min and +15 min, and finally raises Emergency Connect. An
// "I'm OK" from the member cancels it at any point.
//
// WHY A PURE MACHINE: the ladder's whole job is to be correct about time on a
// phone that sleeps, gets killed, and cold-starts hours later. That is exactly
// the kind of logic that cannot be verified by hand, so every rule here is
// exercised by the self-check at the bottom:
//   node --experimental-strip-types lib/family/escalation.ts
//
// The single most important rule is COLLAPSE (see advance): a device that was
// asleep across several steps fires only the furthest one. Replaying each step
// on wake would spam a member with stale reminders and — far worse — could
// raise an Emergency Connect that the member had already answered on another
// device before the ladder was rehydrated.

export type LadderState = 'waiting' | 'cancelled' | 'escalated';
export type LadderAction = 'retry' | 'emergency';

export interface LadderStep { atMs: number; action: LadderAction }

/**
 * The ladder, straight from the spec: "retry at +5 minutes, then +15 minutes,
 * then after a configured number of misses trigger Emergency Connect."
 * Offsets are from the moment the check-in was requested, not from each other.
 */
export const LADDER_STEPS: LadderStep[] = [
  { atMs: 5 * 60_000, action: 'retry' },
  { atMs: 15 * 60_000, action: 'retry' },
  { atMs: 30 * 60_000, action: 'emergency' },
];

/** "Configured number of misses" — the retries that precede Emergency Connect. */
export const MISSES_BEFORE_EMERGENCY = LADDER_STEPS.filter((s) => s.action === 'retry').length;

export interface Ladder {
  id: string;
  circleId: string;
  subjectId: string;        // the member asked to check in
  subjectName: string;
  requestedBy: string;      // the guardian who asked
  requestedByName: string;
  startedAt: number;
  state: LadderState;
  /** How many ladder steps have already fired — the resume cursor. */
  stepsFired: number;
  lastActionAt: number;
}

export interface NewLadderInput {
  id: string;
  circleId: string;
  subjectId: string;
  subjectName: string;
  requestedBy: string;
  requestedByName: string;
  at: number;
}

export function createLadder(i: NewLadderInput): Ladder {
  return {
    id: i.id,
    circleId: i.circleId,
    subjectId: i.subjectId,
    subjectName: i.subjectName,
    requestedBy: i.requestedBy,
    requestedByName: i.requestedByName,
    startedAt: i.at,
    state: 'waiting',
    stepsFired: 0,
    lastActionAt: i.at,
  };
}

/** Is the ladder still running? Only a waiting ladder can fire or be cancelled. */
export function isActive(l: Ladder): boolean { return l.state === 'waiting'; }

/**
 * Absolute time the next step is due, or null when the ladder is finished
 * (cancelled, escalated, or out of steps). Drives the timer in the service.
 */
export function nextDueAt(l: Ladder): number | null {
  if (!isActive(l)) return null;
  const step = LADDER_STEPS[l.stepsFired];
  return step ? l.startedAt + step.atMs : null;
}

export interface AdvanceResult {
  ladder: Ladder;
  /** The single action that became due, or null. Never a burst — see COLLAPSE. */
  fired: LadderAction | null;
  /** Retry steps skipped by the collapse, for the audit line. */
  skipped: number;
}

/**
 * Fold time forward to `now`.
 *
 * COLLAPSE: when several steps came due while the device was asleep, only the
 * furthest one fires and the rest are reported as `skipped`. Firing them in
 * sequence would produce a burst of stale reminders on wake.
 */
export function advance(l: Ladder, now: number): AdvanceResult {
  if (!isActive(l)) return { ladder: l, fired: null, skipped: 0 };

  const elapsed = now - l.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    // Clock moved backwards (timezone change, NTP correction). Never fire on
    // a negative elapsed — an emergency raised by a clock glitch is worse than
    // a late one.
    return { ladder: l, fired: null, skipped: 0 };
  }

  // The furthest step whose time has arrived.
  let target = -1;
  for (let i = 0; i < LADDER_STEPS.length; i++) {
    if (elapsed >= LADDER_STEPS[i].atMs) target = i;
  }
  if (target < l.stepsFired) return { ladder: l, fired: null, skipped: 0 };

  const step = LADDER_STEPS[target];
  const skipped = target - l.stepsFired;   // retries collapsed away
  const ladder: Ladder = {
    ...l,
    stepsFired: target + 1,
    lastActionAt: now,
    state: step.action === 'emergency' ? 'escalated' : l.state,
  };
  return { ladder, fired: step.action, skipped };
}

/** "I'm OK". Cancelling a finished ladder is a no-op, never an error. */
export function cancel(l: Ladder, now: number): Ladder {
  if (!isActive(l)) return l;
  return { ...l, state: 'cancelled', lastActionAt: now };
}

// ── audit lines (E2EE system messages, F6.2) ──
// Glyph-prefixed so a receiver ingests them through the existing family-event
// pipeline (see events.ts) instead of matching English.

export const ESCALATION_GLYPH = {
  request: '\u{1F514}',    // 🔔 check-in requested
  retry: '\u{1F501}',      // 🔁 reminder
  ok: '\u{1F44D}',         // 👍 member confirmed
  emergency: '\u{1F6A8}',  // 🚨 Emergency Connect
} as const;

export function auditRequest(l: Ladder): string {
  return `${ESCALATION_GLYPH.request} ${l.requestedByName} asked ${l.subjectName} to check in`;
}
export function auditRetry(l: Ladder, skipped: number): string {
  const missed = l.stepsFired;
  const note = skipped > 0 ? ` (${skipped} earlier reminder${skipped === 1 ? '' : 's'} missed)` : '';
  return `${ESCALATION_GLYPH.retry} Reminder ${missed}/${MISSES_BEFORE_EMERGENCY}: ${l.subjectName}, please check in${note}`;
}
/** Takes just the name: a member can confirm without any ladder object in hand
 *  (their device never holds one — see escalationService OWNERSHIP). */
export function auditCancelled(subjectName: string): string {
  return `${ESCALATION_GLYPH.ok} ${subjectName} confirmed they are OK`;
}
export function auditEmergency(l: Ladder): string {
  return `${ESCALATION_GLYPH.emergency} Emergency Connect: ${l.subjectName} did not respond to ${MISSES_BEFORE_EMERGENCY} check-in reminders`;
}

// ── self-check ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('escalation: ' + m); };
  const T0 = 1_700_000_000_000;
  const mk = () => createLadder({
    id: 'l1', circleId: 'c1', subjectId: 'u2', subjectName: 'Rohan',
    requestedBy: 'u1', requestedByName: 'Asha', at: T0,
  });
  const MIN = 60_000;

  // shape
  const fresh = mk();
  A(fresh.state === 'waiting' && fresh.stepsFired === 0, 'fresh ladder waits');
  A(isActive(fresh), 'fresh ladder is active');
  A(nextDueAt(fresh) === T0 + 5 * MIN, 'first step due at +5 min');
  A(MISSES_BEFORE_EMERGENCY === 2, 'two retries precede Emergency Connect');

  // nothing fires early
  for (const t of [T0, T0 + MIN, T0 + 4 * MIN, T0 + 5 * MIN - 1]) {
    A(advance(mk(), t).fired === null, `nothing fires at ${t - T0}ms`);
  }

  // step by step
  let l = mk();
  let r = advance(l, T0 + 5 * MIN);
  A(r.fired === 'retry' && r.ladder.stepsFired === 1 && r.skipped === 0, 'first retry at +5');
  A(nextDueAt(r.ladder) === T0 + 15 * MIN, 'second step due at +15');
  A(advance(r.ladder, T0 + 6 * MIN).fired === null, 'no double-fire of the same step');

  r = advance(r.ladder, T0 + 15 * MIN);
  A(r.fired === 'retry' && r.ladder.stepsFired === 2, 'second retry at +15');
  A(r.ladder.state === 'waiting', 'still waiting after the retries');

  r = advance(r.ladder, T0 + 30 * MIN);
  A(r.fired === 'emergency' && r.ladder.state === 'escalated', 'Emergency Connect at +30');
  A(nextDueAt(r.ladder) === null, 'escalated ladder has no next step');
  A(advance(r.ladder, T0 + 90 * MIN).fired === null, 'escalated ladder never fires again');

  // THE COLLAPSE RULE: asleep past every step ⇒ exactly one action
  const cold = advance(mk(), T0 + 45 * MIN);
  A(cold.fired === 'emergency', 'cold start past the end fires emergency');
  A(cold.ladder.stepsFired === LADDER_STEPS.length, 'collapse consumes every step');
  A(cold.skipped === 2, 'collapse reports the two skipped retries');
  // and asleep across just the retries collapses to ONE retry, not two
  const nap = advance(mk(), T0 + 16 * MIN);
  A(nap.fired === 'retry' && nap.ladder.stepsFired === 2 && nap.skipped === 1, 'two retries collapse to one');

  // cancel
  const cancelled = cancel(mk(), T0 + MIN);
  A(cancelled.state === 'cancelled' && !isActive(cancelled), "I'm OK cancels");
  A(nextDueAt(cancelled) === null, 'cancelled ladder has no next step');
  A(advance(cancelled, T0 + 99 * MIN).fired === null, 'cancelled ladder never escalates');
  // cancelling at the very last moment still wins
  const late = cancel(mk(), T0 + 29 * MIN);
  A(advance(late, T0 + 30 * MIN).fired === null, 'cancel before the step beats the step');
  // cancelling twice, or after escalation, is a no-op not a crash
  A(cancel(cancelled, T0 + 2 * MIN) === cancelled, 'double cancel is a no-op');
  A(cancel(r.ladder, T0 + 99 * MIN).state === 'escalated', 'cancel cannot undo an escalation');

  // clock skew must never escalate
  A(advance(mk(), T0 - 60 * MIN).fired === null, 'backwards clock fires nothing');
  A(advance(mk(), NaN).fired === null, 'NaN now fires nothing');

  // immutability — callers persist the returned copy
  const before = mk();
  const snapshot = JSON.stringify(before);
  advance(before, T0 + 45 * MIN);
  cancel(before, T0 + MIN);
  A(JSON.stringify(before) === snapshot, 'advance/cancel never mutate their input');

  // audit lines carry their glyph so receivers can ingest them
  const esc = advance(mk(), T0 + 30 * MIN).ladder;
  A(auditRequest(fresh).startsWith(ESCALATION_GLYPH.request), 'request line is glyphed');
  A(auditRetry(advance(mk(), T0 + 5 * MIN).ladder, 0).startsWith(ESCALATION_GLYPH.retry), 'retry line is glyphed');
  A(auditCancelled(cancelled.subjectName).startsWith(ESCALATION_GLYPH.ok), 'cancel line is glyphed');
  A(auditCancelled('Rohan').includes('Rohan'), 'cancel line names the member');
  A(auditEmergency(esc).startsWith(ESCALATION_GLYPH.emergency), 'emergency line is glyphed');
  A(auditRequest(fresh).includes('Asha') && auditRequest(fresh).includes('Rohan'), 'request names both people');
  A(auditRetry(nap.ladder, 1).includes('1 earlier reminder missed'), 'collapse is disclosed in the audit');
  A(auditRetry(nap.ladder, 2).includes('2 earlier reminders missed'), 'plural reads correctly');

  console.log('family/escalation self-check OK');
}
declare const require: any; declare const module: any; declare const process: any;
const _isMain =
  typeof require !== 'undefined' && typeof module !== 'undefined'
    ? require.main === module
    : typeof process !== 'undefined' && /[\\/]escalation\.ts$/.test(String(process.argv?.[1] ?? ''));
if (_isMain) _selfCheck();
