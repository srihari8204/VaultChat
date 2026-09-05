// app/join/[code].tsx — redeem a group invite link and join.
//
// Reached two ways:
//   1. Deep link  vaultchat://join/CODE  (and the https://vaultchat.app/join/CODE
//      universal link once domain verification is live) — Expo Router maps the
//      path straight here.
//   2. In-app paste-to-join from /new-chat, which pushes /join/<code>.
//
// Backed by POST /chats/join/:code (real redeem: atomic uses++, approval queue).
// On success we land in the chat; if the group needs admin approval we tell the
// user their request was sent.

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { joinViaInvite } from '../../lib/chatService';
import { AuroraBackground } from '../../components/ui';

type Phase =
  | { kind: 'joining' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string };

export default function JoinScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { code } = useLocalSearchParams<{ code: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'joining' });

  const redeem = useCallback(async () => {
    const clean = String(code ?? '').trim();
    if (!clean) { setPhase({ kind: 'error', message: 'This invite link is missing its code.' }); return; }
    setPhase({ kind: 'joining' });
    try {
      const res = await joinViaInvite(clean);
      if (res.pending) { setPhase({ kind: 'pending' }); return; }
      // Joined (or already a member) — go straight to the chat, replacing this
      // screen so Back doesn't bounce through the redeem flow.
      router.replace({ pathname: '/chat', params: { id: res.chatId } } as any);
    } catch (e: any) {
      setPhase({ kind: 'error', message: e?.message ?? 'This link is invalid, expired, or revoked.' });
    }
  }, [code, router]);

  useEffect(() => { redeem(); }, [redeem]);

  const goHome = () => router.replace('/(tabs)/chats' as any);

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />
      <View style={s.body}>
        {phase.kind === 'joining' && (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={s.title}>Joining group…</Text>
            <Text style={s.sub}>Redeeming your invite</Text>
          </>
        )}

        {phase.kind === 'pending' && (
          <>
            <Ionicons name="hourglass-outline" size={56} color={colors.accent} />
            <Text style={s.title}>Request sent</Text>
            <Text style={s.sub}>This group approves new members. An admin will review your request to join.</Text>
            <TouchableOpacity style={s.cta} onPress={goHome} activeOpacity={0.85}>
              <Text style={s.ctaTxt}>Back to chats</Text>
            </TouchableOpacity>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <Ionicons name="alert-circle-outline" size={56} color={colors.danger} />
            <Text style={s.title}>Couldn’t join</Text>
            <Text style={s.sub}>{phase.message}</Text>
            <TouchableOpacity style={[s.cta, { backgroundColor: colors.primary }]} onPress={redeem} activeOpacity={0.85}>
              <Text style={s.ctaTxt}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.ghost} onPress={goHome} activeOpacity={0.7}>
              <Text style={s.ghostTxt}>Back to chats</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  title: { color: c.text, fontSize: 20, fontWeight: '800', marginTop: 16 },
  sub: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 300 },
  cta: { marginTop: 20, height: 52, borderRadius: 14, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, minWidth: 200 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  ghost: { marginTop: 6, paddingVertical: 10 },
  ghostTxt: { color: c.textDim, fontSize: 14, fontWeight: '600' },
});
