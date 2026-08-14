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
import { clusterForZoom } from '../../lib/groups/clustering';

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
.cl{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:#fff;font:800 14px system-ui,sans-serif;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5)}
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
    var isCl=m.count>1;
    var cls=isCl?'cl':('mk'+(m.self?' self':'')+(m.stale?' stale':''));
    var body=isCl?String(m.count):m.ini;
    var sz=isCl?42:34, anc=sz/2;
    var ic=L.divIcon({className:'',html:'<div class="'+cls+'" style="background:'+m.color+'">'+body+'</div>',iconSize:[sz,sz],iconAnchor:[anc,anc]});
    if(markers[m.id]){ markers[m.id].setLatLng([m.lat,m.lng]).setIcon(ic); }
    else { var mk=L.marker([m.lat,m.lng],{icon:ic}).addTo(map);
      mk.on('click',(function(id,cluster,ll){return function(){
        // A cluster has no single member to select, so tapping it zooms in
        // until it breaks apart — the standard, non-surprising behaviour.
        if(cluster){ map.setView(ll, Math.min(map.getZoom()+2, 19), {animate:true}); }
        else if(RN){ RN.postMessage('sel:'+id); }
      };})(m.id, isCl, [m.lat,m.lng]));
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
// Location-history track. Drawn under the markers; fitting the line wins over
// fitAll() because when a path is supplied it IS the subject of the view.
var pathLine=null, pathDots=[];
function setPath(pts){
  if(pathLine){ map.removeLayer(pathLine); pathLine=null; }
  pathDots.forEach(function(d){ map.removeLayer(d); }); pathDots=[];
  if(!pts||pts.length<2) return;
  var ll=pts.map(function(p){ return [p.lat,p.lng]; });
  pathLine=L.polyline(ll,{color:'${selfColor}',weight:4,opacity:.85,lineJoin:'round'}).addTo(map);
  [[ll[0],'#22C55E'],[ll[ll.length-1],'#EF4444']].forEach(function(e){
    pathDots.push(L.circleMarker(e[0],{radius:6,color:'#fff',weight:2,fillColor:e[1],fillOpacity:1}).addTo(map));
  });
  map.fitBounds(pathLine.getBounds().pad(0.2));
  fitted=true;
}
function reportZoom(){ if(RN)RN.postMessage('zoom:'+map.getZoom()); }
map.on('zoomend', reportZoom);
if(RN)RN.postMessage('ready');
reportZoom();
</script></body></html>`;
}

export default function FamilyMap({ members, onSelect, focusId, followId, path, style }: {
  members: FamilyMarker[];
  onSelect?: (id: string) => void;
  focusId?: string | null;
  /**
   * Keep the map centred on this member as they MOVE (spec: Follow member).
   * `focusId` centres once when it changes; following has to re-centre on every
   * new position, which is a different trigger — hence a separate prop rather
   * than a flag on focusId.
   */
  followId?: string | null;
  /** Location-history track, oldest→newest. Start/end get green/red caps. */
  path?: { lat: number; lng: number }[];
  style?: any;
}) {
  const { scheme, colors } = useTheme();
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // The map owns the zoom; it reports each change so we can re-cluster here
  // rather than duplicating the algorithm in injected JavaScript.
  const [zoom, setZoom] = useState(13);

  // Assign each member a stable colour by id order (self keeps the accent),
  // then merge markers that would visually collide at the current zoom.
  const payload = useMemo(() => {
    const coloured = members.map((m, i) => ({
      id: m.id, lat: m.lat, lng: m.lng, self: !!m.self, stale: !!m.stale,
      ini: initials(m.name), color: m.self ? colors.primary : COLORS[i % COLORS.length],
    }));
    return clusterForZoom(coloured, zoom).map((c) => {
      const head = c.items[0];
      // A cluster containing me keeps the accent, so "where am I" survives
      // being merged into a bubble.
      const mine = c.items.some((it) => it.self);
      return {
        id: c.key,
        lat: c.lat, lng: c.lng,
        count: c.items.length,
        self: mine,
        // A bubble is stale only when EVERY member in it is stale; one live
        // member means the group is live.
        stale: c.items.every((it) => it.stale),
        ini: head.ini,
        color: mine ? colors.primary : head.color,
      };
    });
  }, [members, colors.primary, zoom]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setMembers(${JSON.stringify(payload)});true;`);
  }, [ready, payload]);

  useEffect(() => {
    if (ready && focusId && ref.current) ref.current.injectJavaScript(`focus(${JSON.stringify(focusId)});true;`);
  }, [ready, focusId]);

  // FOLLOW: re-centre whenever the followed member's POSITION changes. Keyed on
  // their coordinates, not on `members`, so unrelated members moving (or a
  // re-cluster at the same zoom) does not yank the camera. No polling — this
  // rides the presence updates that already arrive.
  const followed = followId ? members.find((m) => m.id === followId) : undefined;
  useEffect(() => {
    if (!ready || !followed || !ref.current) return;
    ref.current.injectJavaScript(`focus(${JSON.stringify(followed.id)});true;`);
  }, [ready, followed?.id, followed?.lat, followed?.lng]);

  // Thin the track before it crosses the bridge: a month of samples is thousands
  // of points and Leaflet gains nothing from more than a few hundred.
  const trackJs = useMemo(() => {
    if (!path?.length) return '[]';
    const step = Math.ceil(path.length / 400);
    const thinned = step > 1 ? path.filter((_, i) => i % step === 0 || i === path.length - 1) : path;
    return JSON.stringify(thinned.map((p) => ({ lat: p.lat, lng: p.lng })));
  }, [path]);

  useEffect(() => {
    if (ready && ref.current) ref.current.injectJavaScript(`setPath(${trackJs});true;`);
  }, [ready, trackJs]);

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
          else if (d.startsWith('zoom:')) {
            const z = Number(d.slice(5));
            if (Number.isFinite(z)) setZoom(z);
          } else if (d.startsWith('sel:')) onSelect?.(d.slice(4));
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
