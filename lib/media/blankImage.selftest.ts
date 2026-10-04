// lib/media/blankImage.selftest.ts — run: npx tsx lib/media/blankImage.selftest.ts
import assert from 'node:assert/strict';
import { zlibSync } from 'fflate';
import { decodeSmallPng, exportLooksBlank, isUniformPng } from './blankImage';

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** A w×h 8-bit PNG; `pixel(x,y)` gives the channel bytes; rows use `filter`. */
function png(w: number, h: number, color: 2 | 6, pixel: (x: number, y: number) => number[], filter = 0): Uint8Array {
  const bpp = color === 6 ? 4 : 3, stride = w * bpp;
  const plain = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) plain.set(pixel(x, y), y * stride + x * bpp);
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const cur = plain[y * stride + x];
      const a = x >= bpp ? plain[y * stride + x - bpp] : 0;
      const b = y > 0 ? plain[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? plain[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth : 0;
      raw[y * (stride + 1) + 1 + x] = (cur - pred) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = color;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A capture that came back black (opaque or transparent) is uniform.
assert.equal(isUniformPng(png(8, 8, 6, () => [0, 0, 0, 255])), true);
assert.equal(isUniformPng(png(8, 8, 6, () => [0, 0, 0, 0])), true);
assert.equal(isUniformPng(png(8, 8, 2, () => [0, 0, 0], 2)), true);
// A photo-like image is not, whatever row filter the encoder chose.
const photo = (x: number, y: number) => [(x * 31 + y * 7) & 255, (y * 29) & 255, 120 + x];
for (const f of [0, 1, 2, 3, 4]) assert.equal(isUniformPng(png(8, 8, 2, photo, f)), false, `filter ${f}`);
// Filters decode exactly.
const d = decodeSmallPng(png(4, 3, 2, photo, 4))!;
assert.deepEqual([d.w, d.h, d.bpp], [4, 3, 3]);
assert.deepEqual(Array.from(d.px.subarray(3 * 4 + 3, 3 * 4 + 6)), photo(1, 1));
// One pixel off is not blank; JPEG-ish noise within tolerance still is.
assert.equal(isUniformPng(png(8, 8, 2, (x, y) => (x === 5 && y === 6 ? [40, 0, 0] : [0, 0, 0]))), false);
assert.equal(isUniformPng(png(8, 8, 2, (x) => [x % 2, 0, 1])), true);
// Unreadable input is "not blank" (never throws away a real export).
assert.equal(isUniformPng(new Uint8Array([1, 2, 3])), false);

// exportLooksBlank: a uniform export is blank only when the drawn screen shows something else.
const black = png(8, 8, 6, () => [0, 0, 0, 255]);
const clear = png(8, 8, 6, () => [0, 0, 0, 0]);
const screenPhoto = png(8, 8, 6, (x, y) => [...photo(x, y), 255]);
assert.equal(exportLooksBlank(black, screenPhoto), true, 'black export of a real photo is blank');
assert.equal(exportLooksBlank(clear, screenPhoto), true, 'transparent export of a real photo is blank');
// The regression: a plain-colour (near-uniform) photo exported correctly is kept.
const sky = png(8, 8, 6, () => [120, 170, 230, 255]);
const skyOnScreen = png(8, 8, 6, (x, y) => [121 + (x % 2), 169, 229 + (y % 3), 255]);
assert.equal(exportLooksBlank(sky, skyOnScreen), false, 'plain sky photo is not blank');
assert.equal(exportLooksBlank(png(8, 8, 6, () => [8, 8, 8, 255]), png(8, 8, 6, () => [10, 9, 8, 255])), false, 'plain dark photo is not blank');
// A black export where the screen is white is blank.
assert.equal(exportLooksBlank(black, png(8, 8, 6, () => [255, 255, 255, 255])), true);
// A non-uniform export is never blank; an unreadable export is never blank.
assert.equal(exportLooksBlank(screenPhoto, black), false);
assert.equal(exportLooksBlank(new Uint8Array([1, 2, 3]), screenPhoto), false);
// No readable screen probe: a uniform export counts as blank (screen capture is the fallback).
assert.equal(exportLooksBlank(sky, null), true);
assert.equal(exportLooksBlank(sky, new Uint8Array([9])), true);
// RGB export vs RGBA screen compare by colour.
assert.equal(exportLooksBlank(png(8, 8, 2, () => [120, 170, 230]), skyOnScreen), false);
console.log('blankImage selftest: all passed');
