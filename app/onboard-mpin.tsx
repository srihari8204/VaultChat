// app/onboard-mpin.tsx — set a 6-digit MPIN, then confirm it. On match, commit the
// whole onboarding chain server-side: profile/init (encrypted PII) → security
// questions (argon2) → mpin/set (argon2, marks onboarding_complete). Then → success.
// Weak MPINs are rejected client-side too (server re-checks).

import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { MpinInput } from '../components/auth/MpinInput';
import { initProfile, onboarding, saveSecurityQuestions, setMpinRemote, onboardingError } from '../lib/onboarding';
import { AuroraBackground } from '../components/ui';

function isWeak(m: string, dobYear?: string): boolean {
  if (!/^\d{6}$/.test(m)) return true;
  if (/^(\d)\1{5}$/.test(m)) return true;
  if ('0123456789'.includes(m) || '9876543210'.includes(m)) return true;
  if (['123456', '654321', '000000', '121212', '112233'].includes(m)) return true;
  if (dobYear && m.includes(dobYear)) return true;          // year-of-birth pattern
  return false;
}

export default function OnboardMpin() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
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
  // nobody to hand it to, and the retry then fails as "email already
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
    if (isWeak(v, dobYear)) { setMsg('That MPIN is too easy to guess. Pick another.'); setFirst(''); doShake(); return; }
    setMsg(null); setPhase('confirm');
  };

  const onConfirm = async (v: string) => {
    if (v !== first) { setMsg('PINs don’t match. Start again.'); setConfirm(''); setFirst(''); setPhase('set'); doShake(); return; }
    setBusy(true); setMsg(null);
    try {
      const st = onboarding.get();
      const { userId, setupTicket } = await initProfile({
        email: st.email, phone: st.phone, emailTicket: st.emailTicket,
        firstName: st.firstName, lastName: st.lastName, dob: st.dob, status: st.status,
        profilePicUrl: st.profilePicUrl,
      });
      await saveSecurityQuestions(userId, setupTicket, st.securityAnswers);
      await setMpinRemote(userId, setupTicket, v);
      onboarding.set({ userId, mpin: v });                  // mpin kept (RAM) for the success login
      router.replace({ pathname: '/onboard-success', params: { userId } } as any);
    } catch (e: any) {
      setBusy(false);
      setPhase('set'); setFirst(''); setConfirm('');
      Alert.alert('Could not finish setup', onboardingError(e, 'Please try again'));
    }
  };

  const setting = phase === 'set';
  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !busy }} />
      {/* Step 3 of 3 had no back affordance at all — the only step in the chain
          without one, though returning to the questions is perfectly valid. */}
      {!busy && (
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
      )}
      <View style={s.body}>
        <Text style={s.lock}>🔐</Text>
        <Text style={s.title}>{setting ? 'Create your MPIN' : 'Confirm your MPIN'}</Text>
        <Text style={s.sub}>{setting ? 'A 6-digit PIN unlocks VaultChat' : 'Re-enter the same 6 digits'}</Text>

        <View style={{ marginVertical: 28 }}>
          {busy
            ? <ActivityIndicator color={colors.primary} size="large" />
            : setting
              ? <MpinInput key="set" value={first} onChange={setFirst} onComplete={onSet} autoFocus shakeAnim={shake} />
              : <MpinInput key="confirm" value={confirm} onChange={setConfirm} onComplete={onConfirm} autoFocus shakeAnim={shake} />}
        </View>

        {!!msg && <Text style={s.msg}>{msg}</Text>}
        {busy && <Text style={s.sub}>Securing your account…</Text>}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingHorizontal: 20, paddingTop: 8, alignSelf: 'flex-start' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 72, alignItems: 'center' },
  lock: { fontSize: 44, marginBottom: 12 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  msg: { color: c.danger, fontSize: 13, marginTop: 8, textAlign: 'center', fontWeight: '600' },
});
