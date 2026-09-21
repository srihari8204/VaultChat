// lib/map/tileProvider.ts — the ONE place that decides where map tiles come from.
//
// Vector tiles from OpenFreeMap: OpenStreetMap data built with Planetiler and
// served in the OpenMapTiles schema with no API key, no registration and no
// request limit. It replaced CARTO raster, which now bakes an "API KEY REQUIRED"
// watermark INTO the tile image for unkeyed requests — pixels, not an overlay
// the app could hide — and whose raster service is being retired besides.
//
// Everything that renders a map asks for a STYLE URL here and never names a
// provider itself, so moving to self-hosted tiles (a PMTiles file behind our own
// Cloudflare, built from the same OSM extract Valhalla already digests) is a
// change to THIS FILE ONLY — no Family UI, no location code, no distance code,
// no routing, no realtime.
//
// Vector is not just a different URL: labels, POIs, the village/hamlet hierarchy
// and the local-script names of §23–29 come from the style, and 3D buildings
// exist at all. That is why isVectorProvider() below is now true.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/map/tileProvider.ts

export type MapScheme = 'light' | 'dark';

const OFM = 'https://tiles.openfreemap.org';

/** `liberty` is the full-colour road map (it ships its own 3D building layer).
 *
 * Keep it for BOTH app themes. The OpenFreeMap `dark` style hides too much
 * road/landmark detail on phone brightness, and this app uses maps to navigate,
 * so legibility beats matching the surrounding chrome. */
const STYLE: Record<MapScheme, string> = { light: 'liberty', dark: 'liberty' };

/** Attribution for any source we serve ourselves. OpenFreeMap already sends its
 *  own in the TileJSON, which is where MapLibre reads it from. */
export const ATTRIBUTION = '© OpenStreetMap contributors';

/** The MapLibre style, as a URL. Passed straight to `new maplibregl.Map({style})`. */
export function mapStyleUrl(scheme: MapScheme): string {
  return `${OFM}/styles/${STYLE[scheme]}`;
}

/**
 * Raster basemap for the Leaflet fallback engine, which cannot draw vector
 * tiles and only runs when WebGL is unavailable.
 *
 * EMPTY BY DEFAULT, and the emptiness is the decision, not an oversight: there
 * is no keyless raster provider we are allowed to point millions of installs at
 * — OSM's own tile usage policy forbids it and CARTO now watermarks it — so
 * until we serve raster ourselves the fallback runs with NO basemap and still
 * draws the route, the family markers and the geofence over the app background.
 * A blank-but-honest map beats a watermarked or license-violating one.
 *
 * ponytail: no-basemap fallback; set this to our own {z}/{x}/{y} template once
 * the self-hosted tile server lands.
 */
export const RASTER_FALLBACK_URL: string = '';

/**
 * 3D building extrusions. `liberty` already ships this layer and `dark` does
 * not, so both maps add it after load and skip it when it is already there —
 * the two themes must not disagree about whether buildings exist. Fields are
 * the OpenMapTiles schema's, which is what makes this portable to self-hosted
 * tiles built from the same schema.
 */
export function buildings3DLayer(scheme: MapScheme): Record<string, unknown> {
  return {
    id: 'building-3d',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14,
    paint: {
      'fill-extrusion-color': scheme === 'dark' ? 'hsl(220,10%,24%)' : 'hsl(35,8%,85%)',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.8,
    },
  };
}

/** True once this provider serves vector tiles — gates label/POI/style features. */
export function isVectorProvider(): boolean {
  return true;
}

// ── self-check: `npx tsx lib/map/tileProvider.ts` ──────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('tileProvider: ' + m); };

  const urls = (['light', 'dark'] as MapScheme[]).map(mapStyleUrl);
  A(urls.every((u) => u.startsWith('https://')), 'style URLs must be https');
  A(urls.every((u) => u.endsWith('/styles/liberty')), 'both app themes use the readable road-map style');
  // A style URL is fetched, not templated. A leftover z/x/y token here means
  // someone pasted a tile URL where a style belongs, which MapLibre reports as
  // a style parse error and the RN side reads as "this device has no WebGL".
  A(urls.every((u) => !/\{[zxysr]\}/.test(u)), 'a style URL carries no tile tokens');

  for (const scheme of ['light', 'dark'] as MapScheme[]) {
    const b = buildings3DLayer(scheme) as any;
    A(b.id === 'building-3d', `${scheme}: must reuse liberty's layer id so it is skipped when present`);
    A(b.source === 'openmaptiles' && b['source-layer'] === 'building', `${scheme}: OpenMapTiles schema names`);
    A(b.paint['fill-extrusion-height'][1] === 'render_height', `${scheme}: height comes from render_height`);
  }
  A(buildings3DLayer('light').paint !== buildings3DLayer('dark').paint, 'themes must not share a paint object');
  A((buildings3DLayer('light') as any).paint['fill-extrusion-color']
    !== (buildings3DLayer('dark') as any).paint['fill-extrusion-color'], 'buildings must be theme-aware');

  // The fallback is allowed to be empty (no basemap). It is NOT allowed to be a
  // provider we have no right to — that is the whole reason CARTO left.
  A(RASTER_FALLBACK_URL === '' || RASTER_FALLBACK_URL.startsWith('https://'), 'raster fallback must be https or empty');
  A(!/cartocdn|tile\.openstreetmap\.org/.test(RASTER_FALLBACK_URL), 'raster fallback must not use a provider that forbids us');

  console.log('map/tileProvider self-check: OK');
}

export default {};
