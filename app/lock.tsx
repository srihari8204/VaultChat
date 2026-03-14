import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { recordAuthTime } from "../services/lockService";

type Stage = "scanning" | "code" | "locked";

export default function LockScreen() {
  const [stage, setStage]   = useState<Stage>("scanning");
  const [code, setCode]     = useState("");
  const [fails, setFails]   = useState(0);
  const [error, setError]   = useState("");
  const [time, setTime]     = useState("");
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue:1.06, duration:1000, useNativeDriver:true }),
      Animated.timing(pulse, { toValue:1,    duration:1000, useNativeDriver:true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => { setTimeout(() => handleBiometric(), 400); }, []);

  const handleBiometric = async () => {
    setStage("scanning");
    setError("");
    try {
      const supported = await LocalAuthentication.hasHardwareAsync();
      const enrolled  = await LocalAuthentication.isEnrolledAsync();
      if (!supported || !enrolled) { setStage("code"); return; }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Scan your face to open VaultChat",
        fallbackLabel: "Use Secret Code",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });

      if (result.success) {
        await recordAuthTime();
        router.replace("/chats");
      } else if ((result as any).error === "user_fallback") {
        setStage("code");
      } else {
        handleFail();
      }
    } catch {
      setStage("code");
    }
  };

  const handleCodeVerify = async () => {
    if (code.length !== 8) { setError("Enter your 8-digit secret code"); return; }
    try {
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        code.toUpperCase() + "vc_secret_salt_v1"
      );
      const stored = await SecureStore.getItemAsync("vc_secret_code_hash");
      if (hash === stored) {
        await recordAuthTime();
        router.replace("/chats");
      } else {
        handleFail();
        setCode("");
        setError("Wrong code. Try again.");
      }
    } catch {
      setError("Verification failed. Try again.");
    }
  };

  const handleFail = () => {
    const next = fails + 1;
    setFails(next);
    if (next >= 5) { setStage("locked"); setError("Too many attempts. Locked for 30 minutes."); }
  };

  const today = new Date().toLocaleDateString("en-US", { weekday:"long", day:"numeric", month:"long" });

  return (
    <LinearGradient colors={["#010812","#020E1A","#010812"]} style={S.bg}>
      <View style={S.container}>
        <View style={S.clockWrap}>
          <Text style={S.clock}>{time}</Text>
          <Text style={S.date}>{today}</Text>
        </View>

        {stage === "scanning" && (
          <TouchableOpacity onPress={handleBiometric} activeOpacity={0.8}>
            <Animated.View style={[S.ring, { transform:[{scale:pulse}] }]}>
              <View style={S.ringInner}>
                <Text style={S.faceIcon}>👤</Text>
              </View>
            </Animated.View>
          </TouchableOpacity>
        )}

        <Text style={S.appName}>VaultChat</Text>

        {stage === "scanning" && (
          <View style={S.section}>
            <Text style={S.hint}>Scan face to unlock</Text>
            <TouchableOpacity style={S.fpBtn} onPress={handleBiometric} activeOpacity={0.8}>
              <Text style={S.fpTxt}>🖐️  Use Fingerprint Instead</Text>
            </TouchableOpacity>
            <TouchableOpacity style={S.codeBtn} onPress={() => setStage("code")} activeOpacity={0.8}>
              <Text style={S.codeBtnTxt}>🗝️  Enter Secret Code</Text>
            </TouchableOpacity>
          </View>
        )}

        {stage === "code" && (
          <View style={S.section}>
            <Text style={S.codeLabel}>Enter 8-digit Secret Code</Text>
            <View style={S.codeBoxRow}>
              {Array(8).fill(0).map((_,i) => (
                <View key={i} style={[S.codeBox, i===3&&{marginRight:14}, i<code.length&&S.codeBoxFilled]}>
                  <Text style={S.codeBoxTxt}>{i < code.length ? "•" : ""}</Text>
                </View>
              ))}
            </View>
            <TextInput
              style={S.hiddenInput}
              value={code}
              onChangeText={t => { setCode(t.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8)); setError(""); }}
              autoFocus autoCapitalize="characters" maxLength={8} caretHidden
            />
            {!!error && <Text style={S.error}>{error}</Text>}
            <TouchableOpacity
              style={[S.verifyBtn, code.length < 8 && S.verifyOff]}
              onPress={handleCodeVerify} disabled={code.length < 8} activeOpacity={0.85}>
              <Text style={S.verifyTxt}>Unlock →</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setStage("scanning"); setCode(""); setError(""); }} activeOpacity={0.7}>
              <Text style={S.backTxt}>← Back to Face Scan</Text>
            </TouchableOpacity>
          </View>
        )}

        {stage === "locked" && (
          <View style={S.section}>
            <Text style={{fontSize:60}}>🔒</Text>
            <Text style={[S.appName,{color:"#EF4444"}]}>Account Locked</Text>
            <Text style={S.hint}>{error}</Text>
          </View>
        )}

        {fails > 0 && fails < 5 && stage !== "locked" && (
          <Text style={S.failCount}>{5-fails} attempts remaining before lockout</Text>
        )}
      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  bg:           { flex:1 },
  container:    { flex:1, alignItems:"center", justifyContent:"center", padding:28 },
  clockWrap:    { alignItems:"center", marginBottom:32 },
  clock:        { color:"#FFFFFF", fontSize:64, fontWeight:"100", letterSpacing:2 },
  date:         { color:"rgba(255,255,255,0.35)", fontSize:14, marginTop:4 },
  ring:         { width:160, height:160, borderRadius:80, borderWidth:2, borderColor:"#22C55E", backgroundColor:"rgba(34,197,94,0.08)", justifyContent:"center", alignItems:"center", marginBottom:16 },
  ringInner:    { width:120, height:120, borderRadius:60, borderWidth:1, borderColor:"rgba(34,197,94,0.3)", justifyContent:"center", alignItems:"center" },
  faceIcon:     { fontSize:58 },
  appName:      { color:"#FFFFFF", fontSize:22, fontWeight:"900", letterSpacing:1, marginBottom:8 },
  section:      { alignItems:"center", gap:12, width:"100%" },
  hint:         { color:"rgba(255,255,255,0.4)", fontSize:15, marginBottom:8 },
  fpBtn:        { width:"100%", backgroundColor:"rgba(34,197,94,0.08)", borderWidth:1, borderColor:"rgba(34,197,94,0.25)", borderRadius:14, paddingVertical:16, alignItems:"center" },
  fpTxt:        { color:"#22C55E", fontSize:15, fontWeight:"700" },
  codeBtn:      { width:"100%", backgroundColor:"rgba(255,255,255,0.04)", borderWidth:1, borderColor:"rgba(255,255,255,0.1)", borderRadius:14, paddingVertical:14, alignItems:"center" },
  codeBtnTxt:   { color:"rgba(255,255,255,0.45)", fontSize:14 },
  codeLabel:    { color:"rgba(255,255,255,0.5)", fontSize:14, marginBottom:4 },
  codeBoxRow:   { flexDirection:"row", gap:8, marginBottom:4 },
  codeBox:      { width:34, height:44, borderRadius:8, borderWidth:1.5, borderColor:"rgba(255,255,255,0.15)", backgroundColor:"rgba(255,255,255,0.04)", justifyContent:"center", alignItems:"center" },
  codeBoxFilled:{ borderColor:"#F59E0B", backgroundColor:"rgba(245,158,11,0.1)" },
  codeBoxTxt:   { color:"#F59E0B", fontSize:20, fontWeight:"900" },
  hiddenInput:  { position:"absolute", opacity:0, width:1, height:1 },
  error:        { color:"#EF4444", fontSize:13, textAlign:"center" },
  verifyBtn:    { width:"100%", backgroundColor:"#F59E0B", borderRadius:14, paddingVertical:16, alignItems:"center" },
  verifyOff:    { opacity:0.4 },
  verifyTxt:    { color:"#010812", fontSize:16, fontWeight:"900" },
  backTxt:      { color:"rgba(255,255,255,0.3)", fontSize:13, marginTop:4 },
  failCount:    { position:"absolute", bottom:40, color:"rgba(239,68,68,0.6)", fontSize:12 },
});
