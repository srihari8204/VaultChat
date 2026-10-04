// app/mpin-entry.tsx — existing user enters their 6-digit MPIN.
// /auth/mpin/verify issues JWTs (server enforces 5-try / 15-min lockout) → Chats.
//
// This is the screen a returning user actually signs in on, so it carries the
// brand: same night ground and same lockup as app/onboard.tsx, with the mark
// alone rather than the full wordmark — by this point the app has already told
// you what it is called, and a second full logo three seconds later reads as a
// splash that failed to dismiss.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MpinInput } from '../components/auth/MpinInput';
import { onboarding, verifyMpinRemote, onboardingError } from '../lib/onboarding';
import { resetTo } from '../lib/authNav';
import { FRESH_OTP_MESSAGE, needsFreshOtp } from '../lib/otpFirstRoute';
import { openRestoreIfNewPhone } from '../lib/postSignIn';
import { AuthSky, BrandMark, KeyboardSafe } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

export default function MpinEntry() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [mpin, setMpin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 403 otp_required: the SMS proof from the number step has expired. Another
  // MPIN cannot fix that, so the way on is a fresh code (lib/otpFirstRoute).
  const [otpExpired, setOtpExpired] = useState(false);
  // A ref, not `busy`: SMS-style autofill and paste can complete the input
  // twice in one tick, and both calls would read busy === false.
  const inFlight = useRef(false);
  const shake = useRef(new Animated.Value(0)).current;

  const doShake = () => {
    shake.setValue(0);
    Animated.sequence([12, -12, 8, -8, 0].map(t =>
      Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start();
  };

  const submit = async (value: string) => {
    if (inFlight.current) return;
    // Reached without the number step (process death, a stale deep link):
    // there is no account to check the MPIN against, so say so and go back to
    // the start instead of silently doing nothing.
    if (!userId) { setMpin(''); setError('Enter your mobile number first.'); resetTo('/onboard'); return; }
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      await verifyMpinRemote(userId, value);
      onboarding.reset();
      // A phone with no chat history yet is offered the backup restore first
      // (lib/postSignIn.ts). Otherwise resetTo, not replace: the landing form
      // below this screen must not survive the sign-in (lib/authNav.ts).
      if (!(await openRestoreIfNewPhone())) resetTo('/(tabs)/chats');
    } catch (e: unknown) {
      setMpin('');
      if (needsFreshOtp(e)) { setOtpExpired(true); setError(FRESH_OTP_MESSAGE); return; }
      doShake();
      setError(onboardingError(e, 'Incorrect MPIN'));
    } finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <View style={s.screen}>
      <AuthSky />
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable
        onPress={() => router.back()}
        style={s.back}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        hitSlop={10}
      >
        <Ionicons name="arrow-back" size={24} color={AUTH.text} />
      </Pressable>

      <KeyboardSafe style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <BrandMark size={64} markOnly style={{ marginBottom: 4 }} />
        <Text style={s.title} accessibilityRole="header">Welcome back</Text>
        <Text style={s.sub}>Enter your 6-digit MPIN to unlock crazzychat</Text>

        {!otpExpired && <View style={{ marginVertical: 28 }}>
          <MpinInput value={mpin} onChange={setMpin} onComplete={submit} autoFocus shakeAnim={shake} onDark />
        </View>}

        {busy && <ActivityIndicator color={AUTH.accent} />}
        {/* accessibilityLiveRegion so the failure is announced rather than only
            shaken — the shake is the only other signal, and it is invisible to
            a screen reader. */}
        {!!error && (
          <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>
        )}

        {otpExpired && (
          // dismissTo: back to the number step below this screen, or onto it
          // when nothing is below (expo-router replaces in that case).
          <Pressable onPress={() => router.dismissTo('/onboard')} style={s.forgotHit} accessibilityRole="button">
            <Text style={s.forgot}>Verify your number again</Text>
          </Pressable>
        )}

        {/* Without a userId there is no account to recover: same guard as submit. */}
        {!otpExpired && <Pressable
          onPress={() => {
            if (!userId) { setError('Enter your mobile number first.'); resetTo('/onboard'); return; }
            router.push({ pathname: '/mpin-recover', params: { userId } });
          }}
          style={s.forgotHit}
          accessibilityRole="button"
          accessibilityHint="Reset your MPIN with your security questions"
        >
          <Text style={s.forgot}>Forgot MPIN?</Text>
        </Pressable>}
      </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingTop: HEADER_TOP, paddingHorizontal: 20, alignSelf: 'flex-start' },
  body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900' },
  sub: { color: AUTH.dim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  error: { color: AUTH.danger, fontSize: 13, marginTop: 14, textAlign: 'center', fontWeight: '600' },
  forgot: { color: AUTH.cyan, fontSize: 14, fontWeight: '700' },
  forgotHit: { marginTop: 24, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
});
