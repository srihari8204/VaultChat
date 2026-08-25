// lib/docs/zoom.selftest.ts — run: npx tsx lib/docs/zoom.selftest.ts
//
// A pinch reports a MULTIPLIER measured from where the fingers started, not an
// absolute zoom. Multiply it against the live zoom instead of the zoom the
// gesture began at and every pinch compounds — one slow pinch runs away to the
// maximum and the reader feels broken. The clamp is what stops a document from
// zooming to nothing or to an unreadable wall, and the quantiser is what keeps
// a 60fps gesture from forcing 60 re-layouts of a long document.

import { MAX_ZOOM, MIN_ZOOM, columnWidth, pinchZoom, zoomLabel } from './zoom';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function near(name: string, actual: number, expected: number) {
  check(name, Math.abs(actual - expected) < 1e-9, `got ${actual}, want ${expected}`);
}

console.log('\nDocument zoom self-test\n');

console.log('A pinch multiplies the zoom it STARTED from:');
near('no pinch leaves the zoom alone', pinchZoom(1, 1), 1);
near('spreading to 2x from 1 gives 2', pinchZoom(1, 2), 2);
near('spreading to 2x from 1.5 gives 3', pinchZoom(1.5, 2), 3);
near('pinching to half from 2 gives 1', pinchZoom(2, 0.5), 1);

console.log('\nIt cannot run away in either direction:');
near('a huge spread stops at the maximum', pinchZoom(2, 100), MAX_ZOOM);
near('a hard pinch stops at the minimum', pinchZoom(1, 0.01), MIN_ZOOM);
check('the maximum is genuinely bigger than the minimum', MAX_ZOOM > MIN_ZOOM);
check('every clamped result stays in range',
  [0.01, 0.5, 1, 1.7, 3, 50].every(sc => {
    const z = pinchZoom(1, sc);
    return z >= MIN_ZOOM - 1e-9 && z <= MAX_ZOOM + 1e-9;
  }));

console.log('\nGarbage from the gesture stream never corrupts the zoom:');
near('NaN is ignored', pinchZoom(1.5, NaN), 1.5);
near('Infinity is ignored, like NaN — a broken frame must not jump the zoom', pinchZoom(1.5, Infinity), 1.5);
near('a zero or negative scale is ignored', pinchZoom(1.2, 0), 1.2);
near('a negative scale is ignored', pinchZoom(1.2, -3), 1.2);

console.log('\nThe result is quantised, so a 60fps pinch is not 60 re-layouts:');
check('nearby scales collapse to the same step',
  pinchZoom(1, 1.501) === pinchZoom(1, 1.509));
check('a step apart is genuinely different',
  pinchZoom(1, 1.5) !== pinchZoom(1, 1.6));
check('every result is a whole number of 5% steps',
  [1, 1.234, 2.717, 0.9].every(sc => Math.abs((pinchZoom(1, sc) * 100) % 5) < 1e-6));

console.log('\nThe pill reads as a percentage:');
check('1 reads 100%', zoomLabel(1) === '100%');
check('1.3 reads 130%', zoomLabel(1.3) === '130%');
check('0.7 reads 70%', zoomLabel(0.7) === '70%');

console.log('\nGrid columns grow with the text, or the cells clip it:');
check('a column is wider when zoomed in', columnWidth(20, 2) > columnWidth(20, 1));
check('a short cell still gets a usable minimum', columnWidth(1, 1) >= 64);
check('one enormous cell cannot take the whole screen', columnWidth(9999, 1) <= 220);
check('the clamp applies BEFORE the zoom, so zoomed grids stay proportional',
  columnWidth(9999, 2) === 440);

console.log(failures === 0 ? '\nAll document zoom checks passed.\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
