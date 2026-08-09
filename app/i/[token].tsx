// app/i/[token].tsx — redeem a per-invitee invitation token.
//
// This is what a scanned QR or a shared invite link lands on:
//   https://vaultchat.app/i/<token>   (and vaultchat://i/<token>)
//
// Distinct from app/join/[code].tsx, which redeems a plain shareable CODE. The
// token here is signed and bound to one invitation and one group, so the server
// can settle that invitation's status on acceptance — a bare code has no
// invitee to settle.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { redeemInvitation } from '../../lib/chatService';

type Phase =
  | { kind: 'redeeming' }
  | { kind: 'error'; message: string };

export default function InviteTokenScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'redeeming' });

  const redeem = useCallback(async () => {
    const t = String(token ?? '').trim();
    if (!t) { setPhase({ kind: 'error', message: 'This invitation link is missing its code.' }); return; }
    setPhase({ kind: 'redeeming' });
    try {
      const res = await redeemInvitation(t);
      // Replace, so Back does not bounce the user through the redeem screen.
      router.replace({ pathname: '/chat', params: { id: res.chatId } } as any);
    } catch (e: any) {
      setPhase({
        kind: 'error',
        // The server distinguishes expired / superseded / full; surface its
        // wording rather than flattening every case to "invalid".
        message: e?.message ?? 'This invitation is no longer valid.',
      });
    }
  }, [token, router]);

  useEffect(() => { redeem(); }, [redeem]);

  return (
    <View style={[st.wrap, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Invitation', headerTitleAlign: 'center' }} />
      {phase.kind === 'redeeming' ? (
        <>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={[st.msg, { color: colors.textDim }]}>Joining…</Text>
        </>
      ) : (
        <>
          <View style={[st.badge, { backgroundColor: colors.danger + '1a' }]}>
            <Ionicons name="alert-circle" size={34} color={colors.danger} />
          </View>
          <Text style={[st.title, { color: colors.text }]}>Cannot join</Text>
          <Text style={[st.msg, { color: colors.textDim }]}>{phase.message}</Text>
          <TouchableOpacity onPress={redeem} style={[st.btn, { backgroundColor: colors.primary }]}>
            <Ionicons name="refresh" size={17} color="#fff" />
            <Text style={st.btnTxt}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.replace('/(tabs)/chats' as any)} style={st.link}>
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Go to chats</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  badge: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 19, fontWeight: '800' },
  msg: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 13, paddingHorizontal: 28, marginTop: 10 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  link: { padding: 10 },
});
