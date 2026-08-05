// lib/vaultBeam/gate.ts — availability gating for the seamless engine.
//
// The manager picks the cheapest AVAILABLE driver. Direct transports are not
// available until negotiation produces a channel or a LAN endpoint, and that
// takes a moment — so without gating the relay (always reachable) would win the
// first round every time and the direct tiers would never get a chance.
//
// Two tiny wrappers express the policy, and being pure they are testable:
//   • gateUntilReady — a driver that is unavailable until its transport exists
//   • graceGate      — a driver held back for a short window, released early the
//                      moment the direct attempt is known to have failed
//
// Neither wrapper touches progress, work-lists or bitmaps; they only answer
// `available()` differently. Everything else passes straight through.

import { type TransportDriver } from './drivers/types';
import { TransferSession } from './session';

/** Wrap a driver so it is unavailable until `isReady()` returns true. */
export function gateUntilReady(inner: TransportDriver, isReady: () => boolean): TransportDriver {
  return {
    id: inner.id,
    cost: inner.cost,
    channel: inner.channel,
    unitChunks: (s: TransferSession) => inner.unitChunks(s),
    available: async (s: TransferSession) => (isReady() ? inner.available(s) : false),
    run: (s, w, r, sig) => inner.run(s, w, r, sig),
    dispose: () => inner.dispose(),
  };
}

export interface GraceOpts {
  /** How long to hold the driver back, giving cheaper transports a chance. */
  graceMs: number;
  now: () => number;
  /** Release early: the direct attempt is settled, so waiting buys nothing. */
  isReleased: () => boolean;
  /** Start of the grace window. */
  startedAt: number;
}

/**
 * Hold a driver back for a grace window. The relay is always reachable, so
 * without this it would win the first scheduling round before LAN/P2P had time
 * to negotiate — and the fallback ladder would collapse to "always relay".
 *
 * The window is a floor, not a ceiling: `isReleased()` short-circuits it the
 * instant the direct attempt is known to be settled, so a peer that is simply
 * offline costs the grace period once, not on every round.
 */
export function graceGate(inner: TransportDriver, o: GraceOpts): TransportDriver {
  return {
    id: inner.id,
    cost: inner.cost,
    channel: inner.channel,
    unitChunks: (s: TransferSession) => inner.unitChunks(s),
    available: async (s: TransferSession) => {
      const elapsed = o.now() - o.startedAt;
      if (!o.isReleased() && elapsed < o.graceMs) return false;
      return inner.available(s);
    },
    run: (s, w, r, sig) => inner.run(s, w, r, sig),
    dispose: () => inner.dispose(),
  };
}

// ── self-check: `npx tsx lib/vaultBeam/gate.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('gate: ' + m); };
  const CHUNK = 512 * 1024;

  let ran = 0, disposed = 0, unitAsked = 0;
  const inner: TransportDriver = {
    id: 'relay', cost: 30, channel: 'relay',
    unitChunks: () => { unitAsked++; return 8; },
    available: async () => true,
    run: async () => { ran++; return { kind: 'drained' }; },
    dispose: () => { disposed++; },
  };
  const s = new TransferSession({
    transferId: 'Tgate12345678901', sessionVersion: 1, fileId: 'F', keyB64: 'k',
    role: 'sender', totalBytes: 4 * CHUNK,
  });

  const run = async () => {
    // gateUntilReady
    let ready = false;
    const gated = gateUntilReady(inner, () => ready);
    A((await gated.available(s)) === false, 'unavailable before its transport exists');
    ready = true;
    A((await gated.available(s)) === true, 'available once the transport exists');
    A(gated.id === 'relay' && gated.cost === 30 && gated.channel === 'relay', 'identity passes through');
    A(gated.unitChunks(s) === 8 && unitAsked === 1, 'unitChunks passes through');
    await gated.run(s, [], { verified: () => {}, staged: () => {} }, new AbortController().signal);
    A(ran === 1, 'run passes through');
    gated.dispose();
    A(disposed === 1, 'dispose passes through');

    // graceGate: held back, then released by time
    let t = 1000;
    let released = false;
    const graced = graceGate(inner, { graceMs: 500, now: () => t, isReleased: () => released, startedAt: t });
    A((await graced.available(s)) === false, 'held back during the grace window');
    t += 200;
    A((await graced.available(s)) === false, 'still held back mid-window');
    t += 400;
    A((await graced.available(s)) === true, 'available once the window elapses');

    // …and released EARLY when the direct attempt is settled
    t = 1000; released = false;
    const graced2 = graceGate(inner, { graceMs: 5000, now: () => t, isReleased: () => released, startedAt: t });
    A((await graced2.available(s)) === false, 'held back while direct is still trying');
    released = true;
    A((await graced2.available(s)) === true, 'released the moment direct settles, without waiting out the window');

    // a gate must never mask the inner driver saying no
    const never = graceGate(
      { ...inner, available: async () => false },
      { graceMs: 0, now: () => 0, isReleased: () => true, startedAt: 0 },
    );
    A((await never.available(s)) === false, 'an unavailable inner driver stays unavailable');

    console.log('vaultBeam/gate self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
