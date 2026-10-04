// app/onboard.tsx — Landing: MOBILE NUMBER ONLY → SMS OTP (/phone-verify) → branch.
//   exists  → /mpin-entry (existing user enters MPIN)
//   new     → profile → security → mpin → success
// The code comes FIRST for every number (R4BE C15): the ticket it earns is the
// proof of possession MPIN sign-in and recovery need (lib/otpFirstRoute).
//
// ONE FIELD, BECAUSE THERE IS ONE IDENTITY.
//
// This screen used to ask for an email beside the number and send the code to
// the inbox — which put a Google account, a reachable mail server and a
// well-behaved spam folder between a person and an app they were holding the
// SIM for. The number is the account now; email is optional recovery info
// collected two screens later. See the header of lib/onboarding.ts.
//
// Mounted auth screens follow the selected appearance; native splash artwork is unchanged.

import { Stack, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT_CTA } from '../constants/theme';
import { PhoneField, toE164 } from '../components/auth/PhoneField';
import { onboarding, sendPhoneOtp, onboardingError } from '../lib/onboarding';
import { AuthSky, BrandMark, KeyboardSafe } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

export default function OnboardLanding() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();

  const [dialCode, setDialCode] = useState('+91');
  const [national, setNational] = useState('');
  const [busy, setBusy] = useState(false);
  // Synchronous latch, as on the OTP screen: two taps inside one render both
  // saw busy === false and sent two lookups (and could send two SMS codes).
  const inFlight = useRef(false);

  const e164 = toE164(dialCode, national);
  const valid = !!e164;

  const onContinue = async () => {
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      // A ticket from an earlier number must never vouch for this one.
      onboarding.set({ phone: e164, phoneTicket: '' });
      // The cooldown rides in the store rather than a route param: the nav
      // self-test pins this call to `router.push('/phone-verify'` exactly.
      onboarding.set({ otpResendInSec: await sendPhoneOtp(e164) });
      router.push('/phone-verify' as any);
    } catch (e: any) {
      Alert.alert('Could not continue', onboardingError(e, 'Please try again'));
    } finally {
      inFlight.current = false;
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

          {/* The card stays even though it now holds one field: it is what
              stops the screen reading as a form with a logo parked above it,
              and the email half is gone, not moved. */}
          <View style={s.card}>
            <Text style={s.label} accessibilityElementsHidden importantForAccessibility="no">MOBILE NUMBER</Text>
            <PhoneField dialCode={dialCode} national={national} onChange={(d, n) => { setDialCode(d); setNational(n); }} onDark autoFocus />
          </View>

          {/* The one gradient on the screen, so it reads as THE action. Runs
              blue → violet rather than the logo's cyan → violet: cyan is
              1.63:1 against white and the label would vanish into it. */}
          <Pressable
            onPress={onContinue}
            disabled={!valid || busy}
            accessibilityRole="button"
            accessibilityLabel="Next, send a code to this number"
            accessibilityState={{ disabled: !valid || busy, busy }}
            style={({ pressed }) => [s.ctaWrap, !valid && s.ctaOff, pressed && valid && s.ctaDown]}
          >
            <LinearGradient
              colors={[...BRAND_GRADIENT_CTA]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={s.cta}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaTxt}>Next</Text>}
            </LinearGradient>
          </Pressable>

          <Text style={s.note}>We’ll send a 6-digit code by SMS to confirm this number is yours. Carrier charges may apply.</Text>
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { flexGrow: 1, padding: 24, paddingTop: 64, paddingBottom: 40, justifyContent: 'center' },

  card: {
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
  },
  label: {
    color: AUTH.dim, fontSize: 11, fontWeight: '800',
    letterSpacing: 1.2, marginBottom: 8,
  },

  ctaWrap: { marginTop: 24, borderRadius: 16, overflow: 'hidden' },
  // 2026-09-18: minHeight, not height. At OS font scale 1.5 the 16sp label
  // outgrew a pinned 56 and clipped on the very first screen of signup — a
  // large-text user could not read the button that creates their account. 56
  // stays the floor (well over the 44dp reach minimum) and the padding keeps
  // it identical at scale 1.0; it only grows when the label actually needs it.
  cta: { minHeight: 56, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.38 },
  ctaDown: { opacity: 0.88 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },

  note: {
    color: AUTH.faint, fontSize: 12, textAlign: 'center',
    marginTop: 18, lineHeight: 17,
  },
});
