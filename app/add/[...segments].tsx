// app/add/[...segments].tsx — deep-link handler for `vaultchat://add/<vaultId>/<name>`.
//
// The "My QR" code (app/qr-contact.tsx) encodes a VaultID as
//   vaultchat://add/<vaultId>/<encodedName>
// Expo Router maps that URL onto this catch-all route, so scanning the QR with
// the OS camera — or tapping a shared link — opens the app straight here. We
// resolve the VaultID to a real user (GET /user/by-vault/:id), open (or create)
// the direct chat, and replace into it. Same path the in-app scanner uses, so
// external and in-app scans behave identically.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { createDirectChat, getMyProfile, resolveVaultId } from '../../lib/chatService';
import { AuroraBackground } from '../../components/ui';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function AddByVaultIdScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { segments } = useLocalSearchParams<{ segments?: string | string[] }>();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  // First path segment is the VaultID; a second (optional) is a display name
  // hint we only use for the resolving label until the server name comes back.
  const parts = Array.isArray(segments) ? segments : segments ? [segments] : [];
  const vaultId = (parts[0] ?? '').replace(/^@/, '').trim();
  const nameHint = parts[1] ? decodeURIComponent(parts[1]) : '';

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      if (!vaultId) { setError('This link is missing a VaultID.'); return; }
      try {
        const me = await getMyProfile();
        if (me.vaultId && me.vaultId.replace(/^@/, '') === vaultId) {
          setError("That's your own VaultID.");
          return;
        }
        const peer = await resolveVaultId(vaultId);
        const { id } = await createDirectChat({ userId: peer.userId });
        router.replace({
          pathname: '/chat',
          params: { id, peerUid: peer.userId, peerName: peer.name || vaultId },
        } as any);
      } catch (e: any) {
        const msg = e?.status === 404
          ? `No crazzychat user found for @${vaultId}.`
          : e?.status === 401
            ? 'Sign in first, then open this link again.'
            : (e?.message ?? 'Could not open this contact.');
        setError(msg);
      }
    })();
  }, [vaultId, router]);

  return (
    <View style={[S.screen, S.center]}>
      <AuroraBackground />
      {error ? (
        <>
          <Text style={S.icon}>🔗</Text>
          <Text style={S.title}>Couldn’t add contact</Text>
          <Text style={S.sub}>{error}</Text>
          <TouchableOpacity style={S.btn} onPress={() => router.replace('/(tabs)/chats')} activeOpacity={0.85}>
            <Text style={S.btnTxt}>Go to Chats</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={S.sub}>Adding {nameHint || `@${vaultId}`}…</Text>
        </>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  icon:   { fontSize: 44, marginBottom: 4 },
  title:  { color: c.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  sub:    { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn:    { marginTop: 12, backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
