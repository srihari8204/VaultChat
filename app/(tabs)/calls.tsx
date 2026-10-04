// app/(tabs)/calls.tsx — WhatsApp-style call log.
//
// Reads the on-device call history (lib/callLog) recorded by the voice/video
// call screens. Consecutive calls with the same person are grouped with a count
// (like WhatsApp); each row shows the contact photo, direction arrow (missed in
// red), audio/video kind, time + duration. Tap = call info; the call button
// redials; long-press = menu. A FAB starts a new call.

import { useAuthHeader } from '../../hooks/useAuthHeader';
import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, TouchableOpacity, View, Alert, Modal, Pressable, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { AppText as Text } from '../../components/ui/Text';
import { Avatar, AuroraBackground } from '../../components/ui';
import { Sheet, type SheetAction } from '../../components/ui/Sheet';
import { getCallLog, clearCallLog, removeCallLog, callLogKey, getHiddenServerCalls, hideServerCalls, type CallLogEntry } from '../../lib/callLog';
import { listChats, attachmentUrl } from '../../lib/chatService';
import { getCachedUser } from '../../lib/api';
import { fetchCallHistory } from '../../lib/callSession';
import { mergeCallHistory, type CallHistoryEntry } from '../../lib/callHistory';

function useS() {
  const { colors } = useTheme();
  const { metrics } = useVisionComfort();
  return useMemo(() => makeStyles(colors, metrics), [colors, metrics]);
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

// A declined call is its own thing: the user saw it and said no. Calling that
// 'Missed' blames them for it, and the old ternary chain had no branch for it
// at all, so it would have read 'Outgoing' - the opposite direction.
const dirLabel = (d: CallLogEntry['direction']) =>
  d === 'missed' ? 'Missed' : d === 'declined' ? 'Declined' : d === 'incoming' ? 'Incoming' : 'Outgoing';

// Hoisted out of render so React keeps one component identity across renders.
function DirArrow({ d, size = 15 }: { d: CallLogEntry['direction']; size?: number }) {
  const { colors } = useTheme();
  return (
    <Ionicons
      name="arrow-up-outline" size={size}
      // Declined is not a failure, so it is dimmed rather than red - red is
      // reserved for a call that got away from you.
      color={d === 'missed' ? colors.danger : d === 'declined' ? colors.textDim : colors.online}
      style={{ transform: [{ rotate: d === 'outgoing' ? '45deg' : '-135deg' }] }}
    />
  );
}

type CallGroup = {
  key: string;
  peerUid: string;
  peerName: string;
  peerPhoto?: string | null;
  /** True when the row is a group (mesh) call — see lib/callLog.ts. */
  group?: boolean;
  entries: CallHistoryEntry[];
};

// Hoisted: an inline separator was a new component type on every render.
function CallSeparator() {
  const S = useS();
  return <View style={S.sep} />;
}

export default function CallsScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [log, setLog] = useState<CallHistoryEntry[]>([]);
  // Android's native dialog renders only 3 buttons, so a 5-action Alert menu
  // silently dropped 'Call info' and 'Remove from log'. Sheet scrolls instead.
  const [sheet, setSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);
  const [photos, setPhotos] = useState<Map<string, string>>(new Map());
  const authHeader = useAuthHeader();
  const [infoGroup, setInfoGroup] = useState<CallGroup | null>(null);
  // The server half (names, photos, other devices' calls) failed. The device
  // log is still shown; this only says the list may be incomplete.
  const [syncFailed, setSyncFailed] = useState(false);
  // Bumped by the notice's retry; a new callback identity re-runs the focus effect.
  const [syncTry, setSyncTry] = useState(0);

  useFocusEffect(useCallback(() => {
    let alive = true;
    // A retry hides the old notice while it runs; a new failure shows it again.
    if (syncTry > 0) setSyncFailed(false);
    // The device log paints FIRST, on its own, before anything touches the
    // network. It is already on disk, so the list is never blank waiting on a
    // request — and on an offline device or an unmigrated server, this is the
    // whole story and nothing below changes what's on screen.
    getCallLog().then(l => { if (alive) setLog(l); }).catch(() => {});

    Promise.all([listChats(), getCachedUser(), fetchCallHistory(), getHiddenServerCalls()])
      .then(([chats, me, server, hidden]) => {
        if (!alive) return;
        setSyncFailed(false);
        const m = new Map<string, string>();
        // chatId → how to name a call the server told us about but this device
        // never made. Built from the chat list the screen already loads.
        const byChat = new Map<string, { name: string; photo?: string | null; direct?: boolean }>();
        for (const c of chats) {
          if (c.peerUserId && c.peerPhotoURL) m.set(c.peerUserId, c.peerPhotoURL);
          byChat.set(c.id, {
            name: (c.type === 'direct' ? c.peerName : c.name) || 'Call',
            photo: c.type === 'direct' ? c.peerPhotoURL : null,
            direct: c.type === 'direct',
          });
        }
        setPhotos(m);
        // Merge only when the server actually returned something. With
        // CALL_SESSIONS off fetchCallHistory resolves [] without a request, so
        // this is a no-op and the log stays exactly as it was.
        if (server.length && me?.id) {
          getCallLog().then(local => {
            if (alive) setLog(mergeCallHistory(local, server, me.id, { get: (id) => byChat.get(id) }, hidden));
          // The merge could not run, so the list is the device log alone —
          // exactly what the sync notice says.
          }).catch(() => { if (alive) setSyncFailed(true); });
        }
      }).catch(() => { if (alive) setSyncFailed(true); });
    return () => { alive = false; };
  }, [syncTry]));

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
        pathname: '/group-calls',
        params: { chatId: g.chatId ?? '', groupName: g.peerName, mode: kind === 'video' ? 'video' : 'voice' },
      });
      return;
    }
    const path = kind === 'video' ? '/videocall' : '/voicecall';
    router.push({ pathname: path, params: { chatId: g.chatId ?? '', peerUid: g.peerUid, peerName: g.peerName } });
  }, [router]);

  // Removing a row has to reach BOTH sources. Local entries are deleted from
  // the device log; server-only ones have nothing to delete, so their callId is
  // remembered as dismissed — otherwise the row would disappear and come
  // straight back on the next sync.
  // The row is dropped only once both writes succeeded; a failed write keeps
  // it on screen and says so (both writes are safe to retry).
  const removeGroup = useCallback(async (g: CallGroup) => {
    const local = new Set(g.entries.filter(e => !e.remote).map(e => e.id));
    try {
      await removeCallLog([...local]);
    } catch {
      Alert.alert('Could not remove', 'The call is still in your call history. Try again.');
      return;
    }
    try {
      await hideServerCalls(g.entries.filter(e => e.remote && e.callId).map(e => e.callId!));
    } catch {
      // The device half is already gone; keep only the synced rows on screen.
      setLog(prev => prev.filter(e => !local.has(e.id)));
      Alert.alert('Partly removed', 'Calls saved on this device were removed, but calls synced from your account could not be hidden and are still listed. Try again.');
      return;
    }
    setLog(prev => prev.filter(e => !g.entries.some(x => x.id === e.id)));
  }, []);

  const onLongPress = useCallback((g: CallGroup) => {
    const latest = g.entries[0];
    setSheet({
      title: g.peerName,
      actions: [
        { label: 'Voice call', icon: 'call-outline', onPress: () => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, 'audio') },
        { label: 'Video call', icon: 'videocam-outline', onPress: () => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, 'video') },
        { label: 'Call info', icon: 'information-circle-outline', onPress: () => setInfoGroup(g) },
        // Confirmed like confirmClear below (2026-09-17). Both halves are
        // device-local: the device log is deleted and server-synced rows are
        // hidden on THIS device only (hideServerCalls, lib/callLog.ts), so the
        // copy must not promise "all your devices".
        { label: 'Remove from log', icon: 'trash-outline', destructive: true, onPress: () => Alert.alert(
          'Remove from log?',
          'This removes the call from your call history on this device. It cannot be undone.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => removeGroup(g) }],
        ) },
      ],
    });
  }, [call, removeGroup]);

  const confirmClear = useCallback(() => {
    Alert.alert('Clear call log?', 'This removes all call history from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => {
        // Synced rows have to be dismissed too, or "clear" would leave the list
        // repopulating itself from the server a moment later.
        const [cleared, hidden] = await Promise.allSettled([
          clearCallLog(),
          hideServerCalls(log.filter(e => e.remote && e.callId).map(e => e.callId!)),
        ]);
        const localOk = cleared.status === 'fulfilled', remoteOk = hidden.status === 'fulfilled';
        // Drop exactly the half that was written; the rest stays listed.
        setLog(prev => prev.filter(e => (e.remote ? !remoteOk : !localOk)));
        if (!localOk || !remoteOk) {
          Alert.alert('Could not clear everything',
            !localOk && !remoteOk ? 'Your call history was not changed. Try again.'
              : !localOk ? 'Calls saved on this device could not be cleared and are still listed. Try again.'
                : 'Calls synced from your account could not be hidden and are still listed. Try again.');
        }
      } },
    ]);
  }, [log]);

  const renderItem = useCallback(({ item: g }: { item: CallGroup }) => {
    const latest = g.entries[0];
    const missed = latest.direction === 'missed';
    const count = g.entries.length;
    const photo = g.peerPhoto || photos.get(g.peerUid) || null;
    const dur = fmtDuration(latest.durationSec);
    return (
      // Row tap opens call info (as WhatsApp does) rather than dialling: a
      // stray tap while scrolling must not place a call. Calling stays one tap
      // away on the explicit Call-back button.
      <TouchableOpacity style={S.row} activeOpacity={0.7}
        onPress={() => setInfoGroup(g)}
        onLongPress={() => onLongPress(g)} delayLongPress={300}
        accessibilityRole="button"
        accessibilityLabel={`${g.peerName}${count > 1 ? `, ${count} calls` : ''}, ${dirLabel(latest.direction)} ${latest.kind === 'video' ? 'video' : 'voice'} call, ${fmtWhen(latest.at)}`}
        accessibilityHint="Shows call details. Long-press for more actions">
        <Avatar uri={photo && authHeader ? attachmentUrl(photo) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={g.peerName} size={52} ring />
        <View style={{ flex: 1 }}>
          <Text style={[S.name, missed && { color: colors.danger }]}>
            {g.peerName}{count > 1 ? `  (${count})` : ''}
          </Text>
          <View style={S.subRow}>
            <DirArrow d={latest.direction} />
            <Text style={S.sub}>
              {dirLabel(latest.direction)}{`  ·  ${fmtWhen(latest.at)}`}{dur ? `  ·  ${dur}` : ''}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 2 }}>
          <TouchableOpacity onPress={() => setInfoGroup(g)} hitSlop={8} style={S.callBtn} accessibilityRole="button" accessibilityLabel="Call details">
            <Ionicons name="information-circle-outline" size={22} color={colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => call({ chatId: latest.chatId, peerUid: g.peerUid, peerName: g.peerName, group: g.group }, latest.kind)} hitSlop={8} style={S.callBtn} accessibilityRole="button" accessibilityLabel={`${latest.kind === 'video' ? 'Video' : 'Voice'} call ${g.peerName}`}>
            <Ionicons name={latest.kind === 'video' ? 'videocam' : 'call'} size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  }, [S, colors, photos, authHeader, onLongPress, call]);

  return (
    <View style={S.screen}>
      <AuroraBackground variant="calls" />
      <View style={S.header}>
        <Text style={S.title} accessibilityRole="header">Calls</Text>
        {log.length > 0 && (
          <TouchableOpacity onPress={confirmClear} hitSlop={11} accessibilityRole="button" accessibilityLabel="Clear call history">
            <Ionicons name="trash-outline" size={22} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>

      {syncFailed && (
        <TouchableOpacity style={S.notice} onPress={() => setSyncTry(n => n + 1)} accessibilityRole="button"
          accessibilityLabel="Couldn't sync calls from your account. Showing calls saved on this device. Tap to retry.">
          <Ionicons name="cloud-offline-outline" size={16} color={colors.textDim} />
          <Text style={S.noticeTxt}>Couldn’t sync calls from your account. Showing calls saved on this device. Tap to retry.</Text>
        </TouchableOpacity>
      )}

      {groups.length === 0 ? (
        <ScrollView contentContainerStyle={S.body}>
          <Ionicons name="call-outline" size={52} color={colors.textDim} />
          <Text style={S.heading}>No calls yet</Text>
          <Text style={S.sub2}>Voice and video calls you make or receive will show up here.</Text>
        </ScrollView>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={g => g.entries[0].id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingVertical: 6, paddingBottom: TAB_BAR_SPACE + 84 }}
          ListHeaderComponent={<Text style={S.sectionLabel} accessibilityRole="header">RECENT</Text>}
          ItemSeparatorComponent={CallSeparator}
        />
      )}

      <TouchableOpacity style={S.fab} activeOpacity={0.85} onPress={() => router.push({ pathname: '/contacts', params: { mode: 'call' } })} accessibilityRole="button" accessibilityLabel="New call">
        <Ionicons name="call" size={24} color={colors.onPrimary} />
      </TouchableOpacity>

      {/* Call info — every call with this person */}
      <Modal visible={infoGroup != null} transparent animationType="slide" onRequestClose={() => setInfoGroup(null)}>
        {/* The backdrop is a sibling of the sheet, so screen readers reach the
            sheet's own controls instead of one big "close" button around them. */}
        <View style={S.infoWrap}>
          <Pressable style={[StyleSheet.absoluteFill, S.infoBackdrop]} onPress={() => setInfoGroup(null)} accessibilityRole="button" accessibilityLabel="Close call info" />
          <View style={S.infoSheet} accessibilityViewIsModal>
            <View style={S.grip} />
            {infoGroup && (
              <>
                <View style={S.infoHead}>
                  <Avatar uri={(infoGroup.peerPhoto || photos.get(infoGroup.peerUid)) && authHeader ? attachmentUrl(infoGroup.peerPhoto || photos.get(infoGroup.peerUid)!) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={infoGroup.peerName} size={48} ring />
                  <Text style={S.infoName} accessibilityRole="header">{infoGroup.peerName}</Text>
                  <TouchableOpacity onPress={() => setInfoGroup(null)} style={S.callBtn} accessibilityRole="button" accessibilityLabel="Close call info">
                    <Ionicons name="close" size={24} color={colors.textDim} />
                  </TouchableOpacity>
                </View>
                <View style={S.infoActions}>
                  <TouchableOpacity style={S.infoAction} accessibilityRole="button" accessibilityLabel={`Voice call ${infoGroup.peerName}`} onPress={() => { const u = infoGroup; setInfoGroup(null); call({ chatId: u.entries[0].chatId, peerUid: u.peerUid, peerName: u.peerName, group: u.group }, 'audio'); }}>
                    <Ionicons name="call" size={22} color={colors.primary} /><Text style={S.infoActionTxt}>Voice</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.infoAction} accessibilityRole="button" accessibilityLabel={`Video call ${infoGroup.peerName}`} onPress={() => { const u = infoGroup; setInfoGroup(null); call({ chatId: u.entries[0].chatId, peerUid: u.peerUid, peerName: u.peerName, group: u.group }, 'video'); }}>
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
          </View>
        </View>
      </Modal>

      <Sheet
        visible={!!sheet}
        title={sheet?.title}
        message={sheet?.message}
        actions={sheet?.actions ?? []}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

const makeStyles = (c: Palette, m: ReturnType<typeof useVisionComfort>['metrics']) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 12 },
  title:   { color: c.text, fontSize: 28, fontWeight: '800' },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 8, marginBottom: 4 },

  row:     { marginHorizontal: 12, marginVertical: 4, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, backgroundColor: c.glassSoft, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11 * m.spacingScale },
  name:    { color: c.text, fontSize: 16, fontWeight: '600' },
  subRow:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, flexWrap: 'wrap' },
  sub:     { color: c.textDim, fontSize: 13, flexShrink: 1 },
  // Icon-only action grows with the comfort level and keeps a 44dp tap floor.
  callBtn: {
    width: 44 * m.controlScale, minHeight: 44 * m.controlScale, alignItems: 'center', justifyContent: 'center',
  },
  sep:     { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 78 },

  body:    { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40, paddingBottom: TAB_BAR_SPACE },
  heading: { color: c.text, fontSize: 18, fontWeight: '700' },
  sub2:    { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  fab:     { position: 'absolute', right: 20, bottom: TAB_BAR_SPACE + 12, width: 56 * m.controlScale, height: 56 * m.controlScale, borderRadius: 28 * m.controlScale, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', shadowColor: c.primary, shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 },

  notice:       { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, minHeight: 44, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  noticeTxt:    { flex: 1, color: c.textDim, fontSize: 12.5, lineHeight: 17 },
  infoWrap:     { flex: 1, justifyContent: 'flex-end' },
  // Scrim over whatever is behind the modal: dark in both themes by design.
  infoBackdrop: { backgroundColor: c.scrim },
  infoSheet:    { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28 },
  grip:         { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 12 },
  infoHead:     { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  infoName:     { color: c.text, fontSize: 18, fontWeight: '700', flex: 1 },
  infoActions:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 },
  infoAction:   { minWidth: 110, flexGrow: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 12 * m.controlScale, borderRadius: 14, backgroundColor: c.glassSoft },
  infoActionTxt:{ flexShrink: 1, color: c.text, fontSize: 14, fontWeight: '700' },
  infoRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  infoRowTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  infoRowSub:   { color: c.textDim, fontSize: 12, marginTop: 1 },
});
