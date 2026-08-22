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
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * 100);
}

/** Integer paise → rupees, exact to 2 decimals. */
export function fromPaise(paise: number): number {
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
export function splitEvenly(totalRupees: number, parts: number): Split {
  const n = Math.max(1, Math.floor(parts) || 1);
  const total = Math.max(0, toPaise(totalRupees));
  const each = Math.floor(total / n);
  const remainderPaise = total - each * n;
  return { each: fromPaise(each), remainder: fromPaise(remainderPaise), remainderPaise };
}

/** Sum rupee amounts without float drift. */
export function sumRupees(values: number[]): number {
  return fromPaise(values.reduce((acc, v) => acc + toPaise(v), 0));
}

export default { toPaise, fromPaise, splitEvenly, sumRupees };
