// app/group-calls.tsx — Group call hub (honest, no fake/Firebase).
//
// Two real ways out of this screen:
//   • "Start group call" → /group-call-active, an N-way call THROUGH THE SFU,
//     up to the 64-seat ceiling the server enforces at POST /calls.
//   • tap a member → a 1:1 call on the voicecall/videocall screens.
//
// THIS COMMENT USED TO SAY "full-mesh, no SFU, every participant holds one
// RTCPeerConnection to every other". That has not been true since the owner
// decision of 2026-08-16 (lib/call/mode.ts): every call rides the SFU, 1:1
// included, and engine.ts's onOffer/onAnswer/onIce are inert — no SDP crosses
// the wire at all. The mesh is gone, not merely unused. Corrected 2026-09-22
// after the stale text was quoted as fact in an external document.
//
// Scale costs no trust here: RTCFrameCryptor encrypts each frame before it
// leaves the device (lib/call/frameCrypto.ts), so the SFU forwards ciphertext.
//
// The old screen simulated participants joining; nothing here is simulated.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { userErrorText } from '../lib/userErrorText';
import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { Alert, FlatList, StyleSheet, TouchableOpacity, View, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CALL_ENGINE_V2 } from '../constants/flags';
import { useTheme } from '../lib/theme';
import { getChat, attachmentUrl, createDirectChat, type ChatMember } from '../lib/chatService';
import { getSocket } from '../lib/socket';
import { getCurrentUserAsync } from './(constants)/authService';
import { AuroraBackground, AppText as Text } from '../components/ui';
import { initialOf } from '../lib/format';
import { GroupNotFound } from '../components/groups/GroupNotFound';

