import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { sendOTP } from "./(constants)/authService";

const CC = [
  { code: "+91", flag: "IN", name: "India" },
  { code: "+1",  flag: "US", name: "USA"   },
  { code: "+44", flag: "UK", name: "UK"    },
  { code: "+971",flag: "AE", name: "UAE"   },
  { code: "+61", flag: "AU", name: "AU"    },
  { code: "+65", flag: "SG", name: "SG"    },
];

export default function PhoneScreen() {
  const [phone, setPhone] = useState("");
  const [cc, setCC]       = useState(CC[0]);
  const [showCC, setShowCC] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const handleSend = async () => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) { setError("Enter a valid mobile number"); return; }
    setError(""); setLoading(true);
    try {
      await sendOTP(cc.code + digits);
      router.push({ pathname: "/otp", params: { phone: cc.code + digits } });
    } catch (e: any) {
      setError(e?.message ?? "Failed to send OTP. Try again.");
    } finally { setLoading(false); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <LinearGradient colors={["#010812", "#020E1A", "#010812"]} style={StyleSheet.absoluteFillObject} />
      <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">
        <View style={S.header}>
          <View style={S.badge}><Text style={{ fontSize: 36 }}>🔐</Text></View>
          <Text style={S.title}>VaultChat</Text>
          <Text style={S.sub}>Enter your mobile number to get started</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot, n===1&&S.dotActive]}/>)}</View>
        <Text style={S.stepLbl}>Step 1 of 8 — Mobile Verification</Text>

        <TouchableOpacity style={S.ccBtn} onPress={() => setShowCC(!showCC)} activeOpacity={0.8}>
          <Text style={S.ccTxt}>{cc.name}  {cc.code}</Text>
          <Text style={{ color:"#4A9FFF",fontSize:12 }}>{showCC?"▲":"▼"}</Text>
        </TouchableOpacity>
        {showCC && (
          <View style={S.ccDrop}>
            {CC.map(item => (
              <TouchableOpacity key={item.code} style={[S.ccItem, item.code===cc.code&&S.ccActive]} onPress={() => { setCC(item); setShowCC(false); }}>
                <Text style={{ color:"#fff",fontSize:14 }}>{item.name}  {item.code}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={S.inputRow}>
          <Text style={S.prefix}>{cc.code}</Text>
          <TextInput style={S.input} placeholder="Mobile number" placeholderTextColor="rgba(255,255,255,0.25)" keyboardType="phone-pad" value={phone} onChangeText={v=>{setPhone(v);setError("");}} maxLength={15} />
        </View>
        {!!error && <Text style={S.err}>{error}</Text>}
        <Text style={S.hint}>We will send a 6-digit OTP to verify your number.</Text>

        <TouchableOpacity style={[S.btn,(!phone||loading)&&S.btnOff]} onPress={handleSend} disabled={!phone||loading} activeOpacity={0.85}>
          {loading ? <ActivityIndicator color="#fff"/> : <Text style={S.btnTxt}>Send OTP</Text>}
        </TouchableOpacity>
        <Text style={S.legal}>By continuing you agree to VaultChat Terms of Service</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const S = StyleSheet.create({
  scroll:   { flexGrow:1, padding:24, paddingTop:70 },
  header:   { alignItems:"center", marginBottom:32, gap:12 },
  badge:    { width:80, height:80, borderRadius:40, backgroundColor:"rgba(74,159,255,0.12)", borderWidth:1.5, borderColor:"rgba(74,159,255,0.3)", justifyContent:"center", alignItems:"center" },
  title:    { color:"#fff", fontSize:28, fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.45)", fontSize:14, textAlign:"center" },
  steps:    { flexDirection:"row", gap:6, justifyContent:"center", marginBottom:6 },
  dot:      { width:24, height:4, borderRadius:2, backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF", width:32 },
  stepLbl:  { color:"rgba(74,159,255,0.7)", fontSize:11, textAlign:"center", marginBottom:28 },
  ccBtn:    { flexDirection:"row", justifyContent:"space-between", alignItems:"center", backgroundColor:"rgba(255,255,255,0.05)", borderWidth:1, borderColor:"rgba(255,255,255,0.1)", borderRadius:12, padding:14, marginBottom:8 },
  ccTxt:    { color:"#fff", fontSize:15 },
  ccDrop:   { backgroundColor:"#0D1117", borderWidth:1, borderColor:"rgba(74,159,255,0.2)", borderRadius:12, marginBottom:8 },
  ccItem:   { padding:14, borderBottomWidth:1, borderBottomColor:"rgba(255,255,255,0.05)" },
  ccActive: { backgroundColor:"rgba(74,159,255,0.1)" },
  inputRow: { flexDirection:"row", alignItems:"center", backgroundColor:"rgba(255,255,255,0.05)", borderWidth:1, borderColor:"rgba(255,255,255,0.1)", borderRadius:12, marginBottom:12, paddingHorizontal:14 },
  prefix:   { color:"rgba(255,255,255,0.4)", fontSize:15, marginRight:8 },
  input:    { flex:1, color:"#fff", fontSize:18, paddingVertical:14, letterSpacing:2 },
  err:      { color:"#EF4444", fontSize:13, marginBottom:8, textAlign:"center" },
  hint:     { color:"rgba(255,255,255,0.3)", fontSize:12, textAlign:"center", marginBottom:28 },
  btn:      { backgroundColor:"#4A9FFF", borderRadius:14, paddingVertical:16, alignItems:"center", marginBottom:16 },
  btnOff:   { opacity:0.4 },
  btnTxt:   { color:"#fff", fontSize:16, fontWeight:"800" },
  legal:    { color:"rgba(255,255,255,0.2)", fontSize:11, textAlign:"center" },
});
