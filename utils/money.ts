// utils/money.ts — exact money arithmetic in paise.
//
// WHY: float rupees cannot represent 2-decimal values exactly, and dividing a
// pot by a member count almost never divides evenly. The old dividend math was
//     round2((bid - commission) / members)
// which ROUNDS EACH SHARE, so the shares stop summing to the pot: ₹1000 across
// 7 members gave ₹142.86 each — ₹1000.02 paid out of a ₹1000 pot. Over a 20-
// month chit that is real money appearing from nowhere in the organizer's book.
//
// Everything here works in integer paise, where arithmetic is exact (JS numbers
// hold integers exactly up to 2^53 — about ₹90 trillion, far past any chit).

/** Rupees → integer paise. Rounds half-up at the paise boundary. */
function tsToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * 100);
}

/** Integer paise → rupees, exact to 2 decimals. */
function tsFromPaise(paise: number): number {
  return Math.round(paise) / 100;
}

export interface Split {
  /** What each part receives (rupees, 2-decimal exact). */
  each: number;
  /** Left over after giving every part `each` (rupees). Always < parts paise. */
  remainder: number;
  /** How many parts the remainder can top up by one paise each. */
  remainderPaise: number;
}

/**
 * Divide `totalRupees` into `parts` shares that NEVER exceed the total.
 *
 * Floors rather than rounds, so the sum of the shares is always ≤ the pot — an
 * organizer must never be told to pay out more than they hold. The shortfall is
 * returned as `remainder` instead of being silently absorbed, so the books
 * still balance: each × parts + remainder === total, exactly.
 */
function tsSplitEvenly(totalRupees: number, parts: number): Split {
  const n = Math.max(1, Math.floor(parts) || 1);
  const total = Math.max(0, tsToPaise(totalRupees));
  const each = Math.floor(total / n);
  const remainderPaise = total - each * n;
  return { each: tsFromPaise(each), remainder: tsFromPaise(remainderPaise), remainderPaise };
}

/** Sum rupee amounts without float drift. */
function tsSumRupees(values: number[]): number {
  return tsFromPaise(values.reduce((acc, v) => acc + tsToPaise(v), 0));
}

// ─── backend seam: TypeScript, or the Rust core (rust/vaultcore, UniFFI) ────
//
// The switch lives HERE, in the module every consumer already imports, rather
// than at the six call sites. app/finance/{index,customer,reports}.tsx,
// app/finance/chitti/[id].tsx and db/* import { splitEvenly, sumRupees, ... }
// from this file and none of them change: flipping the flag moves every screen
// that shows money at once, and a screen added tomorrow is switched already.
// Same shape as services/crypto/index.ts, deliberately — one facade idiom in
// this codebase, not two.
//
// Chosen at module load from EXPO_PUBLIC_MONEY_BACKEND ('ts' | 'rust',
// default 'ts'):
//
//   'ts'   → the implementations above. Default, and the permanent fallback.
//   'rust' → rust/vaultcore's money module, IF the native binding loads. Any
//            failure falls back to TS — money must never be blocked by a
//            missing .so.
//
// Safe to flip because the two are at PROVEN parity: rust/vaultcore/tests/
// parity.rs replays this file's own selftest vectors plus its exhaustive
// property (every pot ₹0–₹2000 in 1-paise steps × 11 member counts).
//
// The binding has since landed: vaultcore's four money ops are forwarded by
// services/crypto/rust/src/ffi.rs, so they ride libvaultcrypto.so — the .so the
// crypto core already puts in the APK. No second module, no second .so.
// EXPO_PUBLIC_MONEY_BACKEND=rust is set in .env as of the 1.2.8 build; this
// seam is what let that be one env var and no diff here.
interface MoneyCore {
  toPaise(rupees: number): number;
  fromPaise(paise: number): number;
  splitEvenly(totalRupees: number, parts: number): Split;
  sumRupees(values: number[]): number;
}

let native: MoneyCore | null = null;

(function selectBackend(): void {
  if (String(process.env.EXPO_PUBLIC_MONEY_BACKEND || 'ts').toLowerCase() !== 'rust') return;
  try {
    // Lazy require so 'ts' sessions and Node test runs never touch native.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require('./native/MoneyCore').initNativeMoney() ? require('./native/MoneyCore') : null;
  } catch {
    native = null;   // no binding in this build — TS stays live, silently
  }
})();

/** Which backend is live — for diagnostics and the selftest. */
export function moneyBackend(): 'ts' | 'rust' {
  return native ? 'rust' : 'ts';
}

export const toPaise = native ? native.toPaise : tsToPaise;
export const fromPaise = native ? native.fromPaise : tsFromPaise;
export const splitEvenly = native ? native.splitEvenly : tsSplitEvenly;
export const sumRupees = native ? native.sumRupees : tsSumRupees;

export default { toPaise, fromPaise, splitEvenly, sumRupees, moneyBackend };