type CallMode = 'voice' | 'video';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function GroupCallsScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, groupName, mode: modeParam } = useLocalSearchParams<{ chatId: string; groupName: string; mode?: string }>();
  // Only the two known modes; anything else in the link falls back to voice.
  const [mode, setMode] = useState<CallMode>(modeParam === 'video' ? 'video' : 'voice');
  const [members, setMembers] = useState<ChatMember[]>([]);
  const authHeader = useAuthHeader();
  const [loading, setLoading] = useState(true);
  // Load failed: an error with Retry, not "No other members to call."
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  // One tap starts one call; cleared when the screen is focused again, or after
  // a few seconds in case the call screen never took focus.
  const starting = useRef(false);
  // The same flag for the Start button (busy, disabled); the ref is the guard.
  const [startBusy, setStartBusy] = useState(false);
  const setStarting = useCallback((on: boolean) => { starting.current = on; setStartBusy(on); }, []);
  useFocusEffect(useCallback(() => { setStarting(false); }, [setStarting]));
  // The 3 s re-enable after a start, cleared on unmount (no state set on a
  // screen that is gone).
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (releaseTimer.current) clearTimeout(releaseTimer.current); }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!chatId) return;   // GroupNotFound is drawn below
        const [chat, me] = await Promise.all([getChat(chatId), getCurrentUserAsync()]);
        if (active) {
          setMembers(chat.members.filter((m: ChatMember) => !m.leftAt && m.userId !== me?.id));
          setFailed(false);
        }
      } catch { if (active) setFailed(true); } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [chatId, reload]);

  // A 1:1 call needs the DIRECT chat with that member (voicecall/videocall
  // take "the chat to call — must be a direct chat"), never this group's id.
  // Same path as family-member and contacts: open-or-create it first.
  const [opening, setOpening] = useState<string | null>(null);
  const callMember = async (m: ChatMember) => {
    if (opening) return;
    setOpening(m.userId);
    try {
      const direct = await createDirectChat({ userId: m.userId });
      router.push({
        pathname: mode === 'video' ? '/videocall' : '/voicecall',
        params: { chatId: direct.id, peerUid: m.userId, peerName: m.name || m.email || 'Member' },
      });
    } catch (e) {
      Alert.alert('Could not start the call', userErrorText(e, 'Try again.'));
    } finally { setOpening(null); }
  };

  // Group call through the SFU: ring every member, then join the call room.
  //
  // Who rings depends on which build is running, and exactly ONE of them must:
  //   • engine build — the roster travels as the `members` param and
  //     engine.startGroup() rings it, so the ring happens after local media is
  //     up and the peer map exists. Ringing here as well would double-ring.
  //   • legacy build — the call screen never rang anyone, so this screen must.
  // Both emit the same `call_incoming` payload, so a caller on either build is
  // indistinguishable to the callee.
  const startGroupCall = useCallback(async () => {
    if (starting.current || members.length === 0) return;
    setStarting(true);
    const uids = members.map(m => m.userId);
    let rang = true;
    if (!CALL_ENGINE_V2) {
      try {
        const me = await getCurrentUserAsync();
        const s = await getSocket();
        for (const to of uids) {
          s.emit('call_incoming', { to, chatId, group: true, groupName, video: mode === 'video' ? '1' : '0', fromName: me?.name || 'Someone' });
        }
      } catch { rang = false; }
    }
    try {
      router.push({
        pathname: '/group-call-active',
        params: {
          chatId,
          video: mode === 'video' ? '1' : '0',
          name: groupName,
          members: uids.join(','),
        },
      });
    } catch (e) {
      setStarting(false);   // nothing opened: let the next tap try again
      Alert.alert('Could not start the call', userErrorText(e, 'Try again.'));
      return;
    }
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => setStarting(false), 3000);
    if (!rang) {
      // The call room opened, but nobody was told it exists.
      Alert.alert('Members were not rung', 'Could not reach the server to ring the group. They can still join from the group chat.');
    }
  }, [members, chatId, groupName, mode, router, setStarting]);

  if (!chatId) return <GroupNotFound title="Group call" />;

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1} accessibilityRole="header">{(groupName as string) || 'Group'} · Call</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.modeRow} accessibilityRole="radiogroup" accessibilityLabel="Call type">
        {(['voice', 'video'] as const).map(mo => (
          <TouchableOpacity key={mo} style={[s.modeBtn, mode === mo && s.modeBtnActive]} onPress={() => setMode(mo)}
            accessibilityRole="radio" accessibilityLabel={mo === 'voice' ? 'Voice' : 'Video'} accessibilityState={{ selected: mode === mo, checked: mode === mo }}>
            <Ionicons name={mo === 'voice' ? 'call' : 'videocam'} size={18} color={mode === mo ? colors.onPrimary : colors.textDim} />
            <Text style={[s.modeTxt, mode === mo && s.modeTxtActive]}>{mo === 'voice' ? 'Voice' : 'Video'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={[s.startBtn, (loading || members.length === 0 || startBusy) && { opacity: 0.5 }]}
        activeOpacity={0.85}
        onPress={startGroupCall}
        disabled={loading || members.length === 0 || startBusy}
        accessibilityRole="button"
        accessibilityLabel={`Start ${mode} group call`}
        accessibilityState={{ disabled: loading || members.length === 0 || startBusy, busy: startBusy }}
      >
        {startBusy
          ? <ActivityIndicator size="small" color={colors.onPrimary} />
          : <Ionicons name={mode === 'video' ? 'videocam' : 'call'} size={20} color={colors.onPrimary} />}
        <Text style={s.startTxt}>Start {mode} group call</Text>
      </TouchableOpacity>
      <Text style={s.noticeTxt}>Rings everyone in the group at once. Or tap a member below for a 1:1 call.</Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} accessibilityLabel="Loading members" />
      ) : failed ? (
        <View style={{ alignItems: 'center', padding: 40, gap: 12 }}>
          <Text style={s.sub}>Couldn’t load the group’s members.</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading members" onPress={() => { setLoading(true); setReload(n => n + 1); }} style={{ padding: 10 }}>
            <Text style={[s.name, { color: colors.primary }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={m => m.userId}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          renderItem={({ item }) => {
            const name = item.name || item.email || 'Member';
            return (
              <TouchableOpacity style={s.row} onPress={() => callMember(item)} activeOpacity={0.7} disabled={!!opening}
                accessibilityRole="button" accessibilityLabel={`${mode === 'video' ? 'Video' : 'Voice'} call ${name}${item.online ? ', online' : ''}`}
                accessibilityState={{ disabled: !!opening, busy: opening === item.userId }}>
                <View style={s.avatar}>
                  {item.photoURL && authHeader
                    ? <Image source={{ uri: attachmentUrl(item.photoURL), headers: { Authorization: authHeader } }} style={s.avatarImg} />
                    : <Text style={s.avatarTxt}>{initialOf(name)}</Text>}
                  {item.online && <View style={s.onlineDot} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{name}</Text>
                  <Text style={s.sub}>{item.online ? 'Online' : 'Tap to call'}</Text>
                </View>
                <View style={s.callBtn}>
                  {opening === item.userId
                    ? <ActivityIndicator size="small" color={colors.primary} />
                    : <Ionicons name={mode === 'voice' ? 'call' : 'videocam'} size={18} color={colors.primary} />}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={s.sub}>No other members to call.</Text></View>}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  modeRow: { flexDirection: 'row', gap: 8, marginHorizontal: 16, backgroundColor: c.glassSoft, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: c.glassStroke },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10 },
  modeBtnActive: { backgroundColor: c.primary },
  modeTxt: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  modeTxtActive: { color: c.onPrimary },
  noticeTxt: { color: c.textDim, fontSize: 12, lineHeight: 17, marginHorizontal: 18, marginTop: 8, textAlign: 'center' },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginHorizontal: 16, marginTop: 12, paddingVertical: 14, borderRadius: 14, backgroundColor: c.primary },
  startTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '800', textTransform: 'capitalize' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.glassSoft, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.glassStroke },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  avatarImg: { width: 46, height: 46, borderRadius: 23 },
  avatarTxt: { color: c.accent, fontSize: 18, fontWeight: '800' },
  onlineDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: c.online, borderWidth: 2, borderColor: c.card },
  name: { color: c.text, fontSize: 15, fontWeight: '700' },
  sub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  callBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: brandAlpha(0.13), alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: brandAlpha(0.3) },
});
