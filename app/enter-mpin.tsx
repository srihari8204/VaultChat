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
import { useEffect, useRef, useState , useMemo} from 'react';
import { Animated, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { PinPad } from '../components/PinPad';
import { verifyPIN } from './(constants)/authService';
import { logoutUser } from './(constants)/authService';
import { markUnlocked } from '../lib/sessionLock';
import { loadSealedSession } from '../lib/api';
import { VAULT_SESSION_SEALED } from '../constants/flags';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function EnterMpinScreen() {
  const { colors } = useTheme();
  const s = useS();
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
    // A PIN-sealed session (#32) can only be unsealed by the PIN — biometrics
    // can't, and are a coercion weakness anyway. So skip biometrics when sealed.
    if (VAULT_SESSION_SEALED) return;
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
    if (ok) {
      // #32: unseal the real session with this PIN (no-op unless VAULT_SESSION_SEALED).
      await loadSealedSession(v);
      enter();
      return;
    }
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

      {/* Biometric buttons (hidden when the session is PIN-sealed) */}
      {!VAULT_SESSION_SEALED && (hasFingerprint || hasFace) && (
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

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg, alignItems: 'center', paddingTop: 88 },
  lock: { width: 64, height: 64, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  lockIcon: { fontSize: 28 },
  title: { color: c.text, fontSize: 24, fontWeight: '800', marginBottom: 8 },
  subtitle: { color: c.textDim, fontSize: 14, marginBottom: 36 },
  padArea: { minHeight: 320, justifyContent: 'center' },
  msg: { color: c.danger, fontSize: 13, marginTop: 4 },
  bioRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  bioBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  bioIcon: { fontSize: 18 },
  bioTxt: { color: c.text, fontSize: 14, fontWeight: '600' },
  signOut: { marginTop: 'auto', marginBottom: 36, padding: 12 },
  signOutTxt: { color: c.textFaint, fontSize: 14, fontWeight: '600' },
});
