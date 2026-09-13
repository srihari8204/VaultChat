// components/LocationMap.tsx — the one map the location screens share.
//
// WHY A WEBVIEW AND NOT A NATIVE MAP. There is no native map module installed
// here: `@maplibre/maplibre-react-native` is in neither package.json nor
// node_modules. Every map this app already draws — components/nav/NavMap and
// components/family/FamilyMap — is MapLibre GL **JS** running inside a WebView,
// with the library embedded as base64 in the bundle (components/nav/
// maplibreAsset) so nothing is fetched from a CDN. That is the pattern this
// follows: no native module, no prebuild, and it works on no-GMS devices.
//
// Modelled on NavMap's MapLibre page, cut down hard. NavMap's job — one moving
// marker that recentres on each GPS fix, plus a line — is exactly this job;
// FamilyMap's — N members, clustering, per-member colours, road routes — is not.
// Everything NavMap has that a location pin does not need (route, geofence
// circle, compass, draggable pin, 3D buildings, chase-cam) is gone.
//
// WHAT IT DELIBERATELY DOES NOT DO: fall back to Leaflet. NavMap and FamilyMap
// downgrade to their Leaflet page when WebGL is missing, but lib/map/
// tileProvider's RASTER_FALLBACK_URL is deliberately empty — there is no raster
// provider we are licensed to point installs at — so that fallback draws a
// marker on a BLANK RECTANGLE. On a screen whose entire purpose is "here is
// where I am", a blank rectangle is a lie. This says the map could not load,
// still shows the coordinates, and offers a retry.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useTheme } from '../lib/theme';
import { MAPLIBRE_JS_B64, MAPLIBRE_CSS_B64 } from './nav/maplibreAsset';
import { mapStyleUrl } from '../lib/map/tileProvider';

export interface MapPoint { lat: number; lng: number }

/** What the SCREEN knows about the fix. The map cannot tell "permission was
 *  refused" from "the fix has not arrived yet" — only the screen that asked
 *  can, so it says which, and the two get different honest copy. */
export type LocationMapStatus = 'ok' | 'locating' | 'denied';

/** The page. Same shape as NavMap's mlHtml: one JS function per thing that can
 *  change, driven by injectJavaScript once 'ready' has been posted. */
