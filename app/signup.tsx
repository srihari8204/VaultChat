import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Animated, KeyboardAvoidingView,
  Modal, Platform, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from "react-native";
import {
  savePendingSignup, savePIN, signInWithGoogle, configureGoogleSignIn,
} from "./(constants)/authService";
import { markSetupComplete } from "../services/securityService";


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
  { code: "+91",  flag: "IN", name: "India" },
  { code: "+1",   flag: "US", name: "USA" },
  { code: "+44",  flag: "GB", name: "UK" },
];

// ── Fade wrapper for step transitions ────────────────────────────────────────
function FadeIn({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    opacity.setValue(0);
    translateY.setValue(18);
    Animated.parallel([
      Animated.spring(opacity, {
        toValue: 1, useNativeDriver: true, delay,
        speed: 14, bounciness: 0,
      }),
      Animated.spring(translateY, {
        toValue: 0, useNativeDriver: true, delay,
        speed: 14, bounciness: 2,
      }),
    ]).start();
  }, [delay, opacity, translateY]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

// ── Step Indicator: Progress bar ──────────────────────────
function StepIndicator({ step }: { step: number }) {
  const progress = (step / 3) * 100;
  return (
    <View style={S.stepContainer}>
      <View style={S.stepBar}>
        <View style={[S.stepProgress, { width: `${progress}%` }]} />
      </View>
      <Text style={S.stepText}>Step {step} of 3</Text>
    </View>
  );
}

// ── Clean underline input ────────────────────────────────────────────────────
function UnderlineInput({
  label, value, onChangeText, placeholder, keyboardType, autoCapitalize,
  maxLength, textAlign,
}: {
  label: string; value: string; onChangeText: (t: string) => void;
  placeholder: string; keyboardType?: any; autoCapitalize?: any;
  maxLength?: number; textAlign?: "left" | "center";
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ marginBottom: 28 }}>
      <Text style={S.inputLabel}>{label}</Text>
      <TextInput
        style={[
          S.underlineInput,
          focused && { borderBottomColor: "#fff" },
          textAlign ? { textAlign } : null,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.2)"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        maxLength={maxLength}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </View>
  );
}

