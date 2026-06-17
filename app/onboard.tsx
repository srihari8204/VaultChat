// app/onboard.tsx — Landing: mobile + email → /auth/lookup → branch.
//   exists  → /mpin-entry (existing user enters MPIN)
//   new     → email OTP (/email-verify) → profile → security → mpin → success
//
// Email comes from the Google account picker but stays editable; ownership is
// proven by the email OTP before any account is created.

import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform,
  ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { EmailAccountPicker } from '../components/auth/EmailAccountPicker';
import { PhoneField, toE164 } from '../components/auth/PhoneField';
import { lookupUser, onboarding, sendEmailOtp, onboardingError } from '../lib/onboarding';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function OnboardLanding() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [dialCode, setDialCode] = useState('+91');
  const [national, setNational] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const e164 = toE164(dialCode, national);
  const emailOk = EMAIL_RE.test(email.trim());
  const valid = !!e164 && emailOk;

  const onContinue = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const cleanEmail = email.trim().toLowerCase();
      onboarding.set({ email: cleanEmail, phone: e164 });
      const r = await lookupUser(cleanEmail, e164);
      if (r.exists && r.userId) {
        router.push({ pathname: '/mpin-entry', params: { userId: r.userId } } as any);
      } else if (r.conflict === 'phone') {
        Alert.alert('Mobile already registered', 'This mobile number is already registered with another email account. Use that email, or a different mobile number.');
      } else if (r.conflict === 'email') {
        Alert.alert('Email already registered', 'This email is already registered with another mobile number. Use that mobile number, or a different email.');
      } else {
        await sendEmailOtp(cleanEmail);
        router.push('/email-verify' as any);
      }
    } catch (e: any) {
      Alert.alert('Could not continue', onboardingError(e, 'Please try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View style={s.logoWrap}>
            <Image source={require('../assets/images/icon.png')} style={s.logo} />
            <Text style={s.brand}>VaultChat</Text>
            <Text style={s.tag}>Private by design</Text>
          </View>

          <Text style={s.label}>MOBILE NUMBER</Text>
          <PhoneField dialCode={dialCode} national={national} onChange={(d, n) => { setDialCode(d); setNational(n); }} />

          <Text style={[s.label, { marginTop: 20 }]}>EMAIL</Text>
          <EmailAccountPicker
            email={email}
            onEmailChange={setEmail}
            onAccountPicked={(a) => onboarding.set({ firstName: a.firstName, lastName: a.lastName, profilePicUrl: a.photoURL })}
          />

          <TouchableOpacity
            style={[s.cta, !valid && s.ctaOff]}
            onPress={onContinue}
            disabled={!valid || busy}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaTxt}>Sign In / Continue</Text>}
          </TouchableOpacity>

          <Text style={s.note}>We’ll text nothing — a one-time code goes to your email to confirm it’s you.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  body: { flexGrow: 1, padding: 24, paddingTop: 72, justifyContent: 'center' },
  logoWrap: { alignItems: 'center', marginBottom: 40 },
  logo: { width: 72, height: 72, borderRadius: 18, marginBottom: 14 },
  brand: { color: c.text, fontSize: 28, fontWeight: '900', letterSpacing: 0.5 },
  tag: { color: c.textDim, fontSize: 13, marginTop: 4 },
  label: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginBottom: 8 },
  cta: { marginTop: 32, height: 56, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  note: { color: c.textFaint, fontSize: 12, textAlign: 'center', marginTop: 18, lineHeight: 17 },
});
