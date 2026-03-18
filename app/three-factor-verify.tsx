/**
 * app/three-factor-verify.tsx
 * 3-Factor Device Verification screen for VaultChat.
 *
 * Flow:
 *   Step 1 — Face scan (expo-camera CameraView front-facing, scanning brackets animation)
 *   Step 2 — Biometric prompt (fingerprint / Face ID via expo-local-authentication)
 *   Step 3 — Secret code entry (8-char alphanumeric verified against SecureStore hash)
 *   Success — Green checkmark animation, then navigate to /chats
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

// ── colours ────────────────────────────────────────────────────
const C = {
  bg: '#060E1E',
  panel: '#0D1F3C',
  cyan: '#00E5FF',
  green: '#00FF9D',
  coral: '#FF4D6D',
  white: '#FFFFFF',
  muted: '#7BA7C4',
  dark: '#030A14',
};

const { width: SW, height: SH } = Dimensions.get('window');
const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;
const CODE_LEN = 8;

// ── step enum ──────────────────────────────────────────────────
type Step = 1 | 2 | 3;

// ── scanning brackets component ────────────────────────────────
function ScanBrackets({ pulse }: { pulse: Animated.Value }) {
  const sz = SW * 0.64;
  const corners = [
    { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
    { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
    { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
    { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  ] as const;

  return (
    <View style={{ width: sz, height: sz * 1.28, position: 'relative' }}>
      {corners.map((c, i) => (
        <Animated.View
          key={i}
          style={[
            {
              position: 'absolute',
              width: 34,
              height: 34,
              borderColor: C.cyan,
              borderStyle: 'solid',
              opacity: pulse,
            },
            c,
          ]}
        />
      ))}
    </View>
  );
}

// ── scan line animation ────────────────────────────────────────
function ScanLine({ anim }: { anim: Animated.Value }) {
  const sz = SW * 0.64;
  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, sz * 1.28 - 4],
  });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: sz,
        height: 2,
        backgroundColor: C.cyan,
        opacity: 0.8,
        transform: [{ translateY }],
      }}
    />
  );
}

// ── progress bar ───────────────────────────────────────────────
function ProgressBar({ step }: { step: Step | 'done' }) {
  const fraction = step === 'done' ? 1 : (step - 1) / 3;
  const widthAnim = useRef(new Animated.Value(fraction)).current;

  useEffect(() => {
    const target = step === 'done' ? 1 : (step - 1) / 3;
    Animated.timing(widthAnim, {
      toValue: target,
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [step]);

  return (
    <View style={styles.progressOuter}>
      <Animated.View
        style={[
          styles.progressInner,
          {
            width: widthAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
            backgroundColor: step === 'done' ? C.green : C.cyan,
          },
        ]}
      />
    </View>
  );
}

// ── main component ─────────────────────────────────────────────
export default function ThreeFactorVerifyScreen() {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [code, setCode] = useState('');
  const [cameraPermission, requestPermission] = useCameraPermissions();

  // animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const successScale = useRef(new Animated.Value(0)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  const hiddenInputRef = useRef<TextInput>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── pulse animation for brackets ────────────────────────────
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // ── scan line animation ─────────────────────────────────────
  useEffect(() => {
    if (step !== 1) return;
    const loop = Animated.loop(
      Animated.timing(scanLineAnim, {
        toValue: 1,
        duration: 2000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [step]);

  // ── step 1: request camera permission and auto-progress ─────
  useEffect(() => {
    if (step !== 1) return;

    if (!cameraPermission?.granted) {
      requestPermission();
    }

    scanTimerRef.current = setTimeout(() => {
      transitionTo(2);
    }, 3000);

    return () => {
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
  }, [step, cameraPermission?.granted]);

  // ── step 2: biometric prompt ────────────────────────────────
  useEffect(() => {
    if (step !== 2) return;

    const runBiometric = async () => {
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();

        if (!hasHardware || !enrolled) {
          setError('Biometric hardware not available');
          return;
        }

        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'VaultChat — Verify Your Identity',
          cancelLabel: 'Cancel',
          fallbackLabel: 'Use passcode',
          disableDeviceFallback: false,
        });

        if (result.success) {
          setError('');
          transitionTo(3);
        } else {
          setError('Biometric verification failed. Try again.');
        }
      } catch (e) {
        setError('Biometric error. Please try again.');
      }
    };

    // slight delay so the UI settles
    const t = setTimeout(runBiometric, 600);
    return () => clearTimeout(t);
  }, [step]);

  // ── step transition with fade ───────────────────────────────
  const transitionTo = useCallback(
    (next: Step) => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        setStep(next);
        setError('');
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    },
    [fadeAnim]
  );

  // ── step 3: verify secret code ──────────────────────────────
  const verifyCode = useCallback(async (input: string) => {
    if (input.length !== CODE_LEN) return;

    try {
      const stored = await SecureStore.getItemAsync('vc_secret_code_hash');
      if (!stored) {
        setError('No secret code configured. Please set up first.');
        return;
      }

      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        input
      );

      if (hash === stored) {
        setError('');
        showSuccess();
      } else {
        setError('Incorrect code. Please try again.');
        setCode('');
      }
    } catch (e) {
      setError('Verification error. Please try again.');
      setCode('');
    }
  }, []);

  // ── success animation ───────────────────────────────────────
  const showSuccess = useCallback(() => {
    setDone(true);
    Animated.parallel([
      Animated.spring(successScale, {
        toValue: 1,
        friction: 4,
        tension: 60,
        useNativeDriver: true,
      }),
      Animated.timing(successOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setTimeout(() => {
        router.replace('/chats');
      }, 1200);
    });
  }, []);

  // ── handle code input ───────────────────────────────────────
  const onCodeChange = useCallback(
    (text: string) => {
      const clean = text.replace(/[^A-Za-z0-9]/g, '').slice(0, CODE_LEN);
      setCode(clean);
      if (clean.length === CODE_LEN) {
        Keyboard.dismiss();
        verifyCode(clean);
      }
    },
    [verifyCode]
  );

  // ── retry biometric ─────────────────────────────────────────
  const retryBiometric = useCallback(async () => {
    setError('');
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'VaultChat — Verify Your Identity',
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use passcode',
      disableDeviceFallback: false,
    });
    if (result.success) {
      transitionTo(3);
    } else {
      setError('Biometric verification failed. Try again.');
    }
  }, [transitionTo]);

  // ── render: success overlay ─────────────────────────────────
  if (done) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <ProgressBar step="done" />

        <Animated.View
          style={[
            styles.successContainer,
            {
              opacity: successOpacity,
              transform: [{ scale: successScale }],
            },
          ]}
        >
          <View style={styles.checkCircle}>
            <Text style={styles.checkMark}>✓</Text>
          </View>
          <Text style={styles.successTitle}>Verified</Text>
          <Text style={styles.successSub}>All 3 factors confirmed</Text>
        </Animated.View>
      </View>
    );
  }

  // ── render: steps ───────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* progress */}
      <View style={styles.header}>
        <ProgressBar step={step} />
        <Text style={styles.stepLabel}>
          Step {step} of 3
        </Text>
      </View>

      <Animated.View style={[styles.body, { opacity: fadeAnim }]}>
        {/* ── STEP 1: Face Scan ──────────────────────────────── */}
        {step === 1 && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Face Scan</Text>
            <Text style={styles.subtitle}>
              Position your face within the frame
            </Text>

            <View style={styles.cameraWrap}>
              {cameraPermission?.granted ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="front"
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: C.dark }]} />
              )}
              <View style={styles.bracketOverlay}>
                <ScanBrackets pulse={pulseAnim} />
                <ScanLine anim={scanLineAnim} />
              </View>
            </View>

            <Text style={styles.hint}>Scanning…</Text>
          </View>
        )}

        {/* ── STEP 2: Biometric ──────────────────────────────── */}
        {step === 2 && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Biometric Verification</Text>
            <Text style={styles.subtitle}>
              Authenticate with fingerprint or Face ID
            </Text>

            <View style={styles.biometricIcon}>
              <Animated.View
                style={{
                  opacity: pulseAnim,
                }}
              >
                <Text style={styles.fingerprint}>⏿</Text>
              </Animated.View>
            </View>

            {error ? (
              <>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={retryBiometric}
                  activeOpacity={0.7}
                >
                  <Text style={styles.retryBtnText}>Retry</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.hint}>Waiting for biometric…</Text>
            )}
          </View>
        )}

        {/* ── STEP 3: Secret Code ────────────────────────────── */}
        {step === 3 && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Secret Code</Text>
            <Text style={styles.subtitle}>
              Enter your 8-character secret code
            </Text>

            {/* hidden input */}
            <TextInput
              ref={hiddenInputRef}
              style={styles.hiddenInput}
              value={code}
              onChangeText={onCodeChange}
              maxLength={CODE_LEN}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="ascii-capable"
              secureTextEntry
            />

            {/* visible boxes */}
            <TouchableOpacity
              style={styles.codeRow}
              activeOpacity={0.9}
              onPress={() => hiddenInputRef.current?.focus()}
            >
              {Array.from({ length: CODE_LEN }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.codeBox,
                    i < code.length && styles.codeBoxFilled,
                    error ? styles.codeBoxError : null,
                  ]}
                >
                  {i < code.length && (
                    <Text style={styles.codeDot}>●</Text>
                  )}
                </View>
              ))}
            </TouchableOpacity>

            {error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : (
              <Text style={styles.hint}>
                {code.length}/{CODE_LEN} characters
              </Text>
            )}
          </View>
        )}
      </Animated.View>
    </View>
  );
}

