import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function BiometricSetupScreen() {
  const [status,setStatus] = useState<"idle"|"scanning"|"success"|"failed"|"unavailable">("idle");
  const [msg,setMsg] = useState("Tap to register your biometric");
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(()=>{
    const loop=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1.08,duration:1000,useNativeDriver:true}),
      Animated.timing(pulse,{toValue:1,duration:1000,useNativeDriver:true}),
    ]));
    loop.start();
    (async()=>{
      if(Platform.OS==='web'){setStatus("unavailable");setMsg("No biometrics on this device. Skip to use PIN only.");return;}
      const has=await LocalAuthentication.hasHardwareAsync();
      const enr=await LocalAuthentication.isEnrolledAsync();
      if(!has||!enr){setStatus("unavailable");setMsg("No biometrics on this device. Skip to use PIN only.");}
    })();
    return ()=>loop.stop();
  },[pulse]);

  const handleRegister = async () => {
    if(status==="unavailable"){router.push("/permissions");return;}
    if(Platform.OS==='web'){router.push("/permissions");return;}
    setStatus("scanning");setMsg("Scanning...");
    try {
      const r=await LocalAuthentication.authenticateAsync({promptMessage:"Register your biometric for VaultChat",fallbackLabel:"Use PIN instead",cancelLabel:"Skip",disableDeviceFallback:false});
      if(r.success){setStatus("success");setMsg("Biometric registered");setTimeout(()=>router.push("/permissions"),800);}
      else{setStatus("failed");setMsg("Try again or skip to use PIN only");}
    } catch {setStatus("failed");setMsg("Error. Tap to try again.");}
  };

  const clr  = {idle:"#4A9FFF",scanning:"#F59E0B",success:"#22C55E",failed:"#EF4444",unavailable:"#475569"}[status];
  const icon = {idle:"👤",scanning:"⌛",success:"✅",failed:"❌",unavailable:"🔒"}[status];

  return (
    <LinearGradient colors={["#010812","#020E1A","#010812"]} style={{flex:1}}>
      <View style={S.container}>
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>🤳</Text></View>
          <Text style={S.title}>Register Biometric</Text>
          <Text style={S.sub}>FaceID or Fingerprint — required every time you open VaultChat</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=6&&S.dotDone,n===7&&S.dotActive]}/>)}</View>
        <Text style={S.stepLbl}>Step 6 of 8 — Biometric Lock</Text>
        <TouchableOpacity onPress={handleRegister} activeOpacity={0.8} disabled={status==="scanning"||status==="success"}>
          <Animated.View style={[S.ring,{borderColor:clr,transform:[{scale:pulse}]}]}>
            <View style={[S.ringIn,{borderColor:clr+"55"}]}>
              <Text style={{fontSize:64}}>{icon}</Text>
            </View>
          </Animated.View>
        </TouchableOpacity>
        <Text style={[S.msg,{color:clr}]}>{msg}</Text>
        <View style={S.info}>
          <Text style={S.infoTxt}>Your biometric data never leaves your device.</Text>
        </View>
        <TouchableOpacity style={S.skip} onPress={()=>router.push("/permissions")}>
          <Text style={S.skipTxt}>Skip — use PIN only</Text>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,alignItems:"center",paddingTop:60,paddingHorizontal:24 },
  header:   { alignItems:"center",marginBottom:24,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:    { color:"#fff",fontSize:24,fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.4)",fontSize:13,textAlign:"center" },
  steps:    { flexDirection:"row",gap:6,marginBottom:6 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  stepLbl:  { color:"rgba(74,159,255,0.7)",fontSize:11,marginBottom:32 },
  ring:     { width:190,height:190,borderRadius:95,borderWidth:2,backgroundColor:"rgba(74,159,255,0.05)",justifyContent:"center",alignItems:"center",marginBottom:20 },
  ringIn:   { width:150,height:150,borderRadius:75,borderWidth:1,justifyContent:"center",alignItems:"center" },
  msg:      { fontSize:15,fontWeight:"600",marginBottom:24,textAlign:"center" },
  info:     { backgroundColor:"rgba(74,159,255,0.06)",borderWidth:1,borderColor:"rgba(74,159,255,0.15)",borderRadius:12,padding:16,marginBottom:24,width:"100%" },
  infoTxt:  { color:"rgba(255,255,255,0.4)",fontSize:12,lineHeight:18,textAlign:"center" },
  skip:     { padding:12 },
  skipTxt:  { color:"rgba(255,255,255,0.3)",fontSize:13,fontWeight:"600" },
});
