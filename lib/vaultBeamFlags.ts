// lib/vaultBeamFlags.ts — the resolved value of VaultBeam's rollout flags.
//
// `constants/flags.ts` keeps the compiled defaults exactly as they are, plain
// `export const`. This is the READ seam: the server's override when there is
// one, the constant otherwise (see lib/remoteFlags.ts).
//
// WHY A SNAPSHOT MATTERS
// ----------------------
// Making a flag dynamic introduces a hazard the constant never had: it can
// change BETWEEN the start of a transfer and its resume. VB_SEAMLESS_RESUME
// decides which segment-plan version a sender writes (v1 legacy vs v2
// canonical), and the two grids are not interchangeable — lib/blockMap
// deliberately returns null for a v1 plan rather than treating it as canonical.
//
// So the flag decides ONCE, when a transfer is created, and the decision is
// persisted with the transfer. A resume replays that decision instead of asking
// the flag again. A dial moved at 3pm must not strand a transfer that started
// at 2pm.

import { VB_SEAMLESS_RESUME } from '../constants/flags';
import { flagEnabled, remoteFlags } from './remoteFlags';

export const VB_SEAMLESS_RESUME_KEY = 'VB_SEAMLESS_RESUME';

/**
 * The live value — for a transfer that is starting NOW. Anything already in
 * flight must use its persisted snapshot instead.
 */
export function seamlessResumeEnabled(): boolean {
  return flagEnabled(VB_SEAMLESS_RESUME_KEY, VB_SEAMLESS_RESUME);
}

/** Has an operator pulled the emergency lever (as opposed to simply not rolling out)? */
export function seamlessResumeKilled(): boolean {
  try { return remoteFlags().isKilled(VB_SEAMLESS_RESUME_KEY); } catch { return false; }
}

/**
 * Refresh the channel at the one moment it matters most: the start of a
 * transfer. A kill switch pulled while the app is open reaches the next
 * transfer rather than waiting for the next cold boot. Cheap — single-flight,
 * and a no-op while the payload is inside its TTL.
 */
export async function refreshVaultBeamFlags(): Promise<void> {
  try { await remoteFlags().refreshIfStale(); } catch { /* compiled default stands */ }
}

/**
 * Replay a transfer's recorded decision. `undefined` means the transfer predates
 * the snapshot (or was never persisted with one), and the only honest answer
 * there is the legacy path: a transfer created before this field existed was
 * created when the flag was off for everyone.
 */
export function seamlessForTransfer(snapshot: boolean | undefined): boolean {
  return snapshot === true;
}

// ── self-check: `npx tsx lib/vaultBeamFlags.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('vaultBeamFlags: ' + m); };

  // A transfer replays its own snapshot, and ONLY an explicit true opts in.
  A(seamlessForTransfer(true) === true, 'a transfer created seamless resumes seamless');
  A(seamlessForTransfer(false) === false, 'a transfer created legacy resumes legacy');
  A(seamlessForTransfer(undefined) === false, 'a transfer with no snapshot resumes LEGACY');
  // A truthy-but-not-true value must not opt a transfer in. This is the shape a
  // JSON round-trip through AsyncStorage can produce, and guessing wrong here
  // would put a v1 transfer on the canonical grid.
  A(seamlessForTransfer('true' as any) === false, 'a non-boolean snapshot is not an opt-in');
  A(seamlessForTransfer(1 as any) === false, 'a truthy non-boolean is not an opt-in');

  // With no remote payload loaded, the live read is the compiled constant.
  A(seamlessResumeEnabled() === VB_SEAMLESS_RESUME, 'no remote payload ⇒ the compiled constant');
  A(seamlessResumeKilled() === false, 'nothing is killed until the server says so');

  console.log('vaultBeamFlags self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
