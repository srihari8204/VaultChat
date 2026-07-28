// components/family/FamilyMap.tsx — the Family Circle map. A WebView running the
// bundled Leaflet (no CDN, no native map module, renders on no-GMS) that plots
// every circle member as a labelled dot from their decrypted live position, fits
// them all in view, and reports taps back so the screen can focus/navigate. Purely
// a renderer: it holds no location itself, it draws what the screen decrypts.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useTheme } from '../../lib/theme';
import { LEAFLET_JS_B64, LEAFLET_CSS_B64 } from '../nav/leafletAsset';

export interface FamilyMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  battery?: number;   // 0..100
  self?: boolean;
  stale?: boolean;    // last fix older than the freshness threshold
}

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
};
const COLORS = ['#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316'];
const initials = (name: string) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

function html(tileUrl: string, bg: string, selfColor: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${LEAFLET_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
.mk{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:#fff;font:700 12px system-ui,sans-serif;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)}
.mk.self{box-shadow:0 0 0 5px ${selfColor}33,0 1px 5px rgba(0,0,0,.45)}
.mk.stale{opacity:.55}
.leaflet-control-attribution{font-size:9px;background:rgba(0,0,0,.35);color:#ddd}
.leaflet-control-attribution a{color:#bbf}</style>
</head><body><div id="map"></div>
<script src="data:text/javascript;base64,${LEAFLET_JS_B64}"></script>
<script>
var map=L.map('map',{zoomControl:false}).setView([20.6,78.9],4);
L.tileLayer('${tileUrl}',{maxZoom:19,subdomains:'abcd',attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);
var RN=window.ReactNativeWebView, markers={}, fitted=false;
function setMembers(list){ var seen={};
  list.forEach(function(m){ seen[m.id]=1;
    var cls='mk'+(m.self?' self':'')+(m.stale?' stale':'');
    var ic=L.divIcon({className:'',html:'<div class="'+cls+'" style="background:'+m.color+'">'+m.ini+'</div>',iconSize:[34,34],iconAnchor:[17,17]});
    if(markers[m.id]){ markers[m.id].setLatLng([m.lat,m.lng]).setIcon(ic); }
    else { var mk=L.marker([m.lat,m.lng],{icon:ic}).addTo(map);
      mk.on('click',(function(id){return function(){ if(RN)RN.postMessage('sel:'+id); };})(m.id));
      markers[m.id]=mk; } });
  Object.keys(markers).forEach(function(id){ if(!seen[id]){ map.removeLayer(markers[id]); delete markers[id]; } });
  if(!fitted) fitAll();
}
function fitAll(){ var ids=Object.keys(markers); if(!ids.length)return;
  if(ids.length===1){ map.setView(markers[ids[0]].getLatLng(),15); }
  else { map.fitBounds(L.featureGroup(ids.map(function(id){return markers[id];})).getBounds().pad(0.25)); }
  fitted=true;
}
function focus(id){ if(markers[id]) map.setView(markers[id].getLatLng(),16,{animate:true}); }
if(RN)RN.postMessage('ready');
</script></body></html>`;
}

export default function FamilyMap({ members, onSelect, focusId, style }: {
  members: FamilyMarker[];
  onSelect?: (id: string) => void;
  focusId?: string | null;
  style?: any;
}) {
  const { scheme, colors } = useTheme();
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  // Assign each member a stable colour by id order (self keeps the accent).
  const payload = useMemo(() => members.map((m, i) => ({
    id: m.id, lat: m.lat, lng: m.lng, self: !!m.self, stale: !!m.stale,
    ini: initials(m.name), color: m.self ? colors.primary : COLORS[i % COLORS.length],
  })), [members, colors.primary]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setMembers(${JSON.stringify(payload)});true;`);
  }, [ready, payload]);

  useEffect(() => {
    if (ready && focusId && ref.current) ref.current.injectJavaScript(`focus(${JSON.stringify(focusId)});true;`);
  }, [ready, focusId]);

  const source = { html: html(TILES[scheme === 'light' ? 'light' : 'dark'], colors.bg, colors.primary) };

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        ref={ref}
        source={source}
        originWhitelist={['*']}
        javaScriptEnabled
        onMessage={(e) => {
          const d = e.nativeEvent.data;
          if (d === 'ready') setReady(true);
          else if (d.startsWith('sel:')) onSelect?.(d.slice(4));
        }}
        style={{ backgroundColor: colors.bg }}
        androidLayerType="hardware"
      />
      <TouchableOpacity onPress={() => ref.current?.injectJavaScript('fitAll();true;')} style={[styles.fab, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="scan" size={20} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  fab: { position: 'absolute', right: 12, bottom: 12, width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', elevation: 3 },
});
