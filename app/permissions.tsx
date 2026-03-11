import { LinearGradient } from "expo-linear-gradient";
import { Camera } from "expo-camera";
import * as Contacts from "expo-contacts";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

const PERMS = [
  {key:"camera",   icon:"📷",label:"Camera",       sub:"Face scan and photo sharing"},
  {key:"mic",      icon:"🎙️",label:"Microphone",   sub:"Voice and video calls"},
  {key:"contacts", icon:"👥",label:"Contacts",     sub:"Find friends on VaultChat"},
  {key:"location", icon:"📍",label:"Location",     sub:"Secure location sharing"},
  {key:"notifs",   icon:"🔔",label:"Notifications",sub:"New messages and calls"},
];

export default function PermissionsScreen() {
  const [granted,setGranted] = useState<Record<string,boolean>>({});
  const [loading,setLoading] = useState(false);

  const requestAll = async () => {
    setLoading(true);
    const r: Record<string,boolean> = {};
    try {
      r.camera   = (await Camera.requestCameraPermissionsAsync()).granted;
      r.mic      = (await Camera.requestMicrophonePermissionsAsync()).granted;
      r.contacts = (await Contacts.requestPermissionsAsync()).granted;
      r.location = (await Location.requestForegroundPermissionsAsync()).granted;
      r.notifs   = (await Notifications.requestPermissionsAsync()).granted;
      setGranted(r);
    } catch {}
    setLoading(false);
    router.push("/setup-complete");
  };

  return (
    <LinearGradient colors={["#010812","#020E1A","#010812"]} style={{flex:1}}>
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
        <TouchableOpacity style={[S.btn,loading&&S.btnOff]} onPress={requestAll} disabled={loading} activeOpacity={0.85}>
          <Text style={S.btnTxt}>{loading?"Requesting...":"Grant Permissions"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={S.skip} onPress={()=>router.push("/setup-complete")}>
          <Text style={S.skipTxt}>Skip — grant later in settings</Text>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,padding:24,paddingTop:60 },
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
  btn:      { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center",marginBottom:12 },
  btnOff:   { opacity:0.5 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
  skip:     { padding:10,alignItems:"center" },
  skipTxt:  { color:"rgba(255,255,255,0.3)",fontSize:12 },
});
