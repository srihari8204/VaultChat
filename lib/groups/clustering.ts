// lib/groups/clustering.ts — group-map marker clustering (Groups & Circles, G3.7).
//
// A family of four never needs this. A 50-person office group standing in one
// building is an unreadable pile of overlapping avatars, so markers close
// enough to collide are merged into one counted bubble.
//
// CLUSTERING IS ON-DEVICE, AND HAS TO BE. Member positions arrive as sealed
// pings that only this device can open, so the server literally cannot cluster
// what it cannot read. That is a consequence of the encryption model, not a
// design preference.
//
// The algorithm lives here rather than inside the Leaflet WebView so it can be
// tested. The WebView reports its zoom; this module decides the grouping.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/clustering.ts

export interface Clusterable {
  id: string;
  lat: number;
  lng: number;
}

export interface Cluster<T extends Clusterable> {
  /** Stable identity for the bubble, so Leaflet can diff rather than rebuild. */
  key: string;
  /** Centroid — where the bubble is drawn. */
  lat: number;
  lng: number;
  items: T[];
}

/** Web-mercator tile size, and the pixel radius at which avatars collide. */
const TILE_PX = 256;
const COLLIDE_PX = 44;

/**
 * Degrees of longitude that COLLIDE_PX covers at this zoom.
 *
 * At zoom z the world is TILE_PX * 2^z pixels wide, so one pixel is
 * 360 / (TILE_PX * 2^z) degrees. Markers nearer than that visually overlap and
 * should merge. Latitude compression away from the equator is deliberately
 * ignored: it would make the cell non-square in screen space, which is the
 * opposite of what the eye expects.
 */
export function cellSizeForZoom(zoom: number): number {
  const z = Math.max(0, Math.min(22, zoom));
  return (COLLIDE_PX * 360) / (TILE_PX * Math.pow(2, z));
}

/** Snap to a grid cell index. Exported for the self-check. */
export function cellIndex(value: number, cell: number): number {
  return Math.floor(value / cell);
}

/**
 * Bucket items into grid cells and return one cluster per occupied cell.
 *
 * A GRID rather than true distance-based clustering is deliberate: grid
 * bucketing is O(n), stable, and produces the same grouping regardless of input
 * order. Distance clustering is order-dependent, so two members swapping
 * position in the array could reshuffle every bubble on screen — visible as
 * markers jumping for no reason the user can perceive.
 *
 * Output order follows first appearance, so a stable input yields a stable
 * render.
 */
export function clusterByGrid<T extends Clusterable>(items: T[], cellDeg: number): Cluster<T>[] {
  if (cellDeg <= 0) {
    // Degenerate cell: every item is its own cluster rather than one giant one.
    return items.map((it) => ({ key: it.id, lat: it.lat, lng: it.lng, items: [it] }));
  }

  const buckets = new Map<string, T[]>();
  const order: string[] = [];
  for (const it of items) {
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lng)) continue;
    const k = `${cellIndex(it.lat, cellDeg)}:${cellIndex(it.lng, cellDeg)}`;
    const b = buckets.get(k);
    if (b) { b.push(it); } else { buckets.set(k, [it]); order.push(k); }
  }

  return order.map((k) => {
    const group = buckets.get(k)!;
    // Centroid, so the bubble sits among its members rather than on the corner
    // of an invisible grid cell.
    let lat = 0, lng = 0;
    for (const g of group) { lat += g.lat; lng += g.lng; }
    return {
      // Keyed by MEMBERSHIP, not by cell: a cluster that gains or loses someone
      // is a different bubble and must re-render rather than silently keep a
      // stale count.
      key: group.length === 1 ? group[0].id : `c:${group.map((g) => g.id).sort().join('|')}`,
      lat: lat / group.length,
      lng: lng / group.length,
      items: group,
    };
  });
}

/** Convenience: cluster for a given zoom level. */
export function clusterForZoom<T extends Clusterable>(items: T[], zoom: number): Cluster<T>[] {
  return clusterByGrid(items, cellSizeForZoom(zoom));
}

