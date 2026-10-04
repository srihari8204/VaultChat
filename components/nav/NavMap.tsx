// components/nav/NavMap.tsx — the live route map. A WebView running Leaflet
// (embedded from the bundle, no CDN; no native map module → no prebuild, and it
// renders on no-GMS devices). Driven either by the nav service's geo store
// (active navigation) or by an explicit `data` prop (the setup preview): it draws
// the Valhalla route line, the destination, and a moving "you" dot that recenters
// on each GPS fix. Tiles are theme-aware OpenStreetMap VECTOR tiles from
// OpenFreeMap — keyless (needs network; swap to self-hosted PMTiles for true
// offline tiles later — that's infra, not app code, see lib/map/tileProvider).
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useTheme } from '../../lib/theme';
import { useNavGeo, type NavGeo } from '../../lib/nav/navigationService';
import { type LatLng } from '../../lib/nav/geo';
import { LEAFLET_JS_B64, LEAFLET_CSS_B64 } from './leafletAsset';
import { MAPLIBRE_JS_B64, MAPLIBRE_CSS_B64 } from './maplibreAsset';
import { NAV_MAP_3D } from '../../constants/flags';
import { mapStyleUrl, buildings3DLayer, RASTER_FALLBACK_URL, ATTRIBUTION } from '../../lib/map/tileProvider';
// Fixed marker, compass and credit colours drawn inside the pages; why they are
// not theme tokens is documented there.
import { NAV_MAP } from '../../constants/navMapPalette';

// Tiles come from lib/map/tileProvider — the ONE place that names a provider.
// MapLibre gets a vector STYLE URL; the Leaflet fallback below can only draw
// raster, and today there is no raster source we may use, so it runs with no
// basemap (route, lock and markers still draw). See tileProvider for why.

/** Camera modes for the 3D map. follow = pitched chase-cam that rotates to your
 *  heading; north = flat, north-up follow; overview = fit the whole route. */
export type CameraMode = 'follow' | 'north' | 'overview';

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
.you{width:20px;height:20px;border-radius:50%;background:${NAV_MAP.you};border:3px solid ${NAV_MAP.ring};box-shadow:0 0 0 6px ${NAV_MAP.youHalo},0 1px 4px ${NAV_MAP.markerShadow}}
.youwrap{width:20px;height:20px}
.youarrow{position:absolute;left:50%;top:-9px;margin-left:-5px;width:0;height:0;
  border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid ${NAV_MAP.you};
  filter:drop-shadow(0 0 1px ${NAV_MAP.ring})}
#compass{position:absolute;top:12px;right:12px;z-index:1000;width:42px;height:42px;border-radius:21px;
  background:${NAV_MAP.compassGround};border:1px solid ${NAV_MAP.compassEdge};display:none;
  align-items:center;justify-content:center;box-shadow:0 1px 6px ${NAV_MAP.compassShadow}}
#needle{width:26px;height:26px;position:relative;transition:transform .15s linear}
#needle .n{position:absolute;left:50%;top:1px;margin-left:-4px;width:0;height:0;
  border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:11px solid ${NAV_MAP.needleNorth}}
#needle .s{position:absolute;left:50%;bottom:1px;margin-left:-4px;width:0;height:0;
  border-left:4px solid transparent;border-right:4px solid transparent;border-top:11px solid ${NAV_MAP.needleSouth}}
#needle .dot{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:2px;background:${NAV_MAP.ring}}
.leaflet-control-attribution{font-size:9px;background:${NAV_MAP.creditGround};color:${NAV_MAP.creditInk}}
.leaflet-control-attribution a{color:${NAV_MAP.creditLink}}</style>
</head><body><div id="map"></div>
<div id="compass"><div id="needle"><div class="n"></div><div class="s"></div><div class="dot"></div></div></div>
<script src="data:text/javascript;base64,${LEAFLET_JS_B64}"></script>
<script>
var map=L.map('map',{zoomControl:false}).setView([20.6,78.9],4);
// No raster provider configured → no basemap. The route, the lock circle and
// the "you" dot still draw over the app background, which is the honest
// degraded view; a watermarked or license-violating basemap is not.
var TILE=${JSON.stringify(tileUrl)};
if(TILE)L.tileLayer(TILE,{maxZoom:19,subdomains:'abcd',
  attribution:${JSON.stringify(ATTRIBUTION)}}).addTo(map);
