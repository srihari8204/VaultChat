// app/app-lock.tsx — cold-launch gate when device MFA is on. Unlock with biometric
// OR the account MPIN. Reached only when a session token AND vc.mfa.token exist.
//
// #32: it is ALSO the unseal screen. When the session is sealed under a local
// PIN (the user set one — see services/security/pinStore), neither biometrics
// nor the REMOTE MPIN check can produce the key, so this screen asks for the
// local PIN and calls loadSealedSession(). A wrong PIN is a real, explained
// failure with a user-chosen re-login escape — never a silent bounce to
// /onboard, which would look like the app forgot the account.

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { clearTokens, getCachedUser, loadSealedSession, sealedSessionLocked, setCachedUser } from '../lib/api';
import { MpinInput } from '../components/auth/MpinInput';
import { promptBiometricUnlock } from '../lib/mfa';
import { verifyMpinRemote, onboardingError } from '../lib/onboarding';
import { AppText as Text, AuroraBackground, KeyboardSafe } from '../components/ui';
import { resetTo } from '../lib/authNav';
import { consumeLaunchLink } from '../lib/pendingLink';

export default function AppLock() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  // resume=1: pushed by components/ResumeLock over a live stack after the app
  // came back from the background — unlocking returns to that screen.
  const { resume } = useLocalSearchParams<{ resume?: string }>();

  const [mode, setMode] = useState<'bio' | 'mpin' | 'seal'>('bio');
  const [pin, setPin] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [mpin, setMpin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;
  const doShake = () => { shake.setValue(0); Animated.sequence([12, -12, 8, -8, 0].map(t => Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start(); };

  const enter = () => {
    if (resume === '1' && router.canGoBack()) {
      router.back();
      // A notification tapped while this lock was up was held, not opened over
      // it (lib/pendingLink.openWhenUnlocked) — open it now, above the screen
      // the user returns to. The cold path replays it inside resetTo instead.
      const held = consumeLaunchLink();
      if (held) router.push(held as any);
    } else resetTo('/(tabs)/chats');
  };

  // BACK MUST NOT WALK AROUND THE LOCK.
  //
  // gestureEnabled:false covered the swipe and nothing covered the hardware
  // button. From a cold start this screen is the only stack entry, so back
  // should (and still does) exit the app. But lib/api.ts routes here with a
  // router.replace() when a request finds the session sealed-and-locked — that
  // swaps only the TOP entry, so whatever screen the user was on is still
  // underneath, and one press of BACK put them back inside the app they had
  // just been locked out of. Consume back only in that case.
  //
  // Only while THIS screen is focused: "Forgot MPIN?" pushes /mpin-recover on
  // top, and a listener left registered underneath swallowed Back there too.
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => router.canGoBack());
    return () => sub.remove();
  }, [router]));

  useEffect(() => { getCachedUser().then(u => setUserId(u?.id ?? null)).catch(() => setUserId(null)); }, []);
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

  // MPIN mode's way out when the MPIN itself is the problem. Same recovery as
  // the sign-in screen (app/mpin-entry.tsx) — security questions, new MPIN.
  const forgotMpin = () => {
    if (userId) { router.push({ pathname: '/mpin-recover', params: { userId } } as any); return; }
    signInAgain();
  };
  // No cached user id means the MPIN cannot be checked at all; offer the exit
  // instead of an error with nothing to press.
  const signInAgain = async () => {
    await clearTokens().catch(() => {});
    await setCachedUser(null).catch(() => {});
    resetTo('/onboard');
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
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <KeyboardSafe style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.lock} accessibilityElementsHidden importantForAccessibility="no">🔐</Text>
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
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || pin.length < 4, busy }}
            >
              <Text style={s.bioTxt}>{busy ? 'Unlocking…' : 'Unlock'}</Text>
            </TouchableOpacity>
            {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
            <TouchableOpacity onPress={forgotPin} style={{ marginTop: 20 }} accessibilityRole="button">
              <Text style={s.alt}>Forgotten your PIN?</Text>
            </TouchableOpacity>
          </>
        ) : mode === 'bio' ? (
          <>
            <Text style={s.sub}>Unlock with biometrics</Text>
            <TouchableOpacity style={s.bioBtn} onPress={tryBiometric} activeOpacity={0.85} accessibilityRole="button">
              <Text style={s.bioTxt}>Use biometrics</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMode('mpin')} style={{ marginTop: 18 }} accessibilityRole="button">
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
            {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
            <TouchableOpacity onPress={tryBiometric} style={{ marginTop: 16 }} accessibilityRole="button">
              <Text style={s.alt}>Use biometrics</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={forgotMpin} style={{ marginTop: 16 }} accessibilityRole="button">
              <Text style={s.alt}>{userId ? 'Forgot MPIN?' : 'Sign in again'}</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 120, paddingBottom: 32, alignItems: 'center' },
  lock: { fontSize: 48, marginBottom: 16 },
  title: { color: c.text, fontSize: 24, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8, textAlign: 'center' },
  // 2026-09-18: minHeight, not height. This is the cold-launch gate, and the
  // button sizes itself to its label — at font scale 1.5 'Use biometrics' plus
  // 40 of horizontal padding each side no longer fits one line on a narrow
  // phone, wraps to two, and a pinned 54 cut the second line off. A user with
  // large text was then looking at a button with no readable way in. 54 is also
  // the tap floor; the padding keeps it pixel-identical at scale 1.0.
  bioBtn: { marginTop: 28, minHeight: 54, paddingVertical: 16, paddingHorizontal: 40, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  bioTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  alt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  error: { color: c.danger, fontSize: 13, marginTop: 12, fontWeight: '600', textAlign: 'center' },
  pinInput: { marginTop: 24, height: 56, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, color: c.text, fontSize: 24, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
});
