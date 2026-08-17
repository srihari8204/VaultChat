// scripts/maplibre-shim.js — resolve `import ... from 'maplibre-gl'` to the
// copy ALREADY loaded in the page.
//
// The map page loads maplibre-gl from its own embedded asset (≈1.1 MB) before
// this bundle runs, so `window.maplibregl` exists by the time any of these
// libraries touch it. Without this shim there are only bad options:
//
//   * bundle maplibre-gl again  → +1.1 MB in the APK for a second copy of a
//     library already on the page, and two GL contexts fighting over one map;
//   * mark it `external`        → esbuild's IIFE output replaces it with a
//     __require() stub that THROWS "Dynamic require of maplibre-gl is not
//     supported" the moment the bundle loads. That killed the whole bundle
//     silently on the Honor: no globals, no error visible on the map, and the
//     routing engine simply absent.
//
// Aliasing to the live global is the only version that is both correct and free.

const gl = (typeof window !== 'undefined' && window.maplibregl) || {};

export default gl;

// Named exports the libraries reach for. Read through to the live object at
// call time rather than captured at module load, so load order cannot bite.
export const Map = gl.Map;
export const Marker = gl.Marker;
export const Popup = gl.Popup;
export const LngLat = gl.LngLat;
export const LngLatBounds = gl.LngLatBounds;
export const NavigationControl = gl.NavigationControl;
