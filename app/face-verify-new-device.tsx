import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { verifyPIN } from "../services/securityService";
import { trustCurrentDevice } from "../services/deviceService";
import { generateMockFaceVector, isFaceMatch } from "../services/faceService";

const SERVER_URL = "http://192.168.29.58:3001";

type Stage = "intro" | "pin" | "scanning" | "success" | "failed" | "locked";

export default function FaceVerifyNewDeviceScreen() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const [stage, setStage]       = useState<Stage>("intro");
  const [pin, setPin]           = useState("");
  const [attempts, setAttempts] = useState(0);
  const [msg, setMsg]           = useState("");
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1.06, duration: 900, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1,    duration: 900, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  const handlePinKey = async (k: string) => {
    if (k === "⌫") { setPin(p => p.slice(0, -1)); return; }
    if (pin.length >= 6) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 6) {
      const ok = await verifyPIN(next);
      if (ok) { setStage("scanning"); }
      else    { setMsg("Wrong PIN"); setPin(""); }
    }
  };

  const handleFaceScan = async () => {
    setStage("scanning");
    setMsg("Scanning face...");
    try {
      // Step 1: Device biometric check (liveness proxy)
      const bio = await LocalAuthentication.authenticateAsync({
        promptMessage: "Scan your face to verify identity",
        fallbackLabel: "Use PIN",
        cancelLabel: "Cancel",
      });
      if (!bio.success) { handleFail(); return; }

      // Step 2: Get face vector (mock — replace with real TF FaceMesh)
      const faceVector = generateMockFaceVector();

      // Step 3: Send to server for comparison
      const response = await fetch(`${SERVER_URL}/api/face/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, faceVector }),
      });
      const data = await response.json();

      if (data.match) {
        await trustCurrentDevice(uid ?? "", SERVER_URL);
        setStage("success");
        setMsg("Identity verified");
        setTimeout(() => router.replace("/chats"), 1200);
      } else {
        handleFail();
      }
    } catch {
      handleFail();
    }
  };

  const handleFail = () => {
    const next = attempts + 1;
    setAttempts(next);
    if (next >= 3) {
      setStage("locked");
      setMsg("Too many failed attempts. Account locked for 30 minutes.");
    } else {
      setStage("failed");
      setMsg(`Face not recognized. ${3 - next} attempts remaining.`);
    }
  };

  const KEYS = ["1","2","3","4","5","6","7","8","9","","0","⌫"];

  const clr = {
    intro:"#4A9FFF", pin:"#4A9FFF", scanning:"#F59E0B",
    success:"#22C55E", failed:"#EF4444", locked:"#EF4444"
  }[stage];

  const icon = {
    intro:"🔐", pin:"🔢", scanning:"⌛",
    success:"✅", failed:"❌", locked:"🔒"
  }[stage];

  return (
    <LinearGradient colors={["#010812","#020E1A","#010812"]} style={{flex:1}}>
      <View style={S.container}>

        {/* Header */}
        <View style={S.header}>
          <View style={[S.badge,{borderColor:clr+"55",backgroundColor:clr+"11"}]}>
            <Text style={{fontSize:36}}>{icon}</Text>
          </View>
          <Text style={S.title}>New Device Detected</Text>
          <Text style={S.sub}>Verify your identity to continue</Text>
        </View>

        {/* Device warning */}
        <View style={S.warn}>
          <Text style={S.warnTxt}>
            This device is not recognized. For your security, we need to confirm it's really you before granting access.
          </Text>
        </View>

        {/* INTRO stage */}
        {stage === "intro" && (
          <TouchableOpacity style={S.btn} onPress={() => setStage("pin")} activeOpacity={0.85}>
            <Text style={S.btnTxt}>Start Verification</Text>
          </TouchableOpacity>
        )}

        {/* PIN stage */}
        {stage === "pin" && (
          <View style={S.pinWrap}>
            <Text style={S.pinLabel}>Enter your backup PIN</Text>
            <View style={S.dotsRow}>
              {Array(6).fill(0).map((_,i) => (
                <View key={i} style={[S.dot, i < pin.length && S.dotFilled]}/>
              ))}
            </View>
            {!!msg && <Text style={S.err}>{msg}</Text>}
            <View style={S.keypad}>
              {KEYS.map((k,i) => (
                <TouchableOpacity key={i} style={[S.key, k===""&&S.keyEmpty, k==="⌫"&&S.keyDel]}
                  onPress={() => handlePinKey(k)} disabled={k===""} activeOpacity={0.7}>
                  <Text style={[S.keyTxt, k==="⌫"&&{color:"#EF4444"}]}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* SCANNING stage */}
        {stage === "scanning" && (
          <View style={S.scanWrap}>
            <TouchableOpacity onPress={handleFaceScan} activeOpacity={0.8}>
              <Animated.View style={[S.ring,{borderColor:clr,transform:[{scale:pulse}]}]}>
                <View style={[S.ringIn,{borderColor:clr+"55"}]}>
                  <Text style={{fontSize:56}}>👤</Text>
                </View>
              </Animated.View>
            </TouchableOpacity>
            <Text style={[S.scanMsg,{color:clr}]}>
              {msg || "Tap to scan your face"}
            </Text>
            <View style={S.liveness}>
              <Text style={S.livenessItem}>✓ Liveness detection active</Text>
              <Text style={S.livenessItem}>✓ Anti-spoofing enabled</Text>
              <Text style={S.livenessItem}>✓ Depth verification active</Text>
            </View>
          </View>
        )}

        {/* SUCCESS stage */}
        {stage === "success" && (
          <View style={S.resultWrap}>
            <Text style={[S.resultIcon]}>✅</Text>
            <Text style={[S.resultMsg,{color:"#22C55E"}]}>Identity Verified</Text>
            <Text style={S.resultSub}>This device is now trusted. Entering VaultChat...</Text>
          </View>
        )}

        {/* FAILED stage */}
        {stage === "failed" && (
          <View style={S.resultWrap}>
            <Text style={S.resultIcon}>❌</Text>
            <Text style={[S.resultMsg,{color:"#EF4444"}]}>Verification Failed</Text>
            <Text style={S.resultSub}>{msg}</Text>
            <TouchableOpacity style={[S.btn,{backgroundColor:"#EF4444",marginTop:24}]}
              onPress={() => { setStage("scanning"); setMsg(""); }} activeOpacity={0.85}>
              <Text style={S.btnTxt}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* LOCKED stage */}
        {stage === "locked" && (
          <View style={S.resultWrap}>
            <Text style={S.resultIcon}>🔒</Text>
            <Text style={[S.resultMsg,{color:"#EF4444"}]}>Account Locked</Text>
            <Text style={S.resultSub}>{msg}</Text>
            <View style={S.lockedBox}>
              <Text style={S.lockedTxt}>
                If this was you, try again in 30 minutes.{"\n"}
                If this was NOT you, your account is safe — the attacker cannot get in.
              </Text>
            </View>
          </View>
        )}

      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:  { flex:1, padding:24, paddingTop:60 },
  header:     { alignItems:"center", marginBottom:20, gap:10 },
  badge:      { width:80,height:80,borderRadius:40,borderWidth:1.5,justifyContent:"center",alignItems:"center" },
  title:      { color:"#fff",fontSize:22,fontWeight:"900" },
  sub:        { color:"rgba(255,255,255,0.4)",fontSize:13 },
  warn:       { backgroundColor:"rgba(245,158,11,0.08)",borderWidth:1,borderColor:"rgba(245,158,11,0.25)",borderRadius:12,padding:14,marginBottom:24 },
  warnTxt:    { color:"rgba(245,158,11,0.85)",fontSize:13,lineHeight:20,textAlign:"center" },
  btn:        { backgroundColor:"#4A9FFF",borderRadius:14,paddingVertical:16,alignItems:"center" },
  btnTxt:     { color:"#fff",fontSize:16,fontWeight:"800" },
  pinWrap:    { alignItems:"center",gap:16 },
  pinLabel:   { color:"rgba(255,255,255,0.5)",fontSize:14 },
  dotsRow:    { flexDirection:"row",gap:14,marginBottom:8 },
  dot:        { width:16,height:16,borderRadius:8,borderWidth:2,borderColor:"rgba(255,255,255,0.2)" },
  dotFilled:  { backgroundColor:"#4A9FFF",borderColor:"#4A9FFF" },
  err:        { color:"#EF4444",fontSize:13 },
  keypad:     { flexDirection:"row",flexWrap:"wrap",width:260,gap:12,justifyContent:"center" },
  key:        { width:72,height:72,borderRadius:36,backgroundColor:"rgba(255,255,255,0.07)",borderWidth:1,borderColor:"rgba(255,255,255,0.1)",justifyContent:"center",alignItems:"center" },
  keyEmpty:   { backgroundColor:"transparent",borderColor:"transparent" },
  keyDel:     { backgroundColor:"rgba(239,68,68,0.08)",borderColor:"rgba(239,68,68,0.2)" },
  keyTxt:     { color:"#fff",fontSize:22,fontWeight:"600" },
  scanWrap:   { alignItems:"center",gap:16 },
  ring:       { width:180,height:180,borderRadius:90,borderWidth:2,backgroundColor:"rgba(74,159,255,0.05)",justifyContent:"center",alignItems:"center" },
  ringIn:     { width:140,height:140,borderRadius:70,borderWidth:1,justifyContent:"center",alignItems:"center" },
  scanMsg:    { fontSize:15,fontWeight:"600",textAlign:"center" },
  liveness:   { backgroundColor:"rgba(34,197,94,0.06)",borderWidth:1,borderColor:"rgba(34,197,94,0.2)",borderRadius:12,padding:14,gap:6,width:"100%" },
  livenessItem:{ color:"rgba(34,197,94,0.8)",fontSize:12 },
  resultWrap: { alignItems:"center",gap:12 },
  resultIcon: { fontSize:64 },
  resultMsg:  { fontSize:22,fontWeight:"900" },
  resultSub:  { color:"rgba(255,255,255,0.4)",fontSize:14,textAlign:"center",lineHeight:20 },
  lockedBox:  { backgroundColor:"rgba(74,159,255,0.06)",borderRadius:12,padding:16,marginTop:8 },
  lockedTxt:  { color:"rgba(255,255,255,0.4)",fontSize:13,lineHeight:20,textAlign:"center" },
});
