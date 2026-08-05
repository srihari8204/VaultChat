// lib/lock/format.ts — unit-aware readouts + GPS quality tiers for Location
// Lock. Pure (no RN imports); every distance/speed the feature shows goes
// through here so the metric/imperial setting applies everywhere at once.
// `npx tsx lib/lock/format.ts`

export type Units = 'metric' | 'imperial';

const FT_PER_M = 3.28084;
const MI_PER_KM = 0.621371;

/** Distance for display: m/km or ft/mi, sensibly rounded. */
export function fmtDistance(m: number, units: Units = 'metric'): string {
  if (units === 'imperial') {
    const ft = m * FT_PER_M;
    if (ft < 1000) return `${Math.round(ft)} ft`;
    return `${(ft / 5280).toFixed(ft < 5280 * 10 ? 2 : 1)} mi`;
  }
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

/** Speed for display from km/h. */
export function fmtSpeed(kmh: number, units: Units = 'metric'): string {
  const v = units === 'imperial' ? kmh * MI_PER_KM : kmh;
  return `${Math.round(v)} ${units === 'imperial' ? 'mph' : 'km/h'}`;
}

/** Compass heading → cardinal label (e.g. 245 → "SW"). */
export function fmtHeading(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${Math.round(deg)}° ${dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8]}`;
}

// The blueprint's satellite-count / signal readouts need native GNSS access the
// Expo stack doesn't have (design.md) — this accuracy-derived tier is the
// honest stand-in shown as "GPS quality".
export type GpsQuality = 'excellent' | 'good' | 'fair' | 'poor';

export function gpsQuality(accuracyM: number): GpsQuality {
  if (accuracyM < 8) return 'excellent';
  if (accuracyM < 15) return 'good';
  if (accuracyM < 30) return 'fair';
  return 'poor';
}

export const QUALITY_LABEL: Record<GpsQuality, string> = {
  excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor',
};
export const QUALITY_COLOR: Record<GpsQuality, string> = {
  excellent: '#22C55E', good: '#4A9FFF', fair: '#EAB308', poor: '#EF4444',
};

// ── self-check: `npx tsx lib/lock/format.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('format: ' + m); };
  A(fmtDistance(31.4) === '31 m', 'metric metres');
  A(fmtDistance(1500) === '1.50 km', 'metric km');
  A(fmtDistance(30, 'imperial') === '98 ft', 'imperial feet');
  A(fmtDistance(2000, 'imperial').endsWith('mi'), 'imperial miles');
  A(fmtSpeed(28) === '28 km/h' && fmtSpeed(28, 'imperial') === '17 mph', 'speed units');
  A(fmtHeading(245) === '245° SW' && fmtHeading(0) === '0° N', 'heading cardinal');
  A(gpsQuality(4) === 'excellent' && gpsQuality(10) === 'good', 'quality tiers low');
  A(gpsQuality(20) === 'fair' && gpsQuality(45) === 'poor', 'quality tiers high');
  console.log('format self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
