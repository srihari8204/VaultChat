// app/i/[token].tsx — redeem a per-invitee invitation token (LEGACY).
//
// Reached through the app scheme, vaultchat://i/<token>. Nothing in the app
// mints these tokens any more (lib/chatService.ts redeemInvitation); the route
// stays so a link already sitting in someone's messages still works, and the
// server still redeems it (POST /invitations/redeem). The https host has no
// /i/ app-link filter (app.json), so that form opens in the browser.
//
// Distinct from app/join/[code].tsx, which redeems a plain shareable CODE. The
// token here is signed and bound to one invitation and one group, so the server
// can settle that invitation's status on acceptance — a bare code has no
// invitee to settle.
//
// The token is a forwardable credential (lib/chatService.ts redeemInvitation),
// so opening the link only ASKS; joining happens on an explicit tap.
//
// Not done here, and why: the confirm cannot name the group, because the
// server has no token-bound preview (join/[code] has /chats/join/:code/preview);
// and whether this legacy route gets a retirement date or a producer again is
// a product decision. Both are listed in the round-4 fix log.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { tint } from '../../lib/tintColor';
import { redeemInvitation } from '../../lib/chatService';
import { AuroraBackground } from '../../components/ui';
import { AppText as Text } from '../../components/ui/Text';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;
const errStatus = (e: unknown) => (e as { status?: number } | null)?.status;

type Phase =
  | { kind: 'confirm' }
  | { kind: 'redeeming' }
  // `retry` is false when trying again cannot help: no token, or the server
  // said the invitation is expired, superseded or not valid (410).
  | { kind: 'error'; message: string; retry: boolean };

export default function InviteTokenScreen() {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });
  // Set by Cancel (and on unmount). The request cannot be recalled once sent,
  // but its result must not pull the user back into the chat they left for.
  const cancelledRef = useRef(false);
  useEffect(() => () => { cancelledRef.current = true; }, []);

  const redeem = useCallback(async () => {
    const t = String(token ?? '').trim();
    if (!t) { setPhase({ kind: 'error', message: 'This invitation link is missing its code.', retry: false }); return; }
    cancelledRef.current = false;
    setPhase({ kind: 'redeeming' });
    try {
      const res = await redeemInvitation(t);
      if (cancelledRef.current) return;
      // Replace, so Back does not bounce the user through the redeem screen.
      router.replace({ pathname: '/chat', params: { id: res.chatId } });
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setPhase({
        kind: 'error',
        // The server distinguishes expired / superseded / full; surface its
        // wording rather than flattening every case to "invalid".
        message: errText(e, 'This invitation is no longer valid.'),
        retry: errStatus(e) !== 410 && errStatus(e) !== 400,
      });
    }
  }, [token, router]);

  useEffect(() => {
    if (!String(token ?? '').trim()) setPhase({ kind: 'error', message: 'This invitation link is missing its code.', retry: false });
  }, [token]);

  const goChats = () => router.replace('/(tabs)/chats');

  return (
    <View style={st.wrap}>
      <AuroraBackground />
      {/* The root Stack hides headers, so this screen draws its own exits. */}
      <Stack.Screen options={{ headerShown: false }} />
      {phase.kind === 'confirm' ? (
        <>
          <View style={[st.badge, st.badgeOk]}>
            <Ionicons name="mail-open-outline" size={34} color={colors.primary} />
          </View>
          <Text style={st.title} accessibilityRole="header">Accept this invitation?</Text>
          <Text style={st.msg}>
            Accepting joins you to the group this invitation is for. Its members will see you and your messages there.
          </Text>
          <TouchableOpacity onPress={redeem} style={st.btn} accessibilityRole="button">
            <Text style={st.btnTxt}>Accept and join</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={goChats} style={st.link} accessibilityRole="button">
            <Text style={st.linkDim}>Not now</Text>
          </TouchableOpacity>
        </>
      ) : phase.kind === 'redeeming' ? (
        <>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={st.msg} accessibilityLiveRegion="polite">Joining…</Text>
          <TouchableOpacity
            onPress={() => { cancelledRef.current = true; goChats(); }}
            style={st.link}
            accessibilityRole="button"
            accessibilityHint="Stops waiting and goes to chats. A join the server already accepted still completes."
          >
            <Text style={st.linkDim}>Cancel</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={[st.badge, st.badgeErr]}>
            <Ionicons name="alert-circle" size={34} color={colors.danger} />
          </View>
          <Text style={st.title} accessibilityRole="header">Cannot join</Text>
          <Text style={st.msg}>{phase.message}</Text>
          {phase.retry ? (
            <>
              <TouchableOpacity onPress={redeem} style={st.btn} accessibilityRole="button">
                <Ionicons name="refresh" size={17} color={colors.onPrimary} />
                <Text style={st.btnTxt}>Try again</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={goChats} style={st.link} accessibilityRole="button">
                <Text style={st.linkPrimary}>Go to chats</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={goChats} style={st.btn} accessibilityRole="button">
              <Text style={st.btnTxt}>Go to chats</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  // Transparent over AuroraBackground, like the other link screens (join, add).
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12, backgroundColor: 'transparent' },
  badge: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  badgeOk: { backgroundColor: tint(c.primary, 0.1) },
  badgeErr: { backgroundColor: tint(c.danger, 0.1) },
  title: { color: c.text, fontSize: 19, fontWeight: '800' },
  msg: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 13, paddingHorizontal: 28, marginTop: 10, backgroundColor: c.primary },
  btnTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '800' },
  link: { padding: 10, minHeight: 44, justifyContent: 'center' },
  linkDim: { color: c.textDim, fontWeight: '600' },
  linkPrimary: { color: c.primary, fontWeight: '600' },
});
