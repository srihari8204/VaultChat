// scripts/routing-entry.js — what the WebView gets.
//
// Bundled by scripts/build-routing-asset.js into components/nav/routingAsset.ts.
// Everything here runs INSIDE the map page, beside maplibre-gl, so it exposes
// its pieces on `window` for the page script to use.
//
// route-snapper is deliberately NOT here: it ships a WebAssembly module and
// needs a pre-built graph file for a fixed geographic area. Embedding a graph
// large enough for "India, down to villages" would dwarf the app, so it stays
// out until there is a decided area and a hosted graph to fetch.

import { AnyRouting } from '@any-routing/core';
// NOTE: the class is MapLibreProjector, not the "MaplibreEngine" the README
// suggests, and it is a PLUGIN rather than an engine — it goes in
// AnyRouting({plugins:[...]}), not in an `engine` field. Verified against the
// installed .d.ts; the published docs are wrong on both counts.
import { MapLibreProjector } from '@any-routing/maplibre-engine';
import MaplibrePegman from 'maplibre-pegman';

window.AnyRouting = AnyRouting;
window.MapLibreProjector = MapLibreProjector;
window.MaplibrePegman = MaplibrePegman;

/**
 * Build the routing controller for a given map.
 *
 * `routeLayersFactory` is required and is what actually draws the line — the
 * projector renders nothing on its own. One line layer is enough here; the
 * family map already has its own styling language and a second, louder route
 * style would fight the connectors.
 */
window.makeAnyRouting = (map, colour) => new window.AnyRouting({
  dataProvider: window.makeValhallaProvider(),
  // 'none' because our waypoints are family members' live positions — snapping
  // them to the returned path would move a person's dot to the road, which is
  // a lie about where they are.
  waypointsSyncStrategy: 'none',
  plugins: [new window.MapLibreProjector({
    map,
    editable: false,
    canAddWaypoints: false,
    canDragWaypoints: false,
    routeLayersFactory: [({ sourceId }) => ({
      specification: {
        id: 'anyr-route',
        type: 'line',
        source: sourceId,
        paint: { 'line-color': colour, 'line-width': 5, 'line-opacity': 0.95 },
        layout: { 'line-join': 'round', 'line-cap': 'round' },
      },
    })],
  })],
});

/**
 * Valhalla-backed data provider.
 *
 * THIS IS THE WHOLE POINT OF THE INTEGRATION: any-routing owns waypoints,
 * dragging, alternates and rendering; the ROUTE ITSELF still comes from the
 * self-hosted Valhalla that is already deployed and proven. No second routing
 * engine, no API key, and coverage stays global.
 *
 * The request is bridged to React Native rather than fetched here, because the
 * auth token lives on the native side and must not be handed to a web context.
 * RN answers by calling __anyRouteReply(id, payload).
 */
const pending = new Map();
let seq = 0;

window.__anyRouteReply = (id, payload, error) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) p.reject(new Error(error));
  else p.resolve(payload);
};

window.makeValhallaProvider = () => ({
  request(waypoints) {
    const id = ++seq;
    const RN = window.ReactNativeWebView;
    if (!RN) return Promise.reject(new Error('no bridge'));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      RN.postMessage(JSON.stringify({
        type: 'route-request',
        id,
        waypoints: waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
      }));
    }).then((r) => {
      // Shape Valhalla's answer into what any-routing expects. `path` is
      // [lng,lat] here — the opposite order to our own LatLng — and getting it
      // backwards draws a route in the wrong hemisphere, silently.
      const coords = (r.shape || []).map((p) => [p.lng, p.lat]);
      const shape = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { routeId: 0, waypoint: 0 },
          geometry: { type: 'LineString', coordinates: coords },
        }],
      };
      const now = Date.now();
      return {
        rawResponse: r,
        routesShapeGeojson: shape,
        routes: [{
          id: 0,
          label: r.label || '',
          path: coords,
          durationTime: r.timeS || 0,
          distance: r.lengthM || 0,
          departureTime: new Date(now),
          arriveTime: new Date(now + (r.timeS || 0) * 1000),
          waypoints: waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
          shape,
        }],
        selectedRouteId: 0,
        version: id,
        latest: true,
        mode: 'default',
      };
    });
  },
  destroy() { pending.clear(); },
  hasPendingRequests() { return Promise.resolve(pending.size > 0); },
  abortAllRequests() { pending.clear(); },
});
