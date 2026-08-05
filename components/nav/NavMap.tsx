// components/nav/NavMap.tsx — the live route map. A WebView running Leaflet
// (embedded from the bundle, no CDN; no native map module → no prebuild, and it
// renders on no-GMS devices). Driven either by the nav service's geo store
// (active navigation) or by an explicit `data` prop (the setup preview): it draws
// the Valhalla route line, the destination, and a moving "you" dot that recenters
// on each GPS fix. Tiles are theme-aware CARTO raster (needs network; swap to
// self-hosted PMTiles for true offline tiles later — that's infra, not app code).
//
// Location Lock additions (all optional props — navigate.tsx is unchanged):
//  * lock            — the geofence circle, fill/stroke in the zone color
//  * accuracyM       — blue GPS-accuracy circle around the "you" marker
//  * headingDeg      — rotates the "you" marker into a heading arrow + drives
//                      the compass needle
//  * showCompass     — Google-Maps-style compass inside the map (top-right).
//                      Leaflet can't rotate the basemap (see design.md), so the
//                      needle shows DEVICE heading; tapping recenters north-up.
//  * pin / onPinDrop — draggable selection pin + tap-to-drop for the lock
//                      setup flow.

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

export interface LockOverlay {
  center: LatLng;
  radius: number;      // metres
  color: string;       // zone color (stroke; fill at low alpha)
}

