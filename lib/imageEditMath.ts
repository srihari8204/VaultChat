// lib/imageEditMath.ts — pure maths for app/image-editor.tsx.
//
// 1. Colour: one SVG feColorMatrix (4x5, row-major, offsets in 0..1 units) for
//    the chosen filter + brightness + contrast, rendered by react-native-svg's
//    FilterImage and captured with the canvas. Replaces the old translucent
//    "washes" (B&W was a 50% grey film, not desaturation).
// 2. Crop: the user-positioned crop rectangle, kept inside the displayed image
//    and mapped back to image pixels for expo-image-manipulator.
//
// PURE (no react-native import): Node-tested in imageEditMath.selftest.ts.

export type Matrix = number[]; // 20 numbers: rows R,G,B,A of [r g b a offset]

export const IDENTITY: Matrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

export const FILTERS = ['Original', 'B&W', 'Warm', 'Cool', 'Vivid'] as const;
export type FilterName = typeof FILTERS[number];

const saturate = (s: number): Matrix => {
  // The SVG/CSS saturate() matrix (Rec. 709 luma weights).
  const r = 0.2126, g = 0.7152, b = 0.0722;
  return [
    r + (1 - r) * s, g - g * s,       b - b * s,       0, 0,
    r - r * s,       g + (1 - g) * s, b - b * s,       0, 0,
    r - r * s,       g - g * s,       b + (1 - b) * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
};
const channels = (rs: number, gs: number, bs: number): Matrix => [
  rs, 0, 0, 0, 0,
  0, gs, 0, 0, 0,
  0, 0, bs, 0, 0,
  0, 0, 0, 1, 0,
];

const FILTER_MATRIX: Record<FilterName, Matrix> = {
  'Original': IDENTITY,
  'B&W': saturate(0),
  'Warm': channels(1.1, 1.0, 0.85),
  'Cool': channels(0.9, 1.0, 1.15),
  'Vivid': saturate(1.5),
};

/** a ∘ b: apply b first, then a. Both 4x5 affine colour matrices. */
export function compose(a: Matrix, b: Matrix): Matrix {
  const out: Matrix = new Array(20).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      let v = col === 4 ? a[row * 5 + 4] : 0;
      for (let k = 0; k < 4; k++) v += a[row * 5 + k] * b[k * 5 + col];
      out[row * 5 + col] = v;
    }
  }
  return out;
}

/** CSS-style brightness: multiply RGB by 1 + b/100 (b in -100..100). */
export function brightnessMatrix(b: number): Matrix {
  const f = 1 + b / 100;
  return channels(f, f, f);
}

/** CSS-style contrast around mid-grey: v' = (v - 0.5)·k + 0.5, k = 1 + c/100. */
export function contrastMatrix(c: number): Matrix {
  const k = 1 + c / 100;
  const o = 0.5 * (1 - k);
  return [
    k, 0, 0, 0, o,
    0, k, 0, 0, o,
    0, 0, k, 0, o,
    0, 0, 0, 1, 0,
  ];
}

/** The filter first, then brightness, then contrast. null = no change (render
 *  the plain image and skip the filter pass entirely). */
export function editMatrix(filter: FilterName, brightness: number, contrast: number): Matrix | null {
  if (filter === 'Original' && !brightness && !contrast) return null;
  let m = FILTER_MATRIX[filter] ?? IDENTITY;
  if (brightness) m = compose(brightnessMatrix(brightness), m);
  if (contrast) m = compose(contrastMatrix(contrast), m);
  return m.map((v) => Math.round(v * 10000) / 10000);
}

// ── Crop ──────────────────────────────────────────────────────────────

export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export const MIN_CROP = 40;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Where an image of iw×ih lands inside a cw×ch box with resizeMode "contain". */
export function containFrame(cw: number, ch: number, iw: number, ih: number): Rect {
  if (!(cw > 0 && ch > 0 && iw > 0 && ih > 0)) return { x: 0, y: 0, w: Math.max(0, cw), h: Math.max(0, ch) };
  const s = Math.min(cw / iw, ch / ih);
  const w = iw * s, h = ih * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** The starting crop box: the whole image for Free, else the largest centred
 *  box of that ratio (width / height). */
export function initialCrop(frame: Rect, ratio: number | null): Rect {
  if (!ratio) return { ...frame };
  let w = frame.w, h = w / ratio;
  if (h > frame.h) { h = frame.h; w = h * ratio; }
  return { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h };
}

/** Drag the whole box by (dx, dy) from where it was at touch-down. */
export function moveCrop(start: Rect, dx: number, dy: number, frame: Rect): Rect {
  return {
    ...start,
    x: clamp(start.x + dx, frame.x, frame.x + frame.w - start.w),
    y: clamp(start.y + dy, frame.y, frame.y + frame.h - start.h),
  };
}

/** Drag one corner by (dx, dy) from the box at touch-down; the opposite corner
 *  stays put. With a ratio the width leads and the height follows (shrinking
 *  both if the height would leave the image). */
export function resizeCrop(start: Rect, corner: Corner, dx: number, dy: number, ratio: number | null, frame: Rect): Rect {
  const right = corner === 'tr' || corner === 'br';
  const bottom = corner === 'bl' || corner === 'br';
  const ax = right ? start.x : start.x + start.w;     // fixed (anchor) corner
  const ay = bottom ? start.y : start.y + start.h;
  const availW = right ? frame.x + frame.w - ax : ax - frame.x;
  const availH = bottom ? frame.y + frame.h - ay : ay - frame.y;
  const minW = Math.min(MIN_CROP, availW), minH = Math.min(MIN_CROP, availH);
  let w = clamp((right ? 1 : -1) * dx + start.w, minW, availW);
  let h = clamp((bottom ? 1 : -1) * dy + start.h, minH, availH);
  if (ratio) {
    h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
  }
  return { x: right ? ax : ax - w, y: bottom ? ay : ay - h, w, h };
}

/** The on-screen crop box → integer image-pixel crop for ImageManipulator,
 *  always inside the image. */
export function toImageCrop(rect: Rect, frame: Rect, iw: number, ih: number) {
  const sx = iw / frame.w, sy = ih / frame.h;
  const originX = clamp(Math.round((rect.x - frame.x) * sx), 0, iw - 1);
  const originY = clamp(Math.round((rect.y - frame.y) * sy), 0, ih - 1);
  const width = clamp(Math.round(rect.w * sx), 1, iw - originX);
  const height = clamp(Math.round(rect.h * sy), 1, ih - originY);
  return { originX, originY, width, height };
}

export default {};
