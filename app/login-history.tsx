// app/login-history.tsx — Login History & Device Management
// Shows all login sessions with device info, location, time
// Can revoke sessions remotely
// Alerts trusted contacts on new device login

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Alert, StatusBar, ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#FFFFFF', accent: '#4A9FFF', danger: '#FF3C6E', card: '#F9FAFB', green: '#10B981' };

export default function LoginHistoryScreen() {
  const myUid = auth().currentUser?.uid || '';
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSessions = async () => {
      setLoading(true);
      try {
        const snap = await firestore().collection('users').doc(myUid)
          .collection('loginHistory')
          .orderBy('loginAt', 'desc')
          .limit(20)
          .get();
        setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch {}
      setLoading(false);
    };
    loadSessions();
  }, [myUid]);

  const revokeSession = (session: any) => {
    Alert.alert(
      'Revoke Session?',
      'End this login session on ' + (session.deviceName || 'Unknown device') + '?\n\nThis will force a re-login on that device.',
      [
        { text: 'Cancel' },
        { text: 'Revoke', style: 'destructive', onPress: async () => {
          try {
            await firestore().collection('users').doc(myUid)
              .collection('loginHistory').doc(session.id)
              .update({ revoked: true, revokedAt: firestore.FieldValue.serverTimestamp() });
            setSessions(prev => prev.map(s => s.id === session.id ? { ...s, revoked: true } : s));
            Alert.alert('Session Revoked', 'The device will need to re-authenticate.');
          } catch {}
        }},
      ]
    );
  };

  const formatTime = (ts: any) => {
    if (!ts?.toDate) return 'Unknown';
    const d = ts.toDate();
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getDeviceIcon = (platform: string) => {
    if (platform === 'ios') return '\uD83D\uDCF1';
    if (platform === 'android') return '\uD83E\uDD16';
    if (platform === 'web') return '\uD83D\uDCBB';
    return '\uD83D\uDCF1';
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Login History', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Summary */}
        <View style={s.summary}>
          <Text style={{ fontSize: 24 }}>{"\uD83D\uDD10"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.summaryTitle}>{sessions.filter(s => !s.revoked).length} active sessions</Text>
            <Text style={s.summaryDesc}>New device logins alert your trusted contacts</Text>
          </View>
        </View>

        {loading ? (
          <ActivityIndicator color={C.accent} style={{ marginTop: 30 }} />
        ) : (
          <FlatList
            data={sessions}
            keyExtractor={s => s.id}
            renderItem={({ item, index }) => {
              const isCurrent = index === 0 && !item.revoked;
              return (
                <View style={[s.sessionRow, item.revoked && { opacity: 0.4 }]}>
                  <View style={s.sessionIcon}>
                    <Text style={{ fontSize: 24 }}>{getDeviceIcon(item.platform)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={s.deviceName}>{item.deviceName || 'Unknown Device'}</Text>
                      {isCurrent && <View style={s.currentBadge}><Text style={s.currentTxt}>Current</Text></View>}
                      {item.revoked && <View style={[s.currentBadge, { backgroundColor: '#FF3C6E22' }]}><Text style={[s.currentTxt, { color: '#FF3C6E' }]}>Revoked</Text></View>}
                    </View>
                    <Text style={s.deviceInfo}>{item.platform || 'unknown'} {item.osVersion ? 'v' + item.osVersion : ''}</Text>
                    <Text style={s.loginTime}>{formatTime(item.loginAt)}</Text>
                    {item.location && <Text style={s.location}>{"\uD83D\uDCCD"} {item.location}</Text>}
                    {item.ip && <Text style={s.ipText}>IP: {item.ip}</Text>}
                  </View>
                  {!isCurrent && !item.revoked && (
                    <TouchableOpacity style={s.revokeBtn} onPress={() => revokeSession(item)}>
                      <Text style={{ color: C.danger, fontSize: 11, fontWeight: '800' }}>Revoke</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ color: '#6B7280' }}>No login history yet</Text>
              </View>
            }
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  summary: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E5E7EB' },
  summaryTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  summaryDesc: { color: '#9CA3AF', fontSize: 12, marginTop: 2 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  sessionIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#E5E7EB', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  deviceName: { color: '#1F2937', fontSize: 14, fontWeight: '700' },
  deviceInfo: { color: '#9CA3AF', fontSize: 11, marginTop: 2 },
  loginTime: { color: '#6B7280', fontSize: 11, marginTop: 1 },
  location: { color: '#4A9FFF', fontSize: 11, marginTop: 2 },
  ipText: { color: '#9CA3AF', fontSize: 10, marginTop: 1, fontFamily: 'monospace' },
  currentBadge: { backgroundColor: '#10B98122', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  currentTxt: { color: '#10B981', fontSize: 10, fontWeight: '800' },
  revokeBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#FF3C6E15', borderWidth: 1, borderColor: '#FF3C6E33' },
});
