/**
 * lib/typeScale.selftest.ts
 *   run with: npx tsx lib/typeScale.selftest.ts
 *
 * The property that matters most here is a NEGATIVE one: dropping a type scale
 * into a 193-screen app must not move a single pixel on the devices people are
 * already using. Every phone width in the ordinary range must return exactly 1,
 * and the first test asserts that across the whole range rather than at a
 * couple of hand-picked points.
 */
import assert from 'node:assert/strict';
import { typeScale, scaleType, NARROW_DP, MIN_SCALE, MAX_SCALE } from './typeScale';
import { TABLET_MIN_DP } from './responsive';

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

// ── The whole ordinary phone range is untouched ──────────────────────
// 360-599dp covers essentially every phone in use, including both test
// devices (369dp Honor, 392dp Redmi). If any of these ever returns != 1,
// adopting this module silently restyles the entire app.
for (let w = NARROW_DP; w < TABLET_MIN_DP; w++) {
  ok(`phone width ${w}dp must be untouched`, typeScale(w) === 1);
}
ok('the Honor (369dp) is untouched', typeScale(369) === 1);
ok('the Redmi (392dp) is untouched', typeScale(392) === 1);

// ── Narrow devices shrink, but only a little, and never past the floor ──
ok('320dp shrinks', typeScale(320) < 1);
ok('320dp respects the floor', typeScale(320) >= MIN_SCALE);
ok('a 1dp screen does not vanish', typeScale(1) === MIN_SCALE);
ok('359dp shrinks barely', typeScale(359) < 1 && typeScale(359) > 0.99);

// ── Tablets grow, gently, and never past the ceiling ─────────────────
ok('exactly at the tablet threshold nothing jumps', typeScale(TABLET_MIN_DP) === 1);
ok('800dp grows', typeScale(800) > 1);
ok('800dp respects the ceiling', typeScale(800) <= MAX_SCALE);
ok('an absurd 5000dp is still capped', typeScale(5000) === MAX_SCALE);

// Continuity at the boundary: a foldable crossing 600dp mid-animation must not
// snap. Growth per dp is gentle enough that one dp either side is invisible.
ok('no jump across the tablet boundary',
   Math.abs(typeScale(TABLET_MIN_DP + 1) - typeScale(TABLET_MIN_DP)) < 0.01);

// ── Monotonic: wider never yields smaller type ───────────────────────
let prev = 0;
for (let w = 200; w <= 1400; w += 7) {
  const k = typeScale(w);
  ok(`monotonic at ${w}dp`, k >= prev - 1e-9);
  prev = k;
}

// ── Garbage in never produces garbage type ───────────────────────────
// Dimensions legitimately reports 0 mid-rotation, and NaN has been seen on
// some Android split-screen transitions. A NaN fontSize renders nothing at
// all — a blank screen, not a small one.
for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
  ok(`width ${String(bad)} falls back to 1`, typeScale(bad as number) === 1);
}

// ── scaleType keeps the type ratios and returns whole line heights ───
const body = { fontSize: 15, lineHeight: 21 };
const same = scaleType(body, 392);
ok('untouched width returns the exact original numbers',
   same.fontSize === 15 && same.lineHeight === 21);

const big = scaleType(body, 900);
ok('tablet grows the font', big.fontSize > 15);
ok('tablet grows the line height', big.lineHeight > 21);
ok('line height stays a whole number', Number.isInteger(big.lineHeight));
// The ratio is what makes text look set rather than stretched.
const ratioBefore = body.lineHeight / body.fontSize;
const ratioAfter = big.lineHeight / big.fontSize;
ok(`line-height ratio preserved (${ratioBefore.toFixed(2)} -> ${ratioAfter.toFixed(2)})`,
   Math.abs(ratioAfter - ratioBefore) < 0.06);

for (const bad of [0, NaN]) {
  const r = scaleType(body, bad as number);
  ok(`scaleType survives width ${String(bad)}`, r.fontSize === 15 && r.lineHeight === 21);
}

console.log(`typeScale selftest: OK (${n} checks)`);
console.log(`  phones ${NARROW_DP}-${TABLET_MIN_DP - 1}dp: unchanged at 1.0`);
console.log(`  320dp -> ${typeScale(320).toFixed(3)}   800dp -> ${typeScale(800).toFixed(3)}   capped at ${MAX_SCALE}`);
