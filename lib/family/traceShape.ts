// lib/family/traceShape.ts — what a member's track looks like when it leaves the
// phone for road matching (/nav/trace, used by family-history and
// family-member for the "travelled" figure).
//
// Every point is rounded to 4 decimal places (~11 m), and consecutive points
// that round to the same spot are sent once. Road matching still works at
// that precision (it is near GPS noise), but the routing server no longer
// receives the raw fixes, and a parked phone's jitter is not uploaded as a
// stream of near-identical points.
//
// ponytail: rounding, not opt-in. Matching still sends the shape of the day
// (at ~11 m); making it a per-viewer opt-in is a product choice — put a gate
// in front of fetchTraceDistance if that is decided.
//
// Pure — no react-native imports — so traceShape.selftest.ts runs under tsx.

export interface TracePoint { lat: number; lng: number }

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function traceShape(points: readonly TracePoint[]): TracePoint[] {
  const out: TracePoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const q = { lat: r4(p.lat), lng: r4(p.lng) };
    const last = out[out.length - 1];
    if (last && last.lat === q.lat && last.lng === q.lng) continue;
    out.push(q);
  }
  return out;
}
