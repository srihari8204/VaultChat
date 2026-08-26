/**
 * lib/media/compress.selftest.ts — npx tsx lib/media/compress.selftest.ts
 *
 * Every case here is one where the naive version costs the user something:
 * an upscaled upload, a needlessly re-encoded screenshot, or a squashed photo.
 */
import assert from 'node:assert/strict';
import {
  targetSize, shouldCompressVideo, MAX_EDGE, JPEG_QUALITY, VIDEO_MIN_BYTES,
} from './compress';

const ratio = (s: { width: number; height: number }) => s.width / s.height;

console.log('\nA big photo is bounded by its LONG edge, whichever way it is turned:');

// 12 MP landscape — the case that motivated this.
const land = targetSize({ width: 4000, height: 3000 })!;
assert.equal(Math.max(land.width, land.height), MAX_EDGE);
console.log(`  ✓ 4000x3000 -> ${land.width}x${land.height}`);
assert.ok(Math.abs(ratio(land) - 4000 / 3000) < 0.01, 'aspect ratio must survive');
console.log('  ✓ aspect ratio preserved (no squash)');

// The same photo held portrait must get the same budget, not a bigger one.
const port = targetSize({ width: 3000, height: 4000 })!;
assert.equal(Math.max(port.width, port.height), MAX_EDGE);
assert.deepEqual([port.width, port.height], [land.height, land.width]);
console.log(`  ✓ 3000x4000 -> ${port.width}x${port.height} (portrait costs the same)`);

// A tall phone panel screenshot: long edge bounded, width follows.
const tall = targetSize({ width: 1080, height: 2340 })!;
assert.equal(tall.height, MAX_EDGE);
console.log(`  ✓ 1080x2340 -> ${tall.width}x${tall.height}`);

console.log('\nLeaving a photo ALONE is a real answer, and the common one:');

// Re-encoding a small JPEG pays generation loss and saves nothing.
assert.equal(targetSize({ width: 1200, height: 900 }), null);
console.log('  ✓ already under the cap -> untouched');
assert.equal(targetSize({ width: MAX_EDGE, height: 900 }), null);
console.log('  ✓ exactly at the cap -> untouched (no off-by-one re-encode)');

// THE EXPENSIVE MISTAKE: upscaling invents pixels AND inflates the upload.
const small = targetSize({ width: 320, height: 240 });
assert.equal(small, null, 'a small image must never be scaled UP');
console.log('  ✓ small image is never upscaled');

// Unknown dimensions must not be guessed at — 0 would mean "resize to nothing".
assert.equal(targetSize({ width: 0, height: 0 }), null);
console.log('  ✓ unknown dimensions -> leave it alone rather than guess');

console.log('\nDegenerate geometry must not produce a zero dimension:');
const sliver = targetSize({ width: 8000, height: 3 })!;
assert.ok(sliver.width >= 1 && sliver.height >= 1, 'no zero-sized output');
console.log(`  ✓ 8000x3 -> ${sliver.width}x${sliver.height} (encoder would reject a 0)`);

console.log('\nVideo is only worth transcoding when there is something to save:');
assert.equal(shouldCompressVideo(VIDEO_MIN_BYTES), true);
console.log(`  ✓ at the ${Math.round(VIDEO_MIN_BYTES / 1024 / 1024)}MB threshold -> compress`);
assert.equal(shouldCompressVideo(50 * 1024 * 1024), true);
console.log('  ✓ a 50MB clip -> compress');
assert.equal(shouldCompressVideo(500 * 1024), false);
console.log('  ✓ a 500KB clip -> left alone (transcode would cost more than it saves)');
assert.equal(shouldCompressVideo(NaN), false);
console.log('  ✓ unknown size -> left alone rather than transcoded on a guess');

console.log('\nQuality knob stays in the sane band:');
assert.ok(JPEG_QUALITY > 0.5 && JPEG_QUALITY < 0.95, 'too low blurs, too high saves nothing');
console.log(`  ✓ JPEG quality ${JPEG_QUALITY}`);

console.log('\nAll media compression checks passed.\n');
