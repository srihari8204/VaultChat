// app/calls.tsx
// Real call history from Firestore
// Missed / Incoming / Outgoing with icons
// Tap row â†’ calls back
// Long press â†’ delete from history
// Filter tabs: All / Missed / Video / Voice

import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text, TouchableOpacity,
  View,
} from 'react-native';
import BottomNav from './chats';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type CallType   = 'video' | 'voice';
type CallStatus = 'missed' | 'incoming' | 'outgoing' | 'declined';
type FilterTab  = 'All' | 'Missed' | 'Video' | 'Voice';

interface CallRecord {
  id:          string;
  peerUid:     string;
  peerName:    string;
  chatId:      string;
  callType:    CallType;
  callStatus:  CallStatus;
  duration:    number;   // seconds â€” 0 if missed/declined
  startedAt:   any;      // Firestore timestamp
}

const TABS: FilterTab[] = ['All', 'Missed', 'Video', 'Voice'];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function formatDuration(s: number): string {
  if (s === 0) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}

function formatCallTime(ts: any): string {
  if (!ts) return '';
  const d: Date = ts.toDate ? ts.toDate() : new Date(ts);
  const now  = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7)  return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}


function statusColor(status: CallStatus): string {
  switch (status) {
    case 'missed':   return '#FF4D6D';
    case 'declined': return '#FF4D6D';
    case 'incoming': return '#00D4AA';
    case 'outgoing': return '#64748B';
  }
}

