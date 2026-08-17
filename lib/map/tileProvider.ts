// lib/map/tileProvider.ts — the ONE place that decides where map tiles come from.
//
// THIS IS THE SEAM FOR THE VECTOR-TILE UPGRADE (deferred Phase D). Everything
// that renders a map asks for a MapLibre style spec here and never names a
// provider itself, so swapping raster CARTO for self-hosted OpenMapTiles /
// PMTiles / any vector source is a change to THIS FILE ONLY — no Family UI, no
// location code, no distance code, no routing, no realtime.
//
// What lives here: the style spec (sources + layers). What does NOT: camera,
// markers, routes, family state. A tile provider has no opinion about those.
//
// Today: raster CARTO, the same tiles both maps already shipped with. Raster
// cannot do custom label hierarchy, village/hamlet names, multilingual labels
// or POI layers at ANY amount of app code — that is exactly why Phase D is an
// infrastructure decision and not a UI task.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/map/tileProvider.ts

export type MapScheme = 'light' | 'dark';

/** A MapLibre GL style spec, passed straight to `new maplibregl.Map({style})`. */
export interface MapStyleSpec {
  version: 8;
  sources: Record<string, unknown>;
  layers: Record<string, unknown>[];
}

const CARTO_PATH: Record<MapScheme, string> = {
  light: 'basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  dark: 'basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
};

const ATTRIBUTION = '© OpenStreetMap © CARTO';

/**
 * Raster tile URLs for the Leaflet engine, which wants ONE template with an
 * `{s}` subdomain token and understands the `{r}` retina token.
 */
export function leafletTileUrl(scheme: MapScheme): string {
  return scheme === 'light'
    ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
}

/**
 * Raster tile URLs for MapLibre, which wants EXPLICIT per-subdomain URLs and
 * has no `{s}` or `{r}` token. Expanding a..d here rather than at each call
 * site is half the reason this module exists — the two engines disagree about
 * URL shape, and that disagreement is a provider detail, not a map detail.
 */
export function maplibreTileUrls(scheme: MapScheme): string[] {
  return ['a', 'b', 'c', 'd'].map((s) => `https://${s}.${CARTO_PATH[scheme]}`);
}

/**
 * The full MapLibre style. `bg` paints behind the tiles so a slow network shows
 * the app's own background rather than a white flash.
 *
 * PHASE D REPLACES THE BODY OF THIS FUNCTION and nothing else: a vector source
 * plus the layer list from §22 (land → water → landcover → buildings →
 * boundaries → roads → labels → POIs), with the place-label hierarchy of §23–26
 * and `name:xx` language fallbacks of §29. Callers keep working unchanged,
 * because a style spec is the whole contract between them and this file.
 */
export function mapStyle(scheme: MapScheme, bg: string): MapStyleSpec {
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: maplibreTileUrls(scheme),
        tileSize: 256,
        attribution: ATTRIBUTION,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': bg } },
      { id: 'base', type: 'raster', source: 'base' },
    ],
  };
}

/** True once this provider serves vector tiles — gates label/POI/style features. */
export function isVectorProvider(): boolean {
  return false;   // Phase D flips this with the source above.
}

// ── self-check: `npx tsx lib/map/tileProvider.ts` ──────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('tileProvider: ' + m); };

  for (const scheme of ['light', 'dark'] as MapScheme[]) {
    const urls = maplibreTileUrls(scheme);
    A(urls.length === 4, `${scheme}: four subdomains expected`);
    A(new Set(urls).size === 4, `${scheme}: subdomains must be distinct`);
    // MapLibre has no {s}/{r} tokens — leaving one in yields a 404 per tile,
    // which renders as a silently blank map rather than an error.
    A(urls.every((u) => !u.includes('{s}') && !u.includes('{r}')), `${scheme}: MapLibre URLs must not carry {s} or {r}`);
    A(urls.every((u) => u.includes('{z}') && u.includes('{x}') && u.includes('{y}')), `${scheme}: missing a z/x/y token`);
    // Leaflet is the mirror image: it NEEDS {s}.
    A(leafletTileUrl(scheme).includes('{s}'), `${scheme}: Leaflet URL must keep {s}`);

    const st = mapStyle(scheme, '#000');
    A(st.version === 8, 'style version must be 8');
    A(st.layers[0].id === 'bg', 'background must paint first');
    A(st.layers[st.layers.length - 1].id === 'base', 'tiles draw above the background');
    A(!!(st.sources as any).base.attribution, 'attribution is required by the tile terms');
  }
  A(mapStyle('light', '#fff').layers[0].paint!['background-color'] === '#fff', 'bg colour must reach the style');
  A(maplibreTileUrls('light')[0] !== maplibreTileUrls('dark')[0], 'light and dark must differ');

  console.log('map/tileProvider self-check: OK');
}

export default {};
