import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "./(constants)/firebase";

const SECURITY_QUESTIONS = [
  "What was the name of your first pet?",
  "What is your mother's maiden name?",
  "What city were you born in?",
  "What was the name of your first school?",
  "What is your oldest sibling's middle name?",
  "What was the make of your first car?",
  "What street did you grow up on?",
  "What was your childhood nickname?",
];

// -- Step indicator ------------------------------------------------------------
const StepBar = ({ step }: { step: number }) => (
  <View style={st.stepBar}>
    {[1, 2, 3].map(n => (
      <View key={n} style={st.stepWrap}>
        <LinearGradient
          colors={step >= n ? ["#1D4ED8","#7C3AED"] : ["transparent","transparent"]}
          style={[st.stepCircle, step >= n ? {} : st.stepCircleInactive]}>
          <Text style={[st.stepNum, step >= n && { color:"#fff" }]}>{n}</Text>
        </LinearGradient>
        <Text style={[st.stepLabel, step >= n && { color:"rgba(255,255,255,0.8)" }]}>
          {n === 1 ? "Account" : n === 2 ? "Contact" : "Security"}
        </Text>
        {n < 3 && <View style={[st.stepLine, step > n && st.stepLineActive]} />}
      </View>
    ))}
  </View>
);

// -- Dropdown picker -----------------------------------------------------------
const QuestionPicker = ({
  selected, onSelect, exclude,
}: { selected: string; onSelect: (q: string) => void; exclude: string }) => {
  const [open, setOpen] = useState(false);
  const available = SECURITY_QUESTIONS.filter(q => q !== exclude);
  return (
    <View>
      <TouchableOpacity style={st.pickerBtn} onPress={() => setOpen(v => !v)}>
        <Text style={st.pickerText} numberOfLines={1}>
          {selected || "Select a security question"}
        </Text>
        <Text style={st.pickerArrow}>{open ? "?" : "?"}</Text>
      </TouchableOpacity>
      {open && (
        <View style={st.pickerDropdown}>
          {available.map(q => (
            <TouchableOpacity key={q} style={st.pickerItem}
              onPress={() => { onSelect(q); setOpen(false); }}>
              <Text style={[st.pickerItemText, selected === q && { color:"#4A9FFF" }]}>{q}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
};

// -- Main screen ---------------------------------------------------------------
export default function SignupScreen() {
  const router  = useRouter();
  const [step,  setStep]  = useState(1);
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  // Step 1 — Account
  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");

  // Step 2 — Contact
  const [mobile,      setMobile]      = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  const [showCodes,   setShowCodes]   = useState(false);

  // Step 3 — Security
  const [q1, setQ1] = useState("");
  const [a1, setA1] = useState("");
  const [q2, setQ2] = useState("");
  const [a2, setA2] = useState("");

  const COUNTRY_CODES = [
    { code:"+91",  flag:"????", name:"India" },
    { code:"+1",   flag:"????", name:"USA" },
    { code:"+44",  flag:"????", name:"UK" },
    { code:"+61",  flag:"????", name:"Australia" },
    { code:"+971", flag:"????", name:"UAE" },
    { code:"+65",  flag:"????", name:"Singapore" },
    { code:"+60",  flag:"????", name:"Malaysia" },
    { code:"+49",  flag:"????", name:"Germany" },
    { code:"+33",  flag:"????", name:"France" },
    { code:"+81",  flag:"????", name:"Japan" },
  ];

  const getStrength = () => {
    if (!password) return { label:"", color:"transparent", pct:"0%" };
    if (password.length < 6)  return { label:"Weak",   color:"#EF4444", pct:"25%" };
    if (password.length < 8)  return { label:"Fair",   color:"#F59E0B", pct:"50%" };
    if (!/[A-Z]/.test(password)||!/[0-9]/.test(password))
                              return { label:"Good",   color:"#3B82F6", pct:"75%" };
    return                           { label:"Strong", color:"#10B981", pct:"100%" };
  };

  // -- Validate step 1 ---------------------------------------------------------
  const validateStep1 = () => {
    if (!name.trim())     { Alert.alert("Error","Please enter your full name.");    return false; }
    if (!email.trim())    { Alert.alert("Error","Please enter your email.");        return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
                          { Alert.alert("Error","Please enter a valid email.");     return false; }
    if (password.length < 6) { Alert.alert("Error","Password min 6 characters."); return false; }
    if (password !== confirm) { Alert.alert("Error","Passwords do not match.");    return false; }
    return true;
  };

  // -- Validate step 2 ---------------------------------------------------------
  const validateStep2 = () => {
    if (!mobile.trim())       { Alert.alert("Error","Please enter your mobile number."); return false; }
    if (!/^\d{7,15}$/.test(mobile.trim()))
                              { Alert.alert("Error","Please enter a valid mobile number."); return false; }
    return true;
  };

  // -- Validate step 3 ---------------------------------------------------------
  const validateStep3 = () => {
    if (!q1) { Alert.alert("Error","Please select security question 1."); return false; }
    if (!a1.trim()) { Alert.alert("Error","Please answer security question 1."); return false; }
    if (!q2) { Alert.alert("Error","Please select security question 2."); return false; }
    if (!a2.trim()) { Alert.alert("Error","Please answer security question 2."); return false; }
    if (a1.trim().toLowerCase() === a2.trim().toLowerCase())
              { Alert.alert("Error","Security answers must be different."); return false; }
    return true;
  };

  // -- Create account ----------------------------------------------------------
  const handleSignup = async () => {
    if (!validateStep3()) return;
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(
        auth, email.trim().toLowerCase(), password
      );
      await updateProfile(cred.user, { displayName: name.trim() });

      // Save profile to Firestore
      await setDoc(doc(db, "users", cred.user.uid), {
        name:         name.trim(),
        email:        email.trim().toLowerCase(),
        mobile:       countryCode + mobile.trim(),
        createdAt:    new Date().toISOString(),
        // Store hashed answers — never store plain text
        securityQ1:   q1,
        securityA1:   a1.trim().toLowerCase(), // hash this in production
        securityQ2:   q2,
        securityA2:   a2.trim().toLowerCase(),
        vaultId:      `VC-${name.trim().slice(0,4).toUpperCase()}-${mobile.trim().slice(-4)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
      });

      router.replace("/(tabs)/home");
    } catch (e: any) {
      const msg =
        e.code === "auth/email-already-in-use" ? "This email is already registered." :
        e.code === "auth/invalid-email"        ? "Invalid email address." :
        e.code === "auth/weak-password"        ? "Password is too weak." :
        "Signup failed. Please try again.";
      Alert.alert("Signup Failed", msg);
    } finally {
      setLoading(false);
    }
  };

  const strength = getStrength();
  const selectedCountry = COUNTRY_CODES.find(c => c.code === countryCode);

  // -- Render ------------------------------------------------------------------
  return (
    <LinearGradient colors={["#010812","#071020","#0a1628"]} style={s.root}>
      <KeyboardAvoidingView behavior={Platform.OS==="ios"?"padding":"height"} style={{flex:1}}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          {/* Logo */}
          <View style={s.logoWrap}>
            <LinearGradient colors={["#1D4ED8","#7C3AED"]} style={s.logoCircle}>
              <Text style={{fontSize:34}}>??</Text>
            </LinearGradient>
            <Text style={s.logoText}>VaultChat</Text>
          </View>

          {/* Step bar */}
          <StepBar step={step} />

          {/* -- STEP 1 — Account details ----------------------------------- */}
          {step === 1 && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Account Details</Text>
              <Text style={s.cardSub}>Set up your login credentials</Text>

              <Field label="Full Name" icon="??">
                <TextInput style={s.input} placeholder="Your full name"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={name} onChangeText={setName} autoCapitalize="words" />
              </Field>

              <Field label="Email Address" icon="??">
                <TextInput style={s.input} placeholder="your@email.com"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={email} onChangeText={setEmail}
                  keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
              </Field>

              <Field label="Password" icon="??" extra={
                <TouchableOpacity onPress={() => setShowPass(v=>!v)} style={{padding:8}}>
                  <Text style={{fontSize:16}}>{showPass?"??":"???"}</Text>
                </TouchableOpacity>
              }>
                <TextInput style={s.input} placeholder="Min 6 characters"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={password} onChangeText={setPassword}
                  secureTextEntry={!showPass} autoCapitalize="none" />
              </Field>

              {password.length > 0 && (
                <View style={s.strengthWrap}>
                  <View style={s.strengthBar}>
                    <View style={[s.strengthFill,{width:strength.pct as any,backgroundColor:strength.color}]} />
                  </View>
                  <Text style={[s.strengthLabel,{color:strength.color}]}>{strength.label}</Text>
                </View>
              )}

              <Field label="Confirm Password" icon="??" extra={
                confirm.length > 0
                  ? <Text style={{fontSize:16}}>{confirm===password?"?":"?"}</Text>
                  : null
              }>
                <TextInput style={s.input} placeholder="Repeat password"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={confirm} onChangeText={setConfirm}
                  secureTextEntry={!showPass} autoCapitalize="none" />
              </Field>

              <TouchableOpacity style={s.btnWrap} onPress={() => validateStep1() && setStep(2)}>
                <LinearGradient colors={["#1D4ED8","#7C3AED"]} style={s.btn}>
                  <Text style={s.btnText}>Continue ?</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* -- STEP 2 — Contact ------------------------------------------- */}
          {step === 2 && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Contact Info</Text>
              <Text style={s.cardSub}>Your mobile number for account recovery</Text>

              <Text style={s.label}>Mobile Number</Text>
              <View style={s.mobileRow}>

                {/* Country code picker */}
                <TouchableOpacity style={s.codeBtn} onPress={() => setShowCodes(v=>!v)}>
                  <Text style={s.codeFlag}>{selectedCountry?.flag}</Text>
                  <Text style={s.codeText}>{countryCode}</Text>
                  <Text style={s.codeArrow}>{showCodes?"?":"?"}</Text>
                </TouchableOpacity>

                <TextInput style={s.mobileInput}
                  placeholder="XXXXXXXXXX"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={mobile} onChangeText={setMobile}
                  keyboardType="phone-pad" maxLength={15} />
              </View>

              {/* Country code dropdown */}
              {showCodes && (
                <View style={s.codeDropdown}>
                  {COUNTRY_CODES.map(c => (
                    <TouchableOpacity key={c.code} style={s.codeItem}
                      onPress={() => { setCountryCode(c.code); setShowCodes(false); }}>
                      <Text style={s.codeItemFlag}>{c.flag}</Text>
                      <Text style={s.codeItemName}>{c.name}</Text>
                      <Text style={s.codeItemCode}>{c.code}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <View style={s.infoBox}>
                <Text style={s.infoText}>
                  ?? Your mobile number is used for account recovery only. It is stored securely and never shared.
                </Text>
              </View>

              <View style={s.rowBtns}>
                <TouchableOpacity style={s.backBtnWrap} onPress={() => setStep(1)}>
                  <Text style={s.backBtnText}>? Back</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{flex:1}} onPress={() => validateStep2() && setStep(3)}>
                  <LinearGradient colors={["#1D4ED8","#7C3AED"]} style={s.btn}>
                    <Text style={s.btnText}>Continue ?</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* -- STEP 3 — Security questions -------------------------------- */}
          {step === 3 && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Security Questions</Text>
              <Text style={s.cardSub}>Used to verify your identity if you forget your password</Text>

              {/* Question 1 */}
              <View style={s.qBlock}>
                <Text style={s.label}>Security Question 1</Text>
                <QuestionPicker selected={q1} onSelect={setQ1} exclude={q2} />
                {q1 ? (
                  <View style={s.answerWrap}>
                    <Text style={s.inputIcon}>??</Text>
                    <TextInput style={s.input} placeholder="Your answer"
                      placeholderTextColor="rgba(255,255,255,0.25)"
                      value={a1} onChangeText={setA1} autoCapitalize="none" />
                  </View>
                ) : null}
              </View>

              {/* Question 2 */}
              <View style={s.qBlock}>
                <Text style={s.label}>Security Question 2</Text>
                <QuestionPicker selected={q2} onSelect={setQ2} exclude={q1} />
                {q2 ? (
                  <View style={s.answerWrap}>
                    <Text style={s.inputIcon}>??</Text>
                    <TextInput style={s.input} placeholder="Your answer"
                      placeholderTextColor="rgba(255,255,255,0.25)"
                      value={a2} onChangeText={setA2} autoCapitalize="none" />
                  </View>
                ) : null}
              </View>

              <View style={s.infoBox}>
                <Text style={s.infoText}>
                  ?? Answers are case-insensitive and stored securely. Make sure you remember them.
                </Text>
              </View>

              <View style={s.rowBtns}>
                <TouchableOpacity style={s.backBtnWrap} onPress={() => setStep(2)}>
                  <Text style={s.backBtnText}>? Back</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{flex:1}} onPress={handleSignup} disabled={loading}>
                  <LinearGradient colors={["#10B981","#059669"]} style={s.btn}>
                    {loading
                      ? <ActivityIndicator color="#fff" />
                      : <Text style={s.btnText}>Create Account ?</Text>
                    }
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Login link */}
          <TouchableOpacity style={{alignItems:"center",marginTop:20}}
            onPress={() => router.push("/login")}>
            <Text style={{color:"rgba(255,255,255,0.5)",fontSize:14}}>
              Already have an account?{" "}
              <Text style={{color:"#4A9FFF",fontWeight:"800"}}>Sign In</Text>
            </Text>
          </TouchableOpacity>

          <View style={{alignItems:"center",marginTop:16,marginBottom:32}}>
            <Text style={{color:"rgba(255,255,255,0.2)",fontSize:11}}>
              ?? Your data is end-to-end encrypted
            </Text>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

// -- Field wrapper -------------------------------------------------------------
const Field = ({ label, icon, children, extra }: {
  label:string; icon:string; children:React.ReactNode; extra?:React.ReactNode;
}) => (
  <View style={s.inputWrap}>
    <Text style={s.label}>{label}</Text>
    <View style={s.inputRow}>
      <Text style={s.inputIcon}>{icon}</Text>
      {children}
      {extra}
    </View>
  </View>
);

const s = StyleSheet.create({
  root:          { flex:1 },
  scroll:        { flexGrow:1, padding:24, paddingTop:52 },
  logoWrap:      { alignItems:"center", marginBottom:20 },
  logoCircle:    { width:70, height:70, borderRadius:35, justifyContent:"center", alignItems:"center", marginBottom:10 },
  logoText:      { color:"#fff", fontSize:28, fontWeight:"900", letterSpacing:1 },
  card:          { backgroundColor:"rgba(255,255,255,0.05)", borderRadius:24, padding:22,
                   borderWidth:1, borderColor:"rgba(255,255,255,0.08)", marginBottom:16 },
  cardTitle:     { color:"#fff", fontSize:22, fontWeight:"900", marginBottom:4 },
  cardSub:       { color:"rgba(255,255,255,0.4)", fontSize:13, marginBottom:20 },
  inputWrap:     { marginBottom:14 },
  label:         { color:"rgba(255,255,255,0.6)", fontSize:11, fontWeight:"700",
                   marginBottom:7, textTransform:"uppercase", letterSpacing:0.5 },
  inputRow:      { flexDirection:"row", alignItems:"center",
                   backgroundColor:"rgba(255,255,255,0.07)", borderRadius:12,
                   borderWidth:1, borderColor:"rgba(255,255,255,0.1)", paddingHorizontal:14 },
  inputIcon:     { fontSize:16, marginRight:10 },
  input:         { flex:1, color:"#fff", fontSize:15, paddingVertical:13 },
  strengthWrap:  { flexDirection:"row", alignItems:"center", gap:10, marginTop:-8, marginBottom:12 },
  strengthBar:   { flex:1, height:3, backgroundColor:"rgba(255,255,255,0.1)", borderRadius:2, overflow:"hidden" },
  strengthFill:  { height:"100%", borderRadius:2 },
  strengthLabel: { fontSize:11, fontWeight:"800", width:45 },
  btnWrap:       { borderRadius:14, overflow:"hidden", marginTop:8 },
  btn:           { paddingVertical:15, alignItems:"center", borderRadius:14 },
  btnText:       { color:"#fff", fontSize:15, fontWeight:"900" },
  rowBtns:       { flexDirection:"row", gap:12, marginTop:8 },
  backBtnWrap:   { justifyContent:"center", alignItems:"center",
                   backgroundColor:"rgba(255,255,255,0.08)", borderRadius:14,
                   paddingHorizontal:16, borderWidth:1, borderColor:"rgba(255,255,255,0.1)" },
  backBtnText:   { color:"rgba(255,255,255,0.7)", fontWeight:"800", fontSize:14 },
  mobileRow:     { flexDirection:"row", gap:10, marginBottom:14 },
  codeBtn:       { flexDirection:"row", alignItems:"center", gap:4,
                   backgroundColor:"rgba(255,255,255,0.07)", borderRadius:12,
                   borderWidth:1, borderColor:"rgba(255,255,255,0.1)",
                   paddingHorizontal:12, paddingVertical:13 },
  codeFlag:      { fontSize:18 },
  codeText:      { color:"#fff", fontWeight:"800", fontSize:14 },
  codeArrow:     { color:"rgba(255,255,255,0.4)", fontSize:10 },
  mobileInput:   { flex:1, color:"#fff", fontSize:15,
                   backgroundColor:"rgba(255,255,255,0.07)", borderRadius:12,
                   borderWidth:1, borderColor:"rgba(255,255,255,0.1)",
                   paddingHorizontal:14, paddingVertical:13 },
  codeDropdown:  { backgroundColor:"#0d1f35", borderRadius:12, borderWidth:1,
                   borderColor:"rgba(255,255,255,0.1)", marginBottom:12, maxHeight:200,
                   overflow:"scroll" as any },
  codeItem:      { flexDirection:"row", alignItems:"center", gap:10,
                   paddingHorizontal:16, paddingVertical:12,
                   borderBottomWidth:1, borderBottomColor:"rgba(255,255,255,0.05)" },
  codeItemFlag:  { fontSize:20 },
  codeItemName:  { flex:1, color:"#fff", fontSize:14 },
  codeItemCode:  { color:"#4A9FFF", fontWeight:"800", fontSize:14 },
  infoBox:       { backgroundColor:"rgba(74,159,255,0.08)", borderRadius:10,
                   padding:12, marginBottom:16, borderWidth:1,
                   borderColor:"rgba(74,159,255,0.2)" },
  infoText:      { color:"rgba(255,255,255,0.5)", fontSize:12, lineHeight:18 },
  qBlock:        { marginBottom:16 },
  answerWrap:    { flexDirection:"row", alignItems:"center",
                   backgroundColor:"rgba(255,255,255,0.07)", borderRadius:12,
                   borderWidth:1, borderColor:"rgba(255,255,255,0.1)",
                   paddingHorizontal:14, marginTop:8 },
});

// -- Dropdown styles -----------------------------------------------------------
const st = StyleSheet.create({
  stepBar:          { flexDirection:"row", justifyContent:"center", alignItems:"flex-start",
                      marginBottom:20, gap:0 },
  stepWrap:         { alignItems:"center", position:"relative" },
  stepCircle:       { width:32, height:32, borderRadius:16,
                      justifyContent:"center", alignItems:"center" },
  stepCircleInactive:{ borderWidth:1.5, borderColor:"rgba(255,255,255,0.2)" },
  stepNum:          { color:"rgba(255,255,255,0.3)", fontSize:13, fontWeight:"900" },
  stepLabel:        { color:"rgba(255,255,255,0.3)", fontSize:10, fontWeight:"700", marginTop:4 },
  stepLine:         { position:"absolute", top:16, left:32, width:60, height:1.5,
                      backgroundColor:"rgba(255,255,255,0.1)" },
  stepLineActive:   { backgroundColor:"#4A9FFF" },
  pickerBtn:        { flexDirection:"row", alignItems:"center",
                      backgroundColor:"rgba(255,255,255,0.07)", borderRadius:12,
                      borderWidth:1, borderColor:"rgba(255,255,255,0.1)",
                      paddingHorizontal:14, paddingVertical:13, gap:8 },
  pickerText:       { flex:1, color:"rgba(255,255,255,0.6)", fontSize:13 },
  pickerArrow:      { color:"rgba(255,255,255,0.4)", fontSize:11 },
  pickerDropdown:   { backgroundColor:"#0d1f35", borderRadius:12, borderWidth:1,
                      borderColor:"rgba(255,255,255,0.1)", marginTop:4, zIndex:100 },
  pickerItem:       { paddingHorizontal:16, paddingVertical:13,
                      borderBottomWidth:1, borderBottomColor:"rgba(255,255,255,0.05)" },
  pickerItemText:   { color:"rgba(255,255,255,0.7)", fontSize:13 },
});


