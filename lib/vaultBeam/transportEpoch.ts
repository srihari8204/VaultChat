// lib/vaultBeam/transportEpoch.ts — which transport attempt is still allowed to speak.
//
// # THE RACE THIS CLOSES
//
// `receiveDirect` runs each tier under a stall guard:
//
//     await Promise.race([ p2pReceive(...), guard.promise ])
//
// When the guard wins, the race resolves 'stalled' and the caller moves on to
// the relay — but `p2pReceive` IS NOT CANCELLED BY LOSING A RACE. Its promise
// never settles, so its own `finally { pc.close() }` never runs. The datachannel
// stays open and `dc.onmessage` keeps firing, which means a tier the controller
// has already abandoned continues to:
//
//   * write chunks into the same dstPath the relay tier is now writing, and
//   * call onProgress -> setState({ tier: 'direct', done: <its own count> })
//
// The bytes are identical (positional + GCM-verified on both paths), so this
// does not corrupt the file. What it corrupts is STATE: the displayed tier flips
// back to direct and `done` regresses, because the abandoned tier's counter is
// behind the relay's.
//
// An epoch is the smallest thing that fixes it. Each transport attempt takes a
// generation number; a callback carrying a stale generation is dropped instead
// of applied. The abandoned tier can keep talking — nobody is listening.
//
// # WHY NOT JUST TEAR THE TIER DOWN?
//
// We do that too, and it is the better fix for the wasted work. But teardown is
// inherently racy: a message already dispatched to the event loop still lands
// after `close()`. Teardown reduces the window; the epoch closes it. Only the
// epoch makes "a stale tier cannot mutate state" a property rather than a hope.
//
// # DELIBERATELY NOT AUTHORITATIVE
//
// This orders TRANSPORT ATTEMPTS. It is not transfer state, it is never
// persisted, and it says nothing about which chunks exist — the bitmap remains
// the only source of truth for that. After a restart every epoch is gone and
// the work-list is rebuilt from the bitmap, exactly as before.
//
// PURE — no react-native, no storage. `npx tsx lib/vaultBeam/transportEpoch.ts`.

const epochs = new Map<string, number>();

/**
 * Open a new transport attempt and return its epoch.
 *
 * Monotonic per transfer, starting at 1. Call this immediately BEFORE starting
 * a tier, and capture the returned value in that tier's callbacks.
 */
export function beginEpoch(transferId: string): number {
  if (!transferId) return 0;
  const next = (epochs.get(transferId) ?? 0) + 1;
  epochs.set(transferId, next);
  return next;
}

/** The epoch currently allowed to mutate state, or 0 if the transfer is unknown. */
export function currentEpoch(transferId: string): number {
  return epochs.get(transferId) ?? 0;
}

/**
 * May a callback from `epoch` still act?
 *
 * Fails closed: an unknown transfer, a non-number, a zero/negative epoch and any
 * epoch behind the current one all return false. A tier that cannot prove it is
 * current does not get to write.
 */
export function isCurrent(transferId: string, epoch: number): boolean {
  if (!transferId) return false;
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch < 1) return false;
  const cur = epochs.get(transferId);
  return cur !== undefined && epoch === cur;
}

/**
 * Wrap a callback so it only runs while `epoch` is current.
 *
 * The call site then reads as the guarantee itself, which is harder to get wrong
 * than remembering an `if` at the top of every handler.
 */
export function guard<A extends unknown[]>(
  transferId: string,
  epoch: number,
  fn: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => { if (isCurrent(transferId, epoch)) fn(...args); };
}

/** Forget a finished transfer. A later callback from it is then stale by definition. */
export function endTransfer(transferId: string): void {
  epochs.delete(transferId);
}

/** Test/diagnostic only. */
export function __size(): number { return epochs.size; }

export default { beginEpoch, currentEpoch, isCurrent, guard, endTransfer };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  console.log('\nVaultBeam transport epoch\n');

  // ── monotonic ────────────────────────────────────────────────────
  const e1 = beginEpoch('T1');
  A(e1 === 1, '1. the first transport attempt is epoch 1');
  const e2 = beginEpoch('T1');
  A(e2 === 2, '2. the next attempt increments');
  A(currentEpoch('T1') === 2, '3. current tracks the latest attempt');

  // ── the actual race ──────────────────────────────────────────────
  A(!isCurrent('T1', e1), '4. the abandoned DIRECT tier is no longer current');
  A(isCurrent('T1', e2), '5. the RELAY tier that replaced it is');

  let applied = 0;
  const staleCb = guard('T1', e1, () => { applied++; });
  const liveCb = guard('T1', e2, () => { applied++; });
  staleCb(); staleCb(); staleCb();
  A(applied === 0, '6. a stalled tier can fire forever and mutate nothing');
  liveCb();
  A(applied === 1, '7. the current tier still works normally');

  // Progress regression is the symptom this exists to prevent.
  let shown = 0;
  const setDone = (n: number) => { shown = n; };
  const relay = guard('T1', e2, setDone);
  const direct = guard('T1', e1, setDone);
  relay(500); direct(12);
  A(shown === 500, '8. a late direct callback cannot walk progress backwards');

  // ── fails closed ─────────────────────────────────────────────────
  A(!isCurrent('unknown', 1), '9. an unknown transfer is never current');
  A(!isCurrent('T1', 0) && !isCurrent('T1', -1), '10. zero and negative epochs are rejected');
  A(!isCurrent('T1', 99), '11. an epoch from the future is rejected too');
  A(!isCurrent('', 1), '12. an empty transfer id is rejected');
  for (const bad of [NaN, Infinity, undefined, null, '2', {}, []]) {
    A(!isCurrent('T1', bad as number), `13. a malformed epoch (${String(bad)}) is rejected`);
  }
  A(beginEpoch('') === 0, '14. an empty transfer id yields no epoch');

  // ── independent per transfer ─────────────────────────────────────
  const o1 = beginEpoch('T2');
  A(o1 === 1, '15. a different transfer starts its own sequence');
  A(isCurrent('T1', 2) && isCurrent('T2', 1),
    '16. and the two do not interfere');

  // ── cleanup ──────────────────────────────────────────────────────
  endTransfer('T1');
  A(!isCurrent('T1', 2), '17. after cleanup, even the last epoch is stale');
  A(beginEpoch('T1') === 1, '18. a fresh transfer with the same id restarts at 1');
  endTransfer('T1'); endTransfer('T2');
  A(__size() === 0, '19. nothing is left behind');

  // ── never throws ─────────────────────────────────────────────────
  let threw = false;
  try {
    guard('T3', 1, () => { throw new Error('handler blew up'); })();  // stale ⇒ not called
    endTransfer('nope'); isCurrent('nope', 1);
  } catch { threw = true; }
  A(!threw, '20. guarding a stale callback never invokes it, so it cannot throw');

  console.log(failures === 0
    ? '\nALL TRANSPORT-EPOCH CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
