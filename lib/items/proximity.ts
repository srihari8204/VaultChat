// lib/items/proximity.ts — turning a BLE signal into something a person can
// walk toward.
//
// Radio signal strength is not a distance. RSSI swings 10+ dBm while a phone
// sits still — a hand, a pocket, a doorway all move it — so a raw reading
// rendered as "3.2 m" is a number that lies twice a second. Everything here
// exists to make the SEARCH honest: smooth the noise, state a band rather
// than a false precision, and say "closer/further" only when the change is
// bigger than the noise.
//
// Vendor-neutral by construction: this reads RSSI, which every BLE
// advertisement carries. No Tile, no proprietary protocol, no licence — any
// tag, beacon or BLE device works, which is the point.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/items/proximity.ts

/** Reference RSSI at 1 m for a typical BLE tag at 0 dBm TX. */
export const TX_AT_1M = -59;
/** Path-loss exponent. 2 = free space; indoors with walls and bodies is ~2.5. */
export const PATH_LOSS = 2.5;
/** Below this the reading is noise, not a neighbour. */
export const OUT_OF_RANGE_RSSI = -100;
/** A tag unheard for this long is no longer "here". */
export const STALE_MS = 30_000;

export type ProximityBand = 'immediate' | 'near' | 'far' | 'weak' | 'lost';

/** Smoothing weight for the newest sample (EMA). Low = calm, slow to react. */
export const EMA_ALPHA = 0.35;
/** Below this dBm change we refuse to claim the distance moved. */
export const TREND_DEADBAND = 3;

/**
 * Smooth a new RSSI reading into the running estimate.
 *
 * An exponential moving average rather than a window: it needs one number of
 * state, reacts immediately to a genuine step, and cannot be fooled by one
 * outlier the way a min/max would be.
 */
export function smoothRssi(prev: number | null | undefined, sample: number): number {
  if (!Number.isFinite(sample)) return prev ?? OUT_OF_RANGE_RSSI;
  if (prev == null || !Number.isFinite(prev)) return sample;
  return prev + EMA_ALPHA * (sample - prev);
}

/**
 * Rough metres from a smoothed RSSI, via the log-distance path-loss model.
 *
 * DELIBERATELY COARSE, and callers must treat it as such: it is accurate to
 * roughly a factor of two indoors. It exists to drive a hot/cold search, not
 * to place a pin on a map — which is why bandOf() below, not this, is what
 * the UI shows.
 */
export function rssiToMetres(rssi: number): number | null {
  if (!Number.isFinite(rssi) || rssi <= OUT_OF_RANGE_RSSI) return null;
  const m = Math.pow(10, (TX_AT_1M - rssi) / (10 * PATH_LOSS));
  return Math.round(m * 10) / 10;
}

/** The band a person can act on. Bands, not metres, are what the UI states. */
export function bandOf(rssi: number | null | undefined, lastSeenMs?: number, now?: number): ProximityBand {
  if (lastSeenMs != null && now != null && now - lastSeenMs > STALE_MS) return 'lost';
  if (rssi == null || !Number.isFinite(rssi) || rssi <= OUT_OF_RANGE_RSSI) return 'lost';
  if (rssi >= -55) return 'immediate';   // arm's reach
  if (rssi >= -70) return 'near';        // same room
  if (rssi >= -85) return 'far';         // same floor, other room
  return 'weak';                         // barely audible
}

export const BAND_LABEL: Record<ProximityBand, string> = {
  immediate: 'Right here',
  near: 'Very close',
  far: 'Nearby',
  weak: 'Faint signal',
  lost: 'Out of range',
};

/**
 * Is the searcher getting warmer? Returns +1 closer, -1 further, 0 unchanged.
 *
 * The deadband is the whole point: RSSI noise alone will produce ±2 dBm
 * forever, and a "getting closer" arrow that flickers while someone stands
 * still makes the search harder, not easier.
 */
export function trend(prevRssi: number | null | undefined, nowRssi: number | null | undefined): -1 | 0 | 1 {
  if (prevRssi == null || nowRssi == null || !Number.isFinite(prevRssi) || !Number.isFinite(nowRssi)) return 0;
  const d = nowRssi - prevRssi;
  if (d > TREND_DEADBAND) return 1;
  if (d < -TREND_DEADBAND) return -1;
  return 0;
}

// ── self-check: `npx tsx lib/items/proximity.ts` ───────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('proximity: ' + m); };

  // 1. smoothing: first sample seeds, later samples pull toward the new value
  A(smoothRssi(null, -60) === -60, 'the first sample seeds the average');
  const s1 = smoothRssi(-60, -80);
  A(s1 > -80 && s1 < -60, `one outlier must not jump the whole way: ${s1}`);
  // …and a sustained change does eventually get there
  let v: number | null = -60;
  for (let i = 0; i < 25; i++) v = smoothRssi(v, -80);
  A(Math.abs(v! - -80) < 1, `a sustained change must converge: ${v}`);
  A(smoothRssi(-60, NaN) === -60, 'a NaN sample must not poison the estimate');

  // 2. distance is monotonic and refuses the impossible
  const dNear = rssiToMetres(-59)!, dMid = rssiToMetres(-75)!, dFar = rssiToMetres(-90)!;
  A(Math.abs(dNear - 1) < 0.2, `-59 dBm is the 1 m reference, got ${dNear}`);
  A(dNear < dMid && dMid < dFar, 'weaker signal must read as further');
  A(rssiToMetres(-120) === null, 'below the floor is not a distance');
  A(rssiToMetres(NaN) === null, 'NaN is not a distance');

  // 3. bands are ordered and cover the range
  A(bandOf(-50) === 'immediate', 'strong is immediate');
  A(bandOf(-65) === 'near', 'medium is near');
  A(bandOf(-80) === 'far', 'weak-ish is far');
  A(bandOf(-95) === 'weak', 'very weak is weak');
  A(bandOf(null) === 'lost', 'no reading is lost');
  A(bandOf(-120) === 'lost', 'below the floor is lost');
  for (const b of Object.keys(BAND_LABEL) as ProximityBand[]) A(BAND_LABEL[b].length > 0, `${b} needs a label`);

  // 4. STALENESS OUTRANKS SIGNAL — a strong reading from a minute ago is a
  //    memory, not a location, and must never render as "right here"
  const now = 1_700_000_000_000;
  A(bandOf(-50, now - 60_000, now) === 'lost', 'a stale strong reading is lost, not immediate');
  A(bandOf(-50, now - 1_000, now) === 'immediate', 'a fresh strong reading is immediate');

  // 5. trend has a deadband so a still hand does not flicker
  A(trend(-70, -60) === 1, 'a real 10 dBm gain is closer');
  A(trend(-60, -70) === -1, 'a real 10 dBm loss is further');
  A(trend(-70, -68) === 0, 'noise-sized change reports no movement');
  A(trend(-70, -72) === 0, 'noise-sized loss reports no movement');
  A(trend(null, -60) === 0, 'no history means no claim');

  console.log('items/proximity self-check: OK');
}

export default {};
