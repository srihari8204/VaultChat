/**
 * app/otp.tsx — 6-digit OTP verification (Obsidian Aurora).
 *
 * Works for phone (flow='phone' → verifyPhoneOTP) and email (flow='login' /
 * 'signup' → verifyOTP). Auto-advance, auto-submit on the 6th digit, 30s
 * resend timer, and SMS-clipboard auto-detect. Routes new users to profile
 * setup, existing users to the app. No permission prompts.
 */
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator, Animated, AppState, Keyboard, KeyboardAvoidingView,
  Platform, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  clearPendingSignup, getPendingSignup, savePIN, saveUserProfile,
  sendOTP, verifyOTP, sendPhoneOTP, verifyPhoneOTP, hasPIN,
} from './(constants)/authService';
import { markSetupComplete } from '../services/securityService';
import AsyncStorage from '@react-native-async-storage/async-storage';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function OTPScreen() {
  const { colors } = useTheme();
  const s = useS();
  const { phone, flow } = useLocalSearchParams<{ phone: string; flow?: string }>();
  const router = useRouter();
  const isPhone = flow === 'phone';
  const target = (phone as string) ?? '';

  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);

  const inputs = useRef<any[]>([]);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const appStateRef = useRef(AppState.currentState);

  // ── Countdown for resend ───────────────────────────────────────
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ── SMS clipboard auto-detect on return-to-foreground ──────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active' && !autoDetected) {
        try {
          const clip = await Clipboard.getStringAsync();
          const m = clip?.match(/\b(\d{6})\b/);
          if (m) {
            setOtp(m[1].split(''));
            setAutoDetected(true);
            if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setTimeout(() => verify(m[1]), 350);
          }
        } catch {}
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDetected]);

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  // ── Verify ─────────────────────────────────────────────────────
  const verify = async (code: string) => {
    if (loading || done) return;
    setLoading(true);
    setError('');
    try {
      let isNewUser = false;
      if (isPhone) {
        const r = await verifyPhoneOTP(target, code);
        if (!r?.user) throw new Error('Verification failed');
        isNewUser = !!r.isNewUser;
      } else {
        const ok = await submitEmailFlow(target, code, flow === 'signup');
        if (!ok) throw new Error('Invalid code');
      }

      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);

      // Route: new users finish profile setup → MPIN; existing users go
      // through the MPIN gate (set one if they never have, else enter it).
      const pinSet = await hasPIN().catch(() => false);
      setTimeout(() => {
        if (isPhone && isNewUser) {
          router.replace({ pathname: '/profile-setup', params: { phone: target } } as any);
        } else if (pinSet) {
          router.replace('/enter-mpin' as any);
        } else {
          markSetupComplete().catch(() => {});
          router.replace('/set-mpin' as any);
        }
      }, 650);
    } catch (e: any) {
      shake();
      setError(e?.message || 'Invalid code. Try again.');
      setOtp(['', '', '', '', '', '']);
      inputs.current[0]?.focus();
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  };

  // ── Input handling ─────────────────────────────────────────────
  const onChange = (val: string, idx: number) => {
    if (val.length === 6 && /^\d{6}$/.test(val)) { // full paste
      setOtp(val.split(''));
      Keyboard.dismiss();
      verify(val);
      return;
    }
    if (!/^\d*$/.test(val)) return;
    const next = [...otp];
    next[idx] = val.slice(-1);
    setOtp(next);
    if (val && idx < 5) inputs.current[idx + 1]?.focus();
    if (next.every(d => d !== '')) {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      verify(next.join(''));
    }
  };

  const onKey = (e: any, idx: number) => {
    if (e.nativeEvent.key === 'Backspace' && !otp[idx] && idx > 0) {
      const next = [...otp];
      next[idx - 1] = '';
      setOtp(next);
      inputs.current[idx - 1]?.focus();
    }
  };

  const resend = async () => {
    if (countdown > 0) return;
    setOtp(['', '', '', '', '', '']);
    setAutoDetected(false);
    setError('');
    setCountdown(30);
    try {
      if (isPhone) await sendPhoneOTP(target);
      else await sendOTP(target);
      inputs.current[0]?.focus();
    } catch (e: any) {
      setError(e?.message || 'Failed to resend code');
    }
  };

  const filled = otp.filter(d => d !== '').length;

  if (done) {
    return (
      <View style={[s.screen, s.center]}>
        <View style={s.successCircle}><Text style={s.successCheck}>✓</Text></View>
        <Text style={s.successTxt}>Verified</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View style={s.screen}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>←</Text>
        </TouchableOpacity>

        <View style={s.content}>
          <Text style={s.title}>Verify your{'\n'}{isPhone ? 'number' : 'email'}</Text>
          <Text style={s.subtitle}>Code sent to <Text style={s.target}>{target}</Text></Text>

          {autoDetected && (
            <View style={s.autoBadge}><Text style={s.autoTxt}>Auto-detected from SMS</Text></View>
          )}

          <Animated.View style={[s.otpRow, { transform: [{ translateX: shakeAnim }] }]}>
            {otp.map((digit, i) => (
              <View key={i} style={s.otpWrap}>
                <TextInput
                  ref={r => { inputs.current[i] = r; }}
                  style={[s.otpBox, digit ? s.otpBoxFilled : null]}
                  value={digit}
                  onChangeText={v => onChange(v, i)}
                  onKeyPress={e => onKey(e, i)}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoFocus={i === 0}
                  selectTextOnFocus
                  textContentType="oneTimeCode"
                  autoComplete={i === 0 ? ('sms-otp' as any) : 'off'}
                  selectionColor={colors.primary}
                />
                <View style={[s.otpLine, digit ? s.otpLineFilled : null]} />
              </View>
            ))}
          </Animated.View>

          {error ? <Text style={s.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[s.verifyBtn, filled < 6 && s.verifyOff]}
            onPress={() => verify(otp.join(''))}
            disabled={loading || filled < 6}
            activeOpacity={0.85}
          >
            {loading ? <ActivityIndicator color="#04130D" /> : <Text style={s.verifyTxt}>Verify</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={resend} disabled={countdown > 0} style={s.resendBtn}>
            <Text style={[s.resendTxt, countdown === 0 && s.resendActive]}>
              {countdown > 0 ? `Resend code in ${countdown}s` : 'Resend code'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// Email login/signup path (kept for existing flows): verify + finish any
// pending signup profile/PIN saved by the multi-step email signup screen.
async function submitEmailFlow(email: string, code: string, isSignup: boolean): Promise<boolean> {
  let name: string | undefined;
  let pending = null as Awaited<ReturnType<typeof getPendingSignup>>;
  if (isSignup) { pending = await getPendingSignup(); name = pending?.name; }
  const result = await verifyOTP(email, code, name);
  if (!result?.user) return false;
  if (isSignup) {
    if (pending) { try { await saveUserProfile(pending); } catch {} }
    try {
      const pendingPin = await AsyncStorage.getItem('vc_pending_pin');
      if (pendingPin) { await savePIN(pendingPin); await AsyncStorage.removeItem('vc_pending_pin').catch(() => {}); }
    } catch {}
    await clearPendingSignup();
  }
  return true;
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  backBtn: { paddingTop: 56, paddingLeft: 24, width: 80 },
  backTxt: { color: c.text, fontSize: 28, fontWeight: '300' },
  content: { flex: 1, paddingHorizontal: 28, paddingTop: 32 },

  title: { color: c.text, fontSize: 30, fontWeight: '800', lineHeight: 36, marginBottom: 10 },
  subtitle: { color: c.textDim, fontSize: 14, marginBottom: 28 },
  target: { color: c.text, fontWeight: '700' },

  autoBadge: { alignSelf: 'flex-start', backgroundColor: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.3)', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 18 },
  autoTxt: { color: c.primary, fontSize: 12, fontWeight: '700' },

  otpRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginBottom: 14 },
  otpWrap: { flex: 1, alignItems: 'center' },
  otpBox: { width: '100%', height: 58, textAlign: 'center', color: c.text, fontSize: 26, fontWeight: '700' },
  otpBoxFilled: {},
  otpLine: { width: '100%', height: 2, borderRadius: 1, backgroundColor: c.border },
  otpLineFilled: { backgroundColor: c.primary },

  error: { color: c.danger, fontSize: 13, marginBottom: 12 },

  verifyBtn: { height: 56, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginTop: 18, marginBottom: 18 },
  verifyOff: { opacity: 0.35 },
  verifyTxt: { color: '#04130D', fontSize: 16, fontWeight: '800' },

  resendBtn: { alignItems: 'center' },
  resendTxt: { color: c.textFaint, fontSize: 14 },
  resendActive: { color: c.text },

  successCircle: { width: 84, height: 84, borderRadius: 42, borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  successCheck: { color: c.primary, fontSize: 40, fontWeight: '300' },
  successTxt: { color: c.text, fontSize: 22, fontWeight: '800' },
});
