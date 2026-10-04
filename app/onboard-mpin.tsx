// app/onboard-mpin.tsx — set a 6-digit MPIN, then confirm it. On match, commit the
// whole onboarding chain server-side: profile/init (encrypted PII) → security
// questions (argon2) → mpin/set (argon2, marks onboarding_complete). Then → success.
// Weak MPINs are rejected client-side too (server re-checks).
//
// Step 3 of 3, on the shared adaptive auth palette (lib/useAuthTheme).

import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MpinInput } from '../components/auth/MpinInput';
import { initProfile, onboarding, saveSecurityQuestions, setMpinRemote, onboardingError } from '../lib/onboarding';
import { AuthSky, BrandMark, KeyboardSafe, StepRail } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';
import { resetTo } from '../lib/authNav';
import { isWeakPin } from '../lib/weakPin';


export default function OnboardMpin() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const router = useRouter();

  const [phase, setPhase] = useState<'set' | 'confirm'>('set');
  const [first, setFirst] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;

  const dobYear = onboarding.get().dob ? onboarding.get().dob.slice(0, 4) : undefined;

  // BACK IS FINE UNTIL THE CONFIRM LANDS, AND FATAL AFTER IT.
  //
  // Nothing has been sent while the user is picking digits, so back to the
  // security questions is a legitimate correction — hence the arrow below.
  // Once onConfirm starts, three writes are in flight (profile/init → security
  // questions → mpin/set) and the screen that owns the redirect to
  // /onboard-success is this one: leaving mid-commit creates the account with
  // nobody to hand it to, and the retry then fails as "mobile number already
  // registered". So back is swallowed for those few seconds only.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => busy);
    return () => sub.remove();
  }, [busy]);

  const doShake = () => {
    shake.setValue(0);
    Animated.sequence([12, -12, 8, -8, 0].map(t =>
      Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start();
  };

  const onSet = (v: string) => {
    if (isWeakPin(v, 6, dobYear)) { setMsg('That MPIN is too easy to guess. Pick another.'); setFirst(''); doShake(); return; }
    setMsg(null); setPhase('confirm');
  };

  const onConfirm = async (v: string) => {
    if (v !== first) { setMsg('The confirmation didn’t match the first MPIN. Create it again.'); setConfirm(''); setFirst(''); setPhase('set'); doShake(); return; }
    setBusy(true); setMsg(null);
    try {
      const st = onboarding.get();
      // RESUME, DO NOT RESTART (2026-09-17).
      //
      // These three calls are sequential and NOT idempotent. The retry used to
      // re-run all of them, but initProfile consumes phoneTicket — so a network
      // drop after step 1 left an account with no MPIN, and every retry failed
      // with "already registered". Relaunching then routed to /mpin-entry, where
      // there was no MPIN to enter, and "Forgot MPIN?" found no security
      // questions if the drop happened between steps 1 and 2. The number could
      // never be registered again: an account its owner could neither finish
      // creating nor sign into.
      //
      // Persisting {userId, setupTicket} the instant step 1 returns lets the
      // retry skip it and pick up where it failed.
      let userId = st.userId;
      let setupTicket = st.setupTicket;
      if (!userId || !setupTicket) {
        // The store is RAM-only: after process death there is no verified
        // number to create an account with. Start over instead of a 400.
        if (!st.phone || !st.phoneTicket) {
          setBusy(false);
          onboarding.reset();
          Alert.alert('Sign-up expired', 'Please verify your number again.');
          resetTo('/onboard');
          return;
        }
        const created = await initProfile({
          phone: st.phone, phoneTicket: st.phoneTicket,
          email: st.email || undefined,           // optional recovery address, or nothing at all
          firstName: st.firstName, lastName: st.lastName, dob: st.dob, status: st.status,
          profilePicUrl: st.profilePicUrl,
        });
        userId = created.userId;
        setupTicket = created.setupTicket;
        onboarding.set({ userId, setupTicket });   // BEFORE the next call can fail
      }
      await saveSecurityQuestions(userId, setupTicket, st.securityAnswers);
      await setMpinRemote(userId, setupTicket, v);
      onboarding.set({ userId, mpin: v });                  // mpin kept (RAM) for the success login
      router.replace({ pathname: '/onboard-success', params: { userId } });
    } catch (e: unknown) {
      setBusy(false);
      setPhase('set'); setFirst(''); setConfirm('');
      Alert.alert('Could not finish setup', onboardingError(e, 'Please try again'));
    }
  };

  const setting = phase === 'set';
  return (
    <View style={s.screen}>
      <AuthSky />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !busy }} />
      {/* Step 3 of 3 had no back affordance at all — the only step in the chain
          without one, though returning to the questions is perfectly valid. */}
      {!busy && (
        <Pressable
          onPress={() => router.back()}
          style={s.back}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={24} color={AUTH.text} />
        </Pressable>
      )}
      <KeyboardSafe style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {/* The mark replaces the 🔐 emoji: a padlock glyph renders as whatever
            font the OS picked, which is three different pictures across phones. */}
        <BrandMark size={52} markOnly />
        <Text style={s.title} accessibilityRole="header">{setting ? 'Create your MPIN' : 'Confirm your MPIN'}</Text>
        <Text style={s.sub}>{setting ? 'A 6-digit PIN unlocks crazzychat' : 'Re-enter the same 6 digits'}</Text>
        <StepRail step={3} style={s.rail} />

        <View style={s.card}>
          {busy
            ? <ActivityIndicator color={AUTH.accent} size="large" />
            : setting
              ? <MpinInput key="set" value={first} onChange={setFirst} onComplete={onSet} autoFocus shakeAnim={shake} onDark label="New MPIN" />
              : <MpinInput key="confirm" value={confirm} onChange={setConfirm} onComplete={onConfirm} autoFocus shakeAnim={shake} onDark label="Confirm new MPIN" />}
        </View>

        {/* accessibilityLiveRegion so a rejected PIN is announced rather than
            only shaken — the shake is invisible to a screen reader. */}
        {!!msg && <Text style={s.msg} accessibilityLiveRegion="polite">{msg}</Text>}
        {busy && <Text style={s.sub}>Securing your account…</Text>}
      </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingHorizontal: 20, paddingTop: 8, alignSelf: 'flex-start' },
  // 56 dated from before this screen was in INSET_SCREENS, where the root
  // layout already pads the container by HEADER_TOP. The two stacked: 52 + 56
  // = 108dp of empty space above the title on the Honor (44dp inset), and a
  // back row sits between them as well. 32 is the design gap with the
  // status-bar allowance taken back out (2026-09-17).
  body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 32, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900' },
  sub: { color: AUTH.dim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  rail: { width: 132, marginTop: 14 },

  card: {
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

  msg: { color: AUTH.danger, fontSize: 13, marginTop: 8, textAlign: 'center', fontWeight: '600' },
});
