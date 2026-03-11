import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { sendOTP, verifyOTP, getCurrentUser } from "./(constants)/authService";
import { isSetupComplete } from "../services/securityService";
import { isKnownDevice } from "../services/deviceService";

const SERVER_URL = "http://192.168.29.58:3001";

export default function OTPScreen() {
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [otp,setOtp]             = useState(["","","","","",""]);
  const [loading,setLoading]     = useState(false);
  const [error,setError]         = useState("");
  const [timer,setTimer]         = useState(60);
  const [canResend,setCanResend] = useState(false);
  const inputs = useRef<(TextInput|null)[]>([]);

  useEffect(() => {
    const t = setInterval(() => setTimer(p => { if(p<=1){clearInterval(t);setCanResend(true);return 0;} return p-1; }), 1000);
    return () => clearInterval(t);
  }, []);

  const handleChange = (val: string, idx: number) => {
    const digit = val.replace(/\D/g,"").slice(-1);
    const next = [...otp]; next[idx] = digit; setOtp(next); setError("");
    if (digit && idx < 5) inputs.current[idx+1]?.focus();
    if (!digit && idx > 0) inputs.current[idx-1]?.focus();
  };

  const handleVerify = async () => {
    const code = otp.join("");
    if (code.length < 6) { setError("Enter all 6 digits"); return; }
    setError(""); setLoading(true);
    try {
      await verifyOTP(code);
      const done = await isSetupComplete();
      if (!done) { router.replace("/vault-id"); return; }
      const user = getCurrentUser();
      const uid = user?.uid ?? "";
      const known = await isKnownDevice(uid, SERVER_URL);
      if (known) {
        router.replace("/chats");
      } else {
        router.replace({ pathname: "/face-verify-new-device", params: { uid } });
      }
    } catch {
      setError("Invalid OTP. Please try again.");
      setOtp(["","","","","",""]); inputs.current[0]?.focus();
    } finally { setLoading(false); }
  };

  const handleResend = async () => {
    if (!canResend||!phone) return;
    setCanResend(false); setTimer(60); setOtp(["","","","","",""]); setError("");
    try {
      await sendOTP(phone);
      const t = setInterval(() => setTimer(p => { if(p<=1){clearInterval(t);setCanResend(true);return 0;} return p-1; }), 1000);
    } catch { setError("Failed to resend"); setCanResend(true); }
  };

  return (
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==="ios"?"padding":undefined}>
      <LinearGradient colors={["#010812","#020E1A","#010812"]} style={StyleSheet.absoluteFillObject}/>
      <View style={S.container}>
        <TouchableOpacity style={S.back} onPress={()=>router.back()}><Text style={S.backTxt}>Back</Text></TouchableOpacity>
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>📱</Text></View>
          <Text style={S.title}>Verify OTP</Text>
          <Text style={S.sub}>6-digit code sent to</Text>
          <Text style={S.phone}>{phone}</Text>
        </View>
        <View style={S.steps}>{[1,2,3,4,5,6,7,8].map(n=><View key={n} style={[S.dot,n<=1&&S.dotDone,n===2&&S.dotActive]}/>)}</View>
        <View style={S.otpRow}>
          {otp.map((digit,i)=>(
            <TextInput key={i} ref={r=>{inputs.current[i]=r;}} style={[S.box,digit&&S.boxFilled]} value={digit} onChangeText={v=>handleChange(v,i)} keyboardType="number-pad" maxLength={2} selectTextOnFocus autoFocus={i===0}/>
          ))}
        </View>
        {!!error&&<Text style={S.err}>{error}</Text>}
        <View style={S.timerRow}>
          {canResend
            ? <TouchableOpacity onPress={handleResend}><Text style={S.resend}>Resend OTP</Text></TouchableOpacity>
            : <Text style={S.timer}>Resend in <Text style={{color:"#4A9FFF"}}>{timer}s</Text></Text>
          }
        </View>
        <TouchableOpacity style={[S.btn,(!otp.every(d=>d!="")||loading)&&S.btnOff]} onPress={handleVerify} disabled={!otp.every(d=>d!="")||loading} activeOpacity={0.85}>
          {loading?<ActivityIndicator color="#fff"/>:<Text style={S.btnTxt}>Verify and Continue</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const S = StyleSheet.create({
  container:{ flex:1,padding:24,paddingTop:60 },
  back:     { marginBottom:24 },
  backTxt:  { color:"#4A9FFF",fontSize:15,fontWeight:"600" },
  header:   { alignItems:"center",marginBottom:28,gap:8 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center",marginBottom:4 },
  title:    { color:"#fff",fontSize:26,fontWeight:"900" },
  sub:      { color:"rgba(255,255,255,0.45)",fontSize:14 },
  phone:    { color:"#4A9FFF",fontSize:16,fontWeight:"700",letterSpacing:1 },
  steps:    { flexDirection:"row",gap:6,justifyContent:"center",marginBottom:32 },
  dot:      { width:24,height:4,borderRadius:2,backgroundColor:"rgba(255,255,255,0.12)" },
  dotActive:{ backgroundColor:"#4A9FFF",width:32 },
  dotDone:  { backgroundColor:"#22C55E" },
  otpRow:   { flexDirection:"row",justifyContent:"center",gap:10,marginBottom:16 },
  box:      { width:48,height:58,borderRadius:12,borderWidth:1.5,borderColor:"rgba(255,255,255,0.15)",backgroundColor:"rgba(255,255,255,0.05)",color:"#fff",fontSize:24,fontWeight:"900",textAlign:"center" },
  boxFilled:{ borderColor:"#4A9FFF",backgroundColor:"rgba(74,159,255,0.1)" },
  err:      { color:"#EF4444",fontSize:13,textAlign:"center",marginBottom:8 },
  timerRow: { alignItems:"center",marginBottom:28 },
  timer:    { color:"rgba(255,255,255,0.4)",fontSize:14 },
  resend:   { color:"#4A9FFF",fontSize:14,fontWeight:"700" },
  btn:      { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center" },
  btnOff:   { opacity:0.4 },
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
});