var RN=window.ReactNativeWebView;
var line=null,you=null,flag=null,fitted=false,lockC=null,accC=null,pinM=null,pinMode=0,hdg=0,scaleC=null,lastTouch=0;
// Free-explore: a manual pan/zoom pauses follow; it auto-recenters after 10 s idle.
map.on('dragstart zoomstart',function(){lastTouch=Date.now();});
function setScale(imp){ if(scaleC)map.removeControl(scaleC);
  scaleC=L.control.scale({metric:!imp,imperial:!!imp,position:'bottomleft',maxWidth:80}).addTo(map); }
setScale(0);
function setRoute(cs){ if(line)map.removeLayer(line); if(!cs||!cs.length)return;
  line=L.polyline(cs,{color:'${accent}',weight:6,opacity:.85,lineJoin:'round'}).addTo(map);
  if(!fitted){map.fitBounds(line.getBounds().pad(0.18));fitted=true;} }
function setDest(la,ln){ if(flag)map.removeLayer(flag);
  flag=L.circleMarker([la,ln],{radius:8,color:'${NAV_MAP.ring}',weight:3,fillColor:'${accent}',fillOpacity:1}).addTo(map);
  if(!fitted&&!line){map.setView([la,ln],14);} }
function youIcon(){ var rot=isFinite(hdg)&&hdg>0?hdg:0;
  return L.divIcon({className:'',html:'<div class="youwrap" style="transform:rotate('+rot+'deg)"><div class="youarrow"></div><div class="you"></div></div>',iconSize:[20,20],iconAnchor:[10,10]}); }
function setPos(la,ln,follow,acc){
  if(!you){you=L.marker([la,ln],{icon:youIcon(),zIndexOffset:1000}).addTo(map);}else{you.setLatLng([la,ln]);you.setIcon(youIcon());}
  if(acc&&acc>0){ if(!accC){accC=L.circle([la,ln],{radius:acc,color:'${NAV_MAP.you}',weight:1,opacity:.5,fillColor:'${NAV_MAP.you}',fillOpacity:.12,interactive:false}).addTo(map);}else{accC.setLatLng([la,ln]);accC.setRadius(acc);} }
  else if(accC){map.removeLayer(accC);accC=null;}
  if(follow&&Date.now()-lastTouch>10000)map.setView([la,ln],Math.max(map.getZoom(),16),{animate:true}); }
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

// ── MapLibre GL engine (NAV_MAP_3D) — real 3D pitch, heading-up basemap
// rotation, and follow/north/overview camera modes. Exposes the SAME JS
// function names as the Leaflet html() above, so the RN side is engine-agnostic.
function mlHtml(styleUrl: string, bg: string, accent: string, buildings: Record<string, unknown>): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${MAPLIBRE_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
.you{width:20px;height:20px;border-radius:50%;background:${NAV_MAP.you};border:3px solid ${NAV_MAP.ring};box-shadow:0 0 0 6px ${NAV_MAP.youHalo},0 1px 4px ${NAV_MAP.markerShadow}}
.youwrap{width:20px;height:20px;position:relative}
.youarrow{position:absolute;left:50%;top:-9px;margin-left:-5px;width:0;height:0;
  border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid ${NAV_MAP.you};filter:drop-shadow(0 0 1px ${NAV_MAP.ring})}
.destdot{width:16px;height:16px;border-radius:50%;background:${accent};border:3px solid ${NAV_MAP.ring};box-shadow:0 1px 4px ${NAV_MAP.markerShadow}}
#compass{position:absolute;top:12px;right:12px;z-index:2;width:42px;height:42px;border-radius:21px;
  background:${NAV_MAP.compassGround};border:1px solid ${NAV_MAP.compassEdge};display:none;align-items:center;justify-content:center;box-shadow:0 1px 6px ${NAV_MAP.compassShadow}}