function page(styleUrl: string, bg: string, accent: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${MAPLIBRE_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
.pin{width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
  background:${accent};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45)}
.maplibregl-ctrl-attrib{font-size:9px}</style>
</head><body><div id="map"></div>
<script src="data:text/javascript;base64,${MAPLIBRE_JS_B64}"></script>
<script>
var RN=window.ReactNativeWebView;
// No WebGL → say so ONCE, deterministically. Without this the constructor
// throws, nothing below runs, and the RN side waits forever for a 'ready' that
// can never arrive. The same guard both other maps use.
function webglOK(){ try{ var c=document.createElement('canvas');
  return !!(window.WebGLRenderingContext&&(c.getContext('webgl')||c.getContext('experimental-webgl'))); }catch(e){ return false; } }
if(!webglOK()){ if(RN)RN.postMessage(JSON.stringify({type:'maperror',msg:'this device cannot draw maps (no WebGL)'})); throw new Error('no webgl'); }
var STYLE=${JSON.stringify(styleUrl)};
var map=new maplibregl.Map({container:'map',center:[78.9,20.6],zoom:3,
  attributionControl:{compact:true},style:STYLE});
var pin=null,placed=false,lastTouch=0,ready=false;
function setPos(la,ln){
  if(!pin){ var el=document.createElement('div'); el.className='pin';
    pin=new maplibregl.Marker({element:el}).setLngLat([ln,la]).addTo(map); }
  else pin.setLngLat([ln,la]);
  // The first fix jumps — no animation across the ocean from the start view.
  // Later fixes glide, and a hand that just panned is left alone for 10s.
  if(!placed){ map.jumpTo({center:[ln,la],zoom:16}); placed=true; return; }
  if(Date.now()-lastTouch>10000) map.easeTo({center:[ln,la],duration:600});
}
function setTrail(pts){
  var coords=(pts||[]).map(function(p){ return [p.lng,p.lat]; });
  var geo={type:'Feature',geometry:{type:'LineString',coordinates:coords}};
  if(map.getSource('trail')){ map.getSource('trail').setData(geo); return; }
  if(coords.length<2) return;
  map.addSource('trail',{type:'geojson',data:geo});
  map.addLayer({id:'trail-l',type:'line',source:'trail',
    paint:{'line-color':'${accent}','line-width':4,'line-opacity':.85},
    layout:{'line-join':'round','line-cap':'round'}});
}
function recenter(){ if(pin) map.easeTo({center:pin.getLngLat(),zoom:Math.max(map.getZoom(),16),duration:400}); }
map.on('dragstart',function(){ lastTouch=Date.now(); });
map.on('zoomstart',function(e){ if(e.originalEvent) lastTouch=Date.now(); });
// The style picks POI icons from the tile data at runtime, so a sprite the
// style lacks warns once per missing NAME, unbounded as you move. Register a
// blank: the label still draws and logcat stays readable. (As NavMap does.)
map.on('styleimagemissing',function(e){
  try{ if(!map.hasImage(e.id)) map.addImage(e.id,{width:1,height:1,data:new Uint8Array(4)}); }catch(x){}
});
map.on('load',function(){ ready=true; if(RN)RN.postMessage('ready'); });
// The style is FETCHED, so a flaky first minute is the network, not the device.
// MapLibre never retries a failed style itself; 8 tries capped at 5s (~33s
// total) survives a lift or a tunnel before we admit defeat. Errors AFTER first
// paint are individual tiles and must not tear down a map that is working.
var tries=0;
map.on('error',function(e){
  if(ready) return;
  var msg=(e&&e.error&&e.error.message)||'map error';
  if(tries<8){ tries++; setTimeout(function(){ try{ map.setStyle(STYLE); }catch(x){} },Math.min(1200*tries,5000)); return; }
  if(RN)RN.postMessage(JSON.stringify({type:'maperror',msg:msg}));
});
</script></body></html>`;
}

export default function LocationMap({
  coord, trail, height = 200, status, style,
}: {
  /** Where the pin goes. Null while there is no fix. */
  coord: MapPoint | null;
  /** Live track, oldest→newest. Omit for the static one-pin case. */
  trail?: MapPoint[] | null;
  /** Map height in points. The placeholder states use it as a minHeight, so the
   *  screen does not jump when the fix lands. */
  height?: number;
  /** What the screen knows. Defaults to ok/locating from `coord`. */
  status?: LocationMapStatus;
  style?: any;
}) {
  const { scheme, colors } = useTheme();
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Bumped by Try again to remount the WebView — reloading the page is the only
  // way to redo the WebGL check and re-fetch a style it already gave up on.
  const [attempt, setAttempt] = useState(0);

  const state: LocationMapStatus = status ?? (coord ? 'ok' : 'locating');

  useEffect(() => {
    if (!ready || !coord || !ref.current) return;
    ref.current.injectJavaScript(`setPos(${coord.lat},${coord.lng});true;`);
    // Keyed on the COORDINATES, not the object: a parent that rebuilds the
    // literal every render would otherwise re-centre the camera on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, coord?.lat, coord?.lng]);

  // Thin before crossing the bridge: an hour of live sharing is hundreds of
  // fixes and the line looks identical at 300 points.
  const trailJs = useMemo(() => {
    if (!trail?.length) return '[]';
    const step = Math.ceil(trail.length / 300);
    const thin = step > 1 ? trail.filter((_, i) => i % step === 0 || i === trail.length - 1) : trail;
    return JSON.stringify(thin.map((p) => ({ lat: p.lat, lng: p.lng })));
  }, [trail]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setTrail(${trailJs});true;`);
  }, [ready, trailJs]);

  const mapScheme = scheme === 'light' ? 'light' : 'dark';
  // Memoized: page() concatenates the ~1.1MB embedded MapLibre bundle into a
  // fresh string on every call, and this re-renders on every GPS fix. The
  // WebView never re-navigates on an unchanged source.html. NavMap and
  // FamilyMap both carry the same memo for the same reason.
  const source = useMemo(
    () => ({ html: page(mapStyleUrl(mapScheme), colors.bg, colors.primary) }),
    [mapScheme, colors.bg, colors.primary],
  );

  const shell = [
    S.card,
    { minHeight: height, backgroundColor: colors.glassSoft, borderColor: colors.glassStroke },
    style,
  ];

  if (state === 'denied') {
    return (
      <View style={shell}>
        <Ionicons name="lock-closed-outline" size={26} color={colors.textDim} />
        <Text style={[S.title, { color: colors.text }]}>No location permission</Text>
        <Text style={[S.sub, { color: colors.textDim }]}>
          The map stays blank until location access is allowed.
        </Text>
      </View>
    );
  }

  if (!coord) {
    return (
      <View style={shell}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[S.sub, { color: colors.textDim }]}>Waiting for a GPS fix…</Text>
      </View>
    );
  }

  if (failed) {
    // Honest, not blank: name the failure, still give the coordinates, offer a
    // retry. This is the state a silent grey rectangle used to hide.
    return (
      <View style={shell}>
        <Ionicons name="cloud-offline-outline" size={26} color={colors.textDim} />
        <Text style={[S.title, { color: colors.text }]}>Map couldn’t load</Text>
        <Text style={[S.sub, { color: colors.textDim }]}>{failed}</Text>
        <Text style={[S.coords, { color: colors.text }]}>
          {coord.lat.toFixed(5)}, {coord.lng.toFixed(5)}
        </Text>
        <TouchableOpacity
          onPress={() => { setFailed(null); setReady(false); setAttempt((a) => a + 1); }}
          style={[S.retry, { borderColor: colors.glassStroke }]}
        >
          <Ionicons name="refresh" size={14} color={colors.primary} />
          <Text style={[S.retryTxt, { color: colors.primary }]}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[S.wrap, { height, borderColor: colors.glassStroke, backgroundColor: colors.bg }, style]}>
      <WebView
        key={attempt}
        ref={ref}
        source={source}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={(e) => {
          const raw = e.nativeEvent.data;
          if (raw === 'ready') { setReady(true); return; }
          try {
            const m = JSON.parse(raw);
            if (m?.type === 'maperror') {
              // console.WARN, not log: babel strips console.log from release
              // builds, which are exactly the builds this happens on.
              console.warn('[LocationMap] map failed to load:', m.msg);
              setFailed(String(m.msg ?? 'the map tiles are unreachable'));
            }
          } catch { /* not JSON — nothing else uses this channel */ }
        }}
        style={{ backgroundColor: colors.bg }}
        androidLayerType="hardware"
      />
      <TouchableOpacity
        onPress={() => ref.current?.injectJavaScript('recenter();true;')}
        accessibilityRole="button"
        accessibilityLabel="Recentre the map on the pin"
        style={[S.fab, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}
      >
        <Ionicons name="locate" size={18} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

const S = StyleSheet.create({
  // layout-exempt: a map viewport, not a text box — it holds a WebView and one
  // icon button, so there is no text here that a large font scale can clip.
  // Its height is passed in and applied inline by the caller's `height` prop.
  wrap: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  // The placeholder states DO hold text, so they take the same number as a
  // minHeight (applied above) and grow with the font scale instead of clipping.
  card: { borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', padding: 18, gap: 6 },
  title: { fontSize: 14.5, fontWeight: '800', textAlign: 'center' },
  sub: { fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  coords: { fontSize: 13, fontWeight: '700', marginTop: 2 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  retryTxt: { fontSize: 12.5, fontWeight: '700' },
  fab: { position: 'absolute', right: 10, bottom: 10, width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
