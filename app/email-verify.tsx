// app/email-verify.tsx — the SMS OTP step. Proves the MOBILE NUMBER is the
// user's → phoneTicket (required by /auth/profile/init). 6 visible digits.
//
// THE FILE NAME IS A LIE, ON PURPOSE, FOR NOW.
//
// Nothing about this screen is email any more — it verifies a phone. The path
// stays because lib/onboardNav.selftest.ts regex-matches raw source for
// `router.replace('/onboard-profile'` inside app/email-verify.tsx, and renaming
// the route in the same change as rewriting the flow would take the one guard
// that proves the chain still navigates correctly offline exactly when it is
// most needed. Rename it as its own commit, with the guard updated alongside.
//
// Pushed straight off app/onboard.tsx, so it stands on the same night ground and
// reads the same fixed palette rather than the app theme — a flip from navy to
// white one tap into a sign-up reads as a different app. See the always-dark
// note in components/ui/Brand.tsx.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { MpinInput } from '../components/auth/MpinInput';
import { Sheet } from '../components/ui/Sheet';
import {
  onboarding, resendPhoneOtp, verifyPhoneOtp, onboardingError, retryAfterSec, type OtpChannel,
} from '../lib/onboarding';
import { AuthSky } from '../components/ui';
import { AUTH } from '../constants/authTheme';

// All but the last four digits. Four is enough to catch "I typed my old SIM",
// and the whole number is one tap away behind Edit number.
const mask = (p: string) => p.replace(/\d(?=\d{4})/g, '•');

export default function EmailVerify() {
  const router = useRouter();
  const phone = onboarding.get().phone;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // The SERVER's cooldown, not a guessed 30 — a button that goes live early
  // spends one of the few allowed sends on a certain 429. app/onboard.tsx put
  // it here when it sent the first code.
  const [cooldown, setCooldown] = useState(onboarding.get().otpResendInSec);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const ticket = await verifyPhoneOtp(phone, value);
      onboarding.set({ phoneTicket: ticket });
      router.replace('/onboard-profile' as any);
    } catch (e: any) {
      setCode('');
      setErr(onboardingError(e, 'That code didn’t match. Check it and try again.'));
      // A lockout answers with the seconds to wait; run them down here rather
      // than leaving a live button over a door that is shut.
      const wait = retryAfterSec(e);
      if (wait) setCooldown(wait);
    } finally { setBusy(false); }
  };

  const resend = async (channel: OtpChannel = 'sms') => {
    if (cooldown > 0 || busy) return;
    setErr(null);
    try {
      setCooldown(await resendPhoneOtp(phone, channel));
    } catch (e: any) {
      setCooldown(retryAfterSec(e));               // 0 keeps the button live
      setErr(onboardingError(e, 'Could not send another code'));
    }
  };

  const waiting = cooldown > 0;
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
        <Text style={s.title}>Enter the 6-digit code</Text>
        <Text style={s.sub}>Sent by SMS to{'\n'}<Text style={s.phone}>{mask(phone)}</Text></Text>

        {/* Right under the number it corrects, which is where a wrong number is
            noticed. Back() rather than a push, so the landing screen comes back
            with the digits still in it. */}
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={s.editHit}>
          <Text style={s.edit}>Edit number</Text>
        </Pressable>

        {/* The code and its resend belong to one question, so they share one card. */}
        <View style={s.card}>
          <MpinInput value={code} onChange={setCode} onComplete={submit} secure={false} autoFocus onDark />

          {busy && <ActivityIndicator color={AUTH.accent} style={{ marginTop: 18 }} />}

          <Pressable
            onPress={() => resend()}
            disabled={waiting || busy}
            accessibilityRole="button"
            accessibilityLabel={waiting ? `Resend code in ${cooldown} seconds` : 'Resend code'}
            accessibilityState={{ disabled: waiting || busy }}
            style={s.resendHit}
          >
            <Text style={[s.resend, waiting && s.resendOff]}>
              {waiting ? `Resend code in ${cooldown}s` : 'Resend code'}
            </Text>
          </Pressable>
        </View>

        {/* accessibilityLiveRegion so a rejected code is announced, not just
            printed — the cells clearing is invisible to a screen reader. */}
        {!!err && <Text style={s.err} accessibilityLiveRegion="polite">{err}</Text>}

        <Pressable
          onPress={() => setSheet(true)}
          disabled={waiting}
          accessibilityRole="button"
          accessibilityLabel="Didn’t get the code? Other ways to receive it"
          accessibilityState={{ disabled: waiting }}
          style={s.altHit}
        >
          <Text style={[s.alt, waiting && s.resendOff]}>Didn’t get it?</Text>
        </Pressable>
      </View>

      {/* SMS is the one delivery that silently fails — a blocked sender ID, a
          roaming SIM, a DND list. Voice and WhatsApp are different carriers of
          the same code, so they are the escape hatch, not a second attempt. */}
      <Sheet
        visible={sheet}
        title="Didn’t get the code?"
        message="We can send the same code another way."
        actions={[
          { label: 'Call me with the code', icon: 'call-outline', onPress: () => resend('voice') },
          { label: 'Send it on WhatsApp', icon: 'logo-whatsapp', onPress: () => resend('whatsapp') },
        ]}
        onClose={() => setSheet(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingTop: HEADER_TOP, paddingHorizontal: 20, alignSelf: 'flex-start' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900', textAlign: 'center' },
  sub: { color: AUTH.dim, fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  phone: { color: AUTH.text, fontWeight: '700' },

  editHit: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 10 },
  edit: { color: AUTH.cyan, fontSize: 13, fontWeight: '700' },

  card: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: 20,
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

  err: { color: AUTH.danger, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 14 },

  altHit: { marginTop: 14, paddingVertical: 8, paddingHorizontal: 12 },
  alt: { color: AUTH.dim, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
});