#needle{width:26px;height:26px;position:relative;transition:transform .15s linear}
#needle .n{position:absolute;left:50%;top:1px;margin-left:-4px;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:11px solid ${NAV_MAP.needleNorth}}
#needle .s{position:absolute;left:50%;bottom:1px;margin-left:-4px;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:11px solid ${NAV_MAP.needleSouth}}
#needle .dot{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:2px;background:${NAV_MAP.ring}}
.maplibregl-ctrl-attrib{font-size:9px}</style>
</head><body><div id="map"></div>
<div id="compass"><div id="needle"><div class="n"></div><div class="s"></div><div class="dot"></div></div></div>
<script src="data:text/javascript;base64,${MAPLIBRE_JS_B64}"></script>
<script>
var RN=window.ReactNativeWebView;
// No WebGL → say so ONCE, deterministically. Without this the constructor
// throws, the rest of this script never runs, and the RN side sits waiting for
// a 'ready' that can never arrive. It reads this message as "downgrade".
function webglOK(){ try{ var c=document.createElement('canvas');
  return !!(window.WebGLRenderingContext&&(c.getContext('webgl')||c.getContext('experimental-webgl'))); }catch(e){ return false; } }
if(!webglOK()){ if(RN)RN.postMessage(JSON.stringify({type:'mlerror',msg:'webgl unsupported'})); throw new Error('no webgl'); }
var STYLE=${JSON.stringify(styleUrl)};
var BUILDINGS=${JSON.stringify(buildings)};
var map=new maplibregl.Map({container:'map',center:[78.9,20.6],zoom:3,pitch:0,bearing:0,
  attributionControl:{compact:true},style:STYLE});
var youEl=document.createElement('div');youEl.className='youwrap';
youEl.innerHTML='<div class="youarrow"></div><div class="you"></div>';
var you=null,dest=null,pin=null,fitted=false,pinMode=0,hdg=0,cam='follow',lastTouch=0;
var ready=false;
// Geodesic circle polygon (metres) — MapLibre has no metric circle primitive.
function circlePoly(la,ln,rM){var pts=[],R=6378137,d=rM/R,lat=la*Math.PI/180,lng=ln*Math.PI/180;
  for(var i=0;i<64;i++){var b=i*2*Math.PI/64;
    var la2=Math.asin(Math.sin(lat)*Math.cos(d)+Math.cos(lat)*Math.sin(d)*Math.cos(b));
    var ln2=lng+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lat),Math.cos(d)-Math.sin(lat)*Math.sin(la2));
    pts.push([ln2*180/Math.PI,la2*180/Math.PI]);}
  pts.push([pts[0][0],pts[0][1]]); // close the ring EXACTLY (MapLibre requires first==last)
  return {type:'Feature',geometry:{type:'Polygon',coordinates:[pts]}};}
function src(id){return map.getSource(id);}
function ensureLine(id,color,width,geo){
  if(src(id)){src(id).setData(geo);return;}
  map.addSource(id,{type:'geojson',data:geo});
  map.addLayer({id:id+'-l',type:'line',source:id,paint:{'line-color':color,'line-width':width,'line-opacity':.9},layout:{'line-join':'round','line-cap':'round'}});}
function ensureFill(id,color,geo){
  if(src(id)){src(id).setData(geo);
    map.setPaintProperty(id+'-f','fill-color',color);map.setPaintProperty(id+'-o','line-color',color);return;}
  map.addSource(id,{type:'geojson',data:geo});
  map.addLayer({id:id+'-f',type:'fill',source:id,paint:{'fill-color':color,'fill-opacity':.16}});
  map.addLayer({id:id+'-o',type:'line',source:id,paint:{'line-color':color,'line-width':2.5,'line-opacity':.95}});}
function rmLayer(id){['-l','-f','-o'].forEach(function(sfx){if(map.getLayer(id+sfx))map.removeLayer(id+sfx);});if(src(id))map.removeSource(id);}

function setScale(imp){/* MapLibre scale control optional; heading/units handled RN-side */}
function setRoute(cs){ if(!cs||!cs.length){rmLayer('route');return;}
  var coords=cs.map(function(c){return [c[1],c[0]];});
  ensureLine('route','${accent}',6,{type:'Feature',geometry:{type:'LineString',coordinates:coords}});
  if(!fitted){var b=coords.reduce(function(bb,c){return bb.extend(c);},new maplibregl.LngLatBounds(coords[0],coords[0]));
    map.fitBounds(b,{padding:60,duration:0});fitted=true;} }
