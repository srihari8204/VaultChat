import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import {
  savePendingSignup, savePIN, sendOTP,
} from "./(constants)/authService";

const QUESTIONS = [
  "What was your first pet's name?",
  "What is your mother's maiden name?",
  "What was the name of your first school?",
  "What was your childhood nickname?",
  "What city were you born in?",
  "What is your oldest sibling's name?",
  "What was the make of your first car?",
  "What is your favourite movie?",
];

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const CODES = [
  { code: "+91",  flag: "🇮🇳", name: "India" },
  { code: "+1",   flag: "🇺🇸", name: "USA" },
  { code: "+44",  flag: "🇬🇧", name: "UK" },
  { code: "+61",  flag: "🇦🇺", name: "AU" },
  { code: "+971", flag: "🇦🇪", name: "UAE" },
];

// ── Step Bar ──────────────────────────────────────────────────────────────────
function StepBar({ step }: { step: number }) {
  const labels = ["Account", "Security", "PIN"];
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", marginBottom: 24, gap: 0 }}>
      {[1, 2, 3].map(n => (
        <View key={n} style={{ alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {n > 1 && (
              <View style={{
                width: 48, height: 2,
                backgroundColor: step > n - 1 ? "#4A9FFF" : "rgba(255,255,255,0.1)",
              }} />
            )}
            <LinearGradient
              colors={step >= n ? ["#1D4ED8", "#7C3AED"] : ["transparent", "transparent"]}
              style={{
                width: 32, height: 32, borderRadius: 16,
                justifyContent: "center", alignItems: "center",
                borderWidth: step >= n ? 0 : 1.5,
                borderColor: "rgba(255,255,255,0.2)",
              }}>
              <Text style={{ color: step >= n ? "#fff" : "rgba(255,255,255,0.3)", fontSize: 13, fontWeight: "900" }}>
                {n}
              </Text>
            </LinearGradient>
            {n < 3 && (
              <View style={{
                width: 48, height: 2,
                backgroundColor: step > n ? "#4A9FFF" : "rgba(255,255,255,0.1)",
              }} />
            )}
          </View>
          <Text style={{ color: step >= n ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: "700", marginTop: 5 }}>
            {labels[n - 1]}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Question Picker ───────────────────────────────────────────────────────────
function QPicker({ selected, onSelect, exclude }: {
  selected: string; onSelect: (q: string) => void; exclude: string;
}) {
  const [open, setOpen] = useState(false);
  const opts = QUESTIONS.filter(q => q !== exclude);
  return (
    <View style={{ marginBottom: 8 }}>
      <TouchableOpacity style={S.pickerBtn} onPress={() => setOpen(v => !v)}>
        <Text style={S.pickerTxt} numberOfLines={1}>
          {selected || "Select a security question"}
        </Text>
        <Text style={S.pickerArrow}>{open ? "▲" : "▼"}</Text>
      </TouchableOpacity>
      {open && (
        <View style={S.pickerDrop}>
          {opts.map(q => (
            <TouchableOpacity key={q} style={S.pickerItem}
              onPress={() => { onSelect(q); setOpen(false); }}>
              <Text style={[S.pickerItemTxt, selected === q && { color: "#4A9FFF" }]}>{q}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ── PIN Boxes ─────────────────────────────────────────────────────────────────
function PINBoxes({ value, onChangeText, label }: {
  value: string; onChangeText: (t: string) => void; label: string;
}) {
  const inputRef = useRef<TextInput>(null);
  const digits = value.split("");
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={S.label}>{label}</Text>
      <TouchableOpacity onPress={() => inputRef.current?.focus()} activeOpacity={1}>
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "center", marginBottom: 8 }}>
          {[0,1,2,3].map(i => (
            <View key={i} style={[S.pinBox, digits[i] ? S.pinBoxFilled : null]}>
              <View style={[S.pinDot, digits[i] ? S.pinDotFilled : null]} />
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
          {[4,5,6,7].map(i => (
            <View key={i} style={[S.pinBox, digits[i] ? S.pinBoxFilled : null]}>
              <View style={[S.pinDot, digits[i] ? S.pinDotFilled : null]} />
            </View>
          ))}
        </View>
      </TouchableOpacity>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={t => onChangeText(t.replace(/\D/g, "").slice(0, 8))}
        keyboardType="number-pad"
        maxLength={8}
        style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
        caretHidden
      />
    </View>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SignupScreen() {
  const router = useRouter();
  const [step, setStep]     = useState(1);
  const [loading, setLoading] = useState(false);

  // Step 1
  const [name,  setName]  = useState("");
  const [day,   setDay]   = useState("");
  const [month, setMonth] = useState("");
  const [year,  setYear]  = useState("");
  const [email, setEmail] = useState("");
  const [cc,    setCc]    = useState("+91");
  const [mobile, setMobile] = useState("");
  const [showCC, setShowCC] = useState(false);
  const [showMonth, setShowMonth] = useState(false);

  // Step 2
  const [q1, setQ1] = useState("");
  const [a1, setA1] = useState("");
  const [q2, setQ2] = useState("");
  const [a2, setA2] = useState("");

  // Step 3
  const [pin,     setPin]     = useState("");
  const [confirm, setConfirm] = useState("");

  const selected = CODES.find(c => c.code === cc) ?? CODES[0];
  const dob = day && month && year ? day.padStart(2, "0") + "/" + month + "/" + year : "";

  const validateStep1 = () => {
    if (!name.trim())              { Alert.alert("Error", "Enter your full name.");         return false; }
    if (!day || !month || !year)   { Alert.alert("Error", "Enter your date of birth.");     return false; }
    const d = parseInt(day), y = parseInt(year);
    if (d < 1 || d > 31)          { Alert.alert("Error", "Invalid day.");                  return false; }
    if (y < 1900 || y > 2015)     { Alert.alert("Error", "Enter a valid birth year.");      return false; }
    const digits = mobile.replace(/\D/g, "");
    if (digits.length < 8)        { Alert.alert("Error", "Enter a valid mobile number.");  return false; }
    return true;
  };

  const validateStep2 = () => {
    if (!q1)            { Alert.alert("Error", "Select security question 1."); return false; }
    if (!a1.trim())     { Alert.alert("Error", "Answer question 1.");          return false; }
    if (!q2)            { Alert.alert("Error", "Select security question 2."); return false; }
    if (!a2.trim())     { Alert.alert("Error", "Answer question 2.");          return false; }
    if (a1.trim().toLowerCase() === a2.trim().toLowerCase()) {
      Alert.alert("Error", "Both answers cannot be the same."); return false;
    }
    return true;
  };

  const handleFinish = async () => {
    if (pin.length < 8)     { Alert.alert("Error", "PIN must be 8 digits.");         return; }
    if (pin !== confirm)    { Alert.alert("Error", "PINs do not match.");            return; }

    setLoading(true);
    try {
      const fullPhone = cc + mobile.replace(/\D/g, "");
      await savePendingSignup({ name, dob, email, mobile: fullPhone, securityQ1: q1, securityA1: a1, securityQ2: q2, securityA2: a2 });
      await savePIN(pin);
      // OTP sent by otp.tsx on mount
      router.push({ pathname: "/otp", params: { phone: fullPhone, flow: "signup" } });
    } catch (e: any) {
      Alert.alert("Error", e.message ?? "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient colors={["#010812", "#071020", "#0a1628"]} style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled">

          {/* Logo */}
          <View style={S.logoWrap}>
            <LinearGradient colors={["#1D4ED8", "#7C3AED"]} style={S.logoCircle}>
              <Text style={{ fontSize: 32 }}>🔐</Text>
            </LinearGradient>
            <Text style={S.logoText}>VaultChat</Text>
          </View>

          <StepBar step={step} />

          {/* ── STEP 1: Personal ── */}
          {step === 1 && (
            <View style={S.card}>
              <Text style={S.cardTitle}>Personal Details</Text>
              <Text style={S.cardSub}>Your identity information</Text>

              {/* Name */}
              <Text style={S.label}>FULL NAME</Text>
              <View style={S.inputRow}>
                <Text style={S.icon}>👤</Text>
                <TextInput style={S.input} placeholder="Your full name"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={name} onChangeText={setName} autoCapitalize="words" />
              </View>

              {/* DOB */}
              <Text style={[S.label, { marginTop: 14 }]}>DATE OF BIRTH</Text>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
                <TextInput style={[S.input, { flex: 1, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14, textAlign: "center" }]}
                  placeholder="DD" placeholderTextColor="rgba(255,255,255,0.25)"
                  value={day} onChangeText={t => setDay(t.replace(/\D/g, "").slice(0, 2))}
                  keyboardType="number-pad" maxLength={2} />

                <TouchableOpacity
                  style={{ flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14, paddingVertical: 14 }}
                  onPress={() => setShowMonth(v => !v)}>
                  <Text style={{ color: month ? "#fff" : "rgba(255,255,255,0.25)", fontSize: 15 }}>
                    {month || "Month"}
                  </Text>
                  <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 8 }}>{showMonth ? "▲" : "▼"}</Text>
                </TouchableOpacity>

                <TextInput style={[S.input, { flex: 1.5, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14, textAlign: "center" }]}
                  placeholder="YYYY" placeholderTextColor="rgba(255,255,255,0.25)"
                  value={year} onChangeText={t => setYear(t.replace(/\D/g, "").slice(0, 4))}
                  keyboardType="number-pad" maxLength={4} />
              </View>

              {showMonth && (
                <View style={S.pickerDrop}>
                  {MONTHS.map(m => (
                    <TouchableOpacity key={m} style={S.pickerItem}
                      onPress={() => { setMonth(m); setShowMonth(false); }}>
                      <Text style={[S.pickerItemTxt, month === m && { color: "#4A9FFF" }]}>{m}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Email */}
              <Text style={S.label}>EMAIL ADDRESS (OPTIONAL)</Text>
              <View style={S.inputRow}>
                <Text style={S.icon}>✉️</Text>
                <TextInput style={S.input} placeholder="For account recovery"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={email} onChangeText={setEmail}
                  keyboardType="email-address" autoCapitalize="none" />
              </View>

              {/* Mobile */}
              <Text style={[S.label, { marginTop: 14 }]}>MOBILE NUMBER</Text>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                <TouchableOpacity style={S.ccBtn} onPress={() => setShowCC(v => !v)}>
                  <Text style={{ fontSize: 18 }}>{selected.flag}</Text>
                  <Text style={S.ccCode}>{cc}</Text>
                  <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 8 }}>{showCC ? "▲" : "▼"}</Text>
                </TouchableOpacity>
                <TextInput
                  style={[S.input, { flex: 1, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14 }]}
                  placeholder="Mobile number"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={mobile}
                  onChangeText={t => setMobile(t.replace(/\D/g, "").slice(0, 13))}
                  keyboardType="phone-pad" maxLength={13} />
              </View>

              {showCC && (
                <View style={S.pickerDrop}>
                  {CODES.map(c => (
                    <TouchableOpacity key={c.code} style={S.pickerItem}
                      onPress={() => { setCc(c.code); setShowCC(false); }}>
                      <Text style={{ fontSize: 18 }}>{c.flag}</Text>
                      <Text style={[S.pickerItemTxt, { flex: 1, marginLeft: 10 }]}>{c.name}</Text>
                      <Text style={{ color: "#4A9FFF", fontWeight: "800" }}>{c.code}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <TouchableOpacity style={[S.btnWrap, { marginTop: 16 }]}
                onPress={() => validateStep1() && setStep(2)}>
                <LinearGradient colors={["#1D4ED8", "#7C3AED"]} style={S.btn}>
                  <Text style={S.btnTxt}>Continue  →</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* ── STEP 2: Security Questions ── */}
          {step === 2 && (
            <View style={S.card}>
              <Text style={S.cardTitle}>Security Questions</Text>
              <Text style={S.cardSub}>For identity recovery — answers are hashed and never stored as plain text</Text>

              <Text style={S.label}>QUESTION 1</Text>
              <QPicker selected={q1} onSelect={setQ1} exclude={q2} />
              {q1 ? (
                <View style={[S.inputRow, { marginBottom: 16 }]}>
                  <Text style={S.icon}>🔑</Text>
                  <TextInput style={S.input} placeholder="Your answer"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    value={a1} onChangeText={setA1} autoCapitalize="none" />
                </View>
              ) : <View style={{ height: 16 }} />}

              <Text style={S.label}>QUESTION 2</Text>
              <QPicker selected={q2} onSelect={setQ2} exclude={q1} />
              {q2 ? (
                <View style={[S.inputRow, { marginBottom: 16 }]}>
                  <Text style={S.icon}>🔑</Text>
                  <TextInput style={S.input} placeholder="Your answer"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    value={a2} onChangeText={setA2} autoCapitalize="none" />
                </View>
              ) : <View style={{ height: 16 }} />}

              <View style={S.infoBox}>
                <Text style={S.infoTxt}>🔒  Answers are case-insensitive. Stored as one-way encrypted hash.</Text>
              </View>

              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity style={S.backBtn} onPress={() => setStep(1)}>
                  <Text style={S.backTxt}>←  Back</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ flex: 1, borderRadius: 14, overflow: "hidden" }}
                  onPress={() => validateStep2() && setStep(3)}>
                  <LinearGradient colors={["#1D4ED8", "#7C3AED"]} style={S.btn}>
                    <Text style={S.btnTxt}>Continue  →</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── STEP 3: 8-Digit PIN ── */}
          {step === 3 && (
            <View style={S.card}>
              <Text style={S.cardTitle}>Secret PIN</Text>
              <Text style={S.cardSub}>8-digit PIN used for new device login and vault documents</Text>

              <PINBoxes value={pin} onChangeText={setPin} label="CREATE YOUR 8-DIGIT PIN" />
              <PINBoxes value={confirm} onChangeText={setConfirm} label="CONFIRM YOUR PIN" />

              {pin.length === 8 && confirm.length === 8 && (
                <View style={[S.infoBox, { borderColor: pin === confirm ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)", backgroundColor: pin === confirm ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)" }]}>
                  <Text style={{ color: pin === confirm ? "#10B981" : "#EF4444", fontSize: 12, textAlign: "center", fontWeight: "700" }}>
                    {pin === confirm ? "✓  PINs match" : "✗  PINs do not match"}
                  </Text>
                </View>
              )}

              <View style={S.infoBox}>
                <Text style={S.infoTxt}>
                  ⚠️  This PIN cannot be reset without security questions. Write it down safely.
                </Text>
              </View>

              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity style={S.backBtn} onPress={() => setStep(2)}>
                  <Text style={S.backTxt}>←  Back</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ flex: 1, borderRadius: 14, overflow: "hidden" }}
                  onPress={handleFinish} disabled={loading}>
                  <LinearGradient colors={["#10B981", "#059669"]} style={S.btn}>
                    {loading
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={S.btnTxt}>Create Account  →</Text>}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <TouchableOpacity style={{ alignItems: "center", marginTop: 20, marginBottom: 32 }}
            onPress={() => router.replace("/login")}>
            <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>
              Already have an account?{"  "}
              <Text style={{ color: "#4A9FFF", fontWeight: "900" }}>Sign In</Text>
            </Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  scroll:       { flexGrow: 1, padding: 24, paddingTop: 52 },
  logoWrap:     { alignItems: "center", marginBottom: 20 },
  logoCircle:   { width: 68, height: 68, borderRadius: 34, justifyContent: "center", alignItems: "center", marginBottom: 10 },
  logoText:     { color: "#fff", fontSize: 26, fontWeight: "900", letterSpacing: 1 },
  card:         { backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 24, padding: 22, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", marginBottom: 16 },
  cardTitle:    { color: "#fff", fontSize: 22, fontWeight: "900", marginBottom: 4 },
  cardSub:      { color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 20 },
  label:        { color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 8 },
  inputRow:     { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14, marginBottom: 14 },
  icon:         { fontSize: 16, marginRight: 10 },
  input:        { flex: 1, color: "#fff", fontSize: 15, paddingVertical: 14 },
  ccBtn:        { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 12, paddingVertical: 14 },
  ccCode:       { color: "#fff", fontWeight: "800", fontSize: 13 },
  pickerBtn:    { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", paddingHorizontal: 14, paddingVertical: 13, gap: 8 },
  pickerTxt:    { flex: 1, color: "rgba(255,255,255,0.6)", fontSize: 13 },
  pickerArrow:  { color: "rgba(255,255,255,0.4)", fontSize: 10 },
  pickerDrop:   { backgroundColor: "#0D1F35", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", marginBottom: 8, zIndex: 100 },
  pickerItem:   { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)" },
  pickerItemTxt:{ color: "rgba(255,255,255,0.7)", fontSize: 13 },
  pinBox:       { width: 52, height: 58, borderRadius: 12, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.15)", backgroundColor: "rgba(255,255,255,0.05)", justifyContent: "center", alignItems: "center" },
  pinBoxFilled: { borderColor: "#7C3AED", backgroundColor: "rgba(124,58,237,0.15)" },
  pinDot:       { width: 10, height: 10, borderRadius: 5, backgroundColor: "rgba(255,255,255,0.1)" },
  pinDotFilled: { backgroundColor: "#7C3AED" },
  infoBox:      { backgroundColor: "rgba(74,159,255,0.08)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(74,159,255,0.2)" },
  infoTxt:      { color: "rgba(255,255,255,0.5)", fontSize: 12, lineHeight: 18 },
  btnWrap:      { borderRadius: 14, overflow: "hidden" },
  btn:          { paddingVertical: 15, alignItems: "center", borderRadius: 14 },
  btnTxt:       { color: "#fff", fontSize: 15, fontWeight: "900" },
  backBtn:      { justifyContent: "center", alignItems: "center", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 14, paddingHorizontal: 20, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  backTxt:      { color: "rgba(255,255,255,0.7)", fontWeight: "800", fontSize: 14 },
});
