// app/add/[...segments].tsx — deep-link handler for `vaultchat://add/<vaultId>/<name>`.
//
// The "My QR" code (app/qr-contact.tsx) encodes a VaultID as
//   vaultchat://add/<vaultId>/<encodedName>
// Expo Router maps that URL onto this catch-all route, so scanning the QR with
// the OS camera — or tapping a shared link — opens the app straight here. We
// resolve the VaultID to a real user (GET /user/by-vault/:id), then ASK before
// opening (or creating) the direct chat — the same "Contact found → Open chat"
// step the in-app scanner shows (qr-contact.tsx). A link anyone can send must
// not create a chat on its own.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { createDirectChat, getMyProfile, resolveVaultId } from '../../lib/chatService';
import { AuroraBackground } from '../../components/ui';
import { AppText as Text } from '../../components/ui/Text';
import { isVaultId } from '../../lib/vaultIdLink';
import { userErrorText } from '../../lib/userErrorText';

const errStatus = (e: unknown) => (e as { status?: number } | null)?.status;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

type Phase =
  | { k: 'resolving' }
  | { k: 'confirm'; userId: string; name: string }
  | { k: 'opening'; userId: string; name: string }
  | { k: 'error'; msg: string; retry: boolean };

export default function AddByVaultIdScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { segments } = useLocalSearchParams<{ segments?: string | string[] }>();
  const [phase, setPhase] = useState<Phase>({ k: 'resolving' });
  const ran = useRef(false);
  // Cancel during the lookup navigates away; the lookup must not keep setting
  // state on a screen that is gone.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // First path segment is the VaultID. A second (the QR's display name) is
  // ignored on purpose: anyone can craft a link that says "Mum", so nothing is
  // shown but the VaultID until the SERVER's name for it comes back.
  const parts = Array.isArray(segments) ? segments : segments ? [segments] : [];
  const vaultId = (parts[0] ?? '').replace(/^@/, '').trim();

  const resolve = useCallback(async () => {
    if (!vaultId) { setPhase({ k: 'error', msg: 'This link is missing a VaultID.', retry: false }); return; }
    // Same charset the QR scanner accepts (lib/vaultIdLink.ts): a crafted link
    // must not put arbitrary text into the lookup path.
    if (!isVaultId(vaultId)) { setPhase({ k: 'error', msg: 'This link does not contain a valid VaultID.', retry: false }); return; }
    setPhase({ k: 'resolving' });
    const set = (p: Phase) => { if (alive.current) setPhase(p); };
    try {
      const me = await getMyProfile();
      if (me.vaultId && me.vaultId.replace(/^@/, '') === vaultId) {
        set({ k: 'error', msg: "That's your own VaultID.", retry: false });
        return;
      }
      const peer = await resolveVaultId(vaultId);
      set({ k: 'confirm', userId: peer.userId, name: peer.name || `@${vaultId}` });
    } catch (e: unknown) {
      if (errStatus(e) === 404) set({ k: 'error', msg: `No crazzychat user found for @${vaultId}.`, retry: false });
      else if (errStatus(e) === 401) set({ k: 'error', msg: 'Sign in first, then open this link again.', retry: false });
      else set({ k: 'error', msg: userErrorText(e, 'Could not look up this contact.'), retry: true });
    }
  }, [vaultId]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    resolve();
  }, [resolve]);

  const openChat = useCallback(async () => {
    if (phase.k !== 'confirm') return;
    const { userId, name } = phase;
    setPhase({ k: 'opening', userId, name });
    try {
      const { id } = await createDirectChat({ userId });
      if (!alive.current) return;
      router.replace({ pathname: '/chat', params: { id, peerUid: userId, peerName: name } });
    } catch (e: unknown) {
      if (alive.current) setPhase({ k: 'error', msg: userErrorText(e, 'Could not open this chat.'), retry: true });
    }
  }, [phase, router]);

  const goChats = () => router.replace('/(tabs)/chats');

  return (
    <View style={[S.screen, S.center]}>
      <AuroraBackground />
      {phase.k === 'error' ? (
        <>
          <Text style={S.icon} accessible={false} importantForAccessibility="no-hide-descendants">🔗</Text>
          <Text style={S.title} accessibilityRole="header">Couldn’t add contact</Text>
          <Text style={S.sub}>{phase.msg}</Text>
          {phase.retry && (
            <TouchableOpacity style={S.btn} onPress={resolve} activeOpacity={0.85} accessibilityRole="button">
              <Text style={S.btnTxt}>Try again</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={phase.retry ? S.ghost : S.btn} onPress={goChats} activeOpacity={0.85} accessibilityRole="button">
            <Text style={phase.retry ? S.ghostTxt : S.btnTxt}>Go to Chats</Text>
          </TouchableOpacity>
        </>
      ) : phase.k === 'confirm' || phase.k === 'opening' ? (
        <>
          <Text style={S.title} accessibilityRole="header">Contact found</Text>
          <Text style={S.sub}>Start a chat with {phase.name}?</Text>
          <TouchableOpacity
            style={[S.btn, phase.k === 'opening' && { opacity: 0.6 }]}
            onPress={openChat}
            disabled={phase.k === 'opening'}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Open chat with ${phase.name}`}
            accessibilityState={{ busy: phase.k === 'opening', disabled: phase.k === 'opening' }}
          >
            {phase.k === 'opening' ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={S.btnTxt}>Open chat</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={S.ghost} onPress={goChats} disabled={phase.k === 'opening'} activeOpacity={0.85} accessibilityRole="button">
            <Text style={S.ghostTxt}>Cancel</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={S.sub} accessibilityLiveRegion="polite">Looking up @{vaultId}…</Text>
          <TouchableOpacity style={S.ghost} onPress={goChats} activeOpacity={0.85} accessibilityRole="button">
            <Text style={S.ghostTxt}>Cancel</Text>
          </TouchableOpacity>
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
  btn:    { marginTop: 12, backgroundColor: c.primary, borderRadius: 12, minHeight: 48, paddingVertical: 14, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
  btnTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
  ghost:  { minHeight: 44, paddingVertical: 10, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  ghostTxt: { color: c.textDim, fontSize: 15, fontWeight: '600' },
});
