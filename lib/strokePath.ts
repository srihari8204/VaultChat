// lib/strokePath.ts — freehand stroke points → an SVG path `d` string.
//
// Used by the whiteboard and the image editor's draw tool, which used to mount
// one dot View per touch point (gaps on fast strokes, thousands of views on a
// long drawing). One <Path> per stroke, drawn with round caps/joins, is
// continuous at any speed. PURE (no react-native import): Node-tested in
// strokePath.selftest.ts.

export type StrokePoint = { x: number; y: number };

const r = (n: number) => Math.round(n * 10) / 10;

/** "M x y L x y …" for the points; '' for none. A single point becomes a
 *  zero-length segment, which round caps render as a dot. Non-finite points
 *  (a touch event with no location) are skipped rather than poisoning the path. */
export function strokeD(points: readonly StrokePoint[]): string {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length === 0) return '';
  const [first, ...rest] = pts;
  const head = `M${r(first.x)} ${r(first.y)}`;
  if (rest.length === 0) return `${head} L${r(first.x)} ${r(first.y)}`;
  return head + rest.map((p) => ` L${r(p.x)} ${r(p.y)}`).join('');
}

export default {};
