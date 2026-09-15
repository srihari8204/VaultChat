// app/app-lock.tsx — cold-launch gate when device MFA is on. Unlock with biometric
// OR the account MPIN. Reached only when a session token AND vc.mfa.token exist.
//
// #32: it is ALSO the unseal screen. When the session is sealed under a local
// PIN (the user set one — see services/security/pinStore), neither biometrics
// nor the REMOTE MPIN check can produce the key, so this screen asks for the
// local PIN and calls loadSealedSession(). A wrong PIN is a real, explained
// failure with a user-chosen re-login escape — never a silent bounce to
// /onboard, which would look like the app forgot the account.

import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { clearTokens, getCachedUser, loadSealedSession, sealedSessionLocked, setCachedUser } from '../lib/api';
import { MpinInput } from '../components/auth/MpinInput';
import { promptBiometricUnlock } from '../lib/mfa';
import { verifyMpinRemote, onboardingError } from '../lib/onboarding';
import { AuroraBackground } from '../components/ui';
import { resetTo } from '../lib/authNav';

export default function AppLock() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [mode, setMode] = useState<'bio' | 'mpin' | 'seal'>('bio');
  const [pin, setPin] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [mpin, setMpin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;
  const doShake = () => { shake.setValue(0); Animated.sequence([12, -12, 8, -8, 0].map(t => Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start(); };

  const enter = () => resetTo('/(tabs)/chats');

  // BACK MUST NOT WALK AROUND THE LOCK.
  //
  // gestureEnabled:false covered the swipe and nothing covered the hardware
  // button. From a cold start this screen is the only stack entry, so back
  // should (and still does) exit the app. But lib/api.ts routes here with a
  // router.replace() when a request finds the session sealed-and-locked — that
  // swaps only the TOP entry, so whatever screen the user was on is still
  // underneath, and one press of BACK put them back inside the app they had
  // just been locked out of. Consume back only in that case.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => router.canGoBack());
    return () => sub.remove();
  }, [router]);

  useEffect(() => { getCachedUser().then(u => setUserId(u?.id ?? null)); }, []);
  useEffect(() => {
    // Sealed session? Only the local PIN opens it — don't prompt for a
    // biometric that cannot possibly unlock anything.
    sealedSessionLocked()
      .then(locked => { if (locked) setMode('seal'); else tryBiometric(); })
      .catch(() => tryBiometric());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tryBiometric = async () => {
    const ok = await promptBiometricUnlock();
    if (ok) enter(); else setMode('mpin');
  };

  // #32 unseal path: the PIN derives the key that opens the sealed tokens.
  const submitSeal = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (await loadSealedSession(pin)) { enter(); return; }
      setPin(''); doShake();
      setError('That PIN did not unlock this device. Your messages are still here — try again.');
    } finally { setBusy(false); }
  };

  // The honest last resort, and it is the USER'S choice, not a silent redirect.
  // Signing in again replaces the sealed session; anything sealed under the old
  // PIN (cached message bodies) is unreadable afterwards, so say so first.
  const forgotPin = () => Alert.alert(
    'Forgotten PIN',
    'Your PIN is only on this device, so it cannot be reset or recovered. You can sign in again with your account — your chats sync back from the server, but anything stored only on this device under the old PIN is lost.',
    [
      { text: 'Keep trying', style: 'cancel' },
      { text: 'Sign in again', style: 'destructive', onPress: async () => {
        await clearTokens().catch(() => {});
        await setCachedUser(null).catch(() => {});
        resetTo('/onboard');
      } },
    ],
  );

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
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={s.body}>
        <Text style={s.lock}>🔐</Text>
        <Text style={s.title}>crazzychat is locked</Text>

        {mode === 'seal' ? (
          <>
            <Text style={s.sub}>Enter your device PIN to unlock this session</Text>
            <Animated.View style={{ transform: [{ translateX: shake }], width: '100%' }}>
              <TextInput
                style={s.pinInput}
                value={pin}
                onChangeText={v => { setPin(v.replace(/\D/g, '').slice(0, 8)); setError(null); }}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={8}
                autoFocus
                placeholder="••••••"
                placeholderTextColor={colors.textDim}
                onSubmitEditing={submitSeal}
              />
            </Animated.View>
            <TouchableOpacity
              style={[s.bioBtn, (busy || pin.length < 4) && { opacity: 0.5 }]}
              onPress={submitSeal}
              disabled={busy || pin.length < 4}
              activeOpacity={0.85}
            >
              <Text style={s.bioTxt}>{busy ? 'Unlocking…' : 'Unlock'}</Text>
            </TouchableOpacity>
            {!!error && <Text style={s.error}>{error}</Text>}
            <TouchableOpacity onPress={forgotPin} style={{ marginTop: 20 }}>
              <Text style={s.alt}>Forgotten your PIN?</Text>
            </TouchableOpacity>
          </>
        ) : mode === 'bio' ? (
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 120, alignItems: 'center' },
  lock: { fontSize: 48, marginBottom: 16 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  bioBtn: { marginTop: 28, height: 54, paddingHorizontal: 40, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  bioTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  alt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  error: { color: c.danger, fontSize: 13, marginTop: 12, fontWeight: '600', textAlign: 'center' },
  pinInput: { marginTop: 24, height: 56, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, color: c.text, fontSize: 24, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
});
