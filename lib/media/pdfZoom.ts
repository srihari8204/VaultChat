// lib/media/pdfZoom.ts — zoom maths for components/PdfView.
//
// PdfView zooms by RE-LAYING OUT the pages wider (and re-rendering them at the
// new width), not by scaling a bitmap: a scaled bitmap goes soft exactly when
// someone zooms in to read the small print. A pinch shows a live transform for
// feedback and commits ONE zoom when the fingers lift, because every committed
// step re-renders the visible pages. PURE (no react-native import).

export const PDF_MIN_ZOOM = 1;
export const PDF_MAX_ZOOM = 4;
/** Committed zooms land on quarter steps: 1, 1.25, 1.5 … 4. */
const STEP = 0.25;

/** The zoom a finished pinch commits: start zoom × pinch scale, clamped and quantised. */
export function pdfZoom(base: number, scale: number): number {
  const raw = base * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const clamped = Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, raw));
  return Math.round(clamped / STEP) * STEP;
}

/** One step in or out (screen-reader adjustable action, zoom buttons). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  return pdfZoom(zoom + dir * 0.5, 1);
}

/**
 * The scroll offset that keeps the point at the middle of the viewport in the
 * middle after content grows or shrinks by `ratio` (new zoom / old zoom).
 * Never negative; the list clamps the far end itself.
 */
export function keepCentre(offset: number, viewport: number, ratio: number): number {
  if (!(ratio > 0) || !Number.isFinite(offset) || !(viewport >= 0)) return Math.max(0, offset || 0);
  return Math.max(0, (offset + viewport / 2) * ratio - viewport / 2);
}

/** `150%` */
export function pdfZoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export default {};