// ── self-check ──
if (require.main === module) {
  const mk = (id: string, lat: number, lng: number) => ({ id, lat, lng });

  // 1. empty in, empty out
  if (clusterByGrid([], 0.01).length !== 0) throw new Error('empty should stay empty');

  // 2. a lone marker is a cluster of one, keyed by its own id (not a synthetic key)
  const one = clusterByGrid([mk('a', 1, 1)], 0.01);
  if (one.length !== 1 || one[0].items.length !== 1) throw new Error('single item');
  if (one[0].key !== 'a') throw new Error('a lone marker should keep its own id as key');

  // 3. near markers merge; far ones do not
  const near = clusterByGrid([mk('a', 1.0000, 1.0000), mk('b', 1.0001, 1.0001)], 0.01);
  if (near.length !== 1 || near[0].items.length !== 2) throw new Error('near markers must merge');
  const far = clusterByGrid([mk('a', 1, 1), mk('b', 5, 5)], 0.01);
  if (far.length !== 2) throw new Error('far markers must stay separate');

  // 4. centroid sits between members, not on a grid corner
  const c = clusterByGrid([mk('a', 1.000, 2.000), mk('b', 1.002, 2.004)], 0.01)[0];
  if (Math.abs(c.lat - 1.001) > 1e-9 || Math.abs(c.lng - 2.002) > 1e-9) {
    throw new Error('centroid should be the mean: ' + JSON.stringify(c));
  }

  // 5. ORDER INDEPENDENCE — the reason a grid was chosen over distance
  //    clustering. Shuffling the input must not change the grouping.
  const pts = [mk('a', 1.0000, 1.0000), mk('b', 1.0001, 1.0000), mk('c', 9, 9), mk('d', 9.0001, 9)];
  const sig = (cs: Cluster<any>[]) => cs.map((x) => x.key).sort().join(' / ');
  if (sig(clusterByGrid(pts, 0.01)) !== sig(clusterByGrid([...pts].reverse(), 0.01))) {
    throw new Error('grouping must not depend on input order');
  }

  // 6. cluster keys change when MEMBERSHIP changes, so a stale count cannot persist
  const two = clusterByGrid([mk('a', 1, 1), mk('b', 1.0001, 1)], 0.01)[0];
  const three = clusterByGrid([mk('a', 1, 1), mk('b', 1.0001, 1), mk('e', 1.0002, 1)], 0.01)[0];
  if (two.key === three.key) throw new Error('key must change when membership changes');
  // …but is stable when the same members arrive in a different order
  const twoAgain = clusterByGrid([mk('b', 1.0001, 1), mk('a', 1, 1)], 0.01)[0];
  if (two.key !== twoAgain.key) throw new Error('key must be stable under reordering');

  // 7. zooming in splits clusters apart
  const close = [mk('a', 1.0000, 1.0000), mk('b', 1.0020, 1.0000)];
  const wide = clusterForZoom(close, 8);    // zoomed out → one bubble
  const tight = clusterForZoom(close, 18);  // zoomed in  → two markers
  if (wide.length !== 1) throw new Error('should merge when zoomed out, got ' + wide.length);
  if (tight.length !== 2) throw new Error('should split when zoomed in, got ' + tight.length);
  if (cellSizeForZoom(18) >= cellSizeForZoom(8)) throw new Error('cell must shrink as zoom grows');

  // 8. junk coordinates are dropped rather than poisoning a centroid with NaN
  const junk = clusterByGrid([mk('a', 1, 1), mk('bad', NaN, 1), mk('worse', 1, Infinity)], 0.01);
  if (junk.length !== 1 || junk[0].items.length !== 1) throw new Error('non-finite coords must be skipped');
  if (!Number.isFinite(junk[0].lat)) throw new Error('centroid must stay finite');

  // 9. degenerate cell size does not collapse the world into one bubble
  if (clusterByGrid([mk('a', 1, 1), mk('b', 50, 50)], 0).length !== 2) {
    throw new Error('cell <= 0 should leave items unclustered');
  }

  // 10. clamped zoom stays finite at the extremes
  if (!Number.isFinite(cellSizeForZoom(-5)) || !Number.isFinite(cellSizeForZoom(99))) {
    throw new Error('zoom must be clamped to a finite cell');
  }

  console.log('groups/clustering self-check OK');
}
