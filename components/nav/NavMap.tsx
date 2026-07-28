// components/nav/NavMap.tsx — the live route map. A WebView running Leaflet
// (embedded from the bundle, no CDN; no native map module → no prebuild, and it
// renders on no-GMS devices). Driven either by the nav service's geo store
// (active navigation) or by an explicit `data` prop (the setup preview): it draws
// the Valhalla route line, the destination, and a moving "you" dot that recenters
// on each GPS fix. Tiles are theme-aware CARTO raster (needs network; swap to
// self-hosted PMTiles for true offline tiles later — that's infra, not app code).

import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useTheme } from '../../lib/theme';
import { useNavGeo, type NavGeo } from '../../lib/nav/navigationService';
import { type LatLng } from '../../lib/nav/geo';
import { LEAFLET_JS_B64, LEAFLET_CSS_B64 } from './leafletAsset';

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
};

function html(tileUrl: string, bg: string, accent: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${LEAFLET_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
.you{width:20px;height:20px;border-radius:50%;background:#2f7bff;border:3px solid #fff;box-shadow:0 0 0 6px rgba(47,123,255,.20),0 1px 4px rgba(0,0,0,.4)}
.leaflet-control-attribution{font-size:9px;background:rgba(0,0,0,.35);color:#ddd}
.leaflet-control-attribution a{color:#bbf}</style>
</head><body><div id="map"></div>
<script src="data:text/javascript;base64,${LEAFLET_JS_B64}"></script>
<script>
var map=L.map('map',{zoomControl:false}).setView([20.6,78.9],4);
L.tileLayer('${tileUrl}',{maxZoom:19,subdomains:'abcd',
  attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);
var line=null,you=null,flag=null,fitted=false;
function setRoute(cs){ if(line)map.removeLayer(line); if(!cs||!cs.length)return;
  line=L.polyline(cs,{color:'${accent}',weight:6,opacity:.85,lineJoin:'round'}).addTo(map);
  if(!fitted){map.fitBounds(line.getBounds().pad(0.18));fitted=true;} }
function setDest(la,ln){ if(flag)map.removeLayer(flag);
  flag=L.circleMarker([la,ln],{radius:8,color:'#fff',weight:3,fillColor:'${accent}',fillOpacity:1}).addTo(map);
  if(!fitted&&!line){map.setView([la,ln],14);} }
function setPos(la,ln,follow){ var ic=L.divIcon({className:'',html:'<div class="you"></div>',iconSize:[20,20],iconAnchor:[10,10]});
  if(!you){you=L.marker([la,ln],{icon:ic,zIndexOffset:1000}).addTo(map);}else{you.setLatLng([la,ln]);}
  if(follow)map.setView([la,ln],Math.max(map.getZoom(),16),{animate:true}); }
function recenter(){ if(you)map.setView(you.getLatLng(),Math.max(map.getZoom(),16),{animate:true});
  else if(line)map.fitBounds(line.getBounds().pad(0.18));
  else if(flag)map.setView(flag.getLatLng(),14); }
var RN=window.ReactNativeWebView; if(RN)RN.postMessage('ready');
</script></body></html>`;
}

export default function NavMap({ style, data, follow = true }: { style?: any; data?: NavGeo; follow?: boolean }) {
  const { scheme, colors } = useTheme();
  const storeGeo = useNavGeo();
  const geo = data ?? storeGeo;
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const seen = useRef<{ shape: LatLng[] | null; dest: LatLng | null }>({ shape: null, dest: null });

  // Push only what changed. Shape/dest rarely change; pos changes every fix.
  useEffect(() => {
    if (!ready || !ref.current) return;
    let js = '';
    if (geo.shape.length && geo.shape !== seen.current.shape) {
      seen.current.shape = geo.shape;
      js += `setRoute(${JSON.stringify(geo.shape.map((p) => [p.lat, p.lng]))});`;
    }
    if (geo.dest && geo.dest !== seen.current.dest) {
      seen.current.dest = geo.dest;
      js += `setDest(${geo.dest.lat},${geo.dest.lng});`;
    }
    if (geo.pos) js += `setPos(${geo.pos.lat},${geo.pos.lng},${follow ? 1 : 0});`;
    if (js) ref.current.injectJavaScript(js + 'true;');
  }, [ready, geo, follow]);

  const recenter = () => ref.current?.injectJavaScript('recenter();true;');
  const source = { html: html(TILES[scheme === 'light' ? 'light' : 'dark'], colors.bg, colors.primary) };

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        ref={ref}
        source={source}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={(e) => { if (e.nativeEvent.data === 'ready') { seen.current = { shape: null, dest: null }; setReady(true); } }}
        style={{ backgroundColor: colors.bg }}
        androidLayerType="hardware"
      />
      {(geo.pos || geo.dest) && (
        <TouchableOpacity onPress={recenter} style={[styles.fab, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="locate" size={20} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  fab: { position: 'absolute', right: 12, bottom: 12, width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', elevation: 3 },
});
