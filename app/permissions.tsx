import { HEADER_TOP } from '../constants/layout';
import { LinearGradient } from "expo-linear-gradient";
import { Camera } from "expo-camera";
import * as Contacts from "expo-contacts";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { Pedometer } from "expo-sensors";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { canUseFullScreenIntent, openFullScreenIntentSettings } from "../lib/CallService";

const PERMS = [
  {key:"camera",   icon:"📷",label:"Camera",       sub:"Face scan and photo sharing"},
  {key:"mic",      icon:"🎙️",label:"Microphone",   sub:"Voice and video calls"},
  {key:"contacts", icon:"👥",label:"Contacts",     sub:"Find friends on VaultChat"},
  {key:"location", icon:"📍",label:"Location",     sub:"Secure location sharing"},
  {key:"background",icon:"🛰️",label:"Background Access",sub:"Keep Family Space sharing when the app is closed"},
  {key:"motion",   icon:"🏃",label:"Motion & Fitness",sub:"Detect driving so location updates adapt"},
  {key:"notifs",   icon:"🔔",label:"Notifications",sub:"New messages and calls"},
];

export default function PermissionsScreen() {
  const [granted,setGranted] = useState<Record<string,boolean>>({});
  const [loading,setLoading] = useState(false);
  // Android 14 turned USE_FULL_SCREEN_INTENT into a user-granted special
  // access. Declaring it in the manifest is no longer enough, and there is no
  // runtime dialog to request it — the only route is the Settings page below.
  // Ungranted, an incoming call on a locked phone arrives as a small banner
  // instead of a ringing call screen, which for a calling app reads as "calls
  // don't work". canUseFullScreenIntent resolves true where the concept does
  // not exist (iOS, Android 13 and below), so the row simply never appears.
  const [fsiOk,setFsiOk] = useState(true);
  const [asked,setAsked] = useState(false);

  const checkFsi = () => { canUseFullScreenIntent().then(setFsiOk).catch(()=>{}); };

  // Re-check when the user comes back: the grant happens in Settings, in
  // another app, so nothing here would otherwise learn that it succeeded and
  // the row would sit there looking unfinished after they had done it.
  useEffect(() => {
    checkFsi();
    const sub = AppState.addEventListener('change', s => { if (s === 'active') checkFsi(); });
    return () => sub.remove();
  }, []);

  const requestAll = async () => {
    setLoading(true);
    const r: Record<string,boolean> = {};
    try {
      r.camera   = (await Camera.requestCameraPermissionsAsync()).granted;
      r.mic      = (await Camera.requestMicrophonePermissionsAsync()).granted;
      r.contacts = Platform.OS === 'web' ? true : (await Contacts.requestPermissionsAsync()).granted;
      r.location = (await Location.requestForegroundPermissionsAsync()).granted;
      // Background location MUST follow a granted foreground grant — both
      // platforms reject the always-on prompt otherwise. Family Space only keeps
      // sharing while the app is closed if this one lands.
      if (r.location) {
        try { r.background = (await Location.requestBackgroundPermissionsAsync()).granted; } catch { r.background = false; }
      }
      // Motion is an iOS-only prompt; Android resolves granted with no dialog.
      try { r.motion = (await Pedometer.requestPermissionsAsync()).granted; } catch { r.motion = false; }
      r.notifs   = (await Notifications.requestPermissionsAsync()).granted;
      setGranted(r);
    } catch {}
    const fsi = await canUseFullScreenIntent().catch(() => true);
    setFsiOk(fsi);
    setAsked(true);
    setLoading(false);
    // Do NOT auto-advance past a missing full-screen-intent grant. It is the
    // one thing on this screen the button cannot grant, so sailing past it is
    // the same as skipping it silently — and the cost is calls that do not ring
    // on a locked phone. The button becomes "Continue" instead, so nobody is
    // stuck: this pauses once, it does not block.
    if (fsi) router.push("/setup-complete");
  };

  return (
    <LinearGradient colors={["#FFFFFF","#020E1A","#FFFFFF"]} style={{flex:1}}>
      <View style={S.container}>
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>🔑</Text></View>
          <Text style={S.title}>App Permissions</Text>
          <Text style={S.sub}>Grant access so all VaultChat features work correctly</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=7&&S.dotDone,n===8&&S.dotActive]}/>)}</View>
        <Text style={S.stepLbl}>Step 7 of 8 — Permissions</Text>
        <View style={S.list}>
          {PERMS.map(p=>(
            <View key={p.key} style={S.row}>
              <Text style={{fontSize:22,width:34}}>{p.icon}</Text>
              <View style={{flex:1}}>
                <Text style={S.label}>{p.label}</Text>
                <Text style={S.psub}>{p.sub}</Text>
              </View>
              <View style={[S.status,granted[p.key]&&S.statusOk]}>
                <Text style={{fontSize:12,color:granted[p.key]?"#22C55E":"rgba(255,255,255,0.3)"}}>{granted[p.key]?"✓":"○"}</Text>
              </View>
            </View>
          ))}
        </View>
        {!fsiOk && (
          <TouchableOpacity style={S.fsi} onPress={openFullScreenIntentSettings} activeOpacity={0.85}>
            <Text style={{fontSize:22,width:34}}>📱</Text>
            <View style={{flex:1}}>
              <Text style={S.label}>Full-screen calls</Text>
              <Text style={S.psub}>Android needs one extra tap for calls to ring on a locked screen</Text>
            </View>
            <Text style={S.fsiGo}>Allow ›</Text>
          </TouchableOpacity>
        )}
        {/* Once the runtime prompts have run, the button's job changes to
            moving on — otherwise a user held back by the full-screen-intent row
            would tap "Grant Permissions" forever and never leave this screen. */}
        <TouchableOpacity
          style={[S.btn,loading&&S.btnOff]}
          onPress={asked && !fsiOk ? () => router.push("/setup-complete") : requestAll}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={S.btnTxt}>{loading?"Requesting...":asked&&!fsiOk?"Continue":"Grant Permissions"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={S.skip} onPress={()=>router.push("/setup-complete")}>
          <Text style={S.skipTxt}>Skip — grant later in settings</Text>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,padding:24,paddingTop:HEADER_TOP },
  header:   { alignItems:"center",marginBottom:24,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:    { color:"#fff",fontSize:24,fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.4)",fontSize:13,textAlign:"center" },
  steps:    { flexDirection:"row",gap:6,justifyContent:"center",marginBottom:6 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  stepLbl:  { color:"rgba(74,159,255,0.7)",fontSize:11,textAlign:"center",marginBottom:24 },
  list:     { backgroundColor:"rgba(255,255,255,0.03)",borderRadius:16,padding:8,marginBottom:28,gap:4 },
  row:      { flexDirection:"row",alignItems:"center",gap:12,padding:12,borderRadius:12 },
  label:    { color:"#fff",fontSize:14,fontWeight:"600" },
  psub:     { color:"rgba(255,255,255,0.3)",fontSize:12,marginTop:2 },
  status:   { width:28,height:28,borderRadius:14,borderWidth:1,borderColor:"rgba(255,255,255,0.12)",justifyContent:"center",alignItems:"center" },
  statusOk: { borderColor:"#22C55E",backgroundColor:"rgba(34,197,94,0.1)" },
  // Amber, not the blue of the primary button: this row is the one thing on the
  // screen that still needs the user, so it has to read as outstanding rather
  // than as another item in the list above.
  fsi:      { flexDirection:"row",alignItems:"center",gap:12,padding:12,borderRadius:12,marginBottom:12,
              backgroundColor:"rgba(245,158,11,0.12)",borderWidth:1,borderColor:"rgba(245,158,11,0.45)" },
  fsiGo:    { color:"#F59E0B",fontWeight:"800",fontSize:13 },
  btn:      { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center",marginBottom:12 },
  btnOff:   { opacity:0.5 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
  skip:     { padding:10,alignItems:"center" },
  skipTxt:  { color:"rgba(255,255,255,0.3)",fontSize:12 },
});
