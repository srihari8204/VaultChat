import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator, Alert, KeyboardAvoidingView,
  Platform, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from "react-native";
import { sendOTP } from "./(constants)/authService";

const CODES = [
  { code: "+91",  name: "India",     flag: "🇮🇳" },
  { code: "+1",   name: "USA",       flag: "🇺🇸" },
  { code: "+44",  name: "UK",        flag: "🇬🇧" },
  { code: "+61",  name: "Australia", flag: "🇦🇺" },
  { code: "+971", name: "UAE",       flag: "🇦🇪" },
  { code: "+65",  name: "Singapore", flag: "🇸🇬" },
];

export default function LoginScreen() {
  const router = useRouter();
  const [cc,      setCc]      = useState("+91");
  const [phone,   setPhone]   = useState("");
  const [loading, setLoading] = useState(false);
  const [showCC,  setShowCC]  = useState(false);

  const selected = CODES.find(c => c.code === cc) ?? CODES[0];

  const handleSend = async () => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8) {
      Alert.alert("Error", "Enter a valid mobile number.");
      return;
    }
    setLoading(true);
    try {
      const fullPhone = cc + digits;
      await sendOTP(fullPhone);
      router.push({ pathname: "/otp", params: { phone: fullPhone, flow: "login" } });
    } catch (e: any) {
      Alert.alert("Error", e.message ?? "Failed to send OTP. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient colors={["#010812", "#020B18", "#071020"]} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">

          <View style={S.logoWrap}>
            <LinearGradient colors={["#1D4ED8", "#7C3AED"]} style={S.logoCircle}>
              <Text style={{ fontSize: 32 }}>🔐</Text>
            </LinearGradient>
            <Text style={S.logoText}>VaultChat</Text>
            <Text style={S.logoSub}>Secure. Private. Encrypted.</Text>
          </View>

          <View style={S.card}>
            <Text style={S.title}>Welcome Back</Text>
            <Text style={S.sub}>Enter your mobile number to sign in</Text>

            <Text style={S.label}>MOBILE NUMBER</Text>
            <View style={S.phoneRow}>
              <TouchableOpacity style={S.ccBtn} onPress={() => setShowCC(v => !v)}>
                <Text style={{ fontSize: 20 }}>{selected.flag}</Text>
                <Text style={S.ccCode}>{cc}</Text>
                <Text style={S.ccArrow}>{showCC ? "▲" : "▼"}</Text>
              </TouchableOpacity>
              <TextInput
                style={S.phoneInput}
                placeholder="Mobile number"
                placeholderTextColor="rgba(255,255,255,0.25)"
                value={phone}
                onChangeText={t => setPhone(t.replace(/\D/g, "").slice(0, 13))}
                keyboardType="phone-pad"
                maxLength={13}
              />
            </View>

            {showCC && (
              <View style={S.dropdown}>
                {CODES.map(c => (
                  <TouchableOpacity key={c.code} style={S.ddItem}
                    onPress={() => { setCc(c.code); setShowCC(false); }}>
                    <Text style={{ fontSize: 20 }}>{c.flag}</Text>
                    <Text style={S.ddName}>{c.name}</Text>
                    <Text style={S.ddCode}>{c.code}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={S.infoBox}>
              <Text style={S.infoTxt}>
                🔒  OTP will be sent to verify your identity
              </Text>
            </View>

            <TouchableOpacity style={S.btnWrap} onPress={handleSend} disabled={loading}>
              <LinearGradient colors={["#1D4ED8", "#7C3AED"]} style={S.btn}>
                {loading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={S.btnTxt}>Send OTP  →</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={{ alignItems: "center", marginTop: 20 }}
            onPress={() => router.replace("/signup")}>
            <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>
              New to VaultChat?{"  "}
              <Text style={{ color: "#4A9FFF", fontWeight: "900" }}>Create Account</Text>
            </Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  scroll:     { flexGrow: 1, padding: 24, paddingTop: 60 },
  logoWrap:   { alignItems: "center", marginBottom: 28 },
  logoCircle: { width: 72, height: 72, borderRadius: 36, justifyContent: "center", alignItems: "center", marginBottom: 12 },
  logoText:   { color: "#fff", fontSize: 28, fontWeight: "900", letterSpacing: 1 },
  logoSub:    { color: "rgba(255,255,255,0.35)", fontSize: 13, marginTop: 4 },
  card:       { backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 24, padding: 22, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", marginBottom: 16 },
  title:      { color: "#fff", fontSize: 22, fontWeight: "900", marginBottom: 4 },
  sub:        { color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 20 },
  label:      { color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 8 },
  phoneRow:   { flexDirection: "row", gap: 10, marginBottom: 14 },
  ccBtn:      { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 12, paddingVertical: 14 },
  ccCode:     { color: "#fff", fontWeight: "800", fontSize: 13 },
  ccArrow:    { color: "rgba(255,255,255,0.4)", fontSize: 8 },
  phoneInput: { flex: 1, color: "#fff", fontSize: 15, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14, paddingVertical: 14 },
  dropdown:   { backgroundColor: "#0D1F35", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", marginBottom: 12 },
  ddItem:     { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)" },
  ddName:     { flex: 1, color: "#fff", fontSize: 14 },
  ddCode:     { color: "#4A9FFF", fontWeight: "800", fontSize: 14 },
  infoBox:    { backgroundColor: "rgba(74,159,255,0.08)", borderRadius: 10, padding: 12, marginBottom: 20, borderWidth: 1, borderColor: "rgba(74,159,255,0.2)" },
  infoTxt:    { color: "rgba(255,255,255,0.5)", fontSize: 12 },
  btnWrap:    { borderRadius: 14, overflow: "hidden" },
  btn:        { paddingVertical: 16, alignItems: "center", borderRadius: 14 },
  btnTxt:     { color: "#fff", fontSize: 16, fontWeight: "900" },
});
