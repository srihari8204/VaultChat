// app/email-verify.tsx — new-user email OTP. Proves email ownership → emailTicket
// (required by /auth/profile/init). 6 visible digits.
//
// Pushed straight off app/onboard.tsx, so it stands on the same night ground and
// reads the same fixed palette rather than the app theme — a flip from navy to
// white one tap into a sign-up reads as a different app. See the always-dark
// note in components/ui/Brand.tsx.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { MpinInput } from '../components/auth/MpinInput';
import { onboarding, sendEmailOtp, verifyEmailOtp, onboardingError } from '../lib/onboarding';
import { AuthSky } from '../components/ui';
import { AUTH } from '../constants/authTheme';

export default function EmailVerify() {
  const router = useRouter();
  const email = onboarding.get().email;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(30);   // a code was just sent from the landing

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const ticket = await verifyEmailOtp(email, value);
      onboarding.set({ emailTicket: ticket });
      router.replace('/onboard-profile' as any);
    } catch (e: any) {
      setCode('');
      Alert.alert('Wrong code', onboardingError(e, 'Check the code and try again'));
    } finally { setBusy(false); }
  };

  const resend = async () => {
    if (cooldown > 0) return;
    try { await sendEmailOtp(email); setCooldown(30); Alert.alert('Sent', 'A new code is on its way.'); }
    catch (e: any) { Alert.alert('Could not resend', onboardingError(e, 'Try again')); }
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

      <View style={s.body}>
        <Text style={s.title}>Verify your email</Text>
        <Text style={s.sub}>Enter the 6-digit code we sent to{'\n'}<Text style={s.email}>{email}</Text></Text>

        {/* The code and its resend belong to one question, so they share one
            card — the same grouping the landing form uses for mobile+email. */}
        <View style={s.card}>
          <MpinInput value={code} onChange={setCode} onComplete={submit} secure={false} autoFocus onDark />

          {busy && <ActivityIndicator color={AUTH.accent} style={{ marginTop: 18 }} />}

          <Pressable
            onPress={resend}
            disabled={cooldown > 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: cooldown > 0 }}
            style={s.resendHit}
          >
            <Text style={[s.resend, cooldown > 0 && s.resendOff]}>
              {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Didn’t get it? Resend code'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingTop: HEADER_TOP, paddingHorizontal: 20, alignSelf: 'flex-start' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900', textAlign: 'center' },
  sub: { color: AUTH.dim, fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  email: { color: AUTH.text, fontWeight: '700' },

  card: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: 28,
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
  },

  resendHit: { marginTop: 18, paddingVertical: 6 },
  // Cyan rather than the accent: a secondary action on this ground reads better
  // cool, and it is text on night, not white on cyan.
  resend: { color: AUTH.cyan, fontSize: 14, fontWeight: '700' },
  resendOff: { color: AUTH.faint },
});