// ── Clean dropdown selector ──────────────────────────────────────────────────
function DropdownSelector({
  label, selected, placeholder, options, onSelect, exclude,
  renderItem,
}: {
  label: string; selected: string; placeholder: string;
  options: string[]; onSelect: (v: string) => void; exclude?: string;
  renderItem?: (item: string, isSelected: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const filtered = exclude ? options.filter(o => o !== exclude) : options;

  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={S.inputLabel}>{label}</Text>
      <TouchableOpacity
        style={S.dropdownBtn}
        onPress={() => setOpen(v => !v)}
        activeOpacity={0.7}
      >
        <Text style={[
          S.dropdownText,
          !selected && { color: "rgba(255,255,255,0.2)" },
        ]} numberOfLines={1}>
          {selected || placeholder}
        </Text>
        <Text style={S.dropdownChevron}>{open ? "\u2303" : "\u2304"}</Text>
      </TouchableOpacity>
      {open && (
        <View style={S.dropdownList}>
          <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
            {filtered.map(item => (
              <TouchableOpacity
                key={item}
                style={S.dropdownItem}
                onPress={() => { onSelect(item); setOpen(false); }}
                activeOpacity={0.6}
              >
                {renderItem ? renderItem(item, selected === item) : (
                  <Text style={[
                    S.dropdownItemText,
                    selected === item && { color: "#fff", fontWeight: "700" },
                  ]}>
                    {item}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ── PIN Indicator: 8 dashes/dots ─────────────────────────────────────────────
function PINInput({
  value, onChangeText, label,
}: {
  value: string; onChangeText: (t: string) => void; label: string;
}) {
  const inputRef = useRef<TextInput>(null);
  const digits = value.split("");

  return (
    <View style={{ marginBottom: 32 }}>
      <Text style={S.inputLabel}>{label}</Text>
      <TouchableOpacity
        onPress={() => inputRef.current?.focus()}
        activeOpacity={1}
        style={S.pinRow}
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <View key={i} style={S.pinSlot}>
            {digits[i] ? (
              <View style={S.pinDotFilled} />
            ) : (
              <View style={S.pinDash} />
            )}
          </View>
        ))}
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

// ── Month Picker Modal ───────────────────────────────────────────────────────
function MonthPickerModal({
  visible, selected, onSelect, onClose,
}: {
  visible: boolean; selected: string;
  onSelect: (m: string) => void; onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <TouchableOpacity
        style={S.modalOverlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={S.modalContent}>
          <Text style={S.modalTitle}>Select month</Text>
          <View style={S.monthGrid}>
            {MONTHS.map(m => (
              <TouchableOpacity
                key={m}
                style={[
                  S.monthItem,
                  selected === m && S.monthItemActive,
                ]}
                onPress={() => { onSelect(m); onClose(); }}
              >
                <Text style={[
                  S.monthText,
                  selected === m && S.monthTextActive,
                ]}>
                  {m.slice(0, 3)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function SignupScreen() {
  const router = useRouter();
  const [step, setStep]       = useState(1);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    try { configureGoogleSignIn(); } catch {}
  }, []);

  const handleGoogleSignUp = async () => {
    setGoogleLoading(true);
    try {
      const result = await signInWithGoogle();
      console.log('[SIGNUP] Google sign-up success:', result.displayName);
      await markSetupComplete();
      // Google creates profile automatically, go straight to chats
      router.replace('/(tabs)/chats' as any);
    } catch (e: any) {
      console.error('[SIGNUP] Google sign-up error:', e);
      if (!e.message?.includes('cancelled')) {
        Alert.alert('Google Sign-In Error', e.message ?? 'Failed');
      }
    } finally {
      setGoogleLoading(false);
    }
  };
  const [stepKey, setStepKey] = useState(0);

  // Step 1
  const [name,  setName]      = useState("");
  const [day,   setDay]       = useState("");
  const [month, setMonth]     = useState("");
  const [year,  setYear]      = useState("");
  const [email, setEmail]     = useState("");
  const [cc,    setCc]        = useState("+91");
  const [mobile, setMobile]   = useState("");
  const [showCC, setShowCC]   = useState(false);
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

  const goStep = (n: number) => {
    setStepKey(k => k + 1);
    setStep(n);
  };

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
      router.push({ pathname: "/otp", params: { phone: fullPhone, flow: "signup" } });
    } catch (e: any) {
      Alert.alert("Error", e.message ?? "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  // Step titles
  const titles: Record<number, string> = {
    1: "Create Your Account",
    2: "Security\nquestions",
    3: "Set your\nPIN",
  };

  return (
    <View style={S.root}>
      {/* Subtle gradient overlay at top */}
      <LinearGradient
        colors={["rgba(0,0,0,0.03)", "transparent"]}
        style={S.topGlow}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={S.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={S.header}>
            <Text style={S.brand}>VAULTCHAT</Text>
          </View>

          <StepIndicator step={step} />

          {/* Step Title */}
          <FadeIn key={`title-${stepKey}`}>
            <View style={S.titleCard}>
              <Text style={S.title}>{titles[step]}</Text>
            </View>
          </FadeIn>

          {/* ── STEP 1: Personal ── */}
          {step === 1 && (
            <FadeIn key={`step1-${stepKey}`} delay={80}>
              <View style={S.formCard}>
                <UnderlineInput
                  label="FULL NAME"
                  value={name}
                  onChangeText={setName}
                  placeholder="Your full name"
                  autoCapitalize="words"
                />

                {/* Date of Birth */}
                <Text style={S.inputLabel}>DATE OF BIRTH</Text>
                <View style={S.dobRow}>
                  <TextInput
                    style={[S.underlineInput, { flex: 1, textAlign: "center" }]}
                    placeholder="DD"
                    placeholderTextColor="rgba(0,0,0,0.3)"
                    value={day}
                    onChangeText={t => setDay(t.replace(/\D/g, "").slice(0, 2))}
                    keyboardType="number-pad"
                    maxLength={2}
                  />
                  <TouchableOpacity
                    style={[S.underlineInput, { flex: 2, justifyContent: "center" }]}
                    onPress={() => setShowMonth(true)}
                    activeOpacity={0.7}
                  >
                    <Text style={{
                      color: month ? "#000" : "rgba(0,0,0,0.3)",
                      fontSize: 16,
                      textAlign: "center",
                    }}>
                      {month || "Month"}
                    </Text>
                  </TouchableOpacity>
                  <TextInput
                    style={[S.underlineInput, { flex: 1.2, textAlign: "center" }]}
                    placeholder="YYYY"
                    placeholderTextColor="rgba(0,0,0,0.3)"
                    value={year}
                    onChangeText={t => setYear(t.replace(/\D/g, "").slice(0, 4))}
                    keyboardType="number-pad"
                    maxLength={4}
                  />
                </View>

                <MonthPickerModal
                  visible={showMonth}
                  selected={month}
                  onSelect={setMonth}
                  onClose={() => setShowMonth(false)}
                />

                <UnderlineInput
                  label="EMAIL (OPTIONAL)"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="For account recovery"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />

                {/* Mobile with country code pill */}
                <Text style={S.inputLabel}>MOBILE NUMBER</Text>
                <View style={S.mobileRow}>
                  <TouchableOpacity
                    style={S.ccPill}
                    onPress={() => setShowCC(v => !v)}
                    activeOpacity={0.7}
                  >
                    <Text style={S.ccPillText}>{selected.flag}</Text>
                    <Text style={S.ccPillCode}>{cc}</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={[S.underlineInput, { flex: 1, marginBottom: 0 }]}
                    placeholder="Mobile number"
                    placeholderTextColor="rgba(0,0,0,0.3)"
                    value={mobile}
                    onChangeText={t => setMobile(t.replace(/\D/g, "").slice(0, 13))}
                    keyboardType="phone-pad"
                    maxLength={13}
                  />
                </View>

                {showCC && (
                  <View style={S.ccDropdown}>
                    {CODES.map(c => (
                      <TouchableOpacity
                        key={c.code}
                        style={S.ccDropdownItem}
                        onPress={() => { setCc(c.code); setShowCC(false); }}
                        activeOpacity={0.6}
                      >
                        <Text style={S.ccDropdownFlag}>{c.flag}</Text>
                        <Text style={S.ccDropdownName}>{c.name}</Text>
                        <Text style={S.ccDropdownCode}>{c.code}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Continue button */}
                <TouchableOpacity
                  style={[S.primaryBtn, (!name.trim() || !day || !month || !year || mobile.replace(/\D/g, "").length < 8) && S.btnDisabled]}
                  onPress={() => validateStep1() && goStep(2)}
                  disabled={!name.trim() || !day || !month || !year || mobile.replace(/\D/g, "").length < 8}
                  activeOpacity={0.85}
                >
                  <Text style={S.primaryBtnText}>Continue</Text>
                </TouchableOpacity>
              </View>
            </FadeIn>
          )}

          {/* ── STEP 2: Security Questions ── */}
          {step === 2 && (
            <FadeIn key={`step2-${stepKey}`} delay={80}>
              <View style={S.formCard}>
                <DropdownSelector
                  label="QUESTION 1"
                  selected={q1}
                  placeholder="Select a security question"
                  options={QUESTIONS}
                  onSelect={setQ1}
                  exclude={q2}
                />

                {q1 !== "" && (
                  <UnderlineInput
                    label="ANSWER 1"
                    value={a1}
                    onChangeText={setA1}
                    placeholder="Your answer"
                    autoCapitalize="none"
                  />
                )}

                <DropdownSelector
                  label="QUESTION 2"
                  selected={q2}
                  placeholder="Select a security question"
                  options={QUESTIONS}
                  onSelect={setQ2}
                  exclude={q1}
                />

                {q2 !== "" && (
                  <UnderlineInput
                    label="ANSWER 2"
                    value={a2}
                    onChangeText={setA2}
                    placeholder="Your answer"
                    autoCapitalize="none"
                  />
                )}

                {/* Info card */}
                <View style={S.infoCard}>
                  <Text style={S.infoCardText}>
                    Answers are case-insensitive and stored as a one-way encrypted hash. They can never be viewed in plain text.
                  </Text>
                </View>

                <View style={S.btnRow}>
                  <TouchableOpacity
                    style={S.backBtn}
                    onPress={() => goStep(1)}
                    activeOpacity={0.6}
                  >
                    <Text style={S.backBtnText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.primaryBtn, { flex: 1 }]}
                    onPress={() => validateStep2() && goStep(3)}
                    activeOpacity={0.85}
                  >
                    <Text style={S.primaryBtnText}>Continue</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </FadeIn>
          )}

          {/* ── STEP 3: 8-Digit PIN ── */}
          {step === 3 && (
            <FadeIn key={`step3-${stepKey}`} delay={80}>
              <View style={S.formCard}>
                <PINInput
                  value={pin}
                  onChangeText={setPin}
                  label="CREATE YOUR 8-DIGIT PIN"
                />

                <PINInput
                  value={confirm}
                  onChangeText={setConfirm}
                  label="CONFIRM YOUR PIN"
                />

                {/* Match indicator */}
                {pin.length === 8 && confirm.length === 8 && (
                  <Text style={[
                    S.matchText,
                    { color: pin === confirm ? "#22c55e" : "#ef4444" },
                  ]}>
                    {pin === confirm ? "PINs match" : "PINs do not match"}
                  </Text>
                )}

                {/* Info card */}
                <View style={S.infoCard}>
                  <Text style={S.infoCardText}>
                    This PIN cannot be reset without your security questions. Keep it somewhere safe.
                  </Text>
                </View>

                <View style={S.btnRow}>
                  <TouchableOpacity
                    style={S.backBtn}
                    onPress={() => goStep(2)}
                    activeOpacity={0.6}
                  >
                    <Text style={S.backBtnText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.primaryBtn, { flex: 1 }]}
                    onPress={handleFinish}
                    disabled={loading}
                    activeOpacity={0.85}
                  >
                    {loading ? (
                      <ActivityIndicator color="#000" />
                    ) : (
                      <Text style={S.primaryBtnText}>Create Account</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </FadeIn>
          )}

          {/* Google Sign-Up (only show on step 1) */}
          {step === 1 && (
            <>
              <View style={S.dividerRow}>
                <View style={S.dividerLine} />
                <Text style={S.dividerTxt}>or</Text>
                <View style={S.dividerLine} />
              </View>
              <TouchableOpacity style={S.googleBtn} onPress={handleGoogleSignUp} disabled={googleLoading} activeOpacity={0.85}>
                {googleLoading
                  ? <Text style={S.googleBtnTxt}>Signing up...</Text>
                  : <><Text style={S.googleIcon}>G</Text><Text style={S.googleBtnTxt}>Sign up with Google</Text></>
                }
              </TouchableOpacity>
            </>
          )}

          {/* Sign in link */}
          <TouchableOpacity
            style={S.signInRow}
            onPress={() => router.replace("/login")}
            activeOpacity={0.6}
          >
            <Text style={S.signInText}>
              Already have an account?{"  "}
              <Text style={S.signInLink}>Sign In</Text>
            </Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  topGlow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 200,
    zIndex: 0,
  },
  scroll: {
    // flexGrow: 1,
    // paddingHorizontal: 28,
    // paddingTop: Platform.OS === "ios" ? 64 : 48,
    // paddingBottom: 40,
  },

  // Header
  header: {
    marginBottom: 36,
  },
  brand: {
    color: "rgba(0,0,0,0.35)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 6,
  },

  // Step indicator (progress bar)
  stepContainer: {
    marginBottom: 40,
    alignItems: "center",
  },
  stepBar: {
    width: "80%",
    height: 4,
    backgroundColor: "rgba(0,0,0,0.1)",
    borderRadius: 2,
    overflow: "hidden",
  },
  stepProgress: {
    height: "100%",
    backgroundColor: "#000",
    borderRadius: 2,
  },
  stepText: {
    marginTop: 8,
    fontSize: 14,
    color: "rgba(0,0,0,0.6)",
    fontWeight: "600",
  },

  // Title
  title: {
    color: "#000",
    fontSize: 24,
    fontWeight: "800",
    padding:5
    // lineHeight: 40,
    // marginBottom: 40,
    // letterSpacing: -0.5,
  },

  // Section
  section: {
    marginBottom: 16,
  },
  formCard: {
    backgroundColor: "#F9F9F9",
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  titleCard: {
    backgroundColor: "#F0F0F0",
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 24,
    alignItems: "center",
  },

  // Input label
  inputLabel: {
    color: "rgba(0,0,0,0.4)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 2,
    marginBottom: 12,
  },

  // Underline input
  underlineInput: {
    color: "#000",
    fontSize: 16,
    fontWeight: "500",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.12)",
    marginBottom: 28,
  },

  // DOB row
  dobRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 28,
  },

  // Mobile row
  mobileRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 14,
    marginBottom: 28,
  },

  // Country code pill
  ccPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.15)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 2,
  },
  ccPillText: {
    color: "rgba(0,0,0,0.6)",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
  },
  ccPillCode: {
    color: "#000",
    fontSize: 14,
    fontWeight: "700",
  },

  // Country code dropdown
  ccDropdown: {
    backgroundColor: "#F5F5F5",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
    borderRadius: 12,
    marginBottom: 24,
    overflow: "hidden",
  },
  ccDropdownItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.05)",
  },
  ccDropdownFlag: {
    color: "rgba(0,0,0,0.5)",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    width: 28,
  },
  ccDropdownName: {
    color: "rgba(0,0,0,0.6)",
    fontSize: 14,
    flex: 1,
    marginLeft: 8,
  },
  ccDropdownCode: {
    color: "#000",
    fontSize: 14,
    fontWeight: "700",
  },

  // Dropdown selector
  dropdownBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.12)",
  },
  dropdownText: {
    flex: 1,
    color: "#000",
    fontSize: 14,
    fontWeight: "500",
  },
  dropdownChevron: {
    color: "rgba(0,0,0,0.3)",
    fontSize: 16,
    marginLeft: 8,
  },
  dropdownList: {
    backgroundColor: "#F5F5F5",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    borderRadius: 12,
    marginTop: 8,
    overflow: "hidden",
  },
  dropdownItem: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.04)",
  },
  dropdownItemText: {
    color: "rgba(0,0,0,0.5)",
    fontSize: 14,
  },

  // PIN
  pinRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 8,
  },
  pinSlot: {
    width: 32,
    height: 40,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 4,
  },
  pinDash: {
    width: 20,
    height: 2,
    backgroundColor: "rgba(0,0,0,0.15)",
    borderRadius: 1,
  },
  pinDotFilled: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#000",
  },

  // Match text
  matchText: {
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 24,
  },

  // Info card
  infoCard: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 32,
  },
  infoCardText: {
    color: "rgba(0,0,0,0.35)",
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "400",
  },

  // Buttons
  primaryBtn: {
    backgroundColor: "#000",
    borderRadius: 14,
    height: 56,
    justifyContent: "center",
    alignItems: "center",
  },
  btnDisabled: {
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  backBtn: {
    paddingHorizontal: 24,
    height: 56,
    justifyContent: "center",
    alignItems: "center",
  },
  backBtnText: {
    color: "rgba(0,0,0,0.4)",
    fontSize: 15,
    fontWeight: "600",
  },
  btnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  // Sign in
  signInRow: {
    alignItems: "center",
    marginTop: 28,
    marginBottom: 32,
  },
  signInText: {
    color: "rgba(0,0,0,0.35)",
    fontSize: 14,
  },
  signInLink: {
    color: "#000",
    fontWeight: "700",
  },

  // Month picker modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  modalContent: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 340,
  },
  modalTitle: {
    color: "#000",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 24,
    letterSpacing: -0.3,
  },
  monthGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  monthItem: {
    width: "30%" as any,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  monthItemActive: {
    backgroundColor: "#000",
    borderColor: "#000",
  },
  monthText: {
    color: "rgba(0,0,0,0.5)",
    fontSize: 14,
    fontWeight: "600",
  },
  monthTextActive: {
    color: "#FFFFFF",
    fontWeight: "700",
  },

  // Google + Divider
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 16, gap: 12, paddingHorizontal: 4 },
  dividerLine: { flex: 1, height: 1, backgroundColor: 'rgba(0,0,0,0.1)' },
  dividerTxt: { color: 'rgba(0,0,0,0.3)', fontSize: 13, fontWeight: '500' },
  googleBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 54, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1.5, borderColor: 'rgba(0,0,0,0.12)', gap: 10, marginBottom: 8 },
  googleIcon: { fontSize: 20, fontWeight: '700', color: '#4285F4' },
  googleBtnTxt: { color: '#000', fontSize: 16, fontWeight: '600' },
});
