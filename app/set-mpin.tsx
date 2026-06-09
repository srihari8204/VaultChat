/**
 * app/set-mpin.tsx — first-run MPIN setup (Obsidian Aurora).
 *
 * 6-digit PIN + confirm, saved HASHED to SecureStore via savePIN(). No
 * permission prompts. On success → main app.
 */
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { Aurora } from '../constants/theme';
import { PinPad } from '../components/PinPad';
import { savePIN } from './(constants)/authService';
import { markSetupComplete } from '../services/securityService';
import { markUnlocked } from '../lib/sessionLock';

export default function SetMpinScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<'set' | 'confirm'>('set');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(false);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const onSetDone = () => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setTimeout(() => { setPhase('confirm'); setMsg(''); }, 150);
  };

  const onConfirmDone = async (v: string) => {
    if (v !== pin) {
      setError(true);
      setMsg('PINs don’t match. Start again.');
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setTimeout(() => { setPin(''); setConfirm(''); setPhase('set'); setError(false); }, 600);
      return;
    }
    setSaving(true);
    try {
      await savePIN(pin); // hashes to SecureStore (vc_pin_hash)
      await markSetupComplete();
      markUnlocked();
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace('/(tabs)/chats' as any);
    } catch (e: any) {
      setSaving(false);
      setMsg(e?.message || 'Failed to save PIN');
    }
  };

  const setting = phase === 'set';

  return (
    <View style={s.screen}>
      <View style={s.lock}><Text style={s.lockIcon}>🔒</Text></View>
      <Text style={s.title}>{setting ? 'Create your MPIN' : 'Confirm your MPIN'}</Text>
      <Text style={s.subtitle}>
        {setting ? 'You’ll use this 6-digit PIN to unlock VaultChat' : 'Re-enter your PIN to confirm'}
      </Text>

      <View style={s.padArea}>
        {saving
          ? <ActivityIndicator color={Aurora.primary} size="large" />
          : (
            <PinPad
              value={setting ? pin : confirm}
              onChange={setting ? setPin : setConfirm}
              onComplete={setting ? onSetDone : onConfirmDone}
              error={error}
            />
          )}
      </View>

      {msg ? <Text style={[s.msg, error && { color: Aurora.danger }]}>{msg}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Aurora.bg, alignItems: 'center', paddingTop: 96 },
  lock: { width: 64, height: 64, borderRadius: 20, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  lockIcon: { fontSize: 28 },
  title: { color: Aurora.text, fontSize: 24, fontWeight: '800', marginBottom: 8 },
  subtitle: { color: Aurora.textDim, fontSize: 14, textAlign: 'center', paddingHorizontal: 40, marginBottom: 40 },
  padArea: { minHeight: 360, justifyContent: 'center' },
  msg: { color: Aurora.textDim, fontSize: 13, marginTop: 8 },
});
