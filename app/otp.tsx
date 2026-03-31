/**
 * app/otp.tsx
 * OTP Verification — CRED-style premium UI
 * Auto-captures OTP from SMS via textContentType="oneTimeCode" + autoComplete
 * Supports clipboard paste detection for quick OTP entry
 */
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { sendOTP, verifyOTP } from './(constants)/authService';
import { markSetupComplete } from '../services/securityService';

export default function OTPScreen() {
  const { phone } = useLocalSearchParams();
  const router    = useRouter();

  const [otp,       setOtp]       = useState(['','','','','','']);
  const [loading,   setLoading]   = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const [canResend, setCanResend] = useState(false);
  const [error,     setError]     = useState('');
  const [autoDetected, setAutoDetected] = useState(false);

  const inputs = useRef<any[]>([]);
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(40)).current;
  const dotAnims = useRef([0,1,2].map(() => new Animated.Value(0))).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const successScale = useRef(new Animated.Value(0)).current;
  const appStateRef = useRef(AppState.currentState);

  // ── Entrance animation ─────────────────────────────────────────
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.spring(slideUp, { toValue: 0, tension: 60, friction: 12, useNativeDriver: true }),
    ]).start();
    const doInitialSend = async () => {
      try {
        setLoading(true);
        setError('');
        await sendOTP(phone as string);
      } catch (e: any) {
        setError(e?.message || 'Failed to send OTP');
      } finally {
        setLoading(false);
      }
    };
    doInitialSend();
  }, [fadeIn, slideUp, phone]);

  // ── Loading dots animation ─────────────────────────────────────
  useEffect(() => {
    if (!loading) return;
    const anims = dotAnims.map((dot, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 200),
        Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]))
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [loading, dotAnims]);

  // ── Countdown ──────────────────────────────────────────────────
  useEffect(() => {
    if (countdown <= 0) { setCanResend(true); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ── OTP Auto-capture: clipboard monitoring ─────────────────────
  // When user switches back from SMS app, check clipboard for 6-digit code
  useEffect(() => {
    const shakeInEffect = () => {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 15, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -15, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
    };
    const doVerify = async (code: string) => {
      try {
        setLoading(true);
        setError('');
        const ok = await verifyOTP(code);
        if (ok) {
          if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Animated.spring(successScale, { toValue: 1, tension: 50, friction: 8, useNativeDriver: true }).start();
          await markSetupComplete();
          setTimeout(() => router.replace('/(tabs)/chats' as any), 800);
        } else {
          shakeInEffect();
          setError('Invalid code. Try again.');
          setOtp(['','','','','','']);
          inputs.current[0]?.focus();
          if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      } catch (e: any) {
        shakeInEffect();
        setError(e?.message || 'Invalid code. Try again.');
        setOtp(['','','','','','']);
        inputs.current[0]?.focus();
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setLoading(false);
      }
    };
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        try {
          const clip = await Clipboard.getStringAsync();
          const match = clip?.match(/\b(\d{6})\b/);
          if (match && !autoDetected) {
            const digits = match[1].split('');
            setOtp(digits);
            setAutoDetected(true);
            if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            // Auto-verify after short delay
            setTimeout(() => doVerify(match[1]), 500);
          }
        } catch {}
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [autoDetected, router, successScale, shakeAnim]);

  // ── Send OTP ───────────────────────────────────────────────────
  const doSendOTP = async () => {
    try {
      setLoading(true);
      setError('');
      await sendOTP(phone as string);
    } catch (e: any) {
      setError(e?.message || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  // ── Resend ─────────────────────────────────────────────────────
  const handleResend = async () => {
    if (!canResend) return;
    setResending(true);
    setCanResend(false);
    setCountdown(30);
    setOtp(['','','','','','']);
    setAutoDetected(false);
    await doSendOTP();
    setResending(false);
  };

  // ── Handle digit input ─────────────────────────────────────────
  const handleChange = (val: string, idx: number) => {
    // Handle paste of full OTP
    if (val.length === 6 && /^\d{6}$/.test(val)) {
      const digits = val.split('');
      setOtp(digits);
      Keyboard.dismiss();
      doVerifyOTP(val);
      return;
    }
    if (!/^\d*$/.test(val)) return;
    const next = [...otp];
    next[idx] = val.slice(-1);
    setOtp(next);
    if (val && idx < 5) inputs.current[idx + 1]?.focus();
    if (!val && idx > 0) inputs.current[idx - 1]?.focus();
    if (next.every(d => d !== '') && val) {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      doVerifyOTP(next.join(''));
    }
  };

  // ── Handle key press for backspace ─────────────────────────────
  const handleKeyPress = (e: any, idx: number) => {
    if (e.nativeEvent.key === 'Backspace' && !otp[idx] && idx > 0) {
      const next = [...otp];
      next[idx - 1] = '';
      setOtp(next);
      inputs.current[idx - 1]?.focus();
    }
  };

  // ── Shake animation ────────────────────────────────────────────
  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -15, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  // ── Verify OTP ─────────────────────────────────────────────────
  const doVerifyOTP = async (code: string) => {
    try {
      setLoading(true);
      setError('');
      const ok = await verifyOTP(code);
      if (ok) {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Animated.spring(successScale, { toValue: 1, tension: 50, friction: 8, useNativeDriver: true }).start();
        await markSetupComplete();
        setTimeout(() => router.replace('/(tabs)/chats' as any), 800);
      } else {
        shake();
        setError('Invalid code. Try again.');
        setOtp(['','','','','','']);
        inputs.current[0]?.focus();
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (e: any) {
      shake();
      setError(e?.message || 'Invalid code. Try again.');
      setOtp(['','','','','','']);
      inputs.current[0]?.focus();
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = () => {
    const code = otp.join('');
    if (code.length < 6) { setError('Enter all 6 digits'); return; }
    doVerifyOTP(code);
  };

  const filledCount = otp.filter(d => d !== '').length;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
    >
      <View style={s.screen}>
        <Animated.View style={{ flex: 1, opacity: fadeIn, transform: [{ translateY: slideUp }] }}>

        {/* Back button */}
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>←</Text>
        </TouchableOpacity>

        <View style={s.content}>
          {/* Header */}
          <Text style={s.title}>Verify your{'\n'}number</Text>
          <Text style={s.subtitle}>
            Code sent to <Text style={s.phone}>{phone}</Text>
          </Text>

          {/* Auto-detect badge */}
          {autoDetected && (
            <View style={s.autoBadge}>
              <Text style={s.autoTxt}>Auto-detected from SMS</Text>
            </View>
          )}

          {/* OTP Boxes */}
          <Animated.View style={[s.otpRow, { transform: [{ translateX: shakeAnim }] }]}>
            {otp.map((digit, i) => (
              <View key={i} style={s.otpWrap}>
                <TextInput
                  ref={r => { inputs.current[i] = r; }}
                  style={[s.otpBox, digit ? s.otpBoxFilled : null]}
                  value={digit}
                  onChangeText={v => handleChange(v, i)}
                  onKeyPress={e => handleKeyPress(e, i)}
                  keyboardType="number-pad"
                  maxLength={6}
                  selectTextOnFocus
                  textContentType="oneTimeCode"
                  autoComplete={i === 0 ? 'sms-otp' as any : 'off'}
                />
                <View style={[s.otpLine, digit ? s.otpLineFilled : null]} />
              </View>
            ))}
          </Animated.View>

          {/* Error */}
          {error ? <Text style={s.error}>{error}</Text> : null}

          {/* Progress indicator */}
          <View style={s.progressRow}>
            {[0,1,2,3,4,5].map(i => (
              <View key={i} style={[s.progressDot, i < filledCount && s.progressDotFilled]} />
            ))}
          </View>

          {/* Verify button */}
          <TouchableOpacity
            style={[s.verifyBtn, filledCount < 6 && s.verifyBtnOff]}
            onPress={handleVerify}
            disabled={loading || filledCount < 6}
            activeOpacity={0.8}
          >
            {loading ? (
              <View style={s.dotsRow}>
                {dotAnims.map((dot, i) => (
                  <Animated.View key={i} style={[s.loadDot, { transform: [{ translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -8] }) }] }]} />
                ))}
              </View>
            ) : (
              <Text style={s.verifyTxt}>Verify</Text>
            )}
          </TouchableOpacity>

          {/* Resend */}
          <TouchableOpacity onPress={handleResend} disabled={!canResend || resending} style={s.resendBtn}>
            <Text style={[s.resendTxt, canResend && s.resendActive]}>
              {canResend ? 'Resend code' : `Resend in ${countdown}s`}
            </Text>
          </TouchableOpacity>

          {/* Change number */}
          <TouchableOpacity onPress={() => router.back()} style={s.changeBtn}>
            <Text style={s.changeTxt}>Change number</Text>
          </TouchableOpacity>
        </View>

        {/* Success overlay */}
        <Animated.View style={[s.successOverlay, {
          opacity: successScale,
          transform: [{ scale: successScale }],
        }]} pointerEvents="none">
          <View style={s.successCircle}>
            <Text style={s.successCheck}>✓</Text>
          </View>
          <Text style={s.successTxt}>Verified</Text>
        </Animated.View>

      </Animated.View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: '#FFFFFF' },
  backBtn:     { paddingTop: 56, paddingLeft: 24 },
  backTxt:     { color: '#000000', fontSize: 28, fontWeight: '200' },
  content:     { flex: 1, paddingHorizontal: 32, paddingTop: 40 },
  title:       { color: '#000000', fontSize: 36, fontWeight: '800', lineHeight: 44, marginBottom: 12 },
  subtitle:    { color: 'rgba(0,0,0,0.4)', fontSize: 15, marginBottom: 32, lineHeight: 22 },
  phone:       { color: '#000000', fontWeight: '700' },

  autoBadge:   { backgroundColor: 'rgba(16,185,129,0.12)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)' },
  autoTxt:     { color: '#10B981', fontSize: 12, fontWeight: '700' },

  otpRow:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12, gap: 12 },
  otpWrap:     { flex: 1, alignItems: 'center' },
  otpBox:      { width: '100%', height: 56, color: '#000000', fontSize: 28, fontWeight: '700', textAlign: 'center', backgroundColor: 'transparent' },
  otpBoxFilled:{},
  otpLine:     { width: '100%', height: 2, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 1 },
  otpLineFilled:{ backgroundColor: '#000000' },

  error:       { color: '#EF4444', fontSize: 13, marginBottom: 12 },

  progressRow: { flexDirection: 'row', gap: 6, marginBottom: 40, marginTop: 8 },
  progressDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(0,0,0,0.1)' },
  progressDotFilled: { backgroundColor: '#000000' },

  verifyBtn:   { backgroundColor: '#000000', borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginBottom: 24 },
  verifyBtnOff:{ opacity: 0.15 },
  verifyTxt:   { color: '#FFFFFF', fontSize: 17, fontWeight: '800' },

  dotsRow:     { flexDirection: 'row', gap: 6, height: 20, alignItems: 'center' },
  loadDot:     { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFFFFF' },

  resendBtn:   { alignItems: 'center', marginBottom: 16 },
  resendTxt:   { color: 'rgba(0,0,0,0.25)', fontSize: 14 },
  resendActive:{ color: 'rgba(0,0,0,0.7)' },

  changeBtn:   { alignItems: 'center' },
  changeTxt:   { color: 'rgba(0,0,0,0.25)', fontSize: 13 },

  successOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
  successCircle:  { width: 80, height: 80, borderRadius: 40, borderWidth: 2, borderColor: '#10B981', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  successCheck:   { color: '#10B981', fontSize: 36, fontWeight: '200' },
  successTxt:     { color: '#000000', fontSize: 24, fontWeight: '700' },
});
