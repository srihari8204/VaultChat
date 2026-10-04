// app/onboard-success.tsx — account secured. Optional device-level MFA (PIN /
// fingerprint / face) via expo-local-authentication. "Continue to Chats" logs in
// (mpin/verify → JWT), optionally enrolls MFA, clears the onboarding store.
//
// The last screen of the chain, on the shared adaptive auth palette
// (lib/useAuthTheme). The lockup comes back at
// full size here: this is the hand-off into the app, and the brand closing the
// sign-up is the point, not a splash rerun.

import { Stack } from 'expo-router';
import { useMemo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT_CTA } from '../constants/theme';
import { BRAND_CTA_INK } from '../constants/brandCtaInk';
import { resetTo } from '../lib/authNav';
import { onboarding, verifyMpinRemote, uploadAndSetProfilePhoto, onboardingError } from '../lib/onboarding';
import { deviceSecurityAvailable, enableMfa } from '../lib/mfa';
import { FRESH_OTP_MESSAGE, needsFreshOtp } from '../lib/otpFirstRoute';
import { AuthSky, BrandMark } from '../components/ui';
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

export default function OnboardSuccess() {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const [mfaOn, setMfaOn] = useState(false);
  const [hasDeviceSecurity, setHasDeviceSecurity] = useState(true);
  const [busy, setBusy] = useState(false);
  // Synchronous latch: two taps in one frame both saw busy === false and ran
  // verifyMpinRemote twice (each one spends an MPIN attempt).
  const inFlight = useRef(false);

  useEffect(() => { deviceSecurityAvailable().then(setHasDeviceSecurity).catch(() => setHasDeviceSecurity(false)); }, []);

  // BACK IS A DEAD END HERE, ON PURPOSE.
  //
  // By the time this screen mounts, onboard-mpin has already committed the
  // whole chain server-side (profile/init → security questions → mpin/set).
  // onboard-mpin replaced itself with this screen, so the entry BELOW us is
  // onboard-security — and backing into it leads to a second commit attempt
  // that the server rejects as "email already registered", stranding a user
  // who now HAS an account inside a sign-up they can no longer finish.
  // The way out of this screen is the button.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // The plaintext MPIN rides the RAM store from onboard-mpin to here for the
  // first sign-in. Every exit from this screen drops it, not only success.
  useEffect(() => () => { onboarding.set({ mpin: '' }); }, []);

  // `next` lets the same login run land somewhere other than the chat list.
  // Exit Kit needs a real session (and a contact to import into), and neither
  // exists until verifyMpinRemote below has returned a JWT — so the import entry
  // point cannot be a shortcut that skips this, it has to be a destination for it.
  const finish = async (next?: string) => {
    if (inFlight.current) return;
    const { userId, mpin } = onboarding.get();
    if (!userId || !mpin) { Alert.alert('Session expired', 'Please sign in again.'); resetTo('/onboard'); return; }
    inFlight.current = true;
    setBusy(true);
    try {
      await verifyMpinRemote(userId, mpin);              // logs in → JWT stored

      // Upload the picked avatar now that we have a token (best-effort).
      const localPic = onboarding.get().profilePicLocalUri;
      if (localPic) { try { await uploadAndSetProfilePhoto(localPic); } catch { /* non-blocking */ } }

      // The user is SIGNED IN from here on. MFA is optional, and enableMfa can
      // throw on its network step — that must not land in the catch below,
      // which would tell a signed-in user "Could not continue".
      if (mfaOn) {
        try {
          const enabled = await enableMfa();
          if (!enabled && !hasDeviceSecurity) {
            Alert.alert('No device security found', 'You can enable this later in Settings.');
          }
        } catch {
          Alert.alert('Device protection not turned on', 'Your account is ready. You can turn this on later in Settings.');
        }
      }
      onboarding.reset();                                // wipe plaintext MPIN/answers
      // resetTo, not replace: the sign-up screens below this one must not
      // survive into the app (lib/authNav.ts).
      resetTo(next ?? '/(tabs)/chats');
    } catch (e: any) {
      inFlight.current = false;
      setBusy(false);
      // A WAY OUT (2026-09-17). Back is swallowed and the gesture is disabled on
      // this screen, so a failing verify left the only affordance being the
      // button that had just failed — killing the app was the sole escape.
      //
      // The account already EXISTS by now: setMpinRemote succeeded on the
      // previous screen, which is precisely why back is blocked here. So signing
      // in is a correct recovery, not a workaround — offer it alongside retry.
      //
      // Except when the SMS proof has expired (403 otp_required, a sign-up that
      // outlasted the ticket's 15 minutes): retrying cannot pass and the MPIN
      // screen would meet the same refusal, so the only way on is a fresh code.
      if (needsFreshOtp(e)) {
        Alert.alert(
          'Number check expired',
          `${FRESH_OTP_MESSAGE} Your account is already created — after the code, sign in with the MPIN you just set.`,
          [{ text: 'Verify number', onPress: () => { onboarding.reset(); resetTo('/onboard'); } }],
          { cancelable: false },
        );
        return;
      }
      Alert.alert(
        'Could not continue',
        onboardingError(e, 'Please try again'),
        [
          { text: 'Try again', style: 'cancel' },
          {
            text: 'Sign in instead',
            onPress: () => {
              const { userId: uid } = onboarding.get();
              onboarding.reset();                       // wipe the plaintext MPIN
              resetTo(uid ? `/mpin-entry?userId=${encodeURIComponent(uid)}` : '/onboard');
            },
          },
        ],
      );
    }
  };

  return (
    <View style={s.screen}>
      <AuthSky />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      {/* Scrolls rather than clips when large text pushes the button down. */}
      <ScrollView contentContainerStyle={s.body}>
        <BrandMark size={72} markOnly />
        <Text style={s.title} accessibilityRole="header">Account secured</Text>
        <Text style={s.sub}>Your profile is encrypted and your MPIN is set.</Text>

        <View style={s.mfaCard}>
          <Text style={s.mfaTitle}>Add device-level protection (recommended)</Text>
          <TouchableOpacity
            style={s.radioRow}
            onPress={() => setMfaOn(v => !v)}
            activeOpacity={0.8}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: mfaOn }}
          >
            <View style={[s.radio, mfaOn && s.radioOn]}>{mfaOn && <View style={s.radioDot} />}</View>
            <Text style={s.radioTxt}>Enable MFA using device security (PIN / fingerprint / face)</Text>
          </TouchableOpacity>
          {!hasDeviceSecurity && (
            <Text style={s.note}>No device security found on this phone. You can enable this later in Settings.</Text>
          )}
        </View>

        <Pressable
          onPress={() => finish()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Continue to Chats"
          accessibilityState={{ disabled: busy, busy }}
          style={({ pressed }) => [s.ctaWrap, pressed && !busy && s.ctaDown]}
        >
          <LinearGradient
            colors={[...BRAND_GRADIENT_CTA]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.cta}
          >
            {busy ? <ActivityIndicator color={BRAND_CTA_INK} /> : <Text style={s.ctaTxt}>Continue to Chats</Text>}
          </LinearGradient>
        </Pressable>

        {/* Secondary on purpose: importing is something a few people want on day
            one, and nobody should be nudged into it before they have a chat. */}
        <TouchableOpacity
          style={s.secondary}
          onPress={() => finish('/import-chats')}
          disabled={busy}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityHint="Signs you in, then opens the chat import"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={s.secondaryTxt}>Import an existing conversation</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  // Same double-count as onboard-mpin: this screen is in INSET_SCREENS, so
  // the container already adds HEADER_TOP and 52 + 88 left 140dp blank above
  // the title on the Honor. 64 keeps the roomier hero spacing this screen
  // wants without paying for the status bar twice (2026-09-17).
  // flexGrow (a scroll container) keeps the CTA's marginTop 'auto' at the bottom.
  body: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 64, alignItems: 'center' },
  title: { color: AUTH.text, fontSize: 26, fontWeight: '900', marginTop: 8 },
  sub: { color: AUTH.dim, fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },

  mfaCard: {
    width: '100%', marginTop: 36,
    backgroundColor: AUTH.card, borderRadius: 22, borderWidth: 1, borderColor: AUTH.stroke, padding: 18,
  },
  mfaTitle: { color: AUTH.text, fontSize: 14, fontWeight: '800', marginBottom: 12 },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: AUTH.stroke, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: AUTH.accent },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: AUTH.accent },
  radioTxt: { color: AUTH.text, fontSize: 14, flex: 1, lineHeight: 19 },
  note: { color: AUTH.faint, fontSize: 12, marginTop: 10, lineHeight: 16 },

  ctaWrap: { width: '100%', marginTop: 'auto', borderRadius: 16, overflow: 'hidden' },
  // 2026-09-18: minHeight, not height — at font scale 1.5 the 16sp label
  // outgrew a pinned 56 and clipped, on the last tap of signup. 56 stays the
  // floor; the padding keeps it identical at scale 1.0 and only gives way when
  // the label is genuinely taller.
  cta: { minHeight: 56, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  ctaDown: { opacity: 0.88 },
  ctaTxt: { color: BRAND_CTA_INK, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  secondary: { width: '100%', marginTop: 12, marginBottom: 32, paddingVertical: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryTxt: { color: AUTH.cyan, fontSize: 14, fontWeight: '700' },
});