function statusLabel(status: CallStatus): string {
  switch (status) {
    case 'missed':   return 'â†™ Missed';
    case 'incoming': return 'â†™ Incoming';
    case 'outgoing': return 'â†— Outgoing';
    case 'declined': return 'â†™ Declined';
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Main Screen
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function CallsScreen() {
  const router = useRouter();
  const uid    = auth().currentUser?.uid || '';

  const [calls,   setCalls]   = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab,     setTab]     = useState<FilterTab>('All');

  // â”€â”€ Real-time Firestore listener â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!uid) return;

    const unsub = firestore()
      .collection('users')
      .doc(uid)
      .collection('callHistory')
      .orderBy('startedAt', 'desc')
      .limit(100)
      .onSnapshot(snap => {
        const data: CallRecord[] = snap.docs.map(doc => ({
          id: doc.id,
          ...(doc.data() as Omit<CallRecord, 'id'>),
        }));
        setCalls(data);
        setLoading(false);
      }, err => {
        console.error('[Calls]', err);
        setLoading(false);
      });

    return () => unsub();
  }, [uid]);

  // â”€â”€ Filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const filtered = calls.filter(c => {
    switch (tab) {
      case 'Missed': return c.callStatus === 'missed' || c.callStatus === 'declined';
      case 'Video':  return c.callType === 'video';
      case 'Voice':  return c.callType === 'voice';
      default:       return true;
    }
  });

  // â”€â”€ Counts for tab badges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const missedCount = calls.filter(
    c => c.callStatus === 'missed' || c.callStatus === 'declined'
  ).length;

  // â”€â”€ Render row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const renderCall = useCallback(({ item }: { item: CallRecord }) => {
    const callBack = (record: CallRecord) => {
      router.push({
        pathname: record.callType === 'video' ? '/videocall' : '/voicecall',
        params: { chatId: record.chatId, name: record.peerName },
      });
    };

    const deleteRecord = (record: CallRecord) => {
      Alert.alert(
        'Delete',
        `Remove this call with ${record.peerName} from history?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete', style: 'destructive',
            onPress: () => {
              firestore()
                .collection('users')
                .doc(uid)
                .collection('callHistory')
                .doc(record.id)
                .delete()
                .catch(() => {});
            },
          },
        ]
      );
    };

    return (
    <TouchableOpacity
      style={styles.callRow}
      onPress={() => callBack(item)}
      onLongPress={() => deleteRecord(item)}
      activeOpacity={0.7}
    >
      {/* Avatar */}
      <View style={styles.avatarCircle}>
        <Text style={styles.avatarText}>
          {item.peerName.slice(0, 2).toUpperCase()}
        </Text>
      </View>

      {/* Info */}
      <View style={styles.callInfo}>
        <Text style={styles.peerName}>{item.peerName}</Text>
        <View style={styles.callMeta}>
          <Text style={[styles.callStatus, { color: statusColor(item.callStatus) }]}>
            {statusLabel(item.callStatus)}
          </Text>
          {item.duration > 0 && (
            <Text style={styles.callDuration}> Â· {formatDuration(item.duration)}</Text>
          )}
        </View>
      </View>

      {/* Right side */}
      <View style={styles.callRight}>
        <Text style={styles.callTime}>{formatCallTime(item.startedAt)}</Text>
        {/* Call back icon */}
        <TouchableOpacity
          style={[
            styles.callBackBtn,
            { borderColor: item.callType === 'video' ? '#9B5DE5' : '#00D4AA' },
          ]}
          onPress={() => callBack(item)}
        >
          <Text style={styles.callBackIcon}>
            {item.callType === 'video' ? 'ðŸ“¹' : 'ðŸ“ž'}
          </Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
    );
  }, [router, uid]);

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Render
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Calls</Text>
        <Text style={styles.headerSub}>ENCRYPTED CALL HISTORY</Text>
      </View>

      {/* Filter tabs */}
      <View style={styles.tabs}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t}
            </Text>
            {t === 'Missed' && missedCount > 0 && (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{missedCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#00D4AA" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={c => c.id}
          renderItem={renderCall}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyIcon}>
                {tab === 'Missed' ? 'ðŸ“µ' : 'ðŸ“ž'}
              </Text>
              <Text style={styles.emptyText}>
                {tab === 'Missed'
                  ? 'No missed calls'
                  : 'No call history yet'}
              </Text>
            </View>
          }
        />
      )}

      <BottomNav {...{ active: 'Calls' } as any} />
    </View>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Styles
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0A0E1A' },
  header: {
    backgroundColor: '#111827',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B',
  },
  headerTitle:  { fontSize: 20, fontWeight: 'bold', color: '#FFFFFF' },
  headerSub:    { fontSize: 9, color: '#00D4AA', marginTop: 2, fontWeight: 'bold' },

  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B',
  },
  tab: {
    flex: 1, alignItems: 'center', paddingVertical: 12,
    flexDirection: 'row', justifyContent: 'center', gap: 5,
  },
  tabActive:        { borderBottomWidth: 2, borderBottomColor: '#00D4AA' },
  tabText:          { fontSize: 13, color: '#64748B' },
  tabTextActive:    { color: '#00D4AA', fontWeight: 'bold' },
  tabBadge: {
    backgroundColor: '#FF4D6D', borderRadius: 8,
    minWidth: 16, height: 16, justifyContent: 'center',
    alignItems: 'center', paddingHorizontal: 4,
  },
  tabBadgeText:     { fontSize: 9, color: '#FFFFFF', fontWeight: 'bold' },

  loadingWrap:      { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent:      { padding: 14, paddingBottom: 100, flexGrow: 1 },

  callRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, gap: 12,
  },
  avatarCircle: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#111827',
    borderWidth: 1.5, borderColor: '#1E293B',
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText:   { fontSize: 14, fontWeight: 'bold', color: '#00D4AA' },
  callInfo:     { flex: 1 },
  peerName:     { fontSize: 15, fontWeight: 'bold', color: '#FFFFFF', marginBottom: 4 },
  callMeta:     { flexDirection: 'row', alignItems: 'center' },
  callStatus:   { fontSize: 12 },
  callDuration: { fontSize: 12, color: '#374151' },
  callRight:    { alignItems: 'flex-end', gap: 6 },
  callTime:     { fontSize: 11, color: '#374151' },
  callBackBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: '#111827', borderWidth: 1,
    justifyContent: 'center', alignItems: 'center',
  },
  callBackIcon: { fontSize: 16 },

  sep: {
    height: 0.5, backgroundColor: '#111827', marginLeft: 60,
  },
  emptyWrap:  { flex: 1, alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyIcon:  { fontSize: 48 },
  emptyText:  { fontSize: 14, color: '#374151' },
});

