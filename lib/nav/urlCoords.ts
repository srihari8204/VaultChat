// lib/nav/urlCoords.ts — pull "lat,lng" out of the location-URL shapes we emit
// or receive (SOS texts, shared-location links, geo: intents). Pure + no RN
// imports so it runs standalone: `npx tsx lib/nav/urlCoords.ts`.

export function coordsFromUrl(url: string): { lat: number; lng: number } | null {
  if (!url) return null;
  const geo = url.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (geo) return finite(+geo[1], +geo[2]);
  if (/(?:google\.[a-z.]+\/maps|maps\.google|openstreetmap|\/navigate)/i.test(url)) {
    const qp = url.match(/[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?)(?:%2C|,)\s*(-?\d+(?:\.\d+)?)/i)
      || url.match(/[@\/](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (qp) return finite(+qp[1], +qp[2]);
  }
  return null;
}
function finite(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * A destination TYPED as "lat, lng". The whole input must be the pair: an
 * unanchored match read "Plot 45, 12th Cross" as 45°N 12°E. Returns null when
 * the text is not a coordinate pair (geocode it instead), and 'out-of-range'
 * when it is one but no place on Earth has it — such a pair used to become a
 * destination the router could never reach.
 */
export function typedCoords(q: string): { lat: number; lng: number } | 'out-of-range' | null {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : 'out-of-range';
}

/** Whether a pair (e.g. from a deep link) is a real position on Earth. */
export function inLatLngRange(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// self-check
if (require.main === module) {
  const ok = (u: string, lat: number, lng: number) => {
    const c = coordsFromUrl(u);
    if (!c || Math.abs(c.lat - lat) > 1e-6 || Math.abs(c.lng - lng) > 1e-6)
      throw new Error(`FAIL ${u} -> ${JSON.stringify(c)} expected ${lat},${lng}`);
  };
  const nil = (u: string) => { if (coordsFromUrl(u)) throw new Error(`FAIL ${u} -> should be null`); };
  ok('geo:12.9716,77.5946', 12.9716, 77.5946);
  ok('https://maps.google.com/?q=12.9716,77.5946', 12.9716, 77.5946);
  ok('https://www.google.com/maps?q=-33.8688,151.2093', -33.8688, 151.2093);
  ok('https://www.google.com/maps?q=12.97%2C77.59', 12.97, 77.59);
  ok('https://www.google.com/maps/@40.7128,-74.0060,15z', 40.7128, -74.006);
  ok('vaultchat://navigate?q=1.3521,103.8198', 1.3521, 103.8198);
  nil('https://example.com/blog/post');
  nil('https://github.com/anthropics');
  nil('');
  console.log('urlCoords self-check OK');
}
