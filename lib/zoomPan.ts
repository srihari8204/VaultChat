// lib/zoomPan.ts — pinch-zoom and pan limits for a full-screen image.
//
// Used by app/media-viewer.tsx's ImageViewer. PURE (no react-native import):
// Node-tested in zoomPan.selftest.ts.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/** New zoom from a pinch: the start zoom times the change in finger distance,
 *  held to [MIN_ZOOM, MAX_ZOOM]. A zero/invalid start distance keeps `start`. */
export function pinchZoom(start: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !Number.isFinite(dist)) return start;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, start * (dist / startDist)));
}

/** Keep a scaled view's translation inside its box: at zoom z a w-wide view
 *  overflows by (z-1)·w, so it may move ±(z-1)·w/2 each way. At z ≤ 1 → 0. */
export function clampPan(t: number, zoom: number, size: number): number {
  const lim = Math.max(0, ((zoom - 1) * size) / 2);
  if (!Number.isFinite(t)) return 0;
  return Math.max(-lim, Math.min(lim, t));
}

export default {};
