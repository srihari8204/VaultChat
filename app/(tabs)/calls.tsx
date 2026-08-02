// app/(tabs)/calls.tsx — WhatsApp-style call log.
//
// Reads the on-device call history (lib/callLog) recorded by the voice/video
// call screens. Consecutive calls with the same person are grouped with a count
// (like WhatsApp); each row shows the contact photo, direction arrow (missed in
// red), audio/video kind, time + duration. Tap = redial; long-press = menu;
// the info button opens a call detail. A FAB starts a new call.

import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View, Alert, Modal, Pressable, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { Avatar } from '../../components/ui';
import { getCallLog, clearCallLog, removeCallLog, callLogKey, type CallLogEntry } from '../../lib/callLog';
import { listChats, attachmentUrl } from '../../lib/chatService';
import { getAccessToken } from '../../lib/api';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

function fmtWhen(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay) return time;
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })}, ${time}`;
}

function fmtDuration(sec: number): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

const dirLabel = (d: CallLogEntry['direction']) => d === 'missed' ? 'Missed' : d === 'incoming' ? 'Incoming' : 'Outgoing';

type CallGroup = {
  key: string;
  peerUid: string;
  peerName: string;
  peerPhoto?: string | null;
  /** True when the row is a group (mesh) call — see lib/callLog.ts. */
  group?: boolean;
  entries: CallLogEntry[];
};

export default function CallsScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [log, setLog] = useState<CallLogEntry[]>([]);
  const [photos, setPhotos] = useState<Map<string, string>>(new Map());
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [infoGroup, setInfoGroup] = useState<CallGroup | null>(null);

  useFocusEffect(useCallback(() => {
    let alive = true;
    getCallLog().then(l => { if (alive) setLog(l); });
    Promise.all([listChats(), getAccessToken()]).then(([chats, tok]) => {
      if (!alive) return;
      const m = new Map<string, string>();
      for (const c of chats) if (c.peerUserId && c.peerPhotoURL) m.set(c.peerUserId, c.peerPhotoURL);
      setPhotos(m); setAuthHeader(tok ? `Bearer ${tok}` : null);
    }).catch(() => {});
    return () => { alive = false; };
  }, []));

  // Group consecutive calls with the same person (WhatsApp "(3)"), or with the
  // same group chat — a group call has no peer uid, so it keys by chat instead.
  const groups = useMemo<CallGroup[]>(() => {
    const out: CallGroup[] = [];
    for (const e of log) {
      const key = callLogKey(e);
      const last = out[out.length - 1];
      if (last && last.key === key) last.entries.push(e);
      else out.push({ key, peerUid: e.peerUid, peerName: e.peerName, peerPhoto: e.peerPhoto, group: e.group, entries: [e] });
    }
    return out;
  }, [log]);

  // Redial. A group call can't be redialled 1:1 — it goes back to the group call
  // hub for that chat, which loads the current member list and rings it.
  const call = useCallback((
    g: { chatId?: string; peerUid: string; peerName: string; group?: boolean }, kind: 'audio' | 'video',
  ) => {
    if (g.group) {
      router.push({
        pathname: '/group-calls' as any,
        params: { chatId: g.chatId ?? '', groupName: g.peerName, mode: kind === 'video' ? 'video' : 'voice' },
      });
      return;
    }
    const path = kind === 'video' ? '/videocall' : '/voicecall';
    router.push({ pathname: path as any, params: { chatId: g.chatId ?? '', peerUid: g.peerUid, peerName: g.peerName } });
  }, [router]);

  const removeGroup = useCallback(async (g: CallGroup) => {
    await removeCallLog(g.entries.map(e => e.id));
    setLog(prev => prev.filter(e => !g.entries.some(x => x.id === e.id)));
  }, []);

  const onLongPress = useCallback((g: CallGroup) => {
    const latest = g.entries[0];
    Alert.alert(g.peerName, undefined, [
      { text: 'Voice call', onPress: () => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, 'audio') },
      { text: 'Video call', onPress: () => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, 'video') },
      { text: 'Call info', onPress: () => setInfoGroup(g) },
      { text: 'Remove from log', style: 'destructive', onPress: () => removeGroup(g) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [call, removeGroup]);

  const confirmClear = useCallback(() => {
    Alert.alert('Clear call log?', 'This removes all call history from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await clearCallLog(); setLog([]); } },
    ]);
  }, []);

  const DirArrow = ({ d, size = 15 }: { d: CallLogEntry['direction']; size?: number }) => (
    <Ionicons
      name="arrow-up-outline" size={size}
      color={d === 'missed' ? colors.danger : colors.online}
      style={{ transform: [{ rotate: d === 'outgoing' ? '45deg' : '-135deg' }] }}
    />
  );

  const renderItem = ({ item: g }: { item: CallGroup }) => {
    const latest = g.entries[0];
    const missed = latest.direction === 'missed';
    const count = g.entries.length;
    const photo = g.peerPhoto || photos.get(g.peerUid) || null;
    const dur = fmtDuration(latest.durationSec);
    return (
      <TouchableOpacity style={S.row} activeOpacity={0.7}
        onPress={() => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, latest.kind)}
        onLongPress={() => onLongPress(g)} delayLongPress={300}>
        <Avatar uri={photo && authHeader ? attachmentUrl(photo) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={g.peerName} size={48} />
        <View style={{ flex: 1 }}>
          <Text style={[S.name, missed && { color: colors.danger }]} numberOfLines={1}>
            {g.peerName}{count > 1 ? `  (${count})` : ''}
          </Text>
          <View style={S.subRow}>
            <DirArrow d={latest.direction} />
            <Text style={S.sub} numberOfLines={1}>
              {dirLabel(latest.direction)}{`  ·  ${fmtWhen(latest.at)}`}{dur ? `  ·  ${dur}` : ''}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 2 }}>
          <TouchableOpacity onPress={() => setInfoGroup(g)} hitSlop={8} style={S.callBtn}>
            <Ionicons name="information-circle-outline" size={22} color={colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, latest.kind)} hitSlop={8} style={S.callBtn}>
            <Ionicons name={latest.kind === 'video' ? 'videocam' : 'call'} size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.title}>Calls</Text>
        {log.length > 0 && (
          <TouchableOpacity onPress={confirmClear} hitSlop={8}>
            <Ionicons name="trash-outline" size={22} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>

      {groups.length === 0 ? (
        <View style={S.body}>
          <Ionicons name="call-outline" size={52} color={colors.textDim} />
          <Text style={S.heading}>No calls yet</Text>
          <Text style={S.sub2}>Voice and video calls you make or receive will show up here.</Text>
        </View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={g => g.entries[0].id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingVertical: 6 }}
          ListHeaderComponent={<Text style={S.sectionLabel}>RECENT</Text>}
          ItemSeparatorComponent={() => <View style={S.sep} />}
        />
      )}

      <TouchableOpacity style={S.fab} activeOpacity={0.85} onPress={() => router.push('/contacts' as any)}>
        <Ionicons name="call" size={24} color="#fff" />
      </TouchableOpacity>

      {/* Call info — every call with this person */}
      <Modal visible={infoGroup != null} transparent animationType="slide" onRequestClose={() => setInfoGroup(null)}>
        <Pressable style={S.infoBackdrop} onPress={() => setInfoGroup(null)}>
          <Pressable style={S.infoSheet} onPress={() => {}}>
            <View style={S.grip} />
            {infoGroup && (
              <>
                <View style={S.infoHead}>
                  <Avatar uri={(infoGroup.peerPhoto || photos.get(infoGroup.peerUid)) && authHeader ? attachmentUrl(infoGroup.peerPhoto || photos.get(infoGroup.peerUid)!) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={infoGroup.peerName} size={48} />
                  <Text style={S.infoName} numberOfLines={1}>{infoGroup.peerName}</Text>
                </View>
                <View style={S.infoActions}>
                  <TouchableOpacity style={S.infoAction} onPress={() => { const u = infoGroup; setInfoGroup(null); call({ chatId: u.entries[0].chatId, peerUid: u.peerUid, peerName: u.peerName, group: u.group }, 'audio'); }}>
                    <Ionicons name="call" size={22} color={colors.primary} /><Text style={S.infoActionTxt}>Voice</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.infoAction} onPress={() => { const u = infoGroup; setInfoGroup(null); call({ chatId: u.entries[0].chatId, peerUid: u.peerUid, peerName: u.peerName, group: u.group }, 'video'); }}>
                    <Ionicons name="videocam" size={22} color={colors.primary} /><Text style={S.infoActionTxt}>Video</Text>
                  </TouchableOpacity>
                </View>
                <Text style={S.sectionLabel}>{infoGroup.entries.length} CALL{infoGroup.entries.length > 1 ? 'S' : ''}</Text>
                <ScrollView style={{ maxHeight: 300 }}>
                  {infoGroup.entries.map(e => (
                    <View key={e.id} style={S.infoRow}>
                      <DirArrow d={e.direction} size={16} />
                      <View style={{ flex: 1 }}>
                        <Text style={S.infoRowTitle}>{e.kind === 'video' ? 'Video' : 'Voice'} · {dirLabel(e.direction)}</Text>
                        <Text style={S.infoRowSub}>{fmtWhen(e.at)}{e.durationSec ? `  ·  ${fmtDuration(e.durationSec)}` : ''}</Text>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 56, paddingBottom: 12 },
  title:   { color: c.text, fontSize: 28, fontWeight: '800' },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 8, marginBottom: 4 },

  row:     { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 11 },
  name:    { color: c.text, fontSize: 16, fontWeight: '600' },
  subRow:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  sub:     { color: c.textDim, fontSize: 13, flexShrink: 1 },
  callBtn: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' },
  sep:     { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 78 },

  body:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40, paddingBottom: 80 },
  heading: { color: c.text, fontSize: 18, fontWeight: '700' },
  sub2:    { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  fab:     { position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', shadowColor: c.primary, shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 },

  infoBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  infoSheet:    { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28 },
  grip:         { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 12 },
  infoHead:     { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  infoName:     { color: c.text, fontSize: 18, fontWeight: '700', flex: 1 },
  infoActions:  { flexDirection: 'row', gap: 10, marginBottom: 8 },
  infoAction:   { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 12, borderRadius: 14, backgroundColor: c.surface },
  infoActionTxt:{ color: c.text, fontSize: 14, fontWeight: '700' },
  infoRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  infoRowTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  infoRowSub:   { color: c.textDim, fontSize: 12, marginTop: 1 },
});
