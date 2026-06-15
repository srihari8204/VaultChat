// app/verify-contact.tsx — Verify safety number (#101).
//
// Shows the 60-digit safety number derived from both parties' public identity
// keys. If it matches what the contact sees on their device (read aloud or
// compared), there is no man-in-the-middle. The "verified" decision is the
// user's own and is persisted (synced across their devices).

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import { getCachedUser } from '../lib/api';
import { computeSafetyNumber, formatSafetyNumber } from '../services/security/safetyNumber';
import { fetchIdentityKey, getVerifiedContacts, setContactVerified } from '../lib/verification';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; number: string };

export default function VerifyContactScreen() {
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
      if (!myId || !peerId) { setState({ kind: 'unavailable', reason: 'Missing account or contact.' }); return; }

      const [myKey, peerKey, verifiedList] = await Promise.all([
        fetchIdentityKey(myId),
        fetchIdentityKey(peerId),
        getVerifiedContacts().catch(() => [] as string[]),
      ]);

      if (!myKey) { setState({ kind: 'unavailable', reason: 'Your encryption keys aren’t published yet. Open a chat once to set up E2EE, then try again.' }); return; }
      if (!peerKey) { setState({ kind: 'unavailable', reason: `${peerName} hasn’t set up end-to-end encryption yet, so there’s no safety number to compare.` }); return; }

      setVerified(verifiedList.includes(peerId));
      setState({ kind: 'ready', number: computeSafetyNumber(myId, myKey, peerId, peerKey) });
    } catch (e: any) {
      setState({ kind: 'unavailable', reason: e?.message ?? 'Could not load the safety number.' });
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

  return (
    <View style={S.container}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={Aurora.text} />
        </TouchableOpacity>
        <Text style={S.title}>Verify {peerName}</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        {state.kind === 'loading' && (
          <View style={S.center}><ActivityIndicator color={Aurora.primary} /></View>
        )}

        {state.kind === 'unavailable' && (
          <View style={S.card}>
            <Ionicons name="information-circle" size={28} color={Aurora.textDim} />
            <Text style={S.unavailable}>{state.reason}</Text>
          </View>
        )}

        {state.kind === 'ready' && (
          <>
            <View style={S.card}>
              <Text style={S.numberLabel}>Safety number</Text>
              <Text style={S.number}>{formatSafetyNumber(state.number)}</Text>
            </View>

            <Text style={S.explain}>
              Compare this 60-digit number with {peerName} in person or over a trusted channel
              (read it aloud or screen-share). If it matches on both devices, your conversation is
              not being intercepted. If the numbers ever differ, the keys changed — do not trust
              the chat until you re-verify.
            </Text>

            <TouchableOpacity
              style={[S.verifyBtn, verified ? S.verifyBtnOn : S.verifyBtnOff]}
              onPress={toggleVerified}
              disabled={saving}
              activeOpacity={0.85}
            >
              {saving ? (
                <ActivityIndicator size="small" color={verified ? '#fff' : Aurora.primary} />
              ) : (
                <>
                  <Ionicons
                    name={verified ? 'shield-checkmark' : 'shield-outline'}
                    size={18}
                    color={verified ? '#fff' : Aurora.primary}
                  />
                  <Text style={[S.verifyBtnText, { color: verified ? '#fff' : Aurora.primary }]}>
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

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingBottom: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Aurora.border },
  title: { color: Aurora.text, fontSize: 17, fontWeight: '800' },
  center: { paddingVertical: 60, alignItems: 'center' },

  card: { backgroundColor: Aurora.card, borderRadius: 16, borderWidth: 1, borderColor: Aurora.border, padding: 20, alignItems: 'center', gap: 10 },
  numberLabel: { color: Aurora.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  number: { color: Aurora.text, fontSize: 22, fontWeight: '700', letterSpacing: 2, textAlign: 'center', lineHeight: 34, fontVariant: ['tabular-nums'] },

  explain: { color: Aurora.textDim, fontSize: 13.5, lineHeight: 20, marginTop: 18, marginBottom: 22 },

  verifyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15, borderRadius: 14, borderWidth: 1 },
  verifyBtnOn: { backgroundColor: Aurora.primary, borderColor: Aurora.primary },
  verifyBtnOff: { backgroundColor: 'transparent', borderColor: Aurora.primary },
  verifyBtnText: { fontSize: 15, fontWeight: '800' },

  unavailable: { color: Aurora.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
