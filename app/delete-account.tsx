// app/delete-account.tsx — permanently delete this account.
//
// Play requires any app with accounts to offer in-app deletion, and this is
// that screen. It replaces the pair of Alert dialogs Settings used to show,
// because a destructive-styled button in a native alert is one mis-tap from
// erasing everything and gives no chance to say what is actually lost.
//
// Modelled on WhatsApp's delete-account screen, and for the same reasons:
//   • the consequences are listed BEFORE the input, not inside a dialog;
//   • you type your own number back to arm the button — a deliberate act that
//     a mis-tap cannot produce, and the one gesture people already know;
//   • "why are you leaving" is optional feedback, never a gate.
//
// The final native confirm is still there. Two deliberate acts, no more.

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HEADER_TOP } from '../constants/layout';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import { identityMatches } from '../lib/confirmIdentity';
import { deleteAccount } from '../lib/chatService';
import { unregisterPushToken } from '../lib/push';
import { disconnect as disconnectSocket } from '../lib/socket';
import { logoutUser } from './(constants)/authService';
import { AuroraBackground } from '../components/ui';

// What actually happens, in the order a person cares about. Every line here is
// backed by DELETE /user/account — do not add a promise the server does not keep.
const CONSEQUENCES = [
  'Delete your account and free up your number',
  'Erase your profile, PIN and recovery answers',
  'Remove you from all of your groups',
  'Delete your encryption keys and server backup',
  'Erase chats and media on this phone',
];

const REASONS = [
  'I don’t use VaultChat',
  'I’m missing a feature',
  'I have privacy concerns',
  'Too many notifications',
  'I’m changing my number',
  'Other',
];

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();

  const [me, setMe] = useState<{ phone?: string; email?: string } | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(false);
    try {
      const u: any = await api('/user/profile');
      setMe({ phone: u?.phone || undefined, email: u?.email || undefined });
    } catch {
      setLoadErr(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Phone if there is one, email otherwise — confirm with whatever identifies
  // the account to its owner.
  const byPhone = !!me?.phone;

  const armed = useMemo(() => identityMatches(me, typed), [me, typed]);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      await deleteAccount(reason ?? undefined);
      // Order matters: the account is gone, so these are best-effort cleanups
      // of this device. A failure here must not strand the user on a screen for
      // an account that no longer exists.
      try { await unregisterPushToken(); } catch {}
      try { disconnectSocket(); } catch {}
      await logoutUser();          // wipes local chats, media and backups
      router.replace('/onboard' as any);
    } catch (e: any) {
      setBusy(false);
      Alert.alert('Delete failed', e?.message ?? 'Check your connection and try again.');
    }
  }, [reason, router]);

  const confirm = useCallback(() => {
    if (!armed || busy) return;
    Alert.alert(
      'Delete account?',
      'This cannot be undone. Your account is erased now, and every device signed into it is signed out for good.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: run },
      ],
    );
  }, [armed, busy, run]);

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Delete account</Text>
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        <View style={S.warnCard}>
          <View style={S.warnHead}>
            <Ionicons name="warning" size={20} color={colors.danger} />
            <Text style={S.warnTitle}>Deleting your account will:</Text>
          </View>
          {CONSEQUENCES.map(line => (
            <View key={line} style={S.bullet}>
              <Text style={S.dot}>•</Text>
              <Text style={S.bulletTxt}>{line}</Text>
            </View>
          ))}
        </View>

        {/* Said plainly because people assume deletion recalls what they sent.
            It does not, and finding that out afterwards is worse. */}
        <Text style={S.note}>
          Messages you already sent stay on the phones of the people you sent them to — those
          copies are theirs. Nobody will be able to reach you here again.
        </Text>

        {loadErr ? (
          <TouchableOpacity style={S.retry} onPress={load} activeOpacity={0.8}>
            <Ionicons name="refresh" size={18} color={colors.primary} />
            <Text style={S.retryTxt}>Couldn’t load your account. Tap to retry.</Text>
          </TouchableOpacity>
        ) : !me ? (
          <ActivityIndicator style={{ marginTop: 28 }} color={colors.primary} />
        ) : (
          <>
            <Text style={S.sectionLabel}>
              {byPhone ? 'CONFIRM YOUR PHONE NUMBER' : 'CONFIRM YOUR EMAIL'}
            </Text>
            <TextInput
              style={S.input}
              value={typed}
              onChangeText={setTyped}
              placeholder={byPhone ? 'Your number' : 'you@example.com'}
              placeholderTextColor={colors.textFaint}
              keyboardType={byPhone ? 'phone-pad' : 'email-address'}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
            <Text style={S.hint}>
              {byPhone
                ? 'Type the number on this account to turn on the button below.'
                : 'Type the email on this account to turn on the button below.'}
            </Text>

            <Text style={S.sectionLabel}>WHY ARE YOU LEAVING? (OPTIONAL)</Text>
            <View style={S.chips}>
              {REASONS.map(r => (
                <TouchableOpacity
                  key={r}
                  style={[S.chip, reason === r && S.chipOn]}
                  onPress={() => setReason(reason === r ? null : r)}
                  activeOpacity={0.8}>
                  <Text style={[S.chipTxt, reason === r && S.chipTxtOn]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={[S.cta, (!armed || busy) && S.ctaOff]}
              onPress={confirm}
              disabled={!armed || busy}
              activeOpacity={0.85}>
              {busy ? <ActivityIndicator color="#fff" />
                    : <Text style={S.ctaTxt}>Delete my account</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP + 40, paddingBottom: 12, gap: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },

  body: { paddingHorizontal: 18, paddingBottom: 48 },

  warnCard: { marginTop: 6, padding: 16, borderRadius: 16, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.danger },
  warnHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  warnTitle: { color: c.danger, fontSize: 15, fontWeight: '800', flexShrink: 1 },
  bullet: { flexDirection: 'row', gap: 8, paddingVertical: 3 },
  dot: { color: c.danger, fontSize: 14, lineHeight: 20 },
  bulletTxt: { color: c.text, fontSize: 14, lineHeight: 20, flex: 1 },

  note: { color: c.textDim, fontSize: 13, lineHeight: 19, marginTop: 14 },

  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingTop: 24, paddingBottom: 8 },
  input: { minHeight: 52, borderRadius: 14, paddingHorizontal: 16, backgroundColor: c.glassSoft, color: c.text, fontSize: 17, fontWeight: '700' },
  hint: { color: c.textFaint, fontSize: 12, marginTop: 8, lineHeight: 17 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: 'transparent' },
  chipOn: { borderColor: c.primary },
  chipTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  chipTxtOn: { color: c.text },

  cta: { marginTop: 26, minHeight: 50, borderRadius: 14, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },

  retry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28 },
  retryTxt: { color: c.primary, fontSize: 13.5, fontWeight: '700' },
});
