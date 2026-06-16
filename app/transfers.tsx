// app/transfers.tsx — VaultBeam transfers dashboard (W14).
//
// Real state over lib/transferManager (AsyncStorage-backed): active / queued
// (paused) / history, with per-file SHA-256 integrity badges and totals. No
// fabricated rows — everything here is a real persisted transfer record.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, FlatList, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import {
  getTransfers, getTransferStats, cleanOldTransfers, type TransferState,
} from '../lib/transferManager';

const fmtSize = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB`
  : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;

type Stats = { active: number; queued: number; completed: number; failed: number; totalSent: number; totalReceived: number };

export default function TransfersScreen() {
  const router = useRouter();
  const [items, setItems] = useState<TransferState[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [list, st] = await Promise.all([getTransfers(), getTransferStats()]);
    setItems(list);
    setStats(st);
    setLoading(false);
  }, []);

  // Refresh whenever the screen regains focus (a transfer may have completed).
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load]);

  const onClear = useCallback(() => {
    Alert.alert('Clear history', 'Remove old completed transfers?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await cleanOldTransfers(); load(); } },
    ]);
  }, [load]);

  const fmtWhen = (ts: number) => { try { return new Date(ts).toLocaleString(); } catch { return ''; } };

  const renderItem = ({ item }: { item: TransferState }) => {
    const sending = item.direction === 'send';
    const statusColor =
      item.status === 'completed' ? Aurora.primary
      : item.status === 'failed' ? Aurora.danger
      : item.status === 'active' ? Aurora.accent : Aurora.textDim;
    return (
      <View style={s.row}>
        <View style={[s.icon, { backgroundColor: Aurora.surface }]}>
          <Ionicons name={sending ? 'arrow-up' : 'arrow-down'} size={20} color={statusColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{item.fileName || 'file'}</Text>
          <Text style={s.meta} numberOfLines={1}>
            {fmtSize(item.fileSize)} · {item.peerName || 'peer'} · {fmtWhen(item.lastActiveAt)}
          </Text>
          {item.status === 'active' && (
            <View style={s.barTrack}><View style={[s.barFill, { width: `${Math.round((item.progress || 0) * 100)}%` }]} /></View>
          )}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text style={[s.status, { color: statusColor }]}>
            {item.status === 'active' ? `${Math.round((item.progress || 0) * 100)}%` : item.status}
          </Text>
          {item.status === 'completed' && item.verified === true && (
            <View style={s.verifiedPill}><Ionicons name="shield-checkmark" size={11} color={Aurora.primary} /><Text style={s.verifiedTxt}>SHA-256</Text></View>
          )}
          {item.verified === false && (
            <View style={[s.verifiedPill, { backgroundColor: 'rgba(239,68,68,0.12)' }]}><Ionicons name="warning" size={11} color={Aurora.danger} /><Text style={[s.verifiedTxt, { color: Aurora.danger }]}>corrupt</Text></View>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.hbtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={Aurora.text} />
        </TouchableOpacity>
        <Text style={s.title}>Transfers</Text>
        <TouchableOpacity onPress={onClear} style={s.hbtn} hitSlop={10}>
          <Ionicons name="trash-outline" size={20} color={Aurora.textDim} />
        </TouchableOpacity>
      </View>

      {stats && (
        <View style={s.statsRow}>
          <Stat label="Active" value={String(stats.active)} />
          <Stat label="Queued" value={String(stats.queued)} />
          <Stat label="Sent" value={fmtSize(stats.totalSent)} />
          <Stat label="Received" value={fmtSize(stats.totalReceived)} />
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={Aurora.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={t => t.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12 }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Ionicons name="swap-horizontal-outline" size={36} color={Aurora.textFaint} />
              <Text style={{ color: Aurora.textDim, fontSize: 14, marginTop: 10 }}>No transfers yet</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <View style={s.statCard}>
    <Text style={s.statValue}>{value}</Text>
    <Text style={s.statLabel}>{label}</Text>
  </View>
);

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 12, paddingBottom: 8 },
  hbtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800' },
  statsRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, marginBottom: 6 },
  statCard: { flex: 1, backgroundColor: Aurora.card, borderRadius: 12, borderWidth: 1, borderColor: Aurora.border, paddingVertical: 10, alignItems: 'center' },
  statValue: { color: Aurora.text, fontSize: 15, fontWeight: '800' },
  statLabel: { color: Aurora.textDim, fontSize: 10, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Aurora.card, borderRadius: 12, borderWidth: 1, borderColor: Aurora.border, padding: 12, marginBottom: 8 },
  icon: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  name: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
  meta: { color: Aurora.textDim, fontSize: 11, marginTop: 2 },
  status: { fontSize: 12, fontWeight: '700' },
  barTrack: { height: 5, borderRadius: 3, backgroundColor: Aurora.surface, marginTop: 6, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3, backgroundColor: Aurora.accent },
  verifiedPill: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(16,185,129,0.12)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  verifiedTxt: { color: Aurora.primary, fontSize: 10, fontWeight: '700' },
});
