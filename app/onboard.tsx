// app/onboard.tsx — Landing: mobile + email → /auth/lookup → branch.
//   exists  → /mpin-entry (existing user enters MPIN)
//   new     → email OTP (/email-verify) → profile → security → mpin → success
//
// Email comes from the Google account picker but stays editable; ownership is
// proven by the email OTP before any account is created.
//
// THE SCREEN IS THE SPLASH, CONTINUED.
//
// It stands on AuthSky — the same #010628 ground and the same blue/violet
// lighting as assets/images/splash.png — so the hand-off from the native splash
// is a form fading in over artwork that never moved, rather than a cut to a
// different screen. That is also why nothing here reads the app palette: see
// the always-dark note in components/ui/Brand.tsx.

import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT_CTA } from '../constants/theme';
import { EmailAccountPicker } from '../components/auth/EmailAccountPicker';
import { PhoneField, toE164 } from '../components/auth/PhoneField';
import { lookupUser, onboarding, sendEmailOtp, onboardingError } from '../lib/onboarding';
import { AuthSky, BrandMark, KeyboardSafe } from '../components/ui';
import { AUTH } from '../constants/authTheme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function OnboardLanding() {
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
      <AuthSky />
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <BrandMark size={92} tagline style={{ marginBottom: 34 }} />

          {/* ONE CARD, NOT TWO LOOSE FIELDS. The pair is a single question —
              "who are you" — and boxing them together is what stops the screen
              reading as a form with a logo parked above it. */}
          <View style={s.card}>
            <Text style={s.label}>MOBILE NUMBER</Text>
            <PhoneField dialCode={dialCode} national={national} onChange={(d, n) => { setDialCode(d); setNational(n); }} onDark />

            <View style={s.rule} />

            <Text style={s.label}>EMAIL</Text>
            <EmailAccountPicker
              email={email}
              onEmailChange={setEmail}
              onAccountPicked={(a) => onboarding.set({ firstName: a.firstName, lastName: a.lastName })}
              onDark
            />
          </View>

          {/* The one gradient on the screen, so it reads as THE action. Runs
              blue → violet rather than the logo's cyan → violet: cyan is
              1.63:1 against white and the label would vanish into it. */}
          <Pressable
            onPress={onContinue}
            disabled={!valid || busy}
            accessibilityRole="button"
            accessibilityLabel="Sign in or create an account"
            accessibilityState={{ disabled: !valid || busy, busy }}
            style={({ pressed }) => [s.ctaWrap, !valid && s.ctaOff, pressed && valid && s.ctaDown]}
          >
            <LinearGradient
              colors={[...BRAND_GRADIENT_CTA]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={s.cta}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaTxt}>Sign In / Continue</Text>}
            </LinearGradient>
          </Pressable>

          <Text style={s.note}>We’ll text nothing — a one-time code goes to your email to confirm it’s you.</Text>
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { flexGrow: 1, padding: 24, paddingTop: 64, paddingBottom: 40, justifyContent: 'center' },

  card: {
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
  },
  // Separates the two fields without the weight of a full divider row.
  rule: { height: 1, backgroundColor: AUTH.hairline, marginVertical: 18 },

  label: {
    color: AUTH.dim, fontSize: 11, fontWeight: '800',
    letterSpacing: 1.2, marginBottom: 8,
  },

  ctaWrap: { marginTop: 24, borderRadius: 16, overflow: 'hidden' },
  cta: { height: 56, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.38 },
  ctaDown: { opacity: 0.88 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },

  note: {
    color: AUTH.faint, fontSize: 12, textAlign: 'center',
    marginTop: 18, lineHeight: 17,
  },
});
