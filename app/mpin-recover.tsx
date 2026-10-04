// app/mpin-recover.tsx — Forgot MPIN. Phase 1: answer your security questions
// (≥3 must match) → recovery ticket. Phase 2: set + confirm a new 6-digit MPIN
// (weak rejected) → logged in → Chats.
//
// Reached from app/mpin-entry.tsx and app/app-lock.tsx; uses the shared
// adaptive auth palette (lib/useAuthTheme).

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT_CTA } from '../constants/theme';
import { questionLabel } from '../constants/securityQuestionPool';
import { MpinInput } from '../components/auth/MpinInput';
import {
  getRecoveryQuestions, verifyRecoveryAnswers, recoverMpin, onboarding, onboardingError,
} from '../lib/onboarding';
import { AuthSky, BrandMark, KeyboardSafe } from '../components/ui';
import { openRestoreIfNewPhone } from '../lib/postSignIn';
import { resetTo } from '../lib/authNav';
import { FRESH_OTP_MESSAGE, needsFreshOtp } from '../lib/otpFirstRoute';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';
import { isWeakPin } from '../lib/weakPin';

export default function MpinRecover() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();

  const [phase, setPhase] = useState<'loading' | 'loadError' | 'answer' | 'setmpin'>('loading');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [ticket, setTicket] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 403 otp_required on the question load or the answer check (the two
  // possession-gated calls; /auth/mpin/recover is not gated): the SMS proof
  // expired; only a fresh code (the number step) helps, so "Try again" would
  // only repeat the refusal.
  const [otpExpired, setOtpExpired] = useState(false);
  // onConfirm's latch: the MPIN input can complete twice in one tick, and the
  // second recoverMpin would spend the recovery ticket's only use.
  const inFlight = useRef(false);
  // verify's latch: `busy` is state, so two taps in one frame both passed it
  // and sent the answers twice, spending two attempts.
  const verifying = useRef(false);

  // set-mpin phase
  const [mpinPhase, setMpinPhase] = useState<'set' | 'confirm'>('set');
  const [first, setFirst] = useState('');
  const [confirm, setConfirm] = useState('');
  const shake = useRef(new Animated.Value(0)).current;
  const doShake = () => {
    shake.setValue(0);
    Animated.sequence([12, -12, 8, -8, 0].map(t => Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start();
  };

  // A failed load stays on this screen with a retry: being thrown back to the
  // MPIN screen by a dropped connection left no way to try again from here.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    setPhase('loading'); setError(null);
    try {
      const qs = await getRecoveryQuestions(userId);
      if (!alive.current) return;
      if (!qs.length) { Alert.alert('No questions', 'No security questions are set for this account.'); router.back(); return; }
      setQuestions(qs); setPhase('answer');
    } catch (e: any) {
      if (!alive.current) return;
      setOtpExpired(needsFreshOtp(e));
      setError(needsFreshOtp(e) ? FRESH_OTP_MESSAGE : onboardingError(e, 'Could not load your security questions.'));
      setPhase('loadError');
    }
  }, [router, userId]);
  useEffect(() => { void load(); }, [load]);

  const filled = questions.filter(q => (answers[q] ?? '').trim().length >= 2).length;

  const verify = async () => {
    if (verifying.current) return;
    verifying.current = true;
    setBusy(true); setError(null);
    try {
      const payload = questions
        .filter(q => (answers[q] ?? '').trim())
        // Trimmed, as the filter above judged it: a stray space typed after an
        // answer must not make a right answer wrong.
        .map(q => ({ questionCode: q, answer: (answers[q] ?? '').trim() }));
      const t = await verifyRecoveryAnswers(userId, payload);
      setTicket(t); setPhase('setmpin');
    } catch (e: any) {
      if (needsFreshOtp(e)) { setOtpExpired(true); setError(FRESH_OTP_MESSAGE); setPhase('loadError'); return; }
      setError(onboardingError(e, 'Answers don’t match'));
    } finally { verifying.current = false; setBusy(false); }
  };

  const onSet = (v: string) => { if (isWeakPin(v)) { setError('That MPIN is too easy to guess.'); setFirst(''); doShake(); return; } setError(null); setMpinPhase('confirm'); };
  const onConfirm = async (v: string) => {
    if (inFlight.current) return;
    if (v !== first) { setError('The confirmation didn’t match the new MPIN. Create it again.'); setConfirm(''); setFirst(''); setMpinPhase('set'); doShake(); return; }
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      await recoverMpin(userId, ticket, v);
      onboarding.reset();
      // Not router.replace: /onboard and /mpin-entry must not stay under Chats,
      // and a new phone gets the restore offer (lib/postSignIn.ts).
      if (!(await openRestoreIfNewPhone())) resetTo('/(tabs)/chats');
    } catch (e: any) {
      inFlight.current = false;
      setBusy(false); setMpinPhase('set'); setFirst(''); setConfirm('');
      // Inline, under the PIN cells, in the live region the other errors use.
      setError(onboardingError(e, 'Couldn’t reset your MPIN. Choose it again to retry.'));
    }
  };

  const canVerify = filled >= 3 && !busy;

  return (
    <View style={s.screen}>
      <AuthSky />
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Pressable
            onPress={() => router.back()}
            style={s.back}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={10}
          >
            <Ionicons name="arrow-back" size={24} color={AUTH.text} />
          </Pressable>

          {phase === 'loading' && <ActivityIndicator color={AUTH.accent} style={{ marginTop: 80 }} accessibilityLabel="Loading your security questions" />}

          {phase === 'loadError' && (
            <View style={s.head}>
              <BrandMark size={52} markOnly />
              <Text style={s.title} accessibilityRole="header">Reset your MPIN</Text>
              {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
              <Pressable
                // dismissTo: back to the number step, or onto it when it is not
                // in the stack (expo-router replaces then).
                onPress={() => { if (otpExpired) router.dismissTo('/onboard'); else void load(); }}
                accessibilityRole="button"
                style={({ pressed }) => [s.ctaWrap, s.retryWrap, pressed && s.ctaDown]}
              >
                <LinearGradient colors={[...BRAND_GRADIENT_CTA]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.cta}>
                  <Text style={s.ctaTxt}>{otpExpired ? 'Verify your number again' : 'Try again'}</Text>
                </LinearGradient>
              </Pressable>
            </View>
          )}

          {phase === 'answer' && (
            <>
              <View style={s.head}>
                <BrandMark size={52} markOnly />
                <Text style={s.title} accessibilityRole="header">Reset your MPIN</Text>
                <Text style={s.sub}>Answer at least 3 of your security questions.</Text>
              </View>

              {/* All the questions in one card — they are one proof of identity,
                  not a list of unrelated fields. */}
              <View style={s.card}>
                {questions.map((q, i) => (
                  <View key={q} style={s.qBlock}>
                    <Text style={s.qLabel}>{i + 1}. {questionLabel(q)}</Text>
                    <TextInput
                      style={s.input}
                      value={answers[q] ?? ''}
                      onChangeText={(t) => { setAnswers(prev => ({ ...prev, [q]: t })); setError(null); }}
                      placeholder="Your answer"
                      placeholderTextColor={AUTH.faint}
                      autoCapitalize="none" autoCorrect={false} secureTextEntry
                      accessibilityLabel={`Answer to: ${questionLabel(q)}`}
                    />
                  </View>
                ))}
              </View>

              {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}

              <Pressable
                onPress={verify}
                disabled={!canVerify}
                accessibilityRole="button"
                accessibilityLabel="Verify your answers"
                accessibilityState={{ disabled: !canVerify, busy }}
                style={({ pressed }) => [s.ctaWrap, filled < 3 && s.ctaOff, pressed && canVerify && s.ctaDown]}
              >
                <LinearGradient
                  colors={[...BRAND_GRADIENT_CTA]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={s.cta}
                >
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaTxt}>Verify ({filled}/3+)</Text>}
                </LinearGradient>
              </Pressable>
            </>
          )}

          {phase === 'setmpin' && (
            <View style={s.head}>
              <BrandMark size={52} markOnly />
              <Text style={s.title} accessibilityRole="header">{mpinPhase === 'set' ? 'New MPIN' : 'Confirm MPIN'}</Text>
              <Text style={s.sub}>{mpinPhase === 'set' ? 'Choose a new 6-digit PIN' : 'Re-enter to confirm'}</Text>

              <View style={s.pinCard}>
                {busy ? <ActivityIndicator color={AUTH.accent} size="large" />
                  : mpinPhase === 'set'
                    ? <MpinInput key="set" value={first} onChange={setFirst} onComplete={onSet} autoFocus shakeAnim={shake} onDark label="New MPIN" />
                    : <MpinInput key="confirm" value={confirm} onChange={setConfirm} onComplete={onConfirm} autoFocus shakeAnim={shake} onDark label="Confirm new MPIN" />}
              </View>

              {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
            </View>
          )}
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 24, paddingTop: HEADER_TOP, paddingBottom: 48 },
  back: { marginBottom: 8, alignSelf: 'flex-start' },

  head: { alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900' },
  sub: { color: AUTH.dim, fontSize: 14, marginTop: 8, textAlign: 'center' },

  card: {
    alignSelf: 'stretch',
    marginTop: 20,
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    paddingBottom: 2,      // the last question block carries its own margin
  },
  qBlock: { marginBottom: 16 },
  qLabel: { color: AUTH.dim, fontSize: 13, fontWeight: '600', marginBottom: 6, lineHeight: 18 },
  // Fainter than the card it sits in: card-on-card at the same alpha reads as a
  // rendering bug rather than a field.
  input: {
    minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: AUTH.stroke,
    backgroundColor: AUTH.hairline, paddingHorizontal: 14, paddingVertical: 12,
    color: AUTH.text, fontSize: 15,
  },

  pinCard: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 104,
    marginVertical: 28,
    backgroundColor: AUTH.card,
    borderColor: AUTH.stroke,
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
  },

  error: { color: AUTH.danger, fontSize: 13, marginTop: 10, textAlign: 'center', fontWeight: '600' },

  ctaWrap: { marginTop: 20, borderRadius: 16, overflow: 'hidden' },
  retryWrap: { alignSelf: 'stretch' },
  // 2026-09-18: minHeight, not height, for the same reason `input` above is
  // minHeight. At font scale 1.5 the 16sp label outgrew a pinned 56 and
  // clipped — on the one screen that exists to get a locked-out user back in.
  // 56 stays the floor and the padding keeps it identical at scale 1.0.
  cta: { minHeight: 56, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.38 },
  ctaDown: { opacity: 0.88 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
});
