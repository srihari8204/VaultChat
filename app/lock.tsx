// app/lock.tsx — CRED-inspired premium lock screen
// Pure black, massive typography, glassmorphic elements, platinum accents

import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { recordAuthTime } from "../services/lockService";

// CRED palette
const CLR = {
  black: "#000000",
  white: "#FFFFFF",
  silver: "#A0A0A0",
  silverLight: "#C0C0C0",
  silverDim: "#666666",
  red: "#FF4444",
  cardBg: "rgba(255,255,255,0.04)",
  cardBorder: "rgba(255,255,255,0.08)",
  dotActive: "#FFFFFF",
  dotInactive: "rgba(255,255,255,0.15)",
};

type Stage = "scanning" | "code" | "locked";

export default function LockScreen() {
  const [stage, setStage] = useState<Stage>("scanning");
  const [code, setCode] = useState("");
  const [fails, setFails] = useState(0);
  const [error, setError] = useState("");
  const [time, setTime] = useState("");

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const ringRotate = useRef(new Animated.Value(0)).current;
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;

  // Clock
  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // Entry fade animation
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, {
        toValue: 1,
        duration: 800,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slideUp, {
        toValue: 0,
        duration: 800,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeIn, slideUp]);

  // Pulse animation for scan ring
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // Subtle ring rotation
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(ringRotate, {
        toValue: 1,
        duration: 8000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [ringRotate]);

  // Auto-trigger biometric
  useEffect(() => {
    const handleFailInEffect = () => {
      const next = fails + 1;
      setFails(next);
      if (next >= 5) {
        setStage("locked");
        setError("Too many attempts. Locked for 30 minutes.");
      }
    };
    const handleBiometric = async () => {
      if (Platform.OS === 'web') { setStage("code"); return; }
      setStage("scanning");
      setError("");
      try {
        const supported = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (!supported || !enrolled) {
          setStage("code");
          return;
        }

        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: "Scan your face to open crazzychat",
          fallbackLabel: "Use Secret Code",
          cancelLabel: "Cancel",
          disableDeviceFallback: false,
        });

        if (result.success) {
          await recordAuthTime();
          router.replace("/(tabs)/chats");
        } else if ((result as any).error === "user_fallback") {
          setStage("code");
        } else {
          handleFailInEffect();
        }
      } catch {
        setStage("code");
      }
    };
    setTimeout(() => handleBiometric(), 400);
  }, [fails]);

  const handleBiometric = async () => {
    if (Platform.OS === 'web') { setStage("code"); return; }
    setStage("scanning");
    setError("");
    try {
      const supported = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!supported || !enrolled) {
        setStage("code");
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Scan your face to open crazzychat",
        fallbackLabel: "Use Secret Code",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });

      if (result.success) {
        await recordAuthTime();
        router.replace("/(tabs)/chats");
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
    if (code.length < 4) {
      setError("Enter your secret code (4-8 digits)");
      return;
    }
    try {
      // Check PIN first (4-6 digits)
      const { verifyPIN } = await import("./(constants)/authService");
      const pinOk = await verifyPIN(code);
      if (pinOk) {
        await recordAuthTime();
        router.replace("/(tabs)/chats");
        return;
      }

      // Check 8-digit secret code
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        code.toUpperCase() + "vc_secret_salt_v1"
      );
      const stored = await SecureStore.getItemAsync("vc_secret_code_hash");
      if (stored && hash === stored) {
        await recordAuthTime();
        router.replace("/(tabs)/chats");
        return;
      }

      // If no PIN and no secret code set, allow first-time access
      const { hasPIN } = await import("./(constants)/authService");
      const hasPin = await hasPIN();
      const hasSecret = !!stored;
      if (!hasPin && !hasSecret) {
        // First-time user — no PIN set yet, let them in
        await recordAuthTime();
        router.replace("/(tabs)/chats");
        return;
      }

      handleFail();
      setCode("");
      setError("Wrong code. Try again.");
    } catch {
      setError("Verification failed. Try again.");
    }
  };

  const handleFail = () => {
    const next = fails + 1;
    setFails(next);
    if (next >= 5) {
      setStage("locked");
      setError("Too many attempts. Locked for 30 minutes.");
    }
  };

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const spin = ringRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <View style={S.bg}>
      <Animated.View
        style={[
          S.container,
          {
            opacity: fadeIn,
            transform: [{ translateY: slideUp }],
          },
        ]}
      >
        {/* Time Display */}
        <View style={S.clockWrap}>
          <Text style={S.clock}>{time}</Text>
          <Text style={S.date}>{today}</Text>
        </View>

        {/* Scanning Stage */}
        {stage === "scanning" && (
          <>
            <TouchableOpacity onPress={handleBiometric} activeOpacity={0.8}>
              <Animated.View
                style={[
                  S.ringOuter,
                  {
                    transform: [{ scale: pulseAnim }, { rotate: spin }],
                  },
                ]}
              >
                <View style={S.ringDashes}>
                  {/* Decorative arc segments */}
                  {[0, 90, 180, 270].map((deg) => (
                    <View
                      key={deg}
                      style={[
                        S.arcSegment,
                        {
                          transform: [{ rotate: `${deg}deg` }],
                        },
                      ]}
                    />
                  ))}
                </View>
                <View style={S.ringInner}>
                  <View style={S.scanCircle}>
                    {/* Clean scan icon — concentric rings */}
                    <View style={S.scanIconOuter}>
                      <View style={S.scanIconMiddle}>
                        <View style={S.scanIconCore} />
                      </View>
                    </View>
                  </View>
                </View>
              </Animated.View>
            </TouchableOpacity>

            <Text style={S.appName}>crazzychat</Text>
            <Text style={S.hint}>Scan face to unlock</Text>

            <View style={S.actionGroup}>
              {/* Fingerprint button */}
              <TouchableOpacity
                style={S.fingerprintBtn}
                onPress={handleBiometric}
                activeOpacity={0.7}
              >
                <View style={S.fingerprintCircle}>
                  <Text style={S.fingerprintIcon}>Use Fingerprint</Text>
                </View>
              </TouchableOpacity>

              {/* Enter Code */}
              <TouchableOpacity
                style={S.enterCodeBtn}
                onPress={() => setStage("code")}
                activeOpacity={0.7}
              >
                <Text style={S.enterCodeTxt}>Enter Code</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Code Entry Stage */}
        {stage === "code" && (
          <View style={S.codeSection}>
            <Text style={S.appName}>crazzychat</Text>
            <Text style={S.codeLabel}>Enter 8-digit Secret Code</Text>

            {/* Dot indicators */}
            <View style={S.dotsRow}>
              {Array(8)
                .fill(0)
                .map((_, i) => (
                  <View key={i} style={S.dotWrapper}>
                    <View
                      style={[
                        S.dot,
                        i < code.length ? S.dotFilled : S.dotEmpty,
                        i === 3 && { marginRight: 16 },
                      ]}
                    />
                    <View
                      style={[
                        S.dotLine,
                        i < code.length ? S.dotLineFilled : S.dotLineEmpty,
                        i === 3 && { marginRight: 16 },
                      ]}
                    />
                  </View>
                ))}
            </View>

            <TextInput
              style={S.hiddenInput}
              value={code}
              onChangeText={(t) => {
                setCode(
                  t
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, "")
                    .slice(0, 8)
                );
                setError("");
              }}
              autoFocus
              autoCapitalize="characters"
              maxLength={8}
              caretHidden
            />

            {!!error && <Text style={S.error}>{error}</Text>}

            {/* Verify Button */}
            <TouchableOpacity
              style={[S.verifyBtn, code.length < 8 && S.verifyOff]}
              onPress={handleCodeVerify}
              disabled={code.length < 8}
              activeOpacity={0.85}
            >
              <Text style={S.verifyTxt}>Verify</Text>
            </TouchableOpacity>

            {/* Back */}
            <TouchableOpacity
              onPress={() => {
                setStage("scanning");
                setCode("");
                setError("");
              }}
              activeOpacity={0.7}
              style={S.backBtn}
            >
              <Text style={S.backTxt}>Back to Face Scan</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Locked Stage */}
        {stage === "locked" && (
          <View style={S.lockedSection}>
            <View style={S.lockedIconWrap}>
              <View style={S.lockedCircle}>
                <Text style={S.lockedX}>X</Text>
              </View>
            </View>
            <Text style={[S.appName, { color: CLR.red }]}>Account Locked</Text>
            <Text style={S.hint}>{error}</Text>
          </View>
        )}

        {/* Attempt counter */}
        {fails > 0 && fails < 5 && stage !== "locked" && (
          <Text style={S.failCount}>
            {5 - fails} attempt{5 - fails !== 1 ? "s" : ""} remaining
          </Text>
        )}
      </Animated.View>
    </View>
  );
}

