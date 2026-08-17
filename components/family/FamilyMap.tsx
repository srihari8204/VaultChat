// components/family/FamilyMap.tsx — the Family Circle map. A WebView that plots
// every circle member as a labelled dot from their decrypted live position, fits
// them all in view, and reports taps back so the screen can focus/navigate. Purely
// a renderer: it holds no location itself, it draws what the screen decrypts.
//
// TWO ENGINES, ONE CONTRACT. The MapLibre GL page and the Leaflet page expose
// the IDENTICAL JavaScript functions (setMembers / focus / fitAll / setPath /
// reportZoom), so the React half below is engine-agnostic and the screens that
// use this component — family.tsx and family-map.tsx — needed no changes at all.
// Same trick NavMap already uses for NAV_MAP_3D.
//
//   MapLibre (FAMILY_MAP_3D, default ON) — real pitch, heading-up rotation and
//     follow/north/overview cameras, which raster Leaflet cannot do at all.
//   Leaflet — the proven 2D fallback. A device that cannot init WebGL/worker
//     downgrades to it AT RUNTIME before first paint, so the family map is
//     never dead; flip the flag OFF to force it everywhere.
//
// Tiles come from lib/map/tileProvider — the single seam for the deferred
// vector-tile upgrade. Nothing in this file names a tile provider.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useTheme } from '../../lib/theme';
import { LEAFLET_JS_B64, LEAFLET_CSS_B64 } from '../nav/leafletAsset';
import { MAPLIBRE_JS_B64, MAPLIBRE_CSS_B64 } from '../nav/maplibreAsset';
import { ROUTING_JS_B64 } from '../nav/routingAsset';
import { STREETVIEW_API_KEY } from '../../constants/flags';
import { clusterForZoom } from '../../lib/groups/clustering';
import { fetchRoute } from '../../lib/nav/routing';
import { leafletTileUrl, mapStyle } from '../../lib/map/tileProvider';
import { FAMILY_MAP_3D } from '../../constants/flags';

export interface FamilyMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  battery?: number;   // 0..100
  self?: boolean;
  stale?: boolean;    // last fix older than the freshness threshold
  /** Short text drawn on this member's connector line, e.g. "1.2 km".
   *  The screen supplies it — the map does not compute distances. */
  label?: string;
}

/** Camera modes for the 3D engine. Mirrors NavMap's, deliberately. */
export type FamilyCameraMode = 'follow' | 'north' | 'overview';

const COLORS = ['#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316'];
const initials = (name: string) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

/** Marker styling, shared verbatim by both engines so a member looks identical
 *  whichever page is running — an engine swap must not restyle the family. */
const MARKER_CSS = (selfColor: string) => `
.mk{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:#fff;font:700 12px system-ui,sans-serif;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45)}
.mk.self{box-shadow:0 0 0 5px ${selfColor}33,0 1px 5px rgba(0,0,0,.45)}
.mk.stale{opacity:.55}
.cl{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:#fff;font:800 14px system-ui,sans-serif;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5)}
.dest{width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
  background:${selfColor};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.lnk{transform:translate(-50%,-50%);white-space:nowrap;padding:2px 7px;border-radius:999px;
  background:rgba(17,19,24,.82);color:#fff;font:700 10.5px system-ui,sans-serif;
  border:1px solid rgba(255,255,255,.22)}`;

