import { useTheme } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { AppText as Text } from '../components/ui/Text';
import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from "react-native";
import { KeyboardSafe, AuroraBackground } from "../components/ui";
import { SECURITY_QUESTIONS } from "../constants/securityQuestions";
import { saveSecurityAnswers } from "../services/securityService";

export default function SecurityQuestionsScreen() {
  const { colors: c, scheme } = useTheme();
  const S = useMemo(() => makeStyles(c, scheme === 'light'), [c, scheme]);
  const [sel,setSel]         = useState([0,3,6]);
  const [ans,setAns]         = useState(["","",""]);
  const [pick,setPick]       = useState<number|null>(null);
  const [error,setError]     = useState("");

  const setQ = (slot:number,qi:number) => { const n=[...sel];n[slot]=qi;setSel(n);setPick(null); };
  const setA = (slot:number,v:string)  => { const n=[...ans];n[slot]=v;setAns(n);setError(""); };

  const handleNext = async () => {
    if (ans.some(a=>a.trim().length<2)){setError("All answers must be at least 2 characters");return;}
    if (new Set(sel).size<3){setError("Please select 3 different questions");return;}
    setError("");
   await saveSecurityAnswers({q1:SECURITY_QUESTIONS[sel[0]],a1:ans[0],q2:SECURITY_QUESTIONS[sel[1]],a2:ans[1],q3:SECURITY_QUESTIONS[sel[2]],a3:ans[2]});
    router.push("/backup-pin");
  };

  return (
    // KeyboardSafe, not KeyboardAvoidingView (2026-09-17). The old
    // `behavior={Platform.OS==="ios"?"padding":undefined}` resolved to undefined
    // on Android, and RN's KeyboardAvoidingView switches on `behavior` with a
    // `default:` that returns a plain View — so this ACCOUNT RECOVERY screen had
    // literally zero keyboard avoidance on Android.
    //
    // The gradient stays OUTSIDE the wrapper: KeyboardSafe works by padding, and
    // an absolutely-positioned child resolves its insets against the parent's
    // PADDING box, so a StyleSheet.absoluteFillObject background placed inside
    // would be clipped by that padding. app/mpin-recover.tsx already does it this
    // way. keyboardOnly because the CTA lives inside the ScrollView, which
    // already has keyboardShouldPersistTaps and flexGrow, so no resting
    // safe-area gap is wanted here.
    <View style={{flex:1}}>
      <AuroraBackground />
      <KeyboardSafe keyboardOnly style={{flex:1}}>
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>🛡️</Text></View>
          <Text style={S.title}>Security Questions</Text>
          <Text style={S.sub}>For account recovery only. Stored locally — never on servers.</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=4&&S.dotDone,n===5&&S.dotActive]}/>)}</View>
        <Text style={S.stepLbl}>Step 4 of 8 — Security Questions</Text>
        {[0,1,2].map(slot=>(
          <View key={slot} style={S.qBlock}>
            <Text style={S.qNum}>Question {slot+1}</Text>
            <TouchableOpacity style={S.qSel} onPress={()=>setPick(pick===slot?null:slot)} activeOpacity={0.8}>
              <Text style={S.qSelTxt} numberOfLines={2}>{SECURITY_QUESTIONS[sel[slot]]}</Text>
              <Ionicons name={pick===slot?"chevron-up":"chevron-down"} size={14} color="#4A9FFF" style={{marginLeft:8}} />
            </TouchableOpacity>
            {pick===slot&&(
              <ScrollView style={S.drop} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {SECURITY_QUESTIONS.map((q,qi)=>(
                  <TouchableOpacity key={qi} style={[S.dropItem,sel[slot]===qi&&S.dropActive]} onPress={()=>setQ(slot,qi)}>
                    <Text style={{color:c.text,fontSize:13,lineHeight:18}}>{q}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TextInput style={S.ans} placeholder="Your answer" placeholderTextColor={c.textDim} value={ans[slot]} onChangeText={v=>setA(slot,v)} autoCapitalize="none" autoCorrect={false} secureTextEntry/>
          </View>
        ))}
        {!!error&&<Text style={S.err}>{error}</Text>}
        <View style={S.warn}>
          <Text style={S.warnTxt}>Remember your answers exactly as typed. Case-insensitive. Cannot be recovered if forgotten.</Text>
        </View>
        <TouchableOpacity style={S.btn} onPress={handleNext} activeOpacity={0.85}>
          <Text style={S.btnTxt}>Save and Continue</Text>
        </TouchableOpacity>
      </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (c: Palette, light: boolean) => StyleSheet.create({
  scroll:   { flexGrow:1,padding:24,paddingTop:HEADER_TOP },
  header:   { alignItems:"center",marginBottom:24,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:    { color:c.text,fontSize:22,fontWeight:"900" },
  sub:      { color:c.textDim,fontSize:13,textAlign:"center",lineHeight:18 },
  steps:    { flexDirection:"row",gap:6,justifyContent:"center",marginBottom:6 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:c.border },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  stepLbl:  { color:c.primary,fontSize:12,textAlign:"center",marginBottom:20 },
  qBlock:   { marginBottom:20 },
  qNum:     { color:c.primary,fontSize:12,fontWeight:"700",marginBottom:6,letterSpacing:1 },
  qSel:     { flexDirection:"row",justifyContent:"space-between",alignItems:"center",backgroundColor:c.glassSoft,borderWidth:1,borderColor:c.glassStroke,borderRadius:12,padding:12,marginBottom:6 },
  qSelTxt:  { flex:1,color:c.text,fontSize:13,lineHeight:18 },
  drop:     { backgroundColor:c.surfaceSolid,borderWidth:1,borderColor:"rgba(74,159,255,0.2)",borderRadius:12,marginBottom:6,maxHeight:260,overflow:"hidden" },
  dropItem: { padding:12,borderBottomWidth:1,borderBottomColor:c.glassStroke },
  dropActive:{ backgroundColor:"rgba(74,159,255,0.12)" },
  ans:      { backgroundColor:c.glassSoft,borderWidth:1,borderColor:c.glassStroke,borderRadius:12,padding:14,color:c.text,fontSize:15 },
  err:      { color:light ? c.danger : "#EF4444",fontSize:13,textAlign:"center",marginBottom:12 },
  warn:     { backgroundColor:"rgba(245,158,11,0.08)",borderWidth:1,borderColor:"rgba(245,158,11,0.25)",borderRadius:12,padding:14,marginBottom:24 },
  warnTxt:  { color:c.text,fontSize:12,lineHeight:18 },
  btn:      { backgroundColor:c.accentDeep,borderRadius:14,paddingVertical:16,alignItems:"center",marginBottom:32 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
});
