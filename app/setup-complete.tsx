import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { markSetupComplete } from "../services/securityService";

export default function SetupCompleteScreen() {
  const scale   = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    markSetupComplete();
    Animated.parallel([
      Animated.spring(scale,  {toValue:1,tension:50,friction:7,useNativeDriver:true}),
      Animated.timing(opacity,{toValue:1,duration:500,useNativeDriver:true}),
    ]).start();
  },[opacity, scale]);

  const features = [
    {icon:"📱",text:"Mobile number verified"},
    {icon:"🆔",text:"VaultID registered"},
    {icon:"🛡️",text:"Security questions set"},
    {icon:"🔢",text:"Backup PIN saved"},
    {icon:"🤳",text:"Biometric lock active"},
    {icon:"🔑",text:"Permissions granted"},
  ];

  return (
    <LinearGradient colors={["#FFFFFF","#020E1A","#FFFFFF"]} style={{flex:1}}>
      <View style={S.container}>
        <Animated.View style={[S.content,{opacity,transform:[{scale}]}]}>
          <View style={S.circle}><Text style={{fontSize:52}}>🔐</Text></View>
          <Text style={S.title}>VaultChat is Ready</Text>
          <Text style={S.sub}>Your secure vault is set up and locked.</Text>
          <View style={S.list}>
            {features.map(f=>(
              <View key={f.text} style={S.row}>
                <Text style={{fontSize:18}}>{f.icon}</Text>
                <Text style={S.feat}>{f.text}</Text>
                <Text style={{color:"#22C55E",fontSize:16}}>✓</Text>
              </View>
            ))}
          </View>
          <View style={S.badge}>
            <Text style={S.badgeTxt}>Protected by E2EE + Biometric Lock</Text>
          </View>
          <TouchableOpacity style={S.btn} onPress={()=>router.replace("/(tabs)/chats")} activeOpacity={0.85}>
            <Text style={S.btnTxt}>Enter VaultChat</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,justifyContent:"center",alignItems:"center",padding:28 },
  content:  { width:"100%",alignItems:"center",gap:16 },
  circle:   { width:110,height:110,borderRadius:55,backgroundColor:"rgba(34,197,94,0.12)",borderWidth:2,borderColor:"rgba(34,197,94,0.35)",justifyContent:"center",alignItems:"center",marginBottom:8 },
  title:    { color:"#fff",fontSize:28,fontWeight:"900",textAlign:"center" },
  sub:      { color:"rgba(255,255,255,0.4)",fontSize:15,textAlign:"center" },
  list:     { width:"100%",backgroundColor:"rgba(255,255,255,0.03)",borderRadius:16,padding:16,gap:12 },
  row:      { flexDirection:"row",alignItems:"center",gap:12 },
  feat:     { flex:1,color:"rgba(255,255,255,0.7)",fontSize:14 },
  badge:    { backgroundColor:"rgba(34,197,94,0.08)",borderWidth:1,borderColor:"rgba(34,197,94,0.2)",borderRadius:12,padding:12,width:"100%" },
  badgeTxt: { color:"#22C55E",fontSize:12,textAlign:"center",fontWeight:"600" },
  btn:      { backgroundColor:"#22C55E",borderRadius:14,paddingVertical:16,alignItems:"center",width:"100%" },
  btnTxt:   { color:"#fff",fontSize:17,fontWeight:"900" },
});