function setDest(la,ln){ if(!dest){var el=document.createElement('div');el.className='destdot';
    dest=new maplibregl.Marker({element:el}).setLngLat([ln,la]).addTo(map);}else dest.setLngLat([ln,la]);
  if(!fitted&&!src('route')){map.jumpTo({center:[ln,la],zoom:14});} }
function applyCam(la,ln){
  if(cam==='overview'){return;}
  var opts={center:[ln,la],duration:600};
  if(cam==='follow'){opts.pitch=55;opts.bearing=(isFinite(hdg)?hdg:0);opts.zoom=Math.max(map.getZoom(),16.5);}
  else{opts.pitch=0;opts.bearing=0;opts.zoom=Math.max(map.getZoom(),16);}
  map.easeTo(opts); }
function setPos(la,ln,follow,acc){
  if(!you){you=new maplibregl.Marker({element:youEl}).setLngLat([ln,la]).addTo(map);}else you.setLngLat([ln,la]);
  if(acc&&acc>0){ensureFill('acc','${NAV_MAP.you}',circlePoly(la,ln,acc));}else{rmLayer('acc');}
  if(follow&&Date.now()-lastTouch>10000)applyCam(la,ln); }
function setHeading(h){ hdg=h; var el=document.getElementById('needle');
  if(el)el.style.transform='rotate('+(-(map.getBearing()))+'deg)';
  // In follow mode the basemap rotates to heading; keep the you-arrow map-up.
  if(youEl){var a=cam==='follow'?0:(isFinite(h)?h:0);youEl.querySelector('.youarrow').style.transform='rotate('+a+'deg)';}
  if(cam==='follow'&&you&&Date.now()-lastTouch>10000){map.easeTo({bearing:(isFinite(h)?h:0),duration:400});} }
function showCompass(v){ document.getElementById('compass').style.display=v?'flex':'none'; }
function setLock(la,ln,r,color,fit){ ensureFill('lock',color,circlePoly(la,ln,r));
  if(fit&&!fitted){var b=circlePoly(la,ln,r).geometry.coordinates[0].reduce(function(bb,c){return bb.extend(c);},new maplibregl.LngLatBounds());
    map.fitBounds(b,{padding:70,duration:0});fitted=true;} }
function clearLock(){ rmLayer('lock'); }
function setPin(la,ln){ if(!pin){pin=new maplibregl.Marker({draggable:true,color:'${accent}'}).setLngLat([ln,la]).addTo(map);
    pin.on('dragend',function(){var p=pin.getLngLat();if(RN)RN.postMessage(JSON.stringify({type:'pin',lat:p.lat,lng:p.lng}));});
    map.easeTo({center:[ln,la],zoom:Math.max(map.getZoom(),16)});}
  else pin.setLngLat([ln,la]); }
function clearPin(){ if(pin){pin.remove();pin=null;} }
function setPinMode(v){ pinMode=v; map.getCanvas().style.cursor=v?'crosshair':''; }
function setCamera(mode){ cam=mode;
  if(mode==='overview'){ fitAll(); return; }
  if(you){var p=you.getLngLat();applyCam(p.lat,p.lng);} }
function fitAll(){ var b=null;
  if(src('route')){var c=map.getSource('route')._data.geometry.coordinates;b=c.reduce(function(bb,x){return bb.extend(x);},new maplibregl.LngLatBounds(c[0],c[0]));}
  else if(src('lock')){var lc=map.getSource('lock')._data.geometry.coordinates[0];b=lc.reduce(function(bb,x){return bb.extend(x);},new maplibregl.LngLatBounds());}
  if(b)map.easeTo({pitch:0,bearing:0,duration:600}),map.fitBounds(b,{padding:60,pitch:0,bearing:0});
  else if(you)map.easeTo({center:you.getLngLat(),zoom:15,pitch:0,bearing:0,duration:600}); }
