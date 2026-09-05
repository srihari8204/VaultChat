// app/mpin-entry.tsx — existing user enters their 6-digit MPIN.
// /auth/mpin/verify issues JWTs (server enforces 5-try / 15-min lockout) → Chats.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { MpinInput } from '../components/auth/MpinInput';
import { onboarding, verifyMpinRemote, onboardingError } from '../lib/onboarding';
import { AuroraBackground } from '../components/ui';

export default function MpinEntry() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
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
      router.replace('/(tabs)/chats' as any);
    } catch (e: any) {
      setMpin('');
      doShake();
      setError(onboardingError(e, 'Incorrect MPIN'));
    } finally { setBusy(false); }
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <TouchableOpacity onPress={() => router.back()} style={s.back}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
      <View style={s.body}>
        <Text style={s.lock}>🔒</Text>
        <Text style={s.title}>Enter your MPIN</Text>
        <Text style={s.sub}>6-digit PIN to unlock VaultChat</Text>

        <View style={{ marginVertical: 28 }}>
          <MpinInput value={mpin} onChange={setMpin} onComplete={submit} autoFocus shakeAnim={shake} />
        </View>

        {busy && <ActivityIndicator color={colors.primary} />}
        {!!error && <Text style={s.error}>{error}</Text>}

        <TouchableOpacity onPress={() => router.push({ pathname: '/mpin-recover', params: { userId } } as any)} style={{ marginTop: 24 }}>
          <Text style={s.forgot}>Forgot MPIN?</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  back: { paddingTop: HEADER_TOP, paddingHorizontal: 20 },
  backTxt: { color: c.text, fontSize: 26 },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 40, alignItems: 'center' },
  lock: { fontSize: 44, marginBottom: 12 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8 },
  error: { color: c.danger, fontSize: 13, marginTop: 14, textAlign: 'center', fontWeight: '600' },
  forgot: { color: c.primary, fontSize: 14, fontWeight: '700' },
});
