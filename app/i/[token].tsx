// app/i/[token].tsx — redeem a per-invitee invitation token.
//
// This is what a scanned QR or a shared invite link lands on:
//   https://vaultchat.app/i/<token>   (and vaultchat://i/<token>)
//
// Distinct from app/join/[code].tsx, which redeems a plain shareable CODE. The
// token here is signed and bound to one invitation and one group, so the server
// can settle that invitation's status on acceptance — a bare code has no
// invitee to settle.
//
// The token is a forwardable credential (lib/chatService.ts redeemInvitation),
// so opening the link only ASKS; joining happens on an explicit tap.

import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { redeemInvitation } from '../../lib/chatService';
import { AppText as Text } from '../../components/ui/Text';

type Phase =
  | { kind: 'confirm' }
  | { kind: 'redeeming' }
  | { kind: 'error'; message: string };

export default function InviteTokenScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });

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

  useEffect(() => {
    if (!String(token ?? '').trim()) setPhase({ kind: 'error', message: 'This invitation link is missing its code.' });
  }, [token]);

  const goChats = () => router.replace('/(tabs)/chats' as any);

  return (
    <View style={[st.wrap, { backgroundColor: colors.bg }]}>
      {/* The root Stack hides headers, so this screen draws its own exits. */}
      <Stack.Screen options={{ headerShown: false }} />
      {phase.kind === 'confirm' ? (
        <>
          <View style={[st.badge, { backgroundColor: colors.primary + '1a' }]}>
            <Ionicons name="mail-open-outline" size={34} color={colors.primary} />
          </View>
          <Text style={[st.title, { color: colors.text }]} accessibilityRole="header">Accept this invitation?</Text>
          <Text style={[st.msg, { color: colors.textDim }]}>
            Accepting joins you to the group this invitation is for. Its members will see you and your messages there.
          </Text>
          <TouchableOpacity onPress={redeem} style={[st.btn, { backgroundColor: colors.primary }]} accessibilityRole="button">
            <Text style={st.btnTxt}>Accept and join</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={goChats} style={st.link} accessibilityRole="button">
            <Text style={{ color: colors.textDim, fontWeight: '600' }}>Not now</Text>
          </TouchableOpacity>
        </>
      ) : phase.kind === 'redeeming' ? (
        <>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={[st.msg, { color: colors.textDim }]}>Joining…</Text>
          <TouchableOpacity onPress={goChats} style={st.link} accessibilityRole="button">
            <Text style={{ color: colors.textDim, fontWeight: '600' }}>Cancel</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={[st.badge, { backgroundColor: colors.danger + '1a' }]}>
            <Ionicons name="alert-circle" size={34} color={colors.danger} />
          </View>
          <Text style={[st.title, { color: colors.text }]}>Cannot join</Text>
          <Text style={[st.msg, { color: colors.textDim }]}>{phase.message}</Text>
          <TouchableOpacity onPress={redeem} style={[st.btn, { backgroundColor: colors.primary }]} accessibilityRole="button">
            <Ionicons name="refresh" size={17} color="#fff" />
            <Text style={st.btnTxt}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={goChats} style={st.link} accessibilityRole="button">
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
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 13, paddingHorizontal: 28, marginTop: 10 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  link: { padding: 10 },
});
