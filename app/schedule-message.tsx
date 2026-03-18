// @ts-nocheck
// app/schedule-message.tsx — Schedule Messages to Send Later
// Stores in Firestore: users/{uid}/scheduledMessages/{id}
// A background check sends them when time arrives

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  Alert, StatusBar, FlatList, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628', danger: '#FF3C6E' };

const QUICK_TIMES = [
  { label: 'In 30 min', mins: 30 },
  { label: 'In 1 hour', mins: 60 },
  { label: 'In 3 hours', mins: 180 },
  { label: 'Tomorrow 9 AM', mins: -1 },
  { label: 'Tomorrow 6 PM', mins: -2 },
];

export default function ScheduleMessageScreen() {
  const router = useRouter();
  const { chatId, peerName } = useLocalSearchParams();
  const myUid = auth().currentUser?.uid || '';
  const [message, setMessage] = useState('');
  const [scheduled, setScheduled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scheduling, setScheduling] = useState(false);
  const [tab, setTab] = useState('new');

  useEffect(() => { loadScheduled(); }, []);

  const loadScheduled = async () => {
    setLoading(true);
    try {
      const snap = await firestore().collection('users').doc(myUid)
        .collection('scheduledMessages')
        .where('sent', '==', false)
        .orderBy('sendAt', 'asc')
        .get();
      setScheduled(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch {}
    setLoading(false);
  };

  const getScheduleTime = (mins) => {
    const now = new Date();
    if (mins === -1) {
      const tmr = new Date(now);
      tmr.setDate(tmr.getDate() + 1);
      tmr.setHours(9, 0, 0, 0);
      return tmr;
    }
    if (mins === -2) {
      const tmr = new Date(now);
      tmr.setDate(tmr.getDate() + 1);
      tmr.setHours(18, 0, 0, 0);
      return tmr;
    }
    return new Date(now.getTime() + mins * 60000);
  };

  const scheduleMsg = async (mins) => {
    if (!message.trim()) { Alert.alert('Enter a message first'); return; }
    setScheduling(true);
    try {
      const sendAt = getScheduleTime(mins);
      await firestore().collection('users').doc(myUid)
        .collection('scheduledMessages').add({
          chatId: chatId || '',
          peerName: peerName || '',
          message: message.trim(),
          sendAt: firestore.Timestamp.fromDate(sendAt),
          sent: false,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
      setMessage('');
      await loadScheduled();
      Alert.alert('Scheduled!', 'Message will be sent at ' + sendAt.toLocaleString());
    } catch (e) { Alert.alert('Error', 'Could not schedule message'); }
    setScheduling(false);
  };

  const cancelScheduled = (id) => {
    Alert.alert('Cancel Scheduled Message?', 'This message will not be sent.', [
      { text: 'Keep' },
      { text: 'Cancel It', style: 'destructive', onPress: async () => {
        await firestore().collection('users').doc(myUid)
          .collection('scheduledMessages').doc(id).delete();
        setScheduled(prev => prev.filter(s => s.id !== id));
      }},
    ]);
  };

  const formatTime = (ts) => {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff < 0) return 'Sending...';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm from now';
    if (diff < 86400000) return Math.round(diff / 3600000) + 'h from now';
    return d.toLocaleString();
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Schedule Message', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.tabs}>
          <TouchableOpacity style={[s.tab, tab === 'new' && s.tabActive]} onPress={() => setTab('new')}>
            <Text style={[s.tabTxt, tab === 'new' && s.tabTxtActive]}>New</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab === 'pending' && s.tabActive]} onPress={() => setTab('pending')}>
            <Text style={[s.tabTxt, tab === 'pending' && s.tabTxtActive]}>Pending ({scheduled.length})</Text>
          </TouchableOpacity>
        </View>

        {tab === 'new' ? (
          <View style={{ flex: 1 }}>
            {peerName ? <Text style={s.toLabel}>To: {peerName}</Text> : null}

            <View style={s.msgBox}>
              <TextInput style={s.msgInput} value={message} onChangeText={setMessage}
                placeholder="Type your message..." placeholderTextColor="#555" multiline maxLength={2000} />
            </View>

            <Text style={s.quickLabel}>SEND AT</Text>
            <View style={s.quickGrid}>
              {QUICK_TIMES.map(qt => (
                <TouchableOpacity key={qt.label} style={s.quickBtn} onPress={() => scheduleMsg(qt.mins)} disabled={scheduling}>
                  <Text style={s.quickTxt}>{qt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {scheduling && <ActivityIndicator color={C.accent} style={{ marginTop: 12 }} />}
          </View>
        ) : (
          <FlatList
            data={scheduled}
            keyExtractor={s => s.id}
            renderItem={({ item }) => (
              <View style={s.pendingRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.pendingTo}>{item.peerName || 'Chat'}</Text>
                  <Text style={s.pendingMsg} numberOfLines={2}>{item.message}</Text>
                  <Text style={s.pendingTime}>{"\u23F0"} {formatTime(item.sendAt)}</Text>
                </View>
                <TouchableOpacity style={s.cancelBtn} onPress={() => cancelScheduled(item.id)}>
                  <Text style={{ color: C.danger, fontSize: 11, fontWeight: '700' }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}
            contentContainerStyle={{ padding: 12 }}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={{ color: '#555' }}>No scheduled messages</Text></View>}
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  tabs: { flexDirection: 'row', gap: 6, marginBottom: 16 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: '#0A1628' },
  tabActive: { backgroundColor: C.accent },
  tabTxt: { color: '#888', fontSize: 13, fontWeight: '700' },
  tabTxtActive: { color: '#000' },
  toLabel: { color: C.accent, fontSize: 14, fontWeight: '700', marginBottom: 8 },
  msgBox: { backgroundColor: C.card, borderRadius: 14, padding: 4, borderWidth: 1, borderColor: '#111', marginBottom: 16 },
  msgInput: { color: '#fff', fontSize: 15, minHeight: 100, padding: 12, textAlignVertical: 'top' },
  quickLabel: { color: '#555', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quickBtn: { backgroundColor: '#4A9FFF22', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: '#4A9FFF44' },
  quickTxt: { color: C.accent, fontSize: 13, fontWeight: '600' },
  pendingRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#111' },
  pendingTo: { color: C.accent, fontSize: 12, fontWeight: '700' },
  pendingMsg: { color: '#E0E0F0', fontSize: 14, marginTop: 4 },
  pendingTime: { color: '#888', fontSize: 11, marginTop: 6 },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#FF3C6E15', borderWidth: 1, borderColor: '#FF3C6E33' },
});
