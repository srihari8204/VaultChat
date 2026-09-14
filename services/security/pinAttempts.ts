/**
 * Failed-PIN tracking → a graded threat signal.
 *
 * WAS services/security/duressPin.ts. The duress/decoy vault it was named for
 * is gone (it was never wired to any real lock screen — typing the duress PIN
 * produced "Incorrect PIN. Try again.", which tells a coercer they were handed
 * a false PIN). What remains is the part that was always genuinely useful:
 * noticing that somebody is guessing.
 *
 * TWO DELIBERATE CHANGES FROM THE OLD BEHAVIOUR, both of which were hazards:
 *
 * 1. NO WIPE. The old tracker escalated to `critical` at 5 failures, and
 *    `critical` means instant self-destruct. That hands any passer-by a
 *    denial-of-service — type nonsense at a locked phone until it erases
 *    itself — and destroys data on a pocket-dial or a child with the handset.
 *    It now reports `high`, which restricts; escalating to a wipe requires a
 *    second, independent indicator (root, Frida, a hooking framework).
 *
 * 2. FAILURES DECAY. The old counter had no time window, so three wrong
 *    entries on Monday and two on Friday looked identical to five in a row —
 *    a user who is simply bad at remembering their PIN eventually tripped the
 *    alarm by accident. Consecutive means consecutive IN TIME.
 *
 * Injectable storage so it's Node-tested; securityService wires the
 * SecureStore-backed instance.
 */
import { signal, type ThreatSignal } from './threatEngine';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<void>;
  del(key: string): Promise<void>;
}

const STATE_KEY = 'vc_pin_fail_state';
const HIGH_AT = 3;             // >=3 consecutive failures → escalate (restrict)
const DECAY_MS = 15 * 60_000;  // a gap this long means the streak is over

/** Delay before the next attempt is accepted, indexed by streak length. The
 *  lock screen is expected to honour this; it is the cheap half of resisting a
 *  guessing attack, and unlike a wipe it costs an innocent user only time. */
const BACKOFF_MS = [0, 0, 1_000, 5_000, 15_000, 30_000, 60_000];

export function backoffFor(count: number): number {
  if (count <= 0) return 0;
  return BACKOFF_MS[Math.min(count, BACKOFF_MS.length - 1)];
}

interface FailState { n: number; at: number }

export interface PinAttemptTracker {
  recordFailure(): Promise<number>;
  recordSuccess(): Promise<void>;
  getCount(): Promise<number>;
  /** Milliseconds the caller should refuse to accept another attempt for. */
  getBackoffMs(): Promise<number>;
  getSignal(): Promise<ThreatSignal | null>;
}

export function createPinAttemptTracker(store: KV, now: () => number = Date.now): PinAttemptTracker {
  async function readState(): Promise<FailState> {
    const raw = await store.get(STATE_KEY);
    if (!raw) return { n: 0, at: 0 };
    try {
      const p = JSON.parse(raw) as FailState;
      const n = Number.isFinite(p?.n) && p.n > 0 ? p.n : 0;
      const at = Number.isFinite(p?.at) && p.at > 0 ? p.at : 0;
      // A long quiet gap ends the streak — see note 2 above.
      if (!n || now() - at > DECAY_MS) return { n: 0, at: 0 };
      return { n, at };
    } catch {
      // Legacy shape: the bare count written by the old tracker. No timestamp,
      // so it cannot be aged — treat it as a fresh streak rather than dropping
      // it, and it decays normally from here.
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? { n, at: now() } : { n: 0, at: 0 };
    }
  }

  return {
    async recordFailure(): Promise<number> {
      const cur = await readState();
      const next: FailState = { n: cur.n + 1, at: now() };
      await store.set(STATE_KEY, JSON.stringify(next));
      return next.n;
    },
    async recordSuccess(): Promise<void> {
      await store.del(STATE_KEY);
    },
    async getCount(): Promise<number> {
      return (await readState()).n;
    },
    async getBackoffMs(): Promise<number> {
      const { n, at } = await readState();
      const owed = backoffFor(n) - (now() - at);
      return owed > 0 ? owed : 0;
    },
    async getSignal(): Promise<ThreatSignal | null> {
      const { n } = await readState();
      if (n >= HIGH_AT) return signal('PIN_BRUTEFORCE', `${n} consecutive failed PIN entries`, 'high');
      return null;
    },
  };
}