function html(tileUrl: string, bg: string, accent: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${LEAFLET_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
.you{width:20px;height:20px;border-radius:50%;background:#2f7bff;border:3px solid #fff;box-shadow:0 0 0 6px rgba(47,123,255,.20),0 1px 4px rgba(0,0,0,.4)}
.youwrap{width:20px;height:20px}
.youarrow{position:absolute;left:50%;top:-9px;margin-left:-5px;width:0;height:0;
  border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid #2f7bff;
  filter:drop-shadow(0 0 1px #fff)}
#compass{position:absolute;top:12px;right:12px;z-index:1000;width:42px;height:42px;border-radius:21px;
  background:rgba(20,22,28,.82);border:1px solid rgba(255,255,255,.25);display:none;
  align-items:center;justify-content:center;box-shadow:0 1px 6px rgba(0,0,0,.35)}
#needle{width:26px;height:26px;position:relative;transition:transform .15s linear}
#needle .n{position:absolute;left:50%;top:1px;margin-left:-4px;width:0;height:0;
  border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:11px solid #ef4444}
#needle .s{position:absolute;left:50%;bottom:1px;margin-left:-4px;width:0;height:0;
  border-left:4px solid transparent;border-right:4px solid transparent;border-top:11px solid #e5e7eb}
#needle .dot{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:2px;background:#fff}
.leaflet-control-attribution{font-size:9px;background:rgba(0,0,0,.35);color:#ddd}
.leaflet-control-attribution a{color:#bbf}</style>
</head><body><div id="map"></div>
<div id="compass"><div id="needle"><div class="n"></div><div class="s"></div><div class="dot"></div></div></div>
<script src="data:text/javascript;base64,${LEAFLET_JS_B64}"></script>
<script>
var map=L.map('map',{zoomControl:false}).setView([20.6,78.9],4);
L.tileLayer('${tileUrl}',{maxZoom:19,subdomains:'abcd',
  attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);
var RN=window.ReactNativeWebView;
var line=null,you=null,flag=null,fitted=false,lockC=null,accC=null,pinM=null,pinMode=0,hdg=0;
function setRoute(cs){ if(line)map.removeLayer(line); if(!cs||!cs.length)return;
  line=L.polyline(cs,{color:'${accent}',weight:6,opacity:.85,lineJoin:'round'}).addTo(map);
  if(!fitted){map.fitBounds(line.getBounds().pad(0.18));fitted=true;} }
function setDest(la,ln){ if(flag)map.removeLayer(flag);
  flag=L.circleMarker([la,ln],{radius:8,color:'#fff',weight:3,fillColor:'${accent}',fillOpacity:1}).addTo(map);
  if(!fitted&&!line){map.setView([la,ln],14);} }
function youIcon(){ var rot=isFinite(hdg)&&hdg>0?hdg:0;
  return L.divIcon({className:'',html:'<div class="youwrap" style="transform:rotate('+rot+'deg)"><div class="youarrow"></div><div class="you"></div></div>',iconSize:[20,20],iconAnchor:[10,10]}); }
function setPos(la,ln,follow,acc){
  if(!you){you=L.marker([la,ln],{icon:youIcon(),zIndexOffset:1000}).addTo(map);}else{you.setLatLng([la,ln]);you.setIcon(youIcon());}
  if(acc&&acc>0){ if(!accC){accC=L.circle([la,ln],{radius:acc,color:'#2f7bff',weight:1,opacity:.5,fillColor:'#2f7bff',fillOpacity:.12,interactive:false}).addTo(map);}else{accC.setLatLng([la,ln]);accC.setRadius(acc);} }
  else if(accC){map.removeLayer(accC);accC=null;}
  if(follow)map.setView([la,ln],Math.max(map.getZoom(),16),{animate:true}); }
function setHeading(h){ hdg=h; var el=document.getElementById('needle');
  if(el)el.style.transform='rotate('+(-h)+'deg)';
  if(you)you.setIcon(youIcon()); }
function showCompass(v){ document.getElementById('compass').style.display=v?'flex':'none'; }
function setLock(la,ln,r,color,fit){ if(!lockC){lockC=L.circle([la,ln],{radius:r,color:color,weight:2.5,opacity:.95,fillColor:color,fillOpacity:.16,interactive:false}).addTo(map);}
  else{lockC.setLatLng([la,ln]);lockC.setRadius(r);lockC.setStyle({color:color,fillColor:color});}
  if(fit&&!fitted){map.fitBounds(lockC.getBounds().pad(0.35));fitted=true;} }
function clearLock(){ if(lockC){map.removeLayer(lockC);lockC=null;} }
function setPin(la,ln){ if(!pinM){pinM=L.marker([la,ln],{draggable:true}).addTo(map);
    pinM.on('dragend',function(){var p=pinM.getLatLng();if(RN)RN.postMessage(JSON.stringify({type:'pin',lat:p.lat,lng:p.lng}));});
    map.setView([la,ln],Math.max(map.getZoom(),16));}
  else pinM.setLatLng([la,ln]); }
function clearPin(){ if(pinM){map.removeLayer(pinM);pinM=null;} }
function setPinMode(v){ pinMode=v; }
map.on('click',function(e){ if(!pinMode)return; setPin(e.latlng.lat,e.latlng.lng);
  if(RN)RN.postMessage(JSON.stringify({type:'pin',lat:e.latlng.lat,lng:e.latlng.lng})); });
document.getElementById('compass').addEventListener('click',function(){
  if(you)map.setView(you.getLatLng(),Math.max(map.getZoom(),16),{animate:true});
  if(RN)RN.postMessage(JSON.stringify({type:'compass'})); });
function recenter(){ if(you)map.setView(you.getLatLng(),Math.max(map.getZoom(),16),{animate:true});
  else if(lockC)map.fitBounds(lockC.getBounds().pad(0.35));
  else if(line)map.fitBounds(line.getBounds().pad(0.18));
  else if(flag)map.setView(flag.getLatLng(),14); }
function zoomBy(d){ map.setZoom(map.getZoom()+d,{animate:true}); }
if(RN)RN.postMessage('ready');
</script></body></html>`;
}

export default function NavMap({
  style, data, follow = true,
  lock, accuracyM, headingDeg, showCompass = false,
  pin, pinMode = false, onPinDrop, zoomControls = false,
}: {
  style?: any;
  data?: NavGeo;
  follow?: boolean;
  lock?: LockOverlay | null;
  accuracyM?: number;
  headingDeg?: number;
  showCompass?: boolean;
  pin?: LatLng | null;
  pinMode?: boolean;
  onPinDrop?: (p: LatLng) => void;
  zoomControls?: boolean;
}) {
  const { scheme, colors } = useTheme();
  const storeGeo = useNavGeo();
  const geo = data ?? storeGeo;
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const seen = useRef<{ shape: LatLng[] | null; dest: LatLng | null }>({ shape: null, dest: null });
  const onPinRef = useRef(onPinDrop);
  onPinRef.current = onPinDrop;

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
    if (geo.pos) js += `setPos(${geo.pos.lat},${geo.pos.lng},${follow ? 1 : 0},${accuracyM ?? 0});`;
    if (js) ref.current.injectJavaScript(js + 'true;');
  }, [ready, geo, follow, accuracyM]);

  // Lock circle — zone color changes ride the same bridge.
  useEffect(() => {
    if (!ready || !ref.current) return;
    if (lock) {
      ref.current.injectJavaScript(
        `setLock(${lock.center.lat},${lock.center.lng},${lock.radius},'${lock.color}',1);true;`,
      );
    } else {
      ref.current.injectJavaScript('clearLock();true;');
    }
  }, [ready, lock?.center.lat, lock?.center.lng, lock?.radius, lock?.color]);

  // Compass + heading (throttled upstream to ~4 Hz by the heading watcher).
  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`showCompass(${showCompass ? 1 : 0});true;`);
  }, [ready, showCompass]);
  useEffect(() => {
    if (!ready || !ref.current || headingDeg == null) return;
    ref.current.injectJavaScript(`setHeading(${Math.round(headingDeg)});true;`);
  }, [ready, headingDeg]);

  // Selection pin (setup flow).
  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setPinMode(${pinMode ? 1 : 0});true;`);
  }, [ready, pinMode]);
  useEffect(() => {
    if (!ready || !ref.current) return;
    if (pin) ref.current.injectJavaScript(`setPin(${pin.lat},${pin.lng});true;`);
    else ref.current.injectJavaScript('clearPin();true;');
  }, [ready, pin?.lat, pin?.lng]);

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
        onMessage={(e) => {
          const raw = e.nativeEvent.data;
          if (raw === 'ready') { seen.current = { shape: null, dest: null }; setReady(true); return; }
          try {
            const m = JSON.parse(raw);
            if (m?.type === 'pin' && onPinRef.current) onPinRef.current({ lat: m.lat, lng: m.lng });
          } catch {}
        }}
        style={{ backgroundColor: colors.bg }}
        androidLayerType="hardware"
      />
      {zoomControls && (
        <View style={[styles.zoomBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity onPress={() => ref.current?.injectJavaScript('zoomBy(1);true;')} style={styles.zoomBtn}>
            <Ionicons name="add" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={[styles.zoomSep, { backgroundColor: colors.border }]} />
          <TouchableOpacity onPress={() => ref.current?.injectJavaScript('zoomBy(-1);true;')} style={styles.zoomBtn}>
            <Ionicons name="remove" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
      )}
      {(geo.pos || geo.dest || lock) && (
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
  zoomBox: { position: 'absolute', right: 12, bottom: 66, width: 44, borderRadius: 14, borderWidth: 1, overflow: 'hidden', elevation: 3 },
  zoomBtn: { height: 40, alignItems: 'center', justifyContent: 'center' },
  zoomSep: { height: StyleSheet.hairlineWidth, marginHorizontal: 8 },
});