function recenter(){ if(you){var p=you.getLngLat();if(cam==='overview')cam='follow';applyCam(p.lat,p.lng);}else fitAll(); }
function zoomBy(d){ map.easeTo({zoom:map.getZoom()+d,duration:250}); }
map.on('dragstart',function(){lastTouch=Date.now();});
map.on('zoomstart',function(e){if(e.originalEvent)lastTouch=Date.now();});
map.on('rotatestart',function(){lastTouch=Date.now();});
map.on('rotate',function(){var el=document.getElementById('needle');if(el)el.style.transform='rotate('+(-(map.getBearing()))+'deg)';});
map.on('click',function(e){ if(!pinMode)return; setPin(e.lngLat.lat,e.lngLat.lng);
  if(RN)RN.postMessage(JSON.stringify({type:'pin',lat:e.lngLat.lat,lng:e.lngLat.lng})); });
document.getElementById('compass').addEventListener('click',function(){
  map.easeTo({bearing:0,pitch:cam==='follow'?55:0,duration:400}); if(RN)RN.postMessage(JSON.stringify({type:'compass'})); });
// 3D buildings. The light style ships this layer already, the dark one does not
// — adding it here on the same layer id means both themes agree about whether
// buildings exist, and the add is skipped where the style got there first.
// styledata, not load: it must survive the style retry below.
function addBuildings(){
  if(map.getLayer('building-3d')||!map.getSource('openmaptiles'))return;
  try{ map.addLayer(BUILDINGS); }catch(e){}
}
map.on('styledata',addBuildings);
// The styles choose POI icons from the tile data at runtime, so any icon the
// sprite lacks warns once per missing NAME, unbounded as you travel — on a
// phone, where babel keeps console.warn in release builds and logcat is
// already the scarce resource. Register a blank: the label still draws.
map.on('styleimagemissing',function(e){
  try{ if(!map.hasImage(e.id)) map.addImage(e.id,{width:1,height:1,data:new Uint8Array(4)}); }catch(x){}
});
// The style is FETCHED now, so a flaky first minute is a network failure, not a
// broken device — but the RN side reads any pre-ready error as "no WebGL" and
// throws the 3D map away, PERMANENTLY: this engine choice never resets back to
// MapLibre for the life of this screen. At the old 3 tries / ~7s total, a
// driver entering a tunnel or a brief dead zone at the exact moment the map
// first mounted got stuck on a blank Leaflet page (no raster fallback exists,
// see tileProvider) for the REST of that navigation, even once signal
// returned. 8 tries with the delay capped at 5s (~33s total) survives a
// typical tunnel/dead-zone; MapLibre never retries a failed style on its own,
// so retry here and only report upward once the network has really given up.
var styleTries=0;
var STYLE_RETRY_MAX=8, STYLE_RETRY_CAP_MS=5000;
map.on('load',function(){ ready=true; addBuildings(); if(RN)RN.postMessage('ready');
  // Which provider actually served this map. 'load' has fired, so the style at
  // STYLE really did load — the host IS the basemap. You cannot tell this from
  // outside otherwise, and it is the thing to check when tiles move to our own
  // host. Same reasoning as FamilyMap's any-routing report.
  if(RN)RN.postMessage(JSON.stringify({type:'basemap',host:STYLE.split('/')[2]||STYLE})); });
