// app/onboard-success.tsx — account secured. Optional device-level MFA (PIN /
// fingerprint / face) via expo-local-authentication. "Continue to Chats" logs in
// (mpin/verify → JWT), optionally enrolls MFA, clears the onboarding store.

import { brandAlpha, type Palette } from '../constants/theme';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../lib/theme';
import { onboarding, verifyMpinRemote, uploadAndSetProfilePhoto, onboardingError } from '../lib/onboarding';
import { deviceSecurityAvailable, enableMfa } from '../lib/mfa';
import { AuroraBackground } from '../components/ui';

export default function OnboardSuccess() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [mfaOn, setMfaOn] = useState(false);
  const [hasDeviceSecurity, setHasDeviceSecurity] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { deviceSecurityAvailable().then(setHasDeviceSecurity).catch(() => setHasDeviceSecurity(false)); }, []);

  // `next` lets the same login run land somewhere other than the chat list.
  // Exit Kit needs a real session (and a contact to import into), and neither
  // exists until verifyMpinRemote below has returned a JWT — so the import entry
  // point cannot be a shortcut that skips this, it has to be a destination for it.
  const finish = async (next?: string) => {
    if (busy) return;
    const { userId, mpin } = onboarding.get();
    if (!userId || !mpin) { Alert.alert('Session expired', 'Please sign in again.'); router.replace('/onboard' as any); return; }
    setBusy(true);
    try {
      await verifyMpinRemote(userId, mpin);              // logs in → JWT stored

      // Upload the picked avatar now that we have a token (best-effort).
      const localPic = onboarding.get().profilePicLocalUri;
      if (localPic) { try { await uploadAndSetProfilePhoto(localPic); } catch { /* non-blocking */ } }

      if (mfaOn) {
        const enabled = await enableMfa();
        if (!enabled && !hasDeviceSecurity) {
          Alert.alert('No device security found', 'You can enable this later in Settings.');
        }
      }
      onboarding.reset();                                // wipe plaintext MPIN/answers
      router.replace((next ?? '/(tabs)/chats') as any);
    } catch (e: any) {
      setBusy(false);
      Alert.alert('Could not continue', onboardingError(e, 'Please try again'));
    }
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.body}>
        <View style={s.tick}><Text style={{ fontSize: 48 }}>✓</Text></View>
        <Text style={s.title}>Account secured</Text>
        <Text style={s.sub}>Your profile is encrypted and your MPIN is set.</Text>

        <View style={s.mfaCard}>
          <Text style={s.mfaTitle}>Add device-level protection (recommended)</Text>
          <TouchableOpacity style={s.radioRow} onPress={() => setMfaOn(v => !v)} activeOpacity={0.8}>
            <View style={[s.radio, mfaOn && s.radioOn]}>{mfaOn && <View style={s.radioDot} />}</View>
            <Text style={s.radioTxt}>Enable MFA using device security (PIN / fingerprint / face)</Text>
          </TouchableOpacity>
          {!hasDeviceSecurity && (
            <Text style={s.note}>No device security found on this phone. You can enable this later in Settings.</Text>
          )}
        </View>

        <TouchableOpacity style={s.cta} onPress={() => finish()} disabled={busy} activeOpacity={0.85}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaTxt}>Continue to Chats</Text>}
        </TouchableOpacity>

        {/* Secondary on purpose: importing is something a few people want on day
            one, and nobody should be nudged into it before they have a chat. */}
        <TouchableOpacity
          style={s.secondary}
          onPress={() => finish('/import-chats')}
          disabled={busy}
          activeOpacity={0.7}
        >
          <Text style={s.secondaryTxt}>Import an existing conversation</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 96, alignItems: 'center' },
  tick: { width: 96, height: 96, borderRadius: 48, backgroundColor: brandAlpha(0.15), borderWidth: 2, borderColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  title: { color: c.text, fontSize: 26, fontWeight: '900' },
  sub: { color: c.textDim, fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  mfaCard: { width: '100%', backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: 1, borderColor: c.glassStroke, padding: 16, marginTop: 36 },
  mfaTitle: { color: c.text, fontSize: 14, fontWeight: '800', marginBottom: 12 },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.glassStroke, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: c.primary },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: c.primary },
  radioTxt: { color: c.text, fontSize: 14, flex: 1, lineHeight: 19 },
  note: { color: c.textFaint, fontSize: 12, marginTop: 10, lineHeight: 16 },
  cta: { width: '100%', marginTop: 'auto', height: 56, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  secondary: { width: '100%', marginTop: 12, marginBottom: 32, paddingVertical: 12, alignItems: 'center' },
  secondaryTxt: { color: c.textDim, fontSize: 14, fontWeight: '700' },
});
