// lib/media/editExport.ts — geometry for app/image-editor's overlays (strokes,
// text) across crop, rotate and the full-resolution export. PURE (no
// react-native import): editExport.selftest.ts runs it under Node.
//
// The editor draws overlays in CANVAS coordinates: the photo is letterboxed
// into the canvas at `frame` (lib/imageEditMath.containFrame). Everything here
// goes canvas → image pixels → wherever the overlay must land next.

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };
/** Moves a canvas point, and scales a canvas length, onto the new layout. */
export type OverlayMap = { pt: (p: Pt) => Pt; scale: number };

/** Longest edge of the exported photo. A 12 MP photo is 4000 px; past this the
 *  offscreen render costs more memory than a phone reliably has. */
export const EXPORT_MAX_EDGE = 4096;

/** The exported photo's pixel size: the image's own, bounded, never upscaled. */
export function exportSize(imgW: number, imgH: number, maxEdge = EXPORT_MAX_EDGE): { w: number; h: number } {
  if (!(imgW > 0 && imgH > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, maxEdge / Math.max(imgW, imgH));
  return { w: Math.max(1, Math.round(imgW * k)), h: Math.max(1, Math.round(imgH * k)) };
}

/** Canvas → image pixels for an image of width imgW shown at `frame`. */
function toImage(p: Pt, frame: Rect, imgW: number): Pt {
  const k = imgW / frame.w;
  return { x: (p.x - frame.x) * k, y: (p.y - frame.y) * k };
}
/** Image pixels → canvas for an image of width imgW shown at `frame`. */
function toCanvas(p: Pt, frame: Rect, imgW: number): Pt {
  const k = frame.w / imgW;
  return { x: frame.x + p.x * k, y: frame.y + p.y * k };
}

/**
 * Overlays after a crop: the crop rect (image pixels, as ImageManipulator got
 * it) becomes the whole new image, shown at `newFrame`.
 */
export function mapForCrop(
  oldFrame: Rect, oldImgW: number,
  crop: { originX: number; originY: number; width: number },
  newFrame: Rect,
): OverlayMap {
  return {
    pt: (p) => {
      const i = toImage(p, oldFrame, oldImgW);
      return toCanvas({ x: i.x - crop.originX, y: i.y - crop.originY }, newFrame, crop.width);
    },
    scale: (newFrame.w / crop.width) / (oldFrame.w / oldImgW),
  };
}

/**
 * Overlays after a 90° CLOCKWISE rotation (ImageManipulator's positive
 * rotate): image pixel (x, y) of a W×H image lands at (H − y, x) of the H×W
 * result, shown at `newFrame`.
 */
export function mapForRotate90(oldFrame: Rect, oldImgW: number, oldImgH: number, newFrame: Rect): OverlayMap {
  return {
    pt: (p) => {
      const i = toImage(p, oldFrame, oldImgW);
      return toCanvas({ x: oldImgH - i.y, y: i.x }, newFrame, oldImgH);
    },
    scale: (newFrame.w / oldImgH) / (oldFrame.w / oldImgW),
  };
}

/**
 * Where the offscreen export view puts a canvas point: the photo's frame is
 * the whole export, `outW` wide (in the export view's units).
 */
export function toExport(p: Pt, frame: Rect, outW: number): Pt {
  const k = outW / frame.w;
  return { x: (p.x - frame.x) * k, y: (p.y - frame.y) * k };
}

/**
 * The crop box grown or shrunk about its centre — the screen-reader
 * alternative to dragging its corners. Keeps the ratio (if any), stays inside
 * the photo, never smaller than `min`.
 */
export function scaleCrop(rect: Rect, factor: number, frame: Rect, ratio: number | null, min = 40): Rect {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  let w = rect.w * factor, h = ratio ? w / ratio : rect.h * factor;
  // Fit inside the frame, then respect the minimum.
  const fit = Math.min(1, frame.w / w, frame.h / h);
  w *= fit; h *= fit;
  const grow = Math.max(1, Math.min(frame.w, min) / w, Math.min(frame.h, min) / h);
  w = Math.min(frame.w, w * grow); h = Math.min(frame.h, h * grow);
  const x = Math.max(frame.x, Math.min(frame.x + frame.w - w, cx - w / 2));
  const y = Math.max(frame.y, Math.min(frame.y + frame.h - h, cy - h / 2));
  return { x, y, w, h };
}

/**
 * A text overlay moved by (dx, dy) — the screen-reader alternative to
 * dragging it — kept inside `box` (the photo's frame): its top-left stays in
 * the box and, when it fits, so does its far edge. Text larger than the box
 * is pinned to the box's top/left edge.
 */
export function nudgeWithin(p: Pt, size: { w: number; h: number }, dx: number, dy: number, box: Rect): Pt {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  return {
    x: clamp(p.x + dx, box.x, box.x + box.w - size.w),
    y: clamp(p.y + dy, box.y, box.y + box.h - size.h),
  };
}

export default {};
