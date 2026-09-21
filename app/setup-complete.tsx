import { useColors } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useEffect, useRef } from "react";
import { Animated, StyleSheet, ScrollView, TouchableOpacity, View } from "react-native";
import { markSetupComplete } from "../services/securityService";

export default function SetupCompleteScreen() {
  const c = useColors();
  const S = useMemo(() => makeStyles(c), [c]);
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
    <View style={{flex:1,backgroundColor:c.bg}}>
      <AuroraBackground />
      <ScrollView contentContainerStyle={S.container}>
        <Animated.View style={[S.content,{opacity,transform:[{scale}]}]}>
          <View style={S.circle}><Text style={{fontSize:52}}>🔐</Text></View>
          <Text style={S.title}>crazzychat is Ready</Text>
          <Text style={S.sub}>Your secure vault is set up and locked.</Text>
          <View style={S.list}>
            {features.map(f=>(
              <View key={f.text} style={S.row}>
                <Text style={{fontSize:18}}>{f.icon}</Text>
                <Text style={S.feat}>{f.text}</Text>
                <Ionicons name="checkmark" size={16} color="#22C55E" />
              </View>
            ))}
          </View>
          <View style={S.badge}>
            <Text style={S.badgeTxt}>Protected by E2EE + Biometric Lock</Text>
          </View>
          <TouchableOpacity style={S.btn} onPress={()=>router.replace("/(tabs)/chats")} activeOpacity={0.85}>
            <Text style={S.btnTxt}>Enter crazzychat</Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{ flexGrow:1,justifyContent:"center",alignItems:"center",padding:28 },
  content:  { width:"100%",alignItems:"center",gap:16 },
  circle:   { width:110,height:110,borderRadius:55,backgroundColor:"rgba(34,197,94,0.12)",borderWidth:2,borderColor:"rgba(34,197,94,0.35)",justifyContent:"center",alignItems:"center",marginBottom:8 },
  title:    { color:c.text,fontSize:28,fontWeight:"900",textAlign:"center" },
  sub:      { color:c.textDim,fontSize:15,textAlign:"center" },
  list:     { width:"100%",backgroundColor:c.glassSoft,borderWidth:1,borderColor:c.glassStroke,borderRadius:16,padding:16,gap:12 },
  row:      { flexDirection:"row",alignItems:"center",gap:12 },
  feat:     { flex:1,color:c.textDim,fontSize:14 },
  badge:    { backgroundColor:"rgba(34,197,94,0.08)",borderWidth:1,borderColor:"rgba(34,197,94,0.2)",borderRadius:12,padding:12,width:"100%" },
  badgeTxt: { color:c.success,fontSize:12,textAlign:"center",fontWeight:"600" },
  btn:      { backgroundColor:c.accentDeep,borderRadius:14,paddingVertical:16,alignItems:"center",width:"100%" },
  btnTxt:   { color:"#fff",fontSize:17,fontWeight:"900" },
});