function html(tileUrl: string, bg: string, selfColor: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${LEAFLET_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
${MARKER_CSS(selfColor)}
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
// Meeting destination. Highest destination priority (§22) — a plain Leaflet
// marker sits above the tile pane, so it cannot be buried by a label.
var destMk=null;
function setDest(la,ln,label){
  if(la==null){ if(destMk){ map.removeLayer(destMk); destMk=null; } return; }
  var ic=L.divIcon({className:'',html:'<div class="dest"></div>',iconSize:[22,22],iconAnchor:[11,11]});
  if(destMk) destMk.setLatLng([la,ln]).setIcon(ic);
  else destMk=L.marker([la,ln],{icon:ic,title:label||''}).addTo(map);
  map.setView([la,ln], Math.max(map.getZoom(),14), {animate:true});
}
// CONNECTORS: a dashed line from the origin to every member, each labelled
// with its distance. This is the "who is where, and how far" picture — ten
// lines fanning out from you — and it is STRAIGHT-LINE on purpose: it is drawn
// from positions already on this device, so it costs nothing, needs no network
// and cannot be wrong about a road it never consulted. The road route is a
// separate, deliberate request for ONE member (setRoute below).
var linkLines=[], linkTags=[];
function clearLinks(){
  linkLines.forEach(function(l){ map.removeLayer(l); }); linkLines=[];
  linkTags.forEach(function(t){ map.removeLayer(t); }); linkTags=[];
}
function setLinks(from, list){
  clearLinks();
  if(!from||!list||!list.length) return;
  list.forEach(function(m){
    var ln=L.polyline([[from.lat,from.lng],[m.lat,m.lng]],
      {color:m.color,weight:2.5,opacity:.75,dashArray:'6,6',lineCap:'round'}).addTo(map);
    linkLines.push(ln);
    if(m.label){
      // Label at the midpoint: on the line it describes, and away from both
      // member markers so it never sits under one.
      var mid=[(from.lat+m.lat)/2,(from.lng+m.lng)/2];
      var tag=L.marker(mid,{interactive:false,icon:L.divIcon({className:'',
        html:'<div class="lnk">'+m.label+'</div>',iconSize:[0,0]})}).addTo(map);
      linkTags.push(tag);
    }
  });
}
// ROAD ROUTE for one member, from Valhalla. Drawn thicker and solid so it
// reads as a real road path, never confusable with the dashed connectors.
var routeLine=null;
function setRoute(pts){
  if(routeLine){ map.removeLayer(routeLine); routeLine=null; }
  if(!pts||pts.length<2) return;
  routeLine=L.polyline(pts.map(function(p){return [p.lat,p.lng];}),
    {color:'${selfColor}',weight:5,opacity:.95,lineJoin:'round',lineCap:'round'}).addTo(map);
  map.fitBounds(routeLine.getBounds().pad(0.25));
  fitted=true;
}
function reportZoom(){ if(RN)RN.postMessage('zoom:'+map.getZoom()); }
map.on('zoomend', reportZoom);
if(RN)RN.postMessage('ready');
reportZoom();
</script></body></html>`;
}

// ── MapLibre GL engine (FAMILY_MAP_3D) ────────────────────────────────────
//
// Exposes the SAME function names as the Leaflet page above. Everything the
// spec's navigation sections want and raster Leaflet structurally cannot give:
// real pitch (§49), heading-up basemap rotation (§47), north-up (§48) and a
// camera that does not fight the user (§50 — a manual pan suppresses auto
// re-centring for 10 s rather than snapping straight back).
//
// Family markers are HTML elements, so they always paint ABOVE the basemap —
// §66's "family markers beat every label" is a property of the engine here,
// not a z-index we have to maintain.
function mlHtml(style: string, bg: string, selfColor: string, svKey: string): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="data:text/css;base64,${MAPLIBRE_CSS_B64}"/>
<style>html,body,#map{height:100%;margin:0;background:${bg}}
${MARKER_CSS(selfColor)}
.mkwrap{cursor:pointer}
.maplibregl-ctrl-attrib{font-size:9px}</style>
</head><body><div id="map"></div>
<script src="data:text/javascript;base64,${MAPLIBRE_JS_B64}"></script>
<!-- @any-routing + maplibre-pegman, bundled offline (scripts/build-routing-asset.js).
     Loaded AFTER maplibre-gl because the engine attaches to the map object. -->
<script src="data:text/javascript;base64,${ROUTING_JS_B64}"></script>
<script>
var RN=window.ReactNativeWebView;
var map=new maplibregl.Map({container:'map',center:[78.9,20.6],zoom:4,pitch:0,bearing:0,
  attributionControl:{compact:true},style:${style}});
var markers={},fitted=false,cam='north',hdg=0,tilt=55,lastTouch=0,pathIds=[];

/** Build (or restyle) one member's marker element. */
function mkEl(m){
  var w=document.createElement('div'); w.className='mkwrap';
  var isCl=m.count>1, sz=isCl?42:34;
  w.style.width=sz+'px'; w.style.height=sz+'px';
  w.innerHTML='<div class="'+(isCl?'cl':('mk'+(m.self?' self':'')+(m.stale?' stale':'')))
    +'" style="background:'+m.color+'">'+(isCl?String(m.count):m.ini)+'</div>';
  w.addEventListener('click',function(){
    // A cluster has no single member to select, so tapping it zooms in until it
    // breaks apart — the same non-surprising behaviour the Leaflet page has.
    if(isCl){ map.easeTo({center:[m.lng,m.lat],zoom:Math.min(map.getZoom()+2,19),duration:400}); }
    else if(RN){ RN.postMessage('sel:'+m.id); }
  });
  return w;
}
function setMembers(list){
  var seen={};
  list.forEach(function(m){
    seen[m.id]=1;
    var cur=markers[m.id];
    // Rebuild the element only when its LOOK changed. Recreating a marker on
    // every ping would restart the DOM node 8s apart per member and throw away
    // MapLibre's own position transition — the "teleporting markers" of §51.
    var sig=[m.count,m.self?1:0,m.stale?1:0,m.ini,m.color].join('|');
    if(cur&&cur.sig===sig){ cur.mk.setLngLat([m.lng,m.lat]); }
    else{
      if(cur) cur.mk.remove();
      var mk=new maplibregl.Marker({element:mkEl(m)}).setLngLat([m.lng,m.lat]).addTo(map);
      markers[m.id]={mk:mk,sig:sig};
    }
  });
  Object.keys(markers).forEach(function(id){
    if(!seen[id]){ markers[id].mk.remove(); delete markers[id]; }
  });
  if(!fitted) fitAll();
}
function bounds(){
  var ids=Object.keys(markers); if(!ids.length) return null;
  var b=new maplibregl.LngLatBounds();
  ids.forEach(function(id){ b.extend(markers[id].mk.getLngLat()); });
  return b;
}
function fitAll(){
  var ids=Object.keys(markers); if(!ids.length) return;
  if(ids.length===1){ map.easeTo({center:markers[ids[0]].mk.getLngLat(),zoom:15,pitch:0,bearing:0,duration:500}); }
  else { map.fitBounds(bounds(),{padding:70,pitch:0,bearing:0,duration:500}); }
  cam='overview'; fitted=true;
}
function applyCam(ll){
  if(cam==='overview') return;
  var o={center:ll,duration:600};
  if(cam==='follow'){ o.pitch=tilt; o.bearing=(isFinite(hdg)?hdg:0); o.zoom=Math.max(map.getZoom(),16); }
  else { o.pitch=0; o.bearing=0; o.zoom=Math.max(map.getZoom(),15); }
  map.easeTo(o);
}
function focus(id){
  if(!markers[id]) return;
  var ll=markers[id].mk.getLngLat();
  // Focusing is an explicit request, so it overrides overview — but it must not
  // silently switch the user into a pitched chase-cam they did not ask for.
  if(cam==='overview') cam='north';
  map.easeTo({center:ll,zoom:Math.max(map.getZoom(),16),duration:500});
}
function setCamera(mode){
  cam=mode;
  if(mode==='overview'){ fitAll(); return; }
  var ids=Object.keys(markers);
  var self=ids.filter(function(i){return markers[i].sig.split('|')[1]==='1';})[0];
  var id=self||ids[0];
  if(id) applyCam(markers[id].mk.getLngLat());
}
function setHeading(h){
  hdg=h;
  // Only heading-up rotates the basemap; north-up leaves it north-locked (§48).
  // Suppressed right after a manual gesture so the map does not fight the hand
  // that just moved it (§50).
  if(cam==='follow'&&Date.now()-lastTouch>10000){
    map.easeTo({bearing:(isFinite(h)?h:0),duration:400});
  }
}
function setTilt(d){
  tilt=d;
  if(cam==='follow') map.easeTo({pitch:d,duration:300});
}
// Location-history track. Drawn UNDER the markers (HTML markers always sit
// above the canvas), and fitting the line wins over fitAll() because when a
// path is supplied it IS the subject of the view.
function setPath(pts){
  pathIds.forEach(function(id){
    if(map.getLayer(id+'-l')) map.removeLayer(id+'-l');
    if(map.getLayer(id+'-c')) map.removeLayer(id+'-c');
    if(map.getSource(id)) map.removeSource(id);
  });
  pathIds=[];
  if(!pts||pts.length<2) return;
  var coords=pts.map(function(p){ return [p.lng,p.lat]; });
  map.addSource('track',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:coords}}});
  map.addLayer({id:'track-l',type:'line',source:'track',
    paint:{'line-color':'${selfColor}','line-width':4,'line-opacity':.85},
    layout:{'line-join':'round','line-cap':'round'}});
  pathIds.push('track');
  [['start',coords[0],'#22C55E'],['end',coords[coords.length-1],'#EF4444']].forEach(function(e){
    map.addSource(e[0],{type:'geojson',data:{type:'Feature',geometry:{type:'Point',coordinates:e[1]}}});
    map.addLayer({id:e[0]+'-c',type:'circle',source:e[0],
      paint:{'circle-radius':6,'circle-color':e[2],'circle-stroke-color':'#fff','circle-stroke-width':2}});
    pathIds.push(e[0]);
  });
  var b=coords.reduce(function(bb,c){return bb.extend(c);},new maplibregl.LngLatBounds(coords[0],coords[0]));
  map.fitBounds(b,{padding:60,duration:500});
  fitted=true;
}
// Meeting destination — an HTML marker, so like the members it always paints
// above the basemap and takes the highest destination priority (§22).
var destMk=null;
function setDest(la,ln,label){
  if(la==null){ if(destMk){ destMk.remove(); destMk=null; } return; }
  if(!destMk){
    var el=document.createElement('div'); el.innerHTML='<div class="dest"></div>';
    el.title=label||'';
    destMk=new maplibregl.Marker({element:el}).setLngLat([ln,la]).addTo(map);
  } else destMk.setLngLat([ln,la]);
  map.easeTo({center:[ln,la],zoom:Math.max(map.getZoom(),14),duration:500});
}
// CONNECTORS — see the Leaflet page for why these are straight-line. One
// GeoJSON source holds every link so ten members are two layers, not twenty:
// per-feature colour comes from a paint property, which is what MapLibre is
// good at and what keeps this cheap at roster size.
var linkTags=[];
function setLinks(from, list){
  linkTags.forEach(function(m){ m.remove(); }); linkTags=[];
  var fc={type:'FeatureCollection',features:[]};
  if(from&&list&&list.length){
    list.forEach(function(m){
      fc.features.push({type:'Feature',properties:{color:m.color},
        geometry:{type:'LineString',coordinates:[[from.lng,from.lat],[m.lng,m.lat]]}});
      if(m.label){
        var el=document.createElement('div');
        el.className='lnk'; el.textContent=m.label;
        linkTags.push(new maplibregl.Marker({element:el})
          .setLngLat([(from.lng+m.lng)/2,(from.lat+m.lat)/2]).addTo(map));
      }
    });
  }
  if(map.getSource('links')) map.getSource('links').setData(fc);
  else{
    map.addSource('links',{type:'geojson',data:fc});
    map.addLayer({id:'links-l',type:'line',source:'links',
      paint:{'line-color':['get','color'],'line-width':2.5,'line-opacity':.75,
             'line-dasharray':[2,2]},
      layout:{'line-cap':'round'}});
  }
}
// ROAD ROUTE for one member — solid and thicker, so it never reads as one of
// the dashed straight-line connectors above.
function setRoute(pts){
  if(!pts||pts.length<2){
    if(map.getLayer('route-l')) map.removeLayer('route-l');
    if(map.getSource('route')) map.removeSource('route');
    return;
  }
  var coords=pts.map(function(p){ return [p.lng,p.lat]; });
  var geo={type:'Feature',geometry:{type:'LineString',coordinates:coords}};
  if(map.getSource('route')) map.getSource('route').setData(geo);
  else{
    map.addSource('route',{type:'geojson',data:geo});
    map.addLayer({id:'route-l',type:'line',source:'route',
      paint:{'line-color':'${selfColor}','line-width':5,'line-opacity':.95},
      layout:{'line-join':'round','line-cap':'round'}});
  }
  var b=coords.reduce(function(bb,c){return bb.extend(c);},new maplibregl.LngLatBounds(coords[0],coords[0]));
  map.fitBounds(b,{padding:70,duration:500});
  fitted=true;
}
function reportZoom(){ if(RN)RN.postMessage('zoom:'+Math.round(map.getZoom())); }
map.on('zoomend',reportZoom);
map.on('dragstart',function(){lastTouch=Date.now();});
map.on('rotatestart',function(){lastTouch=Date.now();});
map.on('zoomstart',function(e){ if(e.originalEvent) lastTouch=Date.now(); });
// ── @any-routing, driven by OUR Valhalla ──────────────────────────────
// The engine owns waypoints, dragging and rendering; every actual route still
// comes from the deployed Valhalla, bridged through React Native so the auth
// token never enters this web context. Failure here is non-fatal: setRoute()
// above keeps drawing routes the plain way, which is what ships today.
var anyRouting=null;
function initRouting(){
  try{
    if(!window.makeAnyRouting){
      if(RN)RN.postMessage(JSON.stringify({type:'routing-error',msg:'bundle did not load'}));
      return;
    }
    anyRouting=window.makeAnyRouting(map,'${selfColor}');
    anyRouting.initialize();
    if(RN)RN.postMessage(JSON.stringify({type:'routing-ready'}));
  }catch(e){
    if(RN)RN.postMessage(JSON.stringify({type:'routing-error',msg:String(e&&e.message||e)}));
  }
}
/** Ask the engine to route through these waypoints (lat/lng objects). */
function anyRoute(wps){
  if(!anyRouting||!wps||wps.length<2) return;
  try{ anyRouting.setWaypoints(wps); }catch(e){}
}

// ── maplibre-pegman (Street View) ─────────────────────────────────────
// Added ONLY when a key is configured. Street View sends a coordinate to
// Google, so it stays off unless someone deliberately turns it on — this app's
// whole location posture is that positions do not leave without a reason.
function initPegman(){
  var key='${svKey}';
  if(!key||!window.MaplibrePegman) return;
  try{
    new window.MaplibrePegman({position:'top-right',theme:'leaflet-pegman-v3-default',apiKey:key}).addTo(map);
  }catch(e){}
}
// ORDER IS LOAD-BEARING. 'ready' is posted BEFORE the optional extras start.
// The RN side treats a MapLibre 'error' arriving while !ready as "WebGL failed
// on this device" and downgrades the whole map to Leaflet — so initialising
// routing first meant one non-fatal layer complaint from the projector threw
// away the 3D map entirely. Observed: the family map silently reverted to
// Leaflet the moment @any-routing was added. The base map must be declared
// working before anything optional is allowed to raise an error.
map.on('load',function(){
  if(RN)RN.postMessage('ready');
  reportZoom();
  initRouting();
  initPegman();
});
map.on('error',function(e){
  if(RN)RN.postMessage(JSON.stringify({type:'mlerror',msg:(e&&e.error&&e.error.message)||'map error'}));
});
</script></body></html>`;
}

export default function FamilyMap({
  members, onSelect, focusId, followId, path, destination, linkFrom, route, style,
  headingDeg, cameraMode, camera3D = FAMILY_MAP_3D,
}: {
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
  /** Meeting destination pin (Meet Here). Null clears it. */
  destination?: { lat: number; lng: number; name?: string } | null;
  /**
   * Draw a dashed connector from `linkFrom` to every member, each labelled.
   * Straight-line by nature — it is geometry between two known points, not a
   * claim about roads. Pass null to clear.
   */
  linkFrom?: { lat: number; lng: number } | null;
  /** Road-route polyline for ONE member, from Valhalla. Solid, not dashed. */
  route?: { lat: number; lng: number }[] | null;
  style?: any;
  /** Device heading. Rotates the basemap in 'follow' (heading-up) only. */
  headingDeg?: number | null;
  /** Controlled camera. Uncontrolled — with an on-map toggle — if omitted. */
  cameraMode?: FamilyCameraMode;
  /** Use the MapLibre engine. Defaults to FAMILY_MAP_3D; a device that cannot
   *  init WebGL/worker auto-falls-back to the proven Leaflet map. */
  camera3D?: boolean;
}) {
  const { scheme, colors } = useTheme();
  const ref = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  // Synchronous mirror of `ready` — see the onMessage handler for why.
  const readyRef = useRef(false);
  // Engine: MapLibre when asked, but a runtime map error BEFORE first paint
  // downgrades to Leaflet so the family map is never a blank rectangle.
  const [engine, setEngine] = useState<'maplibre' | 'leaflet'>(camera3D ? 'maplibre' : 'leaflet');
  const [cam, setCam] = useState<FamilyCameraMode>(cameraMode ?? 'north');
  useEffect(() => { if (cameraMode) setCam(cameraMode); }, [cameraMode]);
  // The map owns the zoom; it reports each change so we can re-cluster here
  // rather than duplicating the algorithm in injected JavaScript.
  const [zoom, setZoom] = useState(13);

  // Assign each member a stable colour by id order (self keeps the accent),
  // then merge markers that would visually collide at the current zoom.
  const payload = useMemo(() => {
    const coloured = members.map((m, i) => ({
      id: m.id, lat: m.lat, lng: m.lng, self: !!m.self, stale: !!m.stale,
      ini: initials(m.name), color: m.self ? colors.primary : COLORS[i % COLORS.length],
      label: m.label ?? '',
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
        // A merged bubble shows how many it hides, not one member's distance —
        // labelling it "1.2 km" would state that figure for everyone in it.
        label: c.items.length > 1 ? `${c.items.length} members` : head.label,
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

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(destination
      ? `setDest(${destination.lat},${destination.lng},${JSON.stringify(destination.name ?? '')});true;`
      : 'setDest(null);true;');
  // Keyed on the destination's FIELDS, not the object: a parent that rebuilds
  // the literal each render would otherwise re-centre the camera on every tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, destination?.lat, destination?.lng, destination?.name]);

  /**
   * Connector payload. Built from the SAME coloured, clustered list the markers
   * use, so a line always ends exactly on the dot it belongs to — including
   * when several members merge into one bubble at low zoom, where one line to
   * the bubble is the honest drawing rather than N lines to a point.
   *
   * Self is skipped: a connector from you to you is a dot.
   */
  const linkJs = useMemo(() => {
    if (!linkFrom) return 'null,[]';
    const list = payload
      .filter((c) => !(c.self && c.count === 1))
      .map((c) => ({ lat: c.lat, lng: c.lng, color: c.color, label: c.label }));
    return `${JSON.stringify(linkFrom)},${JSON.stringify(list)}`;
  }, [linkFrom, payload]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setLinks(${linkJs});true;`);
  }, [ready, linkJs]);

  useEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.injectJavaScript(`setRoute(${JSON.stringify(route ?? [])});true;`);
  }, [ready, route]);

  // Camera + heading — MapLibre only. Leaflet has no setCamera/setHeading, and
  // calling them there would throw inside the page on every update.
  useEffect(() => {
    if (!ready || !ref.current || engine !== 'maplibre') return;
    ref.current.injectJavaScript(`setCamera(${JSON.stringify(cam)});true;`);
  }, [ready, engine, cam]);
  useEffect(() => {
    if (!ready || !ref.current || engine !== 'maplibre' || headingDeg == null) return;
    ref.current.injectJavaScript(`setHeading(${Math.round(headingDeg)});true;`);
  }, [ready, engine, headingDeg]);

  const source = engine === 'maplibre'
    ? { html: mlHtml(JSON.stringify(mapStyle(scheme === 'light' ? 'light' : 'dark', colors.bg)), colors.bg, colors.primary, STREETVIEW_API_KEY) }
    : { html: html(leafletTileUrl(scheme === 'light' ? 'light' : 'dark'), colors.bg, colors.primary) };

  // Heading-up → north-up → overview, the three modes §46–48 name.
  const cycleCam = () => setCam(cam === 'follow' ? 'north' : cam === 'north' ? 'overview' : 'follow');
  const camIcon = cam === 'follow' ? 'navigate' : cam === 'north' ? 'compass' : 'scan';
  const camLabel = cam === 'follow' ? 'Heading-up' : cam === 'north' ? 'North-up' : 'Overview';

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        ref={ref}
        source={source}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={(e) => {
          const d = e.nativeEvent.data;
          // readyRef, not the `ready` state, guards the fallback below.
          // setReady is asynchronous, so the closure that handles an mlerror
          // arriving microseconds later still sees ready===false and throws the
          // working MapLibre map away. A ref updates synchronously, which is
          // what "the base map already came up" has to mean here.
          if (d === 'ready') { readyRef.current = true; setReady(true); return; }
          if (d.startsWith('zoom:')) {
            const z = Number(d.slice(5));
            if (Number.isFinite(z)) setZoom(z);
            return;
          }
          if (d.startsWith('sel:')) { onSelect?.(d.slice(4)); return; }
          try {
            const m = JSON.parse(d);
            // WebGL/worker failed on this device before first paint → Leaflet.
            if (m?.type === 'mlerror' && engine === 'maplibre' && !readyRef.current) { setEngine('leaflet'); return; }
            // Did the embedded @any-routing/pegman bundle actually come up?
            // A broken <script> tag does not stop the ones after it, so the map
            // would look perfectly fine while the routing engine was absent —
            // this is the only honest way to tell from outside.
            // console.WARN, not log: babel.config.js strips console.log from
            // release builds (keeping warn/error), so a log here is invisible
            // on exactly the builds that go on a phone — which made an absent
            // message look like a failed bundle when nothing was wrong.
            if (m?.type === 'routing-ready') { console.warn('[FamilyMap] any-routing ready'); return; }
            if (m?.type === 'routing-error') { console.warn('[FamilyMap] any-routing FAILED:', m.msg); return; }
            // @any-routing asking for a route. The page has no auth token by
            // design, so the network hop happens HERE and only the geometry
            // goes back over the bridge.
            if (m?.type === 'route-request' && Array.isArray(m.waypoints) && m.waypoints.length >= 2) {
              const [from, to] = [m.waypoints[0], m.waypoints[m.waypoints.length - 1]];
              fetchRoute({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, 'auto')
                .then((r) => ref.current?.injectJavaScript(
                  `__anyRouteReply(${m.id},${JSON.stringify({ shape: r.shape, lengthM: r.lengthM, timeS: r.timeS })});true;`))
                .catch((e) => ref.current?.injectJavaScript(
                  `__anyRouteReply(${m.id},null,${JSON.stringify(String(e?.message ?? 'route failed'))});true;`));
            }
          } catch { /* not JSON — nothing else on this channel */ }
        }}
        style={{ backgroundColor: colors.bg }}
        androidLayerType="hardware"
      />
      {/* Camera toggle. Hidden on Leaflet (which cannot rotate or pitch) and
          when a parent drives the mode, so the control never lies about what
          it will do. Text label, not colour alone — §70. */}
      {engine === 'maplibre' && !cameraMode && (
        <TouchableOpacity
          onPress={cycleCam}
          accessibilityRole="button"
          accessibilityLabel={`Camera: ${camLabel}. Tap to change.`}
          style={[styles.camFab, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Ionicons name={camIcon as any} size={17} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 10, fontWeight: '800' }}>{camLabel}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={() => ref.current?.injectJavaScript('fitAll();true;')}
        accessibilityRole="button"
        accessibilityLabel="Fit all family members on screen"
        style={[styles.fab, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <Ionicons name="scan" size={20} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  fab: { position: 'absolute', right: 12, bottom: 12, width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', elevation: 3 },
  camFab: {
    position: 'absolute', right: 12, bottom: 66, minWidth: 44, paddingHorizontal: 7,
    height: 44, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 1, elevation: 3,
  },
});
