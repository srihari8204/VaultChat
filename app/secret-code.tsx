import { LinearGradient } from "expo-linear-gradient";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { SERVER_URL } from "../constants/server";
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  return Array.from({ length:8 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
}

export default function SecretCodeScreen() {
  const [code]                    = useState(generateCode);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState("");
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue:1.04, duration:1000, useNativeDriver:true }),
      Animated.timing(pulse, { toValue:1,    duration:1000, useNativeDriver:true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const handleSaved = async () => {
    setSaving(true);
    setError("");
    try {
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        code + "vc_secret_salt_v1"
      );
      await SecureStore.setItemAsync("vc_secret_code_hash", hash);
      const { getCurrentUser } = await import("./(constants)/authService");
      const user = getCurrentUser();
      if (user) {
        await fetch(`${SERVER_URL}/api/secretcode/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: user.uid, phone: user.phoneNumber || "", codeHash: hash }),
        });
      }
      setConfirmed(true);
      setTimeout(() => router.push("/biometric-setup"), 900);
    } catch {
      setError("Failed to save. Check your connection.");
      setSaving(false);
    }
  };

  return (
    <LinearGradient colors={["#FFFFFF","#020E1A","#FFFFFF"]} style={S.bg}>
      <View style={S.container}>
        <View style={S.header}>
          <Animated.View style={[S.badge, { transform:[{scale:pulse}] }]}>
            <Text style={{fontSize:40}}>🗝️</Text>
          </Animated.View>
          <Text style={S.title}>Your Secret Code</Text>
          <Text style={S.sub}>{"Tied to your phone number.\nRequired when you switch devices."}</Text>
        </View>

        <View style={S.stepRow}>
          {[1,2,3,4,5,6,7,8].map(n => (
            <View key={n} style={[S.step, n<=5&&S.stepDone, n===6&&S.stepActive]}/>
          ))}
        </View>
        <Text style={S.stepLabel}>Step 6 of 8 — Secret Code</Text>

        <View style={S.codeCard}>
          <View style={S.codeRow}>
            {code.split("").map((ch, i) => (
              <View key={i} style={[S.charBox, i===3&&{marginRight:18}]}>
                <Text style={S.charTxt}>{ch}</Text>
              </View>
            ))}
          </View>
          <Text style={S.codeSub}>Write this down — shown only once</Text>
        </View>

        <View style={S.warnBox}>
          <Text style={S.warnTitle}>⚠️  Important</Text>
          <Text style={S.warnItem}>• Tied to your phone number — not your device</Text>
          <Text style={S.warnItem}>• Required when switching to a new phone</Text>
          <Text style={S.warnItem}>• Never stored as plain text — only hashed</Text>
          <Text style={S.warnItem}>• Cannot be recovered if lost</Text>
        </View>

        {!!error && <Text style={S.error}>{error}</Text>}

        {!confirmed ? (
          <TouchableOpacity style={S.btn} onPress={handleSaved} disabled={saving} activeOpacity={0.85}>
            <Text style={S.btnTxt}>{saving ? "Saving securely..." : "I've Saved My Code ✓"}</Text>
          </TouchableOpacity>
        ) : (
          <View style={[S.btn,{backgroundColor:"#22C55E"}]}>
            <Text style={S.btnTxt}>✓ Saved — Continuing...</Text>
          </View>
        )}
        <Text style={S.tip}>💡 Screenshot this or write it somewhere safe</Text>
      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  bg:         { flex:1 },
  container:  { flex:1, padding:24, paddingTop:60 },
  header:     { alignItems:"center", marginBottom:16, gap:8 },
  badge:      { width:90,height:90,borderRadius:45,backgroundColor:"rgba(245,158,11,0.1)",borderWidth:1.5,borderColor:"rgba(245,158,11,0.3)",justifyContent:"center",alignItems:"center" },
  title:      { color:"#fff", fontSize:24, fontWeight:"900" },
  sub:        { color:"rgba(255,255,255,0.4)", fontSize:13, textAlign:"center", lineHeight:20 },
  stepRow:    { flexDirection:"row", gap:6, justifyContent:"center", marginBottom:6 },
  step:       { width:24, height:4, borderRadius:2, backgroundColor:"rgba(255,255,255,0.1)" },
  stepActive: { backgroundColor:"#F59E0B", width:32 },
  stepDone:   { backgroundColor:"#22C55E" },
  stepLabel:  { color:"rgba(255,255,255,0.3)", fontSize:12, textAlign:"center", marginBottom:20 },
  codeCard:   { backgroundColor:"rgba(245,158,11,0.06)", borderWidth:1.5, borderColor:"rgba(245,158,11,0.3)", borderRadius:16, padding:20, alignItems:"center", marginBottom:16 },
  codeRow:    { flexDirection:"row", gap:8, marginBottom:12 },
  charBox:    { width:36, height:48, borderRadius:8, backgroundColor:"rgba(245,158,11,0.12)", borderWidth:1, borderColor:"rgba(245,158,11,0.4)", justifyContent:"center", alignItems:"center" },
  charTxt:    { color:"#F59E0B", fontSize:22, fontWeight:"900" },
  codeSub:    { color:"rgba(245,158,11,0.55)", fontSize:12 },
  warnBox:    { backgroundColor:"rgba(239,68,68,0.06)", borderWidth:1, borderColor:"rgba(239,68,68,0.2)", borderRadius:12, padding:16, marginBottom:20, gap:6 },
  warnTitle:  { color:"#EF4444", fontSize:14, fontWeight:"800", marginBottom:4 },
  warnItem:   { color:"rgba(255,255,255,0.5)", fontSize:13 },
  error:      { color:"#EF4444", fontSize:13, textAlign:"center", marginBottom:8 },
  btn:        { backgroundColor:"#F59E0B", borderRadius:14, paddingVertical:17, alignItems:"center", marginBottom:12 },
  btnTxt:     { color:"#FFFFFF", fontSize:16, fontWeight:"900" },
  tip:        { color:"rgba(255,255,255,0.22)", fontSize:12, textAlign:"center" },
});
