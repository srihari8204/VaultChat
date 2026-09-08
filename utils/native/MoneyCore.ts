/**
 * utils/native/MoneyCore.ts — typed surface over the Rust money core.
 *
 * The implementation is `rust/vaultcore`'s `money` module — the UniFFI core,
 * proven at parity with utils/money.ts by rust/vaultcore/tests/parity.rs
 * (that file's own vectors plus every pot ₹0–₹2000 in 1-paise steps across 11
 * member counts).
 *
 * WHY THIS RIDES THE CryptoCore HYBRID OBJECT
 * -------------------------------------------
 * UniFFI's own host bindings are Kotlin/Swift, which on Android means
 * generated Kotlin plus a JNA dependency plus a second gradle module, a second
 * .so and a second Expo config plugin — several megabytes of machinery for four
 * arithmetic functions. This app already ships a Rust↔JS bridge: the Nitro
 * HybridObject "CryptoCore", whose whole ABI is one sync JSI method,
 * `call(op, argsJson) → responseJson`. crypto-core takes vaultcore as a path
 * dependency and forwards four ops, so the money core arrives inside the .so
 * that is already in the APK.
 *
 * vaultcore's `#[uniffi::export]` surface is untouched — that is what an
 * iOS/Swift consumer binds to, and what the parity suite exercises.
 *
 * Nothing imports this file except utils/money.ts, which owns backend
 * selection and the TS fallback. initNativeMoney() never throws.
 */
import type { Split } from '../money';

interface NativeCryptoCore {
  call(op: string, argsJson: string): string;
}

let native: NativeCryptoCore | null = null;
let initError: string | null = null;

/**
 * Bind the native bridge and PROVE it does money correctly before letting it
 * near an organizer's book. Never throws; safe to re-call.
 *
 * The probe is the ₹1000-across-7 case, which is the exact bug this core
 * exists for: it must floor to ₹142.85 with 5 paise left over, and the shares
 * plus the remainder must add back to the pot. A binding that answers anything
 * else is refused here, and utils/money.ts stays on TS.
 */
export function initNativeMoney(): boolean {
  if (native) return true;
  if (initError !== null) return false;
  try {
    // Lazy require: Node test runs and TS-backend sessions never touch native.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules');
    const obj = NitroModules.createHybridObject('CryptoCore') as unknown as NativeCryptoCore;

    const resp = JSON.parse(obj.call('splitEvenly', JSON.stringify({ totalRupees: 1000, parts: 7 })));
    if (!resp.ok) throw new Error(resp.error || 'money-core: probe failed');
    const s = resp.result as Split;
    const exact = Math.round(s.each * 100) * 7 + s.remainderPaise === 100000;
    if (s.each !== 142.85 || s.remainderPaise !== 5 || !exact) {
      throw new Error(`money-core: probe returned ${JSON.stringify(s)}`);
    }

    native = obj;
    return true;
  } catch (e) {
    initError = String((e as Error)?.message || e);
    return false;
  }
}

/** Why init failed (for diagnostics), or null. */
export function nativeMoneyInitError(): string | null {
  return initError;
}

function invoke(op: string, args: unknown): any {
  if (!native) throw new Error('money-core: native module not initialised');
  const resp = JSON.parse(native.call(op, JSON.stringify(args)));
  if (!resp.ok) throw new Error(resp.error || 'money-core: unknown native error');
  return resp.result;
}

// ── the four ops, same signatures as utils/money.ts ────────────────────

export function toPaise(rupees: number): number {
  // Non-finite is 0 in the TS impl and would be a rejected argument natively;
  // keep the TS contract at the boundary so the backends are interchangeable.
  if (!Number.isFinite(rupees)) return 0;
  return invoke('toPaise', { rupees });
}

export function fromPaise(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return invoke('fromPaise', { paise: Math.round(paise) });
}

export function splitEvenly(totalRupees: number, parts: number): Split {
  const n = Math.max(1, Math.floor(parts) || 1);
  const total = Number.isFinite(totalRupees) ? Math.max(0, totalRupees) : 0;
  return invoke('splitEvenly', { totalRupees: total, parts: n });
}

export function sumRupees(values: number[]): number {
  return invoke('sumRupees', { values: values.map(v => (Number.isFinite(v) ? v : 0)) });
}

export default { initNativeMoney, nativeMoneyInitError, toPaise, fromPaise, splitEvenly, sumRupees };
