// lib/nav/notificationTimeline.ts — per-maneuver approach state machine. Fed the
// distance-to-maneuver on every GPS tick + the soft/medium/strong thresholds from
// adaptiveDistance, it emits each stage's haptic exactly once, in order, then the
// direction-specific pattern AT the turn, then a confirmation after passing.
// Pure + deterministic → tsx-testable; the caller plays whatever event it returns.

import { type HapticEvent } from './hapticLanguage';
import { type TriggerDistances } from './adaptiveDistance';

export type Stage = 'idle' | 'soft' | 'medium' | 'strong' | 'turn' | 'confirm' | 'done';
const ORDER: Stage[] = ['idle', 'soft', 'medium', 'strong', 'turn', 'confirm', 'done'];
const idx = (s: Stage) => ORDER.indexOf(s);

const TURN_POINT_M = 12; // fire the direction pattern within this many metres of the maneuver

export interface TimelineState { stage: Stage; maneuver: HapticEvent }
export function newTimeline(maneuver: HapticEvent): TimelineState { return { stage: 'idle', maneuver }; }

function eventFor(stage: Stage, maneuver: HapticEvent): HapticEvent | null {
  switch (stage) {
    case 'soft': return 'soft';
    case 'medium': return 'medium';
    case 'strong': return 'strong';
    case 'turn': return maneuver;     // the direction-specific pattern
    case 'confirm': return 'confirm';
    default: return null;             // idle / done → nothing
  }
}

function desired(dist: number, t: TriggerDistances, justPassed: boolean, cur: Stage): Stage {
  if (justPassed) {
    if (idx(cur) < idx('turn')) return 'turn';   // passed before we fired the turn → fire it now
    if (cur === 'turn') return 'confirm';
    return 'done';
  }
  if (dist <= TURN_POINT_M) return 'turn';
  if (dist <= t.strong) return 'strong';
  if (dist <= t.medium) return 'medium';
  if (dist <= t.soft) return 'soft';
  return 'idle';
}

/**
 * Advance on a GPS tick. Returns the (possibly new) state and the single event to
 * play now (or null). Approach stages may be skipped if we start close, but the
 * 'turn' (direction) stage is NEVER skipped — so the driver always feels the
 * maneuver pattern even if they blew past the earlier heads-ups.
 */
export function advanceTimeline(
  s: TimelineState, distanceRemaining: number, triggers: TriggerDistances, justPassed = false,
): { state: TimelineState; fire: HapticEvent | null } {
  if (s.stage === 'done') return { state: s, fire: null };
  const want = desired(distanceRemaining, triggers, justPassed, s.stage);
  if (idx(want) <= idx(s.stage)) return { state: s, fire: null }; // no forward progress

  // Don't leap over the direction fire: if we're before 'turn' and want is past it,
  // stop at 'turn' this tick; continue next tick.
  const turnI = idx('turn');
  const next: Stage = (idx(s.stage) < turnI && idx(want) > turnI) ? 'turn' : want;
  return { state: { ...s, stage: next }, fire: eventFor(next, s.maneuver) };
}

// ── self-check: `npx tsx lib/nav/notificationTimeline.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('notificationTimeline: ' + m); };
  const T: TriggerDistances = { soft: 200, medium: 100, strong: 40 };

  // normal approach: fires soft, medium, strong, direction, confirm — once each, in order
  let s = newTimeline('left'); const fired: (HapticEvent | null)[] = [];
  for (const [d, jp] of [[300, false], [150, false], [80, false], [30, false], [10, false], [0, true], [0, true]] as [number, boolean][]) {
    const r = advanceTimeline(s, d, T, jp); s = r.state; fired.push(r.fire);
  }
  A(JSON.stringify(fired) === JSON.stringify([null, 'soft', 'medium', 'strong', 'left', 'confirm', null]), 'ordered fire sequence');
  A(s.stage === 'done', 'ends done');

  // no double-fire when distance holds
  let s2 = newTimeline('right');
  A(advanceTimeline(s2, 150, T).fire === 'soft', 'first soft');
  s2 = advanceTimeline(s2, 150, T).state; // wait — recompute properly
  let r2 = advanceTimeline(newTimeline('right'), 150, T); r2 = advanceTimeline(r2.state, 150, T);
  A(r2.fire === null, 'same bucket does not re-fire');

  // start already close → skip to strong (skips soft/medium), then still get the turn
  let s3 = newTimeline('uturn');
  const a = advanceTimeline(s3, 30, T); A(a.fire === 'strong', 'jumps to strong when starting close');
  const b = advanceTimeline(a.state, 5, T); A(b.fire === 'uturn', 'then fires direction');

  // blew past without approaching → the direction is NOT skipped
  const c = advanceTimeline(newTimeline('left'), 0, T, true);
  A(c.fire === 'left', 'justPassed still fires the turn');
  const d = advanceTimeline(c.state, 0, T, true); A(d.fire === 'confirm', 'then confirm');

  console.log('notificationTimeline self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
