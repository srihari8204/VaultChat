import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  Alert, StyleSheet, Text, TextInput,
  TouchableOpacity, View, Vibration,
} from "react-native";
import { verifyPIN } from "./(constants)/authService";

export default function PINEntryScreen() {
  const router = useRouter();
  const [pin,     setPin]     = useState("");
  const [attempts,setAttempts]= useState(0);
  const [shake,   setShake]   = useState(false);
  const inputRef = useRef<TextInput>(null);

  const MAX_ATTEMPTS = 5;

  const handleChange = (t: string) => {
    const digits = t.replace(/\D/g, "").slice(0, 8);
    setPin(digits);
    if (digits.length === 8) handleVerify(digits);
  };

  const handleVerify = async (code: string) => {
    const ok = await verifyPIN(code);
    if (ok) {
      router.replace({ pathname: "/facescan", params: { mode: "verify" } });
    } else {
      const newAttempts = attempts + 1;
      setAttempts(newAttempts);
      Vibration.vibrate(300);
      setPin("");
      if (newAttempts >= MAX_ATTEMPTS) {
        Alert.alert(
          "Account Locked",
          "Too many wrong attempts. Please try again later.",
          [{ text: "OK", onPress: () => router.replace("/login") }]
        );
      } else {
        Alert.alert("Wrong PIN", (MAX_ATTEMPTS - newAttempts) + " attempt(s) remaining.");
      }
    }
  };

  const digits = pin.split("");
  const boxRows = [[0,1,2,3], [4,5,6,7]];

  return (
    <LinearGradient colors={["#010812", "#071020", "#020B18"]} style={{ flex: 1 }}>
      <View style={S.container}>

        {/* Icon */}
        <View style={S.iconWrap}>
          <LinearGradient colors={["#7C3AED", "#1D4ED8"]} style={S.iconCircle}>
            <Text style={{ fontSize: 38 }}>🔑</Text>
          </LinearGradient>
        </View>

        <Text style={S.title}>Enter Secret PIN</Text>
        <Text style={S.sub}>
          {attempts > 0
            ? "⚠️  Wrong PIN — " + (MAX_ATTEMPTS - attempts) + " attempt(s) left"
            : "8-digit PIN set during account creation"}
        </Text>

        {/* PIN display boxes */}
        <TouchableOpacity onPress={() => inputRef.current?.focus()} activeOpacity={1}>
          {boxRows.map((row, ri) => (
            <View key={ri} style={S.row}>
              {row.map(i => (
                <View key={i} style={[S.box, digits[i] ? S.boxFilled : null, attempts > 0 && pin === "" && S.boxError]}>
                  <View style={[S.pinDot, digits[i] ? S.pinDotFilled : null]} />
                </View>
              ))}
            </View>
          ))}
        </TouchableOpacity>

        <TextInput
          ref={inputRef}
          value={pin}
          onChangeText={handleChange}
          keyboardType="number-pad"
          maxLength={8}
          style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
          autoFocus
          caretHidden
        />

        <Text style={S.hint}>
          {pin.length}/8 digits entered
        </Text>

        <View style={S.infoBox}>
          <Text style={S.infoTxt}>
            📝  This is the same 8-digit PIN you set when creating your VaultChat account.
            It is also used to access Vault documents.
          </Text>
        </View>

        <TouchableOpacity style={S.forgotBtn} onPress={() => router.replace("/login")}>
          <Text style={S.forgotTxt}>Use a different account</Text>
        </TouchableOpacity>

      </View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:   { flex: 1, padding: 32, paddingTop: 80, alignItems: "center" },
  iconWrap:    { marginBottom: 24 },
  iconCircle:  { width: 90, height: 90, borderRadius: 45, justifyContent: "center", alignItems: "center" },
  title:       { color: "#fff", fontSize: 26, fontWeight: "900", marginBottom: 8 },
  sub:         { color: "rgba(255,255,255,0.45)", fontSize: 14, marginBottom: 36, textAlign: "center" },
  row:         { flexDirection: "row", gap: 12, marginBottom: 12 },
  box:         { width: 58, height: 64, borderRadius: 14, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.15)", backgroundColor: "rgba(255,255,255,0.05)", justifyContent: "center", alignItems: "center" },
  boxFilled:   { borderColor: "#7C3AED", backgroundColor: "rgba(124,58,237,0.15)" },
  boxError:    { borderColor: "#EF4444", backgroundColor: "rgba(239,68,68,0.08)" },
  pinDot:      { width: 12, height: 12, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.1)" },
  pinDotFilled:{ backgroundColor: "#7C3AED" },
  hint:        { color: "rgba(255,255,255,0.3)", fontSize: 12, marginTop: 8, marginBottom: 28 },
  infoBox:     { backgroundColor: "rgba(124,58,237,0.08)", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "rgba(124,58,237,0.2)", width: "100%", marginBottom: 20 },
  infoTxt:     { color: "rgba(255,255,255,0.5)", fontSize: 12, lineHeight: 18, textAlign: "center" },
  forgotBtn:   { padding: 12 },
  forgotTxt:   { color: "#4A9FFF", fontSize: 14, fontWeight: "700" },
});
