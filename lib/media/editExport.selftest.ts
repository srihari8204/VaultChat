// lib/media/editExport.selftest.ts — run: npx tsx lib/media/editExport.selftest.ts
import assert from 'node:assert/strict';
import { containFrame, toImageCrop } from '../imageEditMath';
import { EXPORT_MAX_EDGE, exportSize, mapForCrop, mapForRotate90, scaleCrop, toExport } from './editExport';

const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

// ── exportSize: the photo's own pixels, bounded, never upscaled ──
assert.deepEqual(exportSize(4000, 3000), { w: 4000, h: 3000 });
assert.deepEqual(exportSize(1080, 1920), { w: 1080, h: 1920 });
assert.deepEqual(exportSize(8000, 6000), { w: EXPORT_MAX_EDGE, h: 3072 });
assert.deepEqual(exportSize(0, 100), { w: 0, h: 0 });

// A 4000×3000 photo on a 400×440 canvas: frame is 400×300 at y=70.
const CW = 400, CH = 440;
const f0 = containFrame(CW, CH, 4000, 3000);
near(f0.y, 70, 'frame y');

// ── crop: the overlay stays on the same photo content ──
// Crop the right half (image x 2000..4000). A stroke point on image pixel
// (3000, 1500) is canvas (300, 220); after the crop it is the middle of the
// new 2000×3000 image.
const crop = toImageCrop({ x: 200, y: 70, w: 200, h: 300 }, f0, 4000, 3000);
assert.deepEqual(crop, { originX: 2000, originY: 0, width: 2000, height: 3000 });
const f1 = containFrame(CW, CH, crop.width, crop.height);
const mc = mapForCrop(f0, 4000, crop, f1);
const p1 = mc.pt({ x: 300, y: 220 });
near(p1.x, f1.x + f1.w / 2, 'crop x');
near(p1.y, f1.y + f1.h / 2, 'crop y');
// Lengths scale with the photo: 1 canvas unit was 10 image px, now 3000/f1.h.
near(mc.scale, (f1.w / 2000) / (400 / 4000), 'crop scale');

// ── rotate 90° clockwise: top-left of the photo goes to the top-right ──
const f2 = containFrame(CW, CH, 3000, 4000);
const mr = mapForRotate90(f0, 4000, 3000, f2);
const tl = mr.pt({ x: f0.x, y: f0.y });
near(tl.x, f2.x + f2.w, 'rot tl.x');
near(tl.y, f2.y, 'rot tl.y');
const br = mr.pt({ x: f0.x + f0.w, y: f0.y + f0.h });
near(br.x, f2.x, 'rot br.x');
near(br.y, f2.y + f2.h, 'rot br.y');
// Four rotations bring every point home.
let q = { x: 123, y: 200 };
let fr = f0, w = 4000, h = 3000;
for (let i = 0; i < 4; i++) {
  const nf = containFrame(CW, CH, h, w);
  q = mapForRotate90(fr, w, h, nf).pt(q);
  fr = nf; [w, h] = [h, w];
}
near(q.x, 123, 'four turns x');
near(q.y, 200, 'four turns y');

// ── export: the frame becomes the whole output ──
const e = toExport({ x: f0.x + f0.w, y: f0.y + f0.h }, f0, 4000);
near(e.x, 4000, 'export x');
near(e.y, 3000, 'export y');

// ── scaleCrop: grows about the centre, keeps the ratio, stays in the photo ──
const frame = { x: 0, y: 70, w: 400, h: 300 };
const box = { x: 150, y: 170, w: 100, h: 100 };
const big = scaleCrop(box, 1.5, frame, 1);
near(big.w, 150, 'grow w'); near(big.h, 150, 'grow h');
near(big.x + big.w / 2, 200, 'grow centred');
const huge = scaleCrop(box, 10, frame, 1);
near(huge.w, 300, 'fit w'); near(huge.h, 300, 'fit h');
assert.ok(huge.x >= frame.x && huge.y >= frame.y && huge.y + huge.h <= frame.y + frame.h + 1e-9, 'inside the photo');
const tiny = scaleCrop(box, 0.01, frame, null);
near(tiny.w, 40, 'min w'); near(tiny.h, 40, 'min h');

console.log('editExport selftest: all passed');