const S = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: CLR.black,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },

  // Clock
  clockWrap: {
    alignItems: "center",
    marginBottom: 48,
  },
  clock: {
    color: CLR.white,
    fontSize: 72,
    fontWeight: "100",
    letterSpacing: 4,
    lineHeight: 80,
  },
  date: {
    color: CLR.silver,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 1,
    marginTop: 8,
  },

  // Scan Ring
  ringOuter: {
    width: 160,
    height: 160,
    borderRadius: 80,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 24,
  },
  ringDashes: {
    position: "absolute",
    width: 160,
    height: 160,
  },
  arcSegment: {
    position: "absolute",
    top: 0,
    left: 56,
    width: 48,
    height: 2,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 1,
  },
  ringInner: {
    width: 148,
    height: 148,
    borderRadius: 74,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  scanCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: "center",
    alignItems: "center",
  },
  scanIconOuter: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.25)",
    justifyContent: "center",
    alignItems: "center",
  },
  scanIconMiddle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  scanIconCore: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.3)",
  },

  // Labels
  appName: {
    color: CLR.white,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 2,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  hint: {
    color: CLR.silver,
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.5,
    marginBottom: 40,
  },

  // Action buttons
  actionGroup: {
    alignItems: "center",
    gap: 20,
  },
  fingerprintBtn: {
    alignItems: "center",
  },
  fingerprintCircle: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  fingerprintIcon: {
    color: CLR.silverLight,
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.5,
  },
  enterCodeBtn: {
    paddingVertical: 8,
  },
  enterCodeTxt: {
    color: CLR.silver,
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.5,
  },

  // Code entry
  codeSection: {
    alignItems: "center",
    width: "100%",
  },
  codeLabel: {
    color: CLR.silverDim,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.5,
    marginBottom: 32,
  },
  dotsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
    alignItems: "center",
  },
  dotWrapper: {
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  dotFilled: {
    backgroundColor: CLR.white,
  },
  dotEmpty: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.15)",
  },
  dotLine: {
    width: 24,
    height: 1.5,
    borderRadius: 1,
  },
  dotLineFilled: {
    backgroundColor: "rgba(255,255,255,0.4)",
  },
  dotLineEmpty: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  hiddenInput: {
    position: "absolute",
    opacity: 0,
    width: 1,
    height: 1,
  },
  error: {
    color: CLR.red,
    fontSize: 13,
    fontWeight: "400",
    textAlign: "center",
    marginTop: 8,
    marginBottom: 4,
  },
  verifyBtn: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: CLR.white,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 28,
  },
  verifyOff: {
    opacity: 0.25,
  },
  verifyTxt: {
    color: CLR.black,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 1,
  },
  backBtn: {
    marginTop: 20,
    paddingVertical: 8,
  },
  backTxt: {
    color: CLR.silver,
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.3,
  },

  // Locked
  lockedSection: {
    alignItems: "center",
    gap: 16,
  },
  lockedIconWrap: {
    marginBottom: 8,
  },
  lockedCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: CLR.red,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,68,68,0.06)",
  },
  lockedX: {
    color: CLR.red,
    fontSize: 32,
    fontWeight: "200",
  },

  // Fail counter
  failCount: {
    position: "absolute",
    bottom: 48,
    color: "rgba(255,68,68,0.7)",
    fontSize: 12,
    fontWeight: "400",
    letterSpacing: 0.5,
  },
});
