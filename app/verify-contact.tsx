// app/verify-contact.tsx — Verify safety number (#101).
//
// Shows the 60-digit safety number derived from both parties' public identity
// keys. If it matches what the contact sees on their device (read aloud or
// compared, or copied into a trusted channel), there is no man-in-the-middle. The "verified" decision is the
// user's own and is persisted (synced across their devices).

import { HEADER_TOP } from '../constants/layout';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, ToastAndroid, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getCachedUser } from '../lib/api';
import { computeSafetyNumber, formatSafetyNumber } from '../services/security/safetyNumber';
import { fetchIdentityKey, getVerifiedContacts, setContactVerified } from '../lib/verification';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { copyAndAutoClear } from '../lib/clipboardSafe';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string; retryable: boolean }
  | { kind: 'ready'; number: string };

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VerifyContactScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const params = useLocalSearchParams();
  const peerId = (params.peerId as string) || '';
  const peerName = (params.peerName as string) || 'this contact';

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [verified, setVerified] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const me = await getCachedUser();
      const myId = me?.id;
      if (!myId || !peerId) { setState({ kind: 'unavailable', reason: 'Missing account or contact.', retryable: false }); return; }

      const [myKey, peerKey, verifiedList] = await Promise.all([
        fetchIdentityKey(myId),
        fetchIdentityKey(peerId),
        getVerifiedContacts().catch(() => [] as string[]),
      ]);

      if (!myKey) { setState({ kind: 'unavailable', reason: 'Your encryption keys aren’t published yet. Open a chat once to set up E2EE, then try again.', retryable: true }); return; }
      if (!peerKey) { setState({ kind: 'unavailable', reason: `${peerName} hasn’t set up end-to-end encryption yet, so there’s no safety number to compare.`, retryable: true }); return; }

      setVerified(verifiedList.includes(peerId));
      setState({ kind: 'ready', number: computeSafetyNumber(myId, myKey, peerId, peerKey) });
    } catch (e: any) {
      setState({ kind: 'unavailable', reason: e?.message ?? 'Could not load the safety number.', retryable: true });
    }
  }, [peerId, peerName]);

  useEffect(() => { load(); }, [load]);

  const toggleVerified = useCallback(async () => {
    if (saving) return;
    const next = !verified;
    setSaving(true);
    setVerified(next);
    try {
      await setContactVerified(peerId, next);
    } catch (e: any) {
      setVerified(!next); // revert on failure
      Alert.alert('Could not save', e?.message ?? 'Try again');
    } finally {
      setSaving(false);
    }
  }, [saving, verified, peerId]);

  // Copy for comparing over a trusted text channel; the clipboard clears itself.
  const copyNumber = useCallback(async (n: string) => {
    try {
      await copyAndAutoClear(formatSafetyNumber(n));
      if (Platform.OS === 'android') ToastAndroid.show('Safety number copied', ToastAndroid.SHORT);
      else Alert.alert('Copied', 'The safety number was copied. It is cleared from the clipboard shortly.');
    } catch {
      Alert.alert('Could not copy', 'Try again.');
    }
  }, []);

  return (
    <View style={S.container}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={[S.title, { flexShrink: 1, textAlign: 'center' }]} numberOfLines={1} accessibilityRole="header">Verify {peerName}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        {state.kind === 'loading' && (
          <View style={S.center}><ActivityIndicator color={colors.primary} /></View>
        )}

        {state.kind === 'unavailable' && (
          <View style={S.card}>
            <Ionicons name="information-circle" size={28} color={colors.textDim} />
            <Text style={S.unavailable}>{state.reason}</Text>
            {state.retryable && (
              <TouchableOpacity onPress={load} accessibilityRole="button" accessibilityLabel="Try again" style={{ padding: 10, minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Try again</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {state.kind === 'ready' && (
          <>
            <View style={S.card}>
              <Text style={S.numberLabel}>Safety number</Text>
              {/* Read in five-digit groups, not as one 60-digit number. */}
              <Text style={S.number} accessibilityLabel={`Safety number: ${formatSafetyNumber(state.number).split(/\s+/).join(', ')}`}>{formatSafetyNumber(state.number)}</Text>
              <TouchableOpacity onPress={() => copyNumber(state.number)} style={S.copyBtn} accessibilityRole="button" accessibilityLabel="Copy safety number">
                <Ionicons name="copy-outline" size={16} color={colors.primary} />
                <Text style={S.copyTxt}>Copy</Text>
              </TouchableOpacity>
            </View>

            <Text style={S.explain}>
              Compare this 60-digit number with {peerName} in person or over a trusted channel
              (read it aloud, screen-share, or copy it into a chat you already trust). If it matches on both devices, your conversation is
              not being intercepted. If the numbers ever differ, the keys changed — do not trust
              the chat until you re-verify.
            </Text>

            <TouchableOpacity
              style={[S.verifyBtn, verified ? S.verifyBtnOn : S.verifyBtnOff]}
              onPress={toggleVerified}
              disabled={saving}
              activeOpacity={0.85}
              accessibilityRole="switch"
              accessibilityLabel="Mark as verified"
              accessibilityState={{ checked: verified, busy: saving, disabled: saving }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={verified ? '#fff' : colors.primary} />
              ) : (
                <>
                  <Ionicons
                    name={verified ? 'shield-checkmark' : 'shield-outline'}
                    size={18}
                    color={verified ? '#fff' : colors.primary}
                  />
                  <Text style={[S.verifyBtnText, { color: verified ? '#fff' : colors.primary }]}>
                    {verified ? 'Verified — tap to clear' : 'Mark as verified'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  title: { color: c.text, fontSize: 17, fontWeight: '800' },
  backBtn: { width: 44, height: 44, justifyContent: 'center' },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14 },
  copyTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  center: { paddingVertical: 60, alignItems: 'center' },

  card: { backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: 1, borderColor: c.glassStroke, padding: 20, alignItems: 'center', gap: 10 },
  numberLabel: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  number: { color: c.text, fontSize: 22, fontWeight: '700', letterSpacing: 2, textAlign: 'center', lineHeight: 34, fontVariant: ['tabular-nums'] },

  explain: { color: c.textDim, fontSize: 13.5, lineHeight: 20, marginTop: 18, marginBottom: 22 },

  verifyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15, borderRadius: 14, borderWidth: 1 },
  verifyBtnOn: { backgroundColor: c.primary, borderColor: c.primary },
  verifyBtnOff: { backgroundColor: 'transparent', borderColor: c.primary },
  verifyBtnText: { fontSize: 15, fontWeight: '800' },

  unavailable: { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
