import { AppText as Text } from '../components/ui/Text';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
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
// Auth appearance follows the selected app theme.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, ScrollView, View } from 'react-native';
import { MpinInput } from '../components/auth/MpinInput';
import { Sheet } from '../components/ui/Sheet';
import {
  onboarding, resendPhoneOtp, verifyPhoneOtp, onboardingError, retryAfterSec, type OtpChannel,
} from '../lib/onboarding';
import { AuthSky } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

// All but the last four digits. Four is enough to catch "I typed my old SIM",
// and the whole number is one tap away behind Edit number.
const mask = (p: string) => p.replace(/\d(?=\d{4})/g, '•');

export default function EmailVerify() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();
  const phone = onboarding.get().phone;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The in-flight latch, and it is a REF because `busy` cannot do this job.
   *
   * `busy` is render-closure state. Two onChangeText events in the SAME tick —
   * which is exactly what Android's SMS autofill produces, and what paste-then-
   * complete produces — both read `busy === false` and both POST. The first
   * verify consumes the request id server-side, so the second comes back 400
   * `code_expired` AFTER the screen has already navigated away, having also
   * spent one of the five allowed attempts. A ref is written synchronously, so
   * the second call in the same tick sees it.
   */
  const inFlight = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // The SERVER's cooldown, not a guessed 30 — a button that goes live early
  // spends one of the few allowed sends on a certain 429. app/onboard.tsx put
  // it here when it sent the first code.
  const [cooldown, setCooldownState] = useState(onboarding.get().otpResendInSec);
  /**
   * WALL CLOCK, not a chain of setTimeouts.
   *
   * A `setTimeout(… c - 1, 1000)` chain only advances while JS is running, and
   * the OS suspends timers on a backgrounded app — but the SERVER's 30 seconds
   * keep passing. Come back after two minutes and the button still read
   * "Resend code in 22s" over a door that had been open the whole time. The
   * deadline is absolute, so returning to the screen re-derives the truth.
   */
  const deadline = useRef(Date.now() + onboarding.get().otpResendInSec * 1000);
  const setCooldown = useCallback((sec: number) => {
    deadline.current = Date.now() + Math.max(0, sec) * 1000;
    setCooldownState(Math.max(0, sec));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      const left = Math.ceil((deadline.current - Date.now()) / 1000);
      setCooldownState(left > 0 ? left : 0);
    }, 500);
    return () => clearInterval(id);
  }, [cooldown]);

  const submit = async (value: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
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
    } finally { inFlight.current = false; setBusy(false); }
  };

  const resend = async (channel: OtpChannel = 'sms') => {
    // Same latch, same reason: two fast taps both passed `cooldown > 0` before
    // either had set it, and the second earned a certain 429.
    if (cooldown > 0 || inFlight.current) return;
    inFlight.current = true;
    setErr(null);
    try {
      setCooldown(await resendPhoneOtp(phone, channel));
    } catch (e: any) {
      setCooldown(retryAfterSec(e));               // 0 keeps the button live
      setErr(onboardingError(e, 'Could not send another code'));
    } finally { inFlight.current = false; }
  };

  // The onboarding store is RAM-only (lib/onboarding.ts). After process death,
  // or a deep link straight here, there is no number to verify — start over
  // rather than POST an empty phone.
  const noPhone = !phone;
  useEffect(() => { if (noPhone) router.replace('/onboard' as any); }, [noPhone, router]);

  const waiting = cooldown > 0;
  if (noPhone) return <View style={s.screen}><AuthSky /></View>;
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

      <KeyboardSafe keyboardOnly>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
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
          <MpinInput value={code} onChange={setCode} onComplete={submit} secure={false} autoFocus onDark label="Verification code" />

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
      </ScrollView>
      </KeyboardSafe>

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

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingTop: HEADER_TOP, paddingHorizontal: 20, alignSelf: 'flex-start' },
  body: { flexGrow: 1, paddingBottom: 32, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900', textAlign: 'center' },
  sub: { color: AUTH.dim, fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  phone: { fontSize: 14, color: AUTH.text, fontWeight: '700' },

  editHit: { minHeight: 44, justifyContent: 'center', marginTop: 8, paddingVertical: 6, paddingHorizontal: 10 },
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

  resendHit: { minHeight: 44, justifyContent: 'center', marginTop: 18, paddingVertical: 6 },
  // Cyan rather than the accent: a secondary action on this ground reads better
  // cool, and it is text on night, not white on cyan.
  resend: { color: AUTH.cyan, fontSize: 14, fontWeight: '700' },
  resendOff: { color: AUTH.faint },

  err: { color: AUTH.danger, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 14 },

  altHit: { minHeight: 44, justifyContent: 'center', marginTop: 14, paddingVertical: 8, paddingHorizontal: 12 },
  alt: { color: AUTH.dim, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
});
