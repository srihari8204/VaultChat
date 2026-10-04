// constants/navMapPalette.ts — the fixed colours drawn INSIDE the map pages of
// components/nav/NavMap.tsx (Leaflet and MapLibre) and components/LocationMap.tsx.
//
// Deliberately NOT theme tokens. These pages are HTML in a WebView, painted on
// the basemap, and lib/map/tileProvider serves the same full-colour, light
// `liberty` style in BOTH themes. Markers on it therefore keep one colour set,
// following the usual map conventions: a blue "you" dot in a white ring, a
// red north needle on a dark compass. A theme-following dot would sink into
// the light map in dark mode. What the theme does decide is passed in by the
// components (page background, route line, destination and pin: `colors.bg` /
// `colors.primary`; the lock circle: the zone colour).
//
// Text sits on two of these grounds: the map credits. OpenStreetMap's licence
// requires the credit to stay legible, so constants/navMapPalette.selftest.ts
// asserts the credit ink and link are at least 4.5:1 on their plate, with the
// plate composited over both a white and a black map.

export const NAV_MAP = {
  /** The "you" dot, its heading arrow and the GPS-accuracy circle. */
  you: '#2f7bff',
  /** Soft halo around the "you" dot (`you` at 20%). */
  youHalo: 'rgba(47,123,255,.20)',
  /** White ring around the "you" and destination dots; the needle hub. */
  ring: '#ffffff',
  /** Drop shadow under markers. */
  markerShadow: 'rgba(0,0,0,.4)',
  /** Compass button: a dark disc in both themes, like the maps people know. */
  compassGround: 'rgba(20,22,28,.82)',
  compassEdge: 'rgba(255,255,255,.25)',
  compassShadow: 'rgba(0,0,0,.35)',
  needleNorth: '#ef4444',
  needleSouth: '#e5e7eb',
  /** Leaflet credit plate (the Leaflet fallback has no basemap, so this sits on
   *  the page background, which is light in the light theme). Was #ddd on
   *  rgba(0,0,0,.35): 1.8:1 over a light page. */
  creditGround: 'rgba(0,0,0,.6)',
  creditInk: '#ffffff',
  creditLink: '#e0e7ff',
} as const;

/** components/LocationMap.tsx: the single-pin map on /location. */
export const PIN_MAP = {
  /** White ring around the pin (its fill is the theme primary). */
  ring: '#ffffff',
  pinShadow: 'rgba(0,0,0,.45)',
  /** Credit plate. Was 82% white: the link fell to 4.2:1 over dark tiles. */
  creditGround: 'rgba(255,255,255,.9)',
  creditInk: '#111111',
  creditLink: '#0b57d0',
} as const;
