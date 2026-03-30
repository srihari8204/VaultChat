import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { checkVaultIdAvailable, registerVaultId } from "./(constants)/authService";

export default function VaultIdScreen() {
  const [vaultId,setVaultId] = useState("");
  const [status,setStatus]   = useState<"idle"|"checking"|"available"|"taken"|"invalid">("idle");
  const [loading,setLoading] = useState(false);

  const validate = (v:string) => /^[a-z0-9._]{3,20}$/.test(v);

  const handleChange = async (val: string) => {
    const clean = val.toLowerCase().replace(/[^a-z0-9._]/g,"");
    setVaultId(clean);
    if (clean.length<3){setStatus("idle");return;}
    if (!validate(clean)){setStatus("invalid");return;}
    setStatus("checking");
    try { setStatus((await checkVaultIdAvailable(clean))?"available":"taken"); }
    catch { setStatus("idle"); }
  };

  const handleNext = async () => {
    if (status!=="available") return;
    setLoading(true);
    try { await registerVaultId(vaultId); router.push("/profile-setup"); }
    catch { setStatus("idle"); }
    finally { setLoading(false); }
  };

  const clr = {idle:"transparent",checking:"#F59E0B",available:"#22C55E",taken:"#EF4444",invalid:"#EF4444"}[status];
  const msg = {idle:"",checking:"Checking...",available:"Available",taken:"Already taken",invalid:"Only letters, numbers, . and _ (3-20 chars)"}[status];

  return (
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}>
      <LinearGradient colors={["#FFFFFF","#020E1A","#FFFFFF"]} style={StyleSheet.absoluteFillObject}/>
      <View style={S.container}>
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>🆔</Text></View>
          <Text style={S.title}>Create your VaultID</Text>
          <Text style={S.sub}>Your unique identity on VaultChat</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=2&&S.dotDone,n===3&&S.dotActive]}/>)}</View>
        <Text style={S.stepLbl}>Step 2 of 8 — VaultID</Text>
        <View style={S.inputWrap}>
          <Text style={S.prefix}>vault://</Text>
          <TextInput style={S.input} placeholder="yourvaultid" placeholderTextColor="rgba(255,255,255,0.2)" value={vaultId} onChangeText={handleChange} autoCapitalize="none" autoCorrect={false} maxLength={20}/>
        </View>
        {status!=="idle"&&<Text style={[S.status,{color:clr}]}>{msg}</Text>}
        <View style={S.rules}>
          {["3-20 characters","Letters, numbers, . and _","No spaces","Cannot be changed later"].map(r=><Text key={r} style={S.rule}>- {r}</Text>)}
        </View>
        <TouchableOpacity style={[S.btn,(status!=="available"||loading)&&S.btnOff]} onPress={handleNext} disabled={status!=="available"||loading} activeOpacity={0.85}>
          {loading?<ActivityIndicator color="#fff"/>:<Text style={S.btnTxt}>Claim VaultID</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,padding:24,paddingTop:70 },
  header:   { alignItems:"center",marginBottom:28,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:    { color:"#fff",fontSize:24,fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.4)",fontSize:13,textAlign:"center" },
  steps:    { flexDirection:"row",gap:6,justifyContent:"center",marginBottom:6 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  stepLbl:  { color:"rgba(74,159,255,0.7)",fontSize:11,textAlign:"center",marginBottom:24 },
  inputWrap:{ flexDirection:"row",alignItems:"center",backgroundColor:"rgba(255,255,255,0.05)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",borderRadius:14,paddingHorizontal:14,marginBottom:8 },
  prefix:   { color:"rgba(74,159,255,0.6)",fontSize:14,marginRight:4,fontWeight:"600" },
  input:    { flex:1,color:"#fff",fontSize:18,paddingVertical:14,letterSpacing:1 },
  status:   { fontSize:13,marginBottom:16,textAlign:"center",fontWeight:"600" },
  rules:    { backgroundColor:"rgba(255,255,255,0.03)",borderRadius:12,padding:16,gap:8,marginBottom:32 },
  rule:     { color:"rgba(255,255,255,0.35)",fontSize:13 },
  btn:      { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center" },
  btnOff:   { opacity:0.4 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
});
