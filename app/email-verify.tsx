// app/email-verify.tsx — new-user email OTP. Proves email ownership → emailTicket
// (required by /auth/profile/init). 6 visible digits.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { MpinInput } from '../components/auth/MpinInput';
import { onboarding, sendEmailOtp, verifyEmailOtp, onboardingError } from '../lib/onboarding';

export default function EmailVerify() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
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
      <Stack.Screen options={{ headerShown: false }} />
      <TouchableOpacity onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
      <View style={s.body}>
        <Text style={s.title}>Verify your email</Text>
        <Text style={s.sub}>Enter the 6-digit code we sent to{'\n'}<Text style={{ color: colors.text, fontWeight: '700' }}>{email}</Text></Text>

        <View style={{ marginVertical: 28 }}>
          <MpinInput value={code} onChange={setCode} onComplete={submit} secure={false} autoFocus />
        </View>

        {busy && <ActivityIndicator color={colors.primary} />}

        <TouchableOpacity onPress={resend} disabled={cooldown > 0} style={{ marginTop: 16 }}>
          <Text style={[s.resend, cooldown > 0 && { color: colors.textFaint }]}>
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Didn’t get it? Resend code'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  back: { paddingTop: 56, paddingHorizontal: 20 },
  backTxt: { color: c.text, fontSize: 26 },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center' },
  title: { color: c.text, fontSize: 24, fontWeight: '900', textAlign: 'center' },
  sub: { color: c.textDim, fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  resend: { color: c.primary, fontSize: 14, fontWeight: '700' },
});
