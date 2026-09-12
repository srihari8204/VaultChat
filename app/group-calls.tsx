// app/group-calls.tsx — Group call hub (honest, no fake/Firebase).
//
// Two real ways out of this screen:
//   • "Start group call" → /group-call-active, a full-mesh N-way call over the
//     existing webrtc_* relay + TURN. No SFU: every participant holds one
//     RTCPeerConnection to every other, which is why the server caps the room
//     (meshMaxParticipants). An SFU is a scale step, not a prerequisite.
//   • tap a member → a 1:1 call on the voicecall/videocall screens.
//
// The old screen simulated participants joining; nothing here is simulated.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import React, { useCallback, useEffect, useState , useMemo} from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CALL_ENGINE_V2 } from '../constants/flags';
import { useTheme } from '../lib/theme';
import { getChat, attachmentUrl, type ChatMember } from '../lib/chatService';
import { getAccessToken } from '../lib/api';
import { getSocket } from '../lib/socket';
import { getCurrentUserAsync } from './(constants)/authService';
import { AuroraBackground } from '../components/ui';

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
  const [mode, setMode] = useState<CallMode>((modeParam as CallMode) || 'voice');
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const tok = await getAccessToken();
        if (active) setAuthHeader(tok ? `Bearer ${tok}` : null);
        const [chat, me] = await Promise.all([chatId ? getChat(chatId) : Promise.resolve(null as any), getCurrentUserAsync()]);
        if (active && chat) {
          setMembers(chat.members.filter((m: ChatMember) => !m.leftAt && m.userId !== me?.id));
        }
      } catch { /* leaves empty */ } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [chatId]);

  const callMember = (m: ChatMember) => {
    router.push({
      pathname: mode === 'video' ? '/videocall' : '/voicecall',
      params: { chatId, peerUid: m.userId, peerName: m.name || m.email || 'Member' },
    } as any);
  };

  // Real mesh group call: ring every member, then join the call room.
  //
  // Who rings depends on which build is running, and exactly ONE of them must:
  //   • engine build — the roster travels as the `members` param and
  //     engine.startGroup() rings it, so the ring happens after local media is
  //     up and the peer map exists. Ringing here as well would double-ring.
  //   • legacy build — the call screen never rang anyone, so this screen must.
  // Both emit the same `call_incoming` payload, so a caller on either build is
  // indistinguishable to the callee.
  const startGroupCall = useCallback(async () => {
    const uids = members.map(m => m.userId);
    if (!CALL_ENGINE_V2) {
      try {
        const me = await getCurrentUserAsync();
        const s = await getSocket();
        for (const to of uids) {
          s.emit('call_incoming', { to, chatId, group: true, groupName, video: mode === 'video' ? '1' : '0', fromName: me?.name || 'Someone' });
        }
      } catch {}
    }
    router.push({
      pathname: '/group-call-active',
      params: {
        chatId,
        video: mode === 'video' ? '1' : '0',
        name: groupName,
        members: uids.join(','),
      },
    } as any);
  }, [members, chatId, groupName, mode, router]);

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>{(groupName as string) || 'Group'} · Call</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.modeRow}>
        {(['voice', 'video'] as const).map(mo => (
          <TouchableOpacity key={mo} style={[s.modeBtn, mode === mo && s.modeBtnActive]} onPress={() => setMode(mo)}>
            <Ionicons name={mo === 'voice' ? 'call' : 'videocam'} size={18} color={mode === mo ? '#FFFFFF' : colors.textDim} />
            <Text style={[s.modeTxt, mode === mo && s.modeTxtActive]}>{mo === 'voice' ? 'Voice' : 'Video'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={s.startBtn} activeOpacity={0.85} onPress={startGroupCall}>
        <Ionicons name={mode === 'video' ? 'videocam' : 'call'} size={20} color="#fff" />
        <Text style={s.startTxt}>Start {mode} group call</Text>
      </TouchableOpacity>
      <Text style={s.noticeTxt}>Everyone-at-once call (best for small groups). Or tap a member below for a 1:1 call.</Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={members}
          keyExtractor={m => m.userId}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          renderItem={({ item }) => {
            const name = item.name || item.email || 'Member';
            return (
              <TouchableOpacity style={s.row} onPress={() => callMember(item)} activeOpacity={0.7}>
                <View style={s.avatar}>
                  {item.photoURL && authHeader
                    ? <Image source={{ uri: attachmentUrl(item.photoURL), headers: { Authorization: authHeader } }} style={s.avatarImg} />
                    : <Text style={s.avatarTxt}>{name.charAt(0).toUpperCase()}</Text>}
                  {item.online && <View style={s.onlineDot} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{name}</Text>
                  <Text style={s.sub}>{item.online ? 'Online' : 'Tap to call'}</Text>
                </View>
                <View style={s.callBtn}><Ionicons name={mode === 'voice' ? 'call' : 'videocam'} size={18} color={colors.primary} /></View>
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
  modeTxtActive: { color: '#FFFFFF' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(6,182,212,0.1)', borderWidth: 1, borderColor: 'rgba(6,182,212,0.3)' },
  noticeTxt: { color: c.textDim, fontSize: 12, lineHeight: 17, marginHorizontal: 18, marginTop: 8, textAlign: 'center' },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginHorizontal: 16, marginTop: 12, paddingVertical: 14, borderRadius: 14, backgroundColor: c.primary },
  startTxt: { color: '#fff', fontSize: 15, fontWeight: '800', textTransform: 'capitalize' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.glassSoft, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.glassStroke },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  avatarImg: { width: 46, height: 46, borderRadius: 23 },
  avatarTxt: { color: c.accent, fontSize: 18, fontWeight: '800' },
  onlineDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: c.online, borderWidth: 2, borderColor: c.card },
  name: { color: c.text, fontSize: 15, fontWeight: '700' },
  sub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  callBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: brandAlpha(0.13), alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: brandAlpha(0.3) },
});
