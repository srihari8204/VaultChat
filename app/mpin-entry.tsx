// app/mpin-entry.tsx — existing user enters their 6-digit MPIN.
// /auth/mpin/verify issues JWTs (server enforces 5-try / 15-min lockout) → Chats.
//
// This is the screen a returning user actually signs in on, so it carries the
// brand: same night ground and same lockup as app/onboard.tsx, with the mark
// alone rather than the full wordmark — by this point the app has already told
// you what it is called, and a second full logo three seconds later reads as a
// splash that failed to dismiss.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { MpinInput } from '../components/auth/MpinInput';
import { onboarding, verifyMpinRemote, onboardingError } from '../lib/onboarding';
import { resetTo } from '../lib/authNav';
import { AuthSky, BrandMark } from '../components/ui';
import { AUTH } from '../constants/authTheme';

export default function MpinEntry() {
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [mpin, setMpin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;

  const doShake = () => {
    shake.setValue(0);
    Animated.sequence([12, -12, 8, -8, 0].map(t =>
      Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start();
  };

  const submit = async (value: string) => {
    if (busy || !userId) return;
    setBusy(true); setError(null);
    try {
      await verifyMpinRemote(userId, value);
      onboarding.reset();
      // resetTo, not replace: the landing form below this screen must not
      // survive the sign-in (lib/authNav.ts).
      resetTo('/(tabs)/chats');
    } catch (e: any) {
      setMpin('');
      doShake();
      setError(onboardingError(e, 'Incorrect MPIN'));
    } finally { setBusy(false); }
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
        <BrandMark size={64} markOnly style={{ marginBottom: 4 }} />
        <Text style={s.title}>Welcome back</Text>
        <Text style={s.sub}>Enter your 6-digit MPIN to unlock crazzychat</Text>

        <View style={{ marginVertical: 28 }}>
          <MpinInput value={mpin} onChange={setMpin} onComplete={submit} autoFocus shakeAnim={shake} onDark />
        </View>

        {busy && <ActivityIndicator color={AUTH.accent} />}
        {/* accessibilityLiveRegion so the failure is announced rather than only
            shaken — the shake is the only other signal, and it is invisible to
            a screen reader. */}
        {!!error && (
          <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>
        )}

        <Pressable
          onPress={() => router.push({ pathname: '/mpin-recover', params: { userId } } as any)}
          style={{ marginTop: 24 }}
          accessibilityRole="button"
        >
          <Text style={s.forgot}>Forgot MPIN?</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingTop: HEADER_TOP, paddingHorizontal: 20, alignSelf: 'flex-start' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 24, fontWeight: '900' },
  sub: { color: AUTH.dim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  error: { color: AUTH.danger, fontSize: 13, marginTop: 14, textAlign: 'center', fontWeight: '600' },
  forgot: { color: AUTH.cyan, fontSize: 14, fontWeight: '700' },
});
