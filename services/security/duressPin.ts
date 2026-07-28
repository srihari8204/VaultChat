/**
 * Failed / duress PIN tracking → a graded threat signal.
 *
 * A single wrong PIN is noise; repeated consecutive failures suggest
 * brute-force or coercion, escalating toward self-destruct. Injectable storage
 * so it's Node-tested; securityService wires the SecureStore-backed instance.
 */
import { signal, type ThreatSignal } from './threatEngine';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<void>;
  del(key: string): Promise<void>;
}

const COUNT_KEY = 'vc_pin_fail_count';
const HIGH_AT = 3;      // ≥3 consecutive failures → escalate (restrict)
const CRITICAL_AT = 5;  // ≥5 → self-destruct trigger

export interface DuressPinTracker {
  recordFailure(): Promise<number>;
  recordSuccess(): Promise<void>;
  getCount(): Promise<number>;
  getSignal(): Promise<ThreatSignal | null>;
}

export function createDuressPinTracker(store: KV): DuressPinTracker {
  async function readCount(): Promise<number> {
    const raw = await store.get(COUNT_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return {
    async recordFailure(): Promise<number> {
      const n = (await readCount()) + 1;
      await store.set(COUNT_KEY, String(n));
      return n;
    },
    async recordSuccess(): Promise<void> {
      await store.del(COUNT_KEY);
    },
    getCount: readCount,
    async getSignal(): Promise<ThreatSignal | null> {
      const n = await readCount();
      if (n >= CRITICAL_AT) return signal('DURESS_PIN_REPEATED', `${n} consecutive failed PIN entries`, 'critical');
      if (n >= HIGH_AT) return signal('PIN_BRUTEFORCE', `${n} consecutive failed PIN entries`, 'high');
      return null;
    },
  };
}
