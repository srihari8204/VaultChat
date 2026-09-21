import { HEADER_TOP } from '../constants/layout';
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { savePIN } from "../services/securityService";
import { AppText as Text, AuthSky, KeyboardSafe } from "../components/ui";
import { AUTH_LIGHT, type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

const KEYS = ["1","2","3","4","5","6","7","8","9","","0","⌫"];

export default function BackupPINScreen() {
  const AUTH = useAuthTheme();
  const S = useMemo(() => makeStyles(AUTH), [AUTH]);
  // Reached mid-onboarding (→ /biometric-setup next) or from Settings (→ back).
  const fromSettings = useLocalSearchParams<{ from?: string }>().from === 'settings';
  const [pin,setPin]     = useState("");
  const [confirm,setConfirm] = useState("");
  const [stage,setStage] = useState<"set"|"confirm">("set");
  const [error,setError] = useState("");

  const current = stage==="set"?pin:confirm;
  const setter  = stage==="set"?setPin:setConfirm;

  const handleKey = (k:string) => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (k==="⌫"){setter(p=>p.slice(0,-1));setError("");return;}
    if (k===""||current.length>=6) return;
    const next=current+k; setter(next);
    if (next.length===6) setTimeout(()=>advance(next),120);
  };

  const advance = async (val:string) => {
    if (stage==="set"){setStage("confirm");return;}
    if (val!==pin){setError("PINs do not match. Try again.");setConfirm("");setStage("set");setPin("");return;}
    await savePIN(val);   // also seals the session under it (#32) — see pinStore
    if (fromSettings) router.back(); else router.push("/biometric-setup");
  };

  const dots = Array(6).fill(0).map((_,i)=>({filled:i<current.length}));

  return (
    <View style={S.screen}>
      <AuthSky />
      <KeyboardSafe style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>🔢</Text></View>
          <Text style={S.title}>{stage==="set"?"Set Backup PIN":"Confirm PIN"}</Text>
          <Text style={S.sub}>{stage==="set"?"Used if biometrics fail. Keep it private.":"Enter your PIN again to confirm"}</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=5&&S.dotDone,n===6&&S.dotActive]}/>)}</View>
        <View style={S.dotsRow}>{dots.map((d,i)=><View key={i} style={[S.pinDot,d.filled&&S.pinDotFilled]}/>)}</View>
        {!!error&&<Text style={S.err}>{error}</Text>}
        <View style={S.keypad}>
          {KEYS.map((k,i)=>(
            <TouchableOpacity key={i} style={[S.key,k===""&&S.keyEmpty,k==="⌫"&&S.keyDel]} onPress={()=>handleKey(k)} disabled={k===""} activeOpacity={0.7}>
              <Text style={[S.keyTxt,k==="⌫"&&{color:"#EF4444"}]}>{k}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={S.hint}>PIN is stored securely on your device only.</Text>
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen:     { flex:1, backgroundColor:"transparent" },
  container:  { flexGrow:1,alignItems:"center",paddingTop:HEADER_TOP,paddingHorizontal:32,paddingBottom:32 },
  header:     { alignItems:"center",marginBottom:24,gap:10 },
  badge:      { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:      { color:AUTH.text,fontSize:24,fontWeight:"900" },
  sub:        { color:AUTH.dim,fontSize:13,textAlign:"center" },
  steps:      { flexDirection:"row",gap:6,marginBottom:28 },
  dot:        { width:24,height:4,borderRadius:2,backgroundColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.stroke : "rgba(255,255,255,0.12)" },
  dotActive:  { backgroundColor:"#4A9FFF",width:32 },
  dotDone:    { backgroundColor:"#22C55E" },
  dotsRow:    { flexDirection:"row",gap:14,marginBottom:16 },
  pinDot:     { width:18,height:18,borderRadius:9,borderWidth:2,borderColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.stroke : "rgba(255,255,255,0.2)" },
  pinDotFilled:{ backgroundColor:"#4A9FFF",borderColor:"#4A9FFF" },
  err:        { color:AUTH.danger,fontSize:13,marginBottom:16,textAlign:"center" },
  keypad:     { flexDirection:"row",flexWrap:"wrap",width:"100%",maxWidth:280,gap:14,justifyContent:"center",marginBottom:24 },
  key:        { width:76,height:76,borderRadius:38,backgroundColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.card : "rgba(255,255,255,0.07)",borderWidth:1,borderColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.stroke : "rgba(255,255,255,0.1)",justifyContent:"center",alignItems:"center" },
  keyEmpty:   { backgroundColor:"transparent",borderColor:"transparent" },
  keyDel:     { backgroundColor:"rgba(239,68,68,0.08)",borderColor:"rgba(239,68,68,0.2)" },
  keyTxt:     { color:AUTH.text,fontSize:24,fontWeight:"600" },
  hint:       { color:AUTH.dim,fontSize:12,textAlign:"center" },
});
