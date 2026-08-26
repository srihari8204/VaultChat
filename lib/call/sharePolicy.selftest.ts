/**
 * lib/call/sharePolicy.selftest.ts — npx tsx lib/call/sharePolicy.selftest.ts
 *
 * The share is tuned for text and must STAY that way unless the device proves
 * it cannot afford it. Every case here is one where relaxing too eagerly would
 * soften shared code and slides for no reason.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldRelax, relaxedEncoding, CPU_STRIKES, SCALE_SHARP, SCALE_RELAXED } from './sharePolicy';

console.log('\nRelax only on proven, sustained CPU starvation:');

assert.equal(shouldRelax([]), false);
console.log('  ✓ no samples yet -> stay sharp');
assert.equal(shouldRelax(['cpu']), false);
console.log(`  ✓ one cpu sample is not enough (needs ${CPU_STRIKES})`);
assert.equal(shouldRelax(['cpu', 'cpu']), true);
console.log('  ✓ two consecutive cpu samples -> relax');
assert.equal(shouldRelax(['cpu', 'cpu', 'cpu']), true);
console.log('  ✓ and stays relaxed while it continues');

// A static screen reports 'none', and a bandwidth dip reports 'bandwidth'.
// Neither is a reason to throw away the sharpness this feature exists for.
assert.equal(shouldRelax(['none', 'none']), false);
console.log('  ✓ a quiet/static share is NOT starvation — stays sharp');
assert.equal(shouldRelax(['bandwidth', 'bandwidth']), false);
console.log("  ✓ bandwidth limiting is what 'maintain-resolution' is FOR — stays sharp");

// The streak must be consecutive. A spike during the FLAG_SECURE window at the
// start of every share must not combine with a later unrelated one.
assert.equal(shouldRelax(['cpu', 'none']), false);
console.log('  ✓ recovery breaks the streak');
assert.equal(shouldRelax(['cpu', 'none', 'cpu']), false);
console.log('  ✓ two NON-consecutive spikes do not relax');
assert.equal(shouldRelax(['none', 'cpu', 'cpu']), true);
console.log('  ✓ but a fresh consecutive pair does');

console.log('\nRelaxing must actually reduce encoder load, not just permit it:');
const r = relaxedEncoding();
assert.equal(r.degradationPreference, 'balanced');
console.log("  ✓ 'balanced' lets WebRTC trade resolution for frames");
assert.ok(
  r.scaleResolutionDownBy > SCALE_SHARP,
  'permission alone buys nothing — the pixel count must come down too',
);
console.log(`  ✓ downscale ${SCALE_SHARP} -> ${r.scaleResolutionDownBy}`);

// The whole point: fewer pixels to encode. 2->3 is a real cut, not cosmetic.
const before = 1 / (SCALE_SHARP * SCALE_SHARP);
const after = 1 / (SCALE_RELAXED * SCALE_RELAXED);
assert.ok(after < before * 0.6, 'the pixel cut should be substantial');
console.log(`  ✓ pixels drop to ${Math.round((after / before) * 100)}% of the CPU-saturating size`);

// A phone panel at 1080x2340 still lands well above what a receiving phone
// shows, so this cannot degrade into unreadability.
assert.ok(Math.round(1080 / SCALE_RELAXED) >= 320, 'relaxed width must stay usable');
console.log(`  ✓ 1080x2340 -> ${Math.round(1080 / SCALE_RELAXED)}x${Math.round(2340 / SCALE_RELAXED)}, still above the receiver's display`);

// THE BUG THIS GUARDS. The sampler's 12-tick cap is a LOGGING budget, but it
// used to clear the timer outright — so the adaptation died at 36s too. CPU
// starvation begins when the CONTENT gets busy, which is routinely later than
// that: share a document, open a game two minutes in, and nothing was left
// running to notice.
const room = readFileSync(join(__dirname, 'room.ts'), 'utf8');

console.log('\nThe logging budget must not also cap the adaptation:');
assert.ok(
  !/ticks\s*>\s*\d+\s*\)\s*\{[^}]*clearInterval/.test(room),
  'the tick cap must not clear the timer outright — that stops watching at 36s',
);
console.log('  ✓ the tick cap no longer kills the timer');
assert.ok(room.includes('const logging = ticks <= 12'), 'ticks should gate logging');
console.log('  ✓ ticks gate LOGGING, not watching');
assert.ok(room.includes('!logging && relaxed'), 'watching must end once it has acted');
console.log('  ✓ watching ends once it has acted, or when the share ends');

console.log('\nAll screen-share policy checks passed.\n');
