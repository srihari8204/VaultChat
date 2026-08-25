// lib/docs/zoom.ts — pinch-to-zoom maths for the document reader.
//
// The reader zooms by RESIZING THE TEXT, not by scaling the view. Scaling a view
// blows up the rasterised pixels — text goes soft exactly when someone zoomed in
// to read it — and it strands long lines off the side of the screen. Changing the
// font size re-lays the page out: the text stays sharp and it still wraps to the
// screen, which is what every real reader does.
//
// The cost is that each zoom step is a re-layout, so the scale is quantised —
// a pinch that fires 60 times a second must not trigger 60 re-layouts.

export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 3;
/** Re-layout on 5% steps. Small enough to feel continuous, coarse enough to stay smooth. */
const STEP = 0.05;

/**
 * Where a pinch lands: the zoom the gesture started from, times the pinch scale,
 * clamped and quantised.
 */
export function pinchZoom(base: number, scale: number): number {
  const raw = base * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw));
  return Math.round(clamped / STEP) * STEP;
}

/** What the zoom pill shows: `130%`. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * A grid column's width at a given zoom. Tracks the longest cell so a sheet of
 * one long note and six short numbers does not waste the screen, clamped so one
 * enormous cell cannot push every other column out of view.
 */
export function columnWidth(longestCell: number, zoom: number): number {
  return Math.round(Math.max(64, Math.min(220, 12 + longestCell * 8)) * zoom);
}
