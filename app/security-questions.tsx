import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SECURITY_QUESTIONS } from "../constants/securityQuestions";
import { saveSecurityAnswers } from "../services/securityService";

export default function SecurityQuestionsScreen() {
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
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}>
      <LinearGradient colors={["#FFFFFF","#020E1A","#FFFFFF"]} style={StyleSheet.absoluteFillObject}/>
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
              <View style={S.drop}>
                {SECURITY_QUESTIONS.map((q,qi)=>(
                  <TouchableOpacity key={qi} style={[S.dropItem,sel[slot]===qi&&S.dropActive]} onPress={()=>setQ(slot,qi)}>
                    <Text style={{color:"#fff",fontSize:13,lineHeight:18}}>{q}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <TextInput style={S.ans} placeholder="Your answer" placeholderTextColor="rgba(255,255,255,0.2)" value={ans[slot]} onChangeText={v=>setA(slot,v)} autoCapitalize="none" autoCorrect={false} secureTextEntry/>
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
    </KeyboardAvoidingView>
  );
}

const S = StyleSheet.create({
  scroll:   { flexGrow:1,padding:24,paddingTop:HEADER_TOP },
  header:   { alignItems:"center",marginBottom:24,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:    { color:"#fff",fontSize:22,fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.4)",fontSize:13,textAlign:"center",lineHeight:18 },
  steps:    { flexDirection:"row",gap:6,justifyContent:"center",marginBottom:6 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  stepLbl:  { color:"rgba(74,159,255,0.7)",fontSize:11,textAlign:"center",marginBottom:20 },
  qBlock:   { marginBottom:20 },
  qNum:     { color:"#4A9FFF",fontSize:12,fontWeight:"700",marginBottom:6,letterSpacing:1 },
  qSel:     { flexDirection:"row",justifyContent:"space-between",alignItems:"center",backgroundColor:"rgba(255,255,255,0.05)",borderWidth:1,borderColor:"rgba(255,255,255,0.1)",borderRadius:12,padding:12,marginBottom:6 },
  qSelTxt:  { flex:1,color:"#fff",fontSize:13,lineHeight:18 },
  drop:     { backgroundColor:"#FFFFFF",borderWidth:1,borderColor:"rgba(74,159,255,0.2)",borderRadius:12,marginBottom:6,maxHeight:260,overflow:"hidden" },
  dropItem: { padding:12,borderBottomWidth:1,borderBottomColor:"rgba(255,255,255,0.05)" },
  dropActive:{ backgroundColor:"rgba(74,159,255,0.12)" },
  ans:      { backgroundColor:"rgba(255,255,255,0.05)",borderWidth:1,borderColor:"rgba(255,255,255,0.1)",borderRadius:12,padding:14,color:"#fff",fontSize:15 },
  err:      { color:"#EF4444",fontSize:13,textAlign:"center",marginBottom:12 },
  warn:     { backgroundColor:"rgba(245,158,11,0.08)",borderWidth:1,borderColor:"rgba(245,158,11,0.25)",borderRadius:12,padding:14,marginBottom:24 },
  warnTxt:  { color:"rgba(245,158,11,0.85)",fontSize:12,lineHeight:18 },
  btn:      { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center",marginBottom:32 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
});
