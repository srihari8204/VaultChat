// app/join/[code].tsx — redeem a group invite link and join.
//
// Reached two ways:
//   1. Deep link  vaultchat://join/CODE  (and the https://vaultchat.app/join/CODE
//      universal link once domain verification is live) — Expo Router maps the
//      path straight here.
//   2. The invite QR (app/invite-link.tsx) scanned with the OS camera.
//
// Backed by POST /chats/join/:code (real redeem: atomic uses++, approval queue).
// Opening the link does NOT join: a forwarded link must not silently make
// someone a member, so the screen asks first (as the in-app scanner does for
// contacts). The confirm step shows the group's name, size and whether an admin
// must approve, from GET /chats/join/:code/preview (which joins nothing). A
// server without that route falls back to the generic confirm.
// On success we land in the chat; if the group needs admin approval we tell the
// user their request was sent.

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { joinViaInvite, previewInvite } from '../../lib/chatService';
import { AuroraBackground } from '../../components/ui';
import { AppText as Text } from '../../components/ui/Text';

const PREVIEW_WAIT_MS = 4000;

type Phase =
  | { kind: 'confirm' }
  | { kind: 'joining' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string; retry: boolean };

export default function JoinScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { code } = useLocalSearchParams<{ code: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });
  const [preview, setPreview] = useState<{ name: string; memberCount: number; requiresApproval: boolean } | null>(null);
  // Join waits (briefly) for the preview, so nobody consents to "this group" a
  // moment before its name would have appeared. Settles on any answer, or after
  // PREVIEW_WAIT_MS against a slow or older server.
  const [previewSettled, setPreviewSettled] = useState(false);
  // Set by Cancel (and on unmount). The request cannot be recalled once sent,
  // but its result must not pull the user into a chat they walked away from.
  const cancelledRef = useRef(false);
  useEffect(() => () => { cancelledRef.current = true; }, []);

  const redeem = useCallback(async () => {
    const clean = String(code ?? '').trim();
    if (!clean) { setPhase({ kind: 'error', message: 'This invite link is missing its code.', retry: false }); return; }
    cancelledRef.current = false;
    setPhase({ kind: 'joining' });
    try {
      const res = await joinViaInvite(clean);
      if (cancelledRef.current) return;
      if (res.pending) { setPhase({ kind: 'pending' }); return; }
      // Joined (or already a member) — go straight to the chat, replacing this
      // screen so Back doesn't bounce through the redeem flow.
      router.replace({ pathname: '/chat', params: { id: res.chatId } });
    } catch (e: any) {
      if (cancelledRef.current) return;
      // 410 = revoked, expired or used up (as the preview says): retrying the
      // same code cannot work. Anything else (offline, a 5xx) can.
      setPhase({ kind: 'error', message: e?.message ?? 'This link is invalid, expired, or revoked.', retry: e?.status !== 410 });
    }
  }, [code, router]);

  // A link with no code has nothing to confirm.
  useEffect(() => {
    const clean = String(code ?? '').trim();
    if (!clean) { setPhase({ kind: 'error', message: 'This invite link is missing its code.', retry: false }); return; }
    let dead = false;
    const settle = setTimeout(() => { if (!dead) setPreviewSettled(true); }, PREVIEW_WAIT_MS);
    previewInvite(clean).then((p) => { if (!dead) setPreview(p); }).catch((e: any) => {
      if (dead) return;
      // 410 = revoked, expired, used up or unknown: there is nothing to join.
      // Anything else (offline, an older server) keeps the generic confirm.
      if (e?.status === 410) setPhase({ kind: 'error', message: 'This invite link is invalid, expired, or revoked.', retry: false });
    }).finally(() => { if (!dead) setPreviewSettled(true); });
    return () => { dead = true; clearTimeout(settle); };
  }, [code]);

  const goHome = () => router.replace('/(tabs)/chats');

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.body}>
        {phase.kind === 'confirm' && (
          <>
            <Ionicons name="people-circle-outline" size={56} color={colors.primary} />
            <Text style={s.title} accessibilityRole="header">
              {preview ? `Join ${preview.name}?` : 'Join this group?'}
            </Text>
            {preview && (
              <Text style={s.sub}>
                {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
                {preview.requiresApproval ? ' · an admin approves new members' : ''}
              </Text>
            )}
            <Text style={s.sub}>
              Someone shared a group invite link with you. If you join, the group&apos;s members will see you
              and your messages there.
            </Text>
            {!previewSettled && (
              <Text style={s.sub} accessibilityLiveRegion="polite">Loading group details…</Text>
            )}
            <TouchableOpacity style={[s.cta, { backgroundColor: colors.primary }, !previewSettled && { opacity: 0.5 }]} onPress={redeem}
              disabled={!previewSettled} activeOpacity={0.85} accessibilityRole="button" accessibilityState={{ disabled: !previewSettled, busy: !previewSettled }}>
              <Text style={s.ctaTxt}>Join group</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.ghost} onPress={goHome} activeOpacity={0.7} accessibilityRole="button">
              <Text style={s.ghostTxt}>Not now</Text>
            </TouchableOpacity>
          </>
        )}

        {phase.kind === 'joining' && (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={s.title} accessibilityRole="header">Joining group…</Text>
            <Text style={s.sub}>Redeeming your invite</Text>
            <TouchableOpacity style={s.ghost} onPress={() => { cancelledRef.current = true; goHome(); }} activeOpacity={0.7}
              accessibilityRole="button" accessibilityHint="Stops waiting and goes to chats. A join the server already accepted still completes.">
              <Text style={s.ghostTxt}>Cancel</Text>
            </TouchableOpacity>
          </>
        )}

        {phase.kind === 'pending' && (
          <>
            <Ionicons name="hourglass-outline" size={56} color={colors.accent} />
            <Text style={s.title} accessibilityRole="header">Request sent</Text>
            <Text style={s.sub}>This group approves new members. An admin will review your request to join.</Text>
            <TouchableOpacity style={s.cta} onPress={goHome} activeOpacity={0.85} accessibilityRole="button">
              <Text style={s.ctaTxt}>Back to chats</Text>
            </TouchableOpacity>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <Ionicons name="alert-circle-outline" size={56} color={colors.danger} />
            <Text style={s.title} accessibilityRole="header">Couldn’t join</Text>
            <Text style={s.sub}>{phase.message}</Text>
            {phase.retry && (
              <TouchableOpacity style={[s.cta, { backgroundColor: colors.primary }]} onPress={redeem} activeOpacity={0.85} accessibilityRole="button">
                <Text style={s.ctaTxt}>Try again</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.ghost} onPress={goHome} activeOpacity={0.7} accessibilityRole="button">
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
  // 2026-09-18: minHeight, not height — at font scale 1.5 the 16sp label outgrew
  // a pinned 52 and clipped, leaving the only retry on a failed invite unreadable.
  // 52 stays the floor and the padding keeps the pill identical at scale 1.0.
  cta: { marginTop: 20, minHeight: 52, paddingVertical: 10, borderRadius: 14, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, minWidth: 200 },
  ctaTxt: { color: c.onPrimary, fontSize: 16, fontWeight: '800' },
  ghost: { marginTop: 6, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  ghostTxt: { color: c.textDim, fontSize: 14, fontWeight: '600' },
});
