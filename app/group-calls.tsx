// app/group-calls.tsx — Group call hub (honest, no fake/Firebase).
//
// Real N-way (everyone-at-once) group calling requires a media server (SFU) +
// TURN — that's a deployment/infra step. Rather than fake it (the old screen
// simulated participants joining), this lists the group's members and starts a
// REAL 1:1 WebRTC call with any member (reusing the working voicecall/videocall
// screens). The full mesh/SFU group call lights up once the media server is
// provisioned.

import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import { getChat, attachmentUrl, type ChatMember } from '../lib/chatService';
import { getAccessToken } from '../lib/api';
import { getCurrentUserAsync } from './(constants)/authService';

type CallMode = 'voice' | 'video';

export default function GroupCallsScreen() {
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

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={Aurora.text} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>{(groupName as string) || 'Group'} · Call</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.modeRow}>
        {(['voice', 'video'] as const).map(mo => (
          <TouchableOpacity key={mo} style={[s.modeBtn, mode === mo && s.modeBtnActive]} onPress={() => setMode(mo)}>
            <Ionicons name={mo === 'voice' ? 'call' : 'videocam'} size={18} color={mode === mo ? '#04130D' : Aurora.textDim} />
            <Text style={[s.modeTxt, mode === mo && s.modeTxtActive]}>{mo === 'voice' ? 'Voice' : 'Video'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={s.notice}>
        <Ionicons name="information-circle-outline" size={18} color={Aurora.accent} />
        <Text style={s.noticeTxt}>Everyone-at-once group calls need the media server (rolling out). Tap a member to start a 1:1 call now.</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={Aurora.primary} style={{ marginTop: 30 }} />
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
                <View style={s.callBtn}><Ionicons name={mode === 'voice' ? 'call' : 'videocam'} size={18} color={Aurora.primary} /></View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={s.sub}>No other members to call.</Text></View>}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800', flex: 1 },
  modeRow: { flexDirection: 'row', gap: 8, marginHorizontal: 16, backgroundColor: Aurora.surface, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: Aurora.border },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10 },
  modeBtnActive: { backgroundColor: Aurora.primary },
  modeTxt: { color: Aurora.textDim, fontSize: 14, fontWeight: '700' },
  modeTxtActive: { color: '#04130D' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(6,182,212,0.1)', borderWidth: 1, borderColor: 'rgba(6,182,212,0.3)' },
  noticeTxt: { flex: 1, color: Aurora.textDim, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Aurora.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: Aurora.border },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: Aurora.surfaceSolid, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  avatarImg: { width: 46, height: 46, borderRadius: 23 },
  avatarTxt: { color: Aurora.accent, fontSize: 18, fontWeight: '800' },
  onlineDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: Aurora.online, borderWidth: 2, borderColor: Aurora.card },
  name: { color: Aurora.text, fontSize: 15, fontWeight: '700' },
  sub: { color: Aurora.textDim, fontSize: 12, marginTop: 2 },
  callBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(16,185,129,0.13)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
});
