// lib/media/blankImage.ts — "did the capture come back blank?"
//
// react-native-view-shot can return a uniformly black/transparent bitmap
// instead of throwing when the platform did not draw the view it was asked to
// capture (app/image-editor's offscreen full-resolution export). The caller
// shrinks the capture to a tiny PNG; a uniform one is either blank or a photo
// that really is one plain colour, so exportLooksBlank compares it with the
// same probe of the on-screen canvas (which is drawn). PURE (fflate only, no
// react-native).

import { unzlibSync } from 'fflate';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Pixels of an 8-bit RGB/RGBA/grey(+alpha) non-interlaced PNG, as rows of
 *  channel bytes; null for anything else (the caller then assumes "not blank"). */
export function decodeSmallPng(png: Uint8Array): { w: number; h: number; bpp: number; px: Uint8Array } | null {
  if (png.length < 33 || SIG.some((b, i) => png[i] !== b)) return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8, w = 0, h = 0, bpp = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(off + 8); h = dv.getUint32(off + 12);
      const depth = data[8], color = data[9], interlace = data[12];
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color];
      if (depth !== 8 || !channels || interlace !== 0 || w * h > 4096) return null;
      bpp = channels;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || !bpp || !idat.length) return null;
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) { joined.set(d, o); o += d.length; }
  let raw: Uint8Array;
  try { raw = unzlibSync(joined); } catch { return null; }
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) return null;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : -1;
      if (pred < 0) return null;
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, bpp, px };
}

/** True when every pixel of the PNG is within `tolerance` of the first one
 *  (per channel). False for a PNG this cannot read. */
export function isUniformPng(png: Uint8Array, tolerance = 2): boolean {
  const img = decodeSmallPng(png);
  if (!img) return false;
  const { bpp, px } = img;
  for (let i = bpp; i < px.length; i++) if (Math.abs(px[i] - px[i % bpp]) > tolerance) return false;
  return true;
}

/** Mean per-pixel colour difference (0–255) above which a uniform export is
 *  judged blank rather than a plain photo: a blank capture is black or
 *  transparent where the screen shows the photo, while two renders of the
 *  same plain photo differ only by scaling and JPEG noise. */
export const BLANK_MEAN_DIFF = 16;

/** True when the export probe is uniform AND it does not match the on-screen
 *  probe of the same area — i.e. the platform did not draw the export. A
 *  plain-colour photo (export uniform, screen the same colour) is kept.
 *  Without a readable screen probe a uniform export counts as blank (the
 *  screen capture is the fallback anyway); an unreadable export does not. */
export function exportLooksBlank(exportPng: Uint8Array, screenPng: Uint8Array | null): boolean {
  if (!isUniformPng(exportPng)) return false;
  const e = decodeSmallPng(exportPng)!;
  const s = screenPng ? decodeSmallPng(screenPng) : null;
  if (!s || s.w !== e.w || s.h !== e.h) return true;
  // Colour channels only (a transparent blank and an opaque photo both count
  // by their RGB / grey value), compared pixel by pixel.
  const ch = Math.min(e.bpp, s.bpp) >= 3 ? 3 : 1;
  let sum = 0;
  for (let i = 0; i < e.w * e.h; i++) {
    for (let k = 0; k < ch; k++) sum += Math.abs(e.px[i * e.bpp + k] - s.px[i * s.bpp + k]);
  }
  return sum / (e.w * e.h * ch) > BLANK_MEAN_DIFF;
}