map.on('error',function(e){
  var msg=(e&&e.error&&e.error.message)||'map error';
  if(!ready&&styleTries<STYLE_RETRY_MAX){ styleTries++;
    setTimeout(function(){ try{map.setStyle(STYLE);}catch(x){} },Math.min(1200*styleTries,STYLE_RETRY_CAP_MS)); return; }
  if(RN)RN.postMessage(JSON.stringify({type:'mlerror',msg:msg}));
});
</script></body></html>`;
}

export default function NavMap({
  style, data, follow = true,
  lock, accuracyM, headingDeg, showCompass = false,
  pin, pinMode = false, onPinDrop, zoomControls = false, imperialScale = false,
  cameraMode, camera3D = NAV_MAP_3D,
}: {
  style?: StyleProp<ViewStyle>;
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
  imperialScale?: boolean;
  /** Controlled camera mode (MapLibre engine only). Uncontrolled if omitted. */
  cameraMode?: CameraMode;
  /** Use the MapLibre GL 3D engine. Defaults to the NAV_MAP_3D flag; a device
   *  that fails to init WebGL/worker auto-falls-back to the Leaflet 2D map. */
  camera3D?: boolean;
}) {
  const { colors, scheme } = useTheme();
  const storeGeo = useNavGeo();
  const geo = data ?? storeGeo;
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // Engine: MapLibre 3D when asked, but a runtime map error before first paint
  // downgrades to the proven Leaflet map so the nav map is never dead.
  const [engine, setEngine] = useState<'maplibre' | 'leaflet'>(camera3D ? 'maplibre' : 'leaflet');
  const [cam, setCam] = useState<CameraMode>(cameraMode ?? 'follow');
  useEffect(() => { if (cameraMode) setCam(cameraMode); }, [cameraMode]);
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

  // Lock circle — zone color changes ride the same bridge. Keyed on the
  // primitives, so a fresh `lock` object with the same values re-injects nothing.
  const lockLat = lock?.center.lat, lockLng = lock?.center.lng, lockR = lock?.radius, lockColor = lock?.color;
  useEffect(() => {
    if (!ready || !ref.current) return;
    if (lockLat != null && lockLng != null && lockR != null) {
      ref.current.injectJavaScript(
        `setLock(${lockLat},${lockLng},${lockR},'${lockColor}',1);true;`,
      );
    } else {
      ref.current.injectJavaScript('clearLock();true;');
    }
  }, [ready, lockLat, lockLng, lockR, lockColor]);

  // Compass + heading (throttled upstream to ~4 Hz by the heading watcher).
  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`showCompass(${showCompass ? 1 : 0});true;`);
  }, [ready, showCompass]);
  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setScale(${imperialScale ? 1 : 0});true;`);
  }, [ready, imperialScale]);
  useEffect(() => {
    if (!ready || !ref.current || headingDeg == null) return;
    ref.current.injectJavaScript(`setHeading(${Math.round(headingDeg)});true;`);
  }, [ready, headingDeg]);

  // Selection pin (setup flow).
  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setPinMode(${pinMode ? 1 : 0});true;`);
  }, [ready, pinMode]);
  const pinLat = pin?.lat, pinLng = pin?.lng;
  useEffect(() => {
    if (!ready || !ref.current) return;
    if (pinLat != null && pinLng != null) ref.current.injectJavaScript(`setPin(${pinLat},${pinLng});true;`);
    else ref.current.injectJavaScript('clearPin();true;');
  }, [ready, pinLat, pinLng]);

  // Camera mode → MapLibre only (no-op string on Leaflet, which lacks setCamera).
  useEffect(() => {
    if (!ready || !ref.current || engine !== 'maplibre') return;
    ref.current.injectJavaScript(`setCamera(${JSON.stringify(cam)});true;`);
  }, [ready, engine, cam]);

  const recenter = () => ref.current?.injectJavaScript('recenter();true;');
  // 3D toggle cycles the chase-cam: follow (pitched, heading-up) → north (flat) → overview.
  const cycleCam = () => {
    const next: CameraMode = cam === 'follow' ? 'north' : cam === 'north' ? 'overview' : 'follow';
    setCam(next);
  };
  const camIcon: keyof typeof Ionicons.glyphMap = cam === 'follow' ? 'cube' : cam === 'north' ? 'navigate' : 'scan';
  // The scheme goes to tileProvider, the one place that picks a style. It
  // deliberately serves the full-colour `liberty` style for BOTH themes (its
  // dark style hides road detail), so the basemap itself stays light; only the
  // chrome around it follows the theme.
  const mapScheme = scheme === 'light' ? 'light' : 'dark';
  // Memoized — same reasoning as FamilyMap's identical fix: mlHtml
  // concatenates the ~1.1MB embedded MapLibre bundle into a fresh string on
  // every call, and this component re-renders on every GPS fix. The WebView
  // never reloads on an unchanged source.html, so the allocation was pure
  // per-render churn.
  const source = useMemo(() => (engine === 'maplibre'
    ? { html: mlHtml(mapStyleUrl(mapScheme), colors.bg, colors.primary, buildings3DLayer(mapScheme)) }
    : { html: html(RASTER_FALLBACK_URL, colors.bg, colors.primary) }),
    [engine, mapScheme, colors.bg, colors.primary]);

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
            else if (m?.type === 'basemap') console.warn('[NavMap] basemap provider:', m.host);
            // WebGL/worker failed on this device before first paint → fall back to Leaflet.
            else if (m?.type === 'mlerror' && engine === 'maplibre' && !ready) {
              // A downgrade now means NO BASEMAP — there is no raster provider we
              // are allowed to use — so it must not be silent. console.WARN, not
              // log: babel strips log from release builds, which are exactly the
              // builds this happens on. Same reasoning as FamilyMap's routing report.
              console.warn('[NavMap] MapLibre failed, falling back to Leaflet (no basemap):', m.msg);
              seen.current = { shape: null, dest: null };
              setEngine('leaflet');
            }
          } catch {}
        }}
        style={{ backgroundColor: colors.bg }}
        androidLayerType="hardware"
      />
      {/* The Leaflet fallback has no basemap (tileProvider: RASTER_FALLBACK_URL
          is empty by decision). Say so instead of drawing the route over a
          blank rectangle as if that were the map. */}
      {engine === 'leaflet' && !RASTER_FALLBACK_URL && (
        <View pointerEvents="none" accessibilityLiveRegion="polite"
          style={[styles.notice, { backgroundColor: colors.glass, borderColor: colors.glassStroke }]}>
          <Ionicons name="map-outline" size={14} color={colors.textDim} />
          <Text style={[styles.noticeTxt, { color: colors.text }]}>
            Street map unavailable on this device. Route and markers only.
          </Text>
        </View>
      )}
      {zoomControls && (
        <View style={[styles.zoomBox, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <TouchableOpacity onPress={() => ref.current?.injectJavaScript('zoomBy(1);true;')} accessibilityRole="button" accessibilityLabel="Zoom in" style={styles.zoomBtn}>
            <Ionicons name="add" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={[styles.zoomSep, { backgroundColor: colors.border }]} />
          <TouchableOpacity onPress={() => ref.current?.injectJavaScript('zoomBy(-1);true;')} accessibilityRole="button" accessibilityLabel="Zoom out" style={styles.zoomBtn}>
            <Ionicons name="remove" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
      )}
      {/* 3D camera toggle — MapLibre only; uncontrolled (hidden when a parent drives cameraMode). */}
      {engine === 'maplibre' && !cameraMode && (
        <TouchableOpacity onPress={cycleCam} accessibilityRole="button" accessibilityLabel="Change map view"
          accessibilityValue={{ text: cam === 'follow' ? 'Follow, heading up' : cam === 'north' ? 'North up' : 'Route overview' }} style={[styles.fab, { bottom: zoomControls ? CAM_FAB_ABOVE_ZOOM : 66, backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <Ionicons name={camIcon} size={19} color={colors.primary} />
        </TouchableOpacity>
      )}
      {(geo.pos || geo.dest || lock) && (
        <TouchableOpacity onPress={recenter} accessibilityRole="button" accessibilityLabel="Recentre the map on your location" style={[styles.fab, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <Ionicons name="locate" size={20} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const ZOOM_BTN = 44;
// The camera button sits above the zoom box (bottom 66, two buttons, borders,
// separator) with a 10 pt gap. At 120 it overlapped "Zoom in".
const CAM_FAB_ABOVE_ZOOM = 66 + 2 * ZOOM_BTN + 3 + 10;

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  fab: { position: 'absolute', right: 12, bottom: 12, width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', elevation: 3 },
  zoomBox: { position: 'absolute', right: 12, bottom: 66, width: 44, borderRadius: 14, borderWidth: 1, overflow: 'hidden', elevation: 3 },
  // 2026-09-18: height stays PINNED. +/- are Ionicons, not text, and they do not
  // font-scale; the slot is already boxed to zoomBox's fixed 44 width, so letting
  // the height grow would just turn two square buttons into ovals inside a
  // capsule that cannot follow them. 44 (was 40): square, and a full touch target.
  zoomBtn: {
    // layout-exempt: icon-only zoom control, no text to clip.
    height: ZOOM_BTN, alignItems: 'center', justifyContent: 'center',
  },
  zoomSep: { height: StyleSheet.hairlineWidth, marginHorizontal: 8 },
  // layout-exempt: absolute overlay sized by its edges; the text wraps and
  // grows with font scale instead of clipping.
  notice: { position: 'absolute', left: 10, right: 66, top: 10, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1 },
  noticeTxt: { flex: 1, fontSize: 12, fontWeight: '600' },
});
