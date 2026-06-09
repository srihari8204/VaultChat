/**
 * app/enter-mpin.tsx — unlock with MPIN or biometrics (Obsidian Aurora).
 *
 * On mount, if biometrics are enrolled it auto-prompts (and shows
 * Fingerprint / Face buttons). Biometric success bypasses the PIN. Cancelling
 * falls back to manual 6-digit entry (verifyPIN — hashed compare). All
 * biometric calls are wrapped so no system permission alert ever blocks.
 */
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Aurora } from '../constants/theme';
import { PinPad } from '../components/PinPad';
import { verifyPIN } from './(constants)/authService';
import { logoutUser } from './(constants)/authService';
import { markUnlocked } from '../lib/sessionLock';

export default function EnterMpinScreen() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [msg, setMsg] = useState('');
  const [bioTypes, setBioTypes] = useState<number[]>([]);
  const shake = useRef(new Animated.Value(0)).current;
  const triedAuto = useRef(false);

  const enter = () => { markUnlocked(); router.replace('/(tabs)/chats' as any); };

  // Detect + auto-trigger biometrics (silent — never throws a blocking alert).
  useEffect(() => {
    (async () => {
      try {
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (hasHw && enrolled) {
          const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
          setBioTypes(types);
          if (!triedAuto.current) { triedAuto.current = true; runBiometric(); }
        }
      } catch { /* unavailable — silently fall back to PIN */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runBiometric = async () => {
    try {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock VaultChat',
        cancelLabel: 'Use PIN',
        disableDeviceFallback: false,
      });
      if (r.success) {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        enter();
      }
      // notEnrolled / userCancel / lockout → just stay on PIN entry, no alert.
    } catch { /* swallow — PIN entry remains available */ }
  };

  const doShake = () => {
    Animated.sequence([
      Animated.timing(shake, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 6, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const onComplete = async (v: string) => {
    const ok = await verifyPIN(v);
    if (ok) { enter(); return; }
    setError(true);
    setMsg('Incorrect PIN');
    doShake();
    if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    setTimeout(() => { setPin(''); setError(false); }, 500);
  };

  const hasFingerprint = bioTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  const hasFace = bioTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);

  const signOut = async () => { try { await logoutUser(); } catch {} router.replace('/welcome' as any); };

  return (
    <View style={s.screen}>
      <View style={s.lock}><Text style={s.lockIcon}>🔐</Text></View>
      <Text style={s.title}>Enter MPIN</Text>
      <Text style={s.subtitle}>Unlock VaultChat to continue</Text>

      <Animated.View style={[s.padArea, { transform: [{ translateX: shake }] }]}>
        <PinPad value={pin} onChange={setPin} onComplete={onComplete} error={error} />
      </Animated.View>

      {msg ? <Text style={s.msg}>{msg}</Text> : null}

      {/* Biometric buttons */}
      {(hasFingerprint || hasFace) && (
        <View style={s.bioRow}>
          {hasFingerprint && (
            <TouchableOpacity style={s.bioBtn} onPress={runBiometric} activeOpacity={0.8}>
              <Text style={s.bioIcon}>🫆</Text>
              <Text style={s.bioTxt}>Use Fingerprint</Text>
            </TouchableOpacity>
          )}
          {hasFace && (
            <TouchableOpacity style={s.bioBtn} onPress={runBiometric} activeOpacity={0.8}>
              <Text style={s.bioIcon}>🙂</Text>
              <Text style={s.bioTxt}>Use Face ID</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <TouchableOpacity style={s.signOut} onPress={signOut}>
        <Text style={s.signOutTxt}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Aurora.bg, alignItems: 'center', paddingTop: 88 },
  lock: { width: 64, height: 64, borderRadius: 20, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  lockIcon: { fontSize: 28 },
  title: { color: Aurora.text, fontSize: 24, fontWeight: '800', marginBottom: 8 },
  subtitle: { color: Aurora.textDim, fontSize: 14, marginBottom: 36 },
  padArea: { minHeight: 320, justifyContent: 'center' },
  msg: { color: Aurora.danger, fontSize: 13, marginTop: 4 },
  bioRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  bioBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  bioIcon: { fontSize: 18 },
  bioTxt: { color: Aurora.text, fontSize: 14, fontWeight: '600' },
  signOut: { marginTop: 'auto', marginBottom: 36, padding: 12 },
  signOutTxt: { color: Aurora.textFaint, fontSize: 14, fontWeight: '600' },
});