// ── styles ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
    paddingTop: TOP,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  progressOuter: {
    height: 4,
    backgroundColor: C.panel,
    borderRadius: 2,
    overflow: 'hidden',
    marginHorizontal: 24,
    marginTop: 16,
  },
  progressInner: {
    height: '100%',
    borderRadius: 2,
  },
  stepLabel: {
    color: C.muted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 10,
    fontWeight: '500',
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepContainer: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: {
    color: C.white,
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: C.muted,
    fontSize: 15,
    marginBottom: 32,
    textAlign: 'center',
  },
  hint: {
    color: C.cyan,
    fontSize: 14,
    marginTop: 24,
    fontWeight: '500',
  },

  // camera
  cameraWrap: {
    width: SW * 0.64,
    height: SW * 0.64 * 1.28,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: C.dark,
  },
  bracketOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // biometric
  biometricIcon: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: C.panel,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: C.cyan,
  },
  fingerprint: {
    fontSize: 56,
    color: C.cyan,
  },

  // code
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 0,
    width: 0,
  },
  codeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  codeBox: {
    width: 38,
    height: 48,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: C.panel,
    backgroundColor: C.dark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  codeBoxFilled: {
    borderColor: C.cyan,
  },
  codeBoxError: {
    borderColor: C.coral,
  },
  codeDot: {
    color: C.cyan,
    fontSize: 18,
  },

  // error
  errorText: {
    color: C.coral,
    fontSize: 14,
    marginTop: 20,
    textAlign: 'center',
    fontWeight: '500',
  },

  // retry
  retryBtn: {
    marginTop: 16,
    backgroundColor: C.panel,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.cyan,
  },
  retryBtnText: {
    color: C.cyan,
    fontSize: 15,
    fontWeight: '600',
  },

  // success
  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: C.green,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  checkMark: {
    fontSize: 52,
    color: C.bg,
    fontWeight: '700',
    marginTop: -4,
  },
  successTitle: {
    color: C.green,
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  successSub: {
    color: C.muted,
    fontSize: 15,
  },
});
