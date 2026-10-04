// run: npx tsx lib/imageEditMath.selftest.ts
import assert from 'node:assert/strict';
import {
  IDENTITY, compose, editMatrix, brightnessMatrix, contrastMatrix,
  containFrame, initialCrop, moveCrop, resizeCrop, toImageCrop, MIN_CROP,
} from './imageEditMath';

let n = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
const near = (a: number, b: number, m: string) => ok(Math.abs(a - b) < 1e-3, `${m}: ${a} vs ${b}`);
// Apply a 4x5 matrix to an RGBA pixel (0..1).
const apply = (m: number[], p: number[]) => [0, 1, 2, 3].map((r) =>
  m[r * 5] * p[0] + m[r * 5 + 1] * p[1] + m[r * 5 + 2] * p[2] + m[r * 5 + 3] * p[3] + m[r * 5 + 4]);

// Colour
ok(editMatrix('Original', 0, 0) === null, 'no edit → null (plain image)');
assert.deepEqual(compose(IDENTITY, IDENTITY), IDENTITY); n++;
const bw = editMatrix('B&W', 0, 0)!;
const grey = apply(bw, [1, 0, 0, 1]);
near(grey[0], grey[1], 'B&W: R==G'); near(grey[1], grey[2], 'B&W: G==B');
near(apply(bw, [1, 1, 1, 1])[0], 1, 'B&W keeps white white');
near(apply(brightnessMatrix(50), [0.4, 0.4, 0.4, 1])[0], 0.6, 'brightness +50 = ×1.5');
near(apply(contrastMatrix(50), [0.5, 0.5, 0.5, 1])[0], 0.5, 'contrast pivots on mid-grey');
near(apply(contrastMatrix(50), [0.7, 0.7, 0.7, 1])[0], 0.8, 'contrast +50 stretches');
// Order: filter, then brightness — B&W of pure red, then ×1.5.
const both = editMatrix('B&W', 50, 0)!;
near(apply(both, [1, 0, 0, 1])[0], 0.2126 * 1.5, 'filter then brightness');
near(apply(both, [1, 0, 0, 1])[3], 1, 'alpha untouched');
ok(editMatrix('Warm', 0, 0)!.length === 20, '20 values');

// Crop
const f = containFrame(400, 300, 2000, 1000);   // wide image: letterboxed top/bottom
near(f.w, 400, 'contain width'); near(f.h, 200, 'contain height'); near(f.y, 50, 'contain y');
assert.deepEqual(containFrame(0, 300, 10, 10), { x: 0, y: 0, w: 0, h: 300 }); n++;
const sq = initialCrop(f, 1);
near(sq.w, 200, '1:1 fits height'); near(sq.x, 100, '1:1 centred');
assert.deepEqual(initialCrop(f, null), f); n++;
const moved = moveCrop(sq, 1000, -1000, f);
near(moved.x, 200, 'move clamps right'); near(moved.y, 50, 'move clamps top');
const grown = resizeCrop(initialCrop(f, null), 'tl', 50, 20, null, f);
near(grown.x, 50, 'tl moves x'); near(grown.y, 70, 'tl moves y');
near(grown.x + grown.w, 400, 'tl keeps right edge'); near(grown.y + grown.h, 250, 'tl keeps bottom edge');
const tiny = resizeCrop(sq, 'br', -1000, -1000, null, f);
near(tiny.w, MIN_CROP, 'min width'); near(tiny.h, MIN_CROP, 'min height'); near(tiny.x, sq.x, 'br keeps x');
const locked = resizeCrop(sq, 'br', 100, 0, 1, f);
near(locked.w, locked.h, 'ratio held');
ok(locked.y + locked.h <= f.y + f.h + 1e-6, 'ratio box stays inside frame');
const px = toImageCrop(sq, f, 2000, 1000);
assert.deepEqual(px, { originX: 500, originY: 0, width: 1000, height: 1000 }); n++;
const edge = toImageCrop({ x: 399, y: 249, w: 50, h: 50 }, f, 2000, 1000);
ok(edge.originX + edge.width <= 2000 && edge.originY + edge.height <= 1000, 'crop stays inside image');

console.log(`imageEditMath selftest: ${n} checks passed`);
