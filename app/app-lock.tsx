// app/app-lock.tsx — cold-launch gate when device MFA is on. Unlock with biometric
// OR the account MPIN. Reached only when a session token AND vc.mfa.token exist.

import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getCachedUser } from '../lib/api';
import { MpinInput } from '../components/auth/MpinInput';
import { promptBiometricUnlock } from '../lib/mfa';
import { verifyMpinRemote, onboardingError } from '../lib/onboarding';

export default function AppLock() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [mode, setMode] = useState<'bio' | 'mpin'>('bio');
  const [userId, setUserId] = useState<string | null>(null);
  const [mpin, setMpin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;
  const doShake = () => { shake.setValue(0); Animated.sequence([12, -12, 8, -8, 0].map(t => Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start(); };

  const enter = () => router.replace('/(tabs)/chats' as any);

  useEffect(() => { getCachedUser().then(u => setUserId(u?.id ?? null)); }, []);
  useEffect(() => { tryBiometric(); /* prompt on mount */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tryBiometric = async () => {
    const ok = await promptBiometricUnlock();
    if (ok) enter(); else setMode('mpin');
  };

  const submitMpin = async (value: string) => {
    if (busy || !userId) { if (!userId) setError('Session error — sign in again.'); return; }
    setBusy(true); setError(null);
    try {
      await verifyMpinRemote(userId, value);
      enter();
    } catch (e: any) {
      setMpin(''); doShake(); setError(onboardingError(e, 'Incorrect MPIN'));
    } finally { setBusy(false); }
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={s.body}>
        <Text style={s.lock}>🔐</Text>
        <Text style={s.title}>VaultChat is locked</Text>

        {mode === 'bio' ? (
          <>
            <Text style={s.sub}>Unlock with biometrics</Text>
            <TouchableOpacity style={s.bioBtn} onPress={tryBiometric} activeOpacity={0.85}>
              <Text style={s.bioTxt}>Use biometrics</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMode('mpin')} style={{ marginTop: 18 }}>
              <Text style={s.alt}>Use MPIN instead</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={s.sub}>Enter your 6-digit MPIN</Text>
            <View style={{ marginVertical: 24 }}>
              <MpinInput value={mpin} onChange={setMpin} onComplete={submitMpin} autoFocus shakeAnim={shake} />
            </View>
            {busy && <ActivityIndicator color={colors.primary} />}
            {!!error && <Text style={s.error}>{error}</Text>}
            <TouchableOpacity onPress={tryBiometric} style={{ marginTop: 16 }}>
              <Text style={s.alt}>Use biometrics</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 120, alignItems: 'center' },
  lock: { fontSize: 48, marginBottom: 16 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  bioBtn: { marginTop: 28, height: 54, paddingHorizontal: 40, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  bioTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  alt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  error: { color: c.danger, fontSize: 13, marginTop: 12, fontWeight: '600' },
});
