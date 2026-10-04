// app/app-lock.tsx — the app lock. Reached on a cold launch when device MFA is
// on or the session is sealed, and on resume (components/ResumeLock, resume=1)
// after the Auto Screen Lock timeout for an MFA or Device-PIN user. Unlock with
// biometrics or the account MPIN (MFA), or the Device PIN (PIN-only users).
//
// #32: it is ALSO the unseal screen. When the session is sealed under a local
// PIN (the user set one — see services/security/pinStore), neither biometrics
// nor the REMOTE MPIN check can produce the key, so this screen asks for the
// local PIN and calls loadSealedSession(). A wrong PIN is a real, explained
// failure with a user-chosen re-login escape — never a silent bounce to
// /onboard, which would look like the app forgot the account.

import { type Href, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, BackHandler, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { clearTokens, getCachedUser, loadSealedSession, sealedSessionLocked, setCachedUser } from '../lib/api';
import { MpinInput } from '../components/auth/MpinInput';
import { isMfaEnabled, promptBiometricUnlock } from '../lib/mfa';
import { verifyMpinRemote, onboardingError, isOfflineError } from '../lib/onboarding';
import { unlockMode } from '../lib/resumeLockPolicy';
import { hasPin, pinBackoffMs, verifyPin } from '../services/security/pinStore';
import { AppText as Text, AuroraBackground, KeyboardSafe } from '../components/ui';
import { resetTo } from '../lib/authNav';
import { consumeLaunchLink, noteAuthEdge } from '../lib/pendingLink';

export default function AppLock() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  // resume=1: pushed by components/ResumeLock over a live stack after the app
  // came back from the background — unlocking returns to that screen.
  const { resume } = useLocalSearchParams<{ resume?: string }>();

  const [mode, setMode] = useState<'bio' | 'mpin' | 'seal' | 'pin'>('bio');
  /** A Device PIN exists, so it is offered as another way in. */
  const [devicePin, setDevicePin] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [pin, setPin] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [mpin, setMpin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;
  const doShake = () => { shake.setValue(0); Animated.sequence([12, -12, 8, -8, 0].map(t => Animated.timing(shake, { toValue: t, duration: 55, useNativeDriver: true }))).start(); };

  // However this lock was raised — the root gate, ResumeLock's push, or the
  // sealed relock in lib/api — the user now stands at it, so a later visit to
  // '/' must come back here rather than route into Chats (lib/pendingLink
  // splashNext). Only the gate and resetTo recorded it before.
  useEffect(() => { noteAuthEdge('/app-lock'); }, []);

  const enter = () => {
    if (resume === '1' && router.canGoBack()) {
      noteAuthEdge(null); // back inside; resetTo records it on the other branch
      router.back();
      // A notification tapped while this lock was up was held, not opened over
      // it (lib/pendingLink.openWhenUnlocked) — open it now, above the screen
      // the user returns to. The cold path replays it inside resetTo instead.
      const held = consumeLaunchLink();
      if (held) router.push(held as Href);
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
    // biometric that cannot possibly unlock anything. A Device-PIN user without
    // MFA (relocked on resume) is asked for that PIN (lib/resumeLockPolicy).
    Promise.all([
      sealedSessionLocked().catch(() => false),
      isMfaEnabled(),
      hasPin().catch(() => false),
    ]).then(([sealedLocked, mfaOn, hasDevicePin]) => {
      if (!alive.current) return;
      setDevicePin(hasDevicePin);
      const m = unlockMode({ sealedLocked, mfaOn, hasDevicePin });
      if (m === 'bio') tryBiometric(); else setMode(m);
    }).catch(() => { if (alive.current) tryBiometric(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tryBiometric = async () => {
    const ok = await promptBiometricUnlock();
    // The prompt can outlive the screen (unlocked another way, signed out).
    if (!alive.current) return;
    if (ok) enter(); else setMode('mpin');
  };

  // #32 unseal path: the PIN derives the key that opens the sealed tokens.
  // Resume path for a Device-PIN user: the session is already open in memory,
  // so the PIN is checked against pinStore (which owns the attempt backoff).
  const submitSeal = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const ok = mode === 'pin' ? await verifyPin(pin) : await loadSealedSession(pin);
      if (!alive.current) return;
      if (ok) { enter(); return; }
      setPin(''); doShake();
      const wait = mode === 'pin' ? await pinBackoffMs() : 0;
      if (!alive.current) return;
      setError(wait > 0
        ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`
        : 'That PIN did not unlock this device. Your messages are still here — try again.');
    } catch {
      if (alive.current) setError("Couldn't check your PIN. Try again.");
    } finally { if (alive.current) setBusy(false); }
  };

  // No cached user id means the MPIN cannot be checked at all; offer the exit
  // instead of an error with nothing to press. Also the Forgotten PIN Alert's
  // destructive choice below.
  const signInAgain = async () => {
    await clearTokens().catch(() => {});
    await setCachedUser(null).catch(() => {});
    resetTo('/onboard');
  };

  // The honest last resort, and it is the USER'S choice, not a silent redirect.
  // Signing in again replaces the sealed session; anything sealed under the old
  // PIN (cached message bodies) is unreadable afterwards, so say so first.
  // In `pin` mode the session is open, so the MPIN unlocks without losing
  // anything: offer that before the destructive way out.
  const forgotPin = () => Alert.alert(
    'Forgotten PIN',
    mode === 'pin'
      ? 'Your PIN is only on this device, so it cannot be reset or recovered. You can unlock with your MPIN instead. Signing in again also works, but anything stored only on this device under the old PIN is lost.'
      : 'Your PIN is only on this device, so it cannot be reset or recovered. You can sign in again with your account — your chats sync back from the server, but anything stored only on this device under the old PIN is lost.',
    [
      { text: 'Keep trying', style: 'cancel' },
      ...(mode === 'pin' ? [{ text: 'Use MPIN instead', onPress: () => { setError(null); setMode('mpin'); } }] : []),
      { text: 'Sign in again', style: 'destructive', onPress: () => { void signInAgain(); } },
    ],
  );

  // MPIN mode's way out when the MPIN itself is the problem. Same recovery as
  // the sign-in screen (app/mpin-entry.tsx) — security questions, new MPIN.
  const forgotMpin = () => {
    if (userId) { router.push({ pathname: '/mpin-recover', params: { userId } }); return; }
    void signInAgain();
  };

  const submitMpin = async (value: string) => {
    if (busy || !userId) { if (!userId) setError('Session error — sign in again.'); return; }
    setBusy(true); setError(null);
    try {
      await verifyMpinRemote(userId, value);
      if (alive.current) enter();
    } catch (e: any) {
      if (!alive.current) return;
      setMpin(''); doShake();
      // The MPIN is checked by the server; offline, only biometrics (or the
      // Device PIN) can unlock.
      setError(isOfflineError(e)
        ? `You're offline — use biometrics${devicePin ? ' or your device PIN' : ''}, or try again when connected.`
        : onboardingError(e, 'Incorrect MPIN'));
    } finally { if (alive.current) setBusy(false); }
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <KeyboardSafe style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.lock} accessibilityElementsHidden importantForAccessibility="no">🔐</Text>
        <Text style={s.title} accessibilityRole="header">crazzychat is locked</Text>

        {mode === 'seal' || mode === 'pin' ? (
          <>
            <Text style={s.sub}>{mode === 'seal' ? 'Enter your device PIN to unlock this session' : 'Enter your device PIN to unlock'}</Text>
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
                accessibilityLabel="Device PIN"
                accessibilityHint="4 to 8 digits"
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
            {mode === 'pin' && (
              // The session is open in memory here (unlike a sealed one), so the
              // server-checked MPIN can unlock it too.
              <TouchableOpacity onPress={() => { setError(null); setMode('mpin'); }} style={[s.altHit, { marginTop: 10 }]} accessibilityRole="button">
                <Text style={s.alt}>Use MPIN instead</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={forgotPin} style={[s.altHit, { marginTop: 10 }]} accessibilityRole="button">
              <Text style={s.alt}>Forgotten your PIN?</Text>
            </TouchableOpacity>
          </>
        ) : mode === 'bio' ? (
          <>
            <Text style={s.sub}>Unlock with biometrics</Text>
            <TouchableOpacity style={s.bioBtn} onPress={tryBiometric} activeOpacity={0.85} accessibilityRole="button">
              <Text style={s.bioTxt}>Use biometrics</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMode('mpin')} style={[s.altHit, { marginTop: 8 }]} accessibilityRole="button">
              <Text style={s.alt}>Use MPIN instead</Text>
            </TouchableOpacity>
            {devicePin && (
              <TouchableOpacity onPress={() => { setError(null); setMode('pin'); }} style={[s.altHit, { marginTop: 8 }]} accessibilityRole="button">
                <Text style={s.alt}>Use device PIN</Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <>
            <Text style={s.sub}>Enter your 6-digit MPIN</Text>
            <View style={{ marginVertical: 24 }}>
              <MpinInput value={mpin} onChange={setMpin} onComplete={submitMpin} autoFocus shakeAnim={shake} />
            </View>
            {busy && <ActivityIndicator color={colors.primary} />}
            {!!error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
            <TouchableOpacity onPress={tryBiometric} style={[s.altHit, { marginTop: 6 }]} accessibilityRole="button">
              <Text style={s.alt}>Use biometrics</Text>
            </TouchableOpacity>
            {devicePin && (
              <TouchableOpacity onPress={() => { setError(null); setMode('pin'); }} style={[s.altHit, { marginTop: 6 }]} accessibilityRole="button">
                <Text style={s.alt}>Use device PIN</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={forgotMpin} style={[s.altHit, { marginTop: 6 }]} accessibilityRole="button">
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
  bioTxt: { color: c.onPrimary, fontSize: 16, fontWeight: '800' },
  alt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  // 44pt touch floor for the 14pt text links.
  altHit: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  error: { color: c.danger, fontSize: 13, marginTop: 12, fontWeight: '600', textAlign: 'center' },
  // minHeight, not height, for the same reason as bioBtn: a pinned 56 clips
  // the 24pt digits at large font scales.
  pinInput: { marginTop: 24, minHeight: 56, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, color: c.text, fontSize: 24, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
});
