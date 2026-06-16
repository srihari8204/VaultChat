// app/transfers.tsx — VaultBeam transfers dashboard (W14).
//
// Real state over lib/transferManager (AsyncStorage-backed): active / queued
// (paused) / history, with per-file SHA-256 integrity badges and totals. No
// fabricated rows — everything here is a real persisted transfer record.

import React, { useState, useEffect, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, FlatList, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  getTransfers, getTransferStats, cleanOldTransfers, type TransferState,
} from '../lib/transferManager';

const fmtSize = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB`
  : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;

type Stats = { active: number; queued: number; completed: number; failed: number; totalSent: number; totalReceived: number };

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function TransfersScreen() {
  const { colors } = useTheme();
  const s = useS();
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
      item.status === 'completed' ? colors.primary
      : item.status === 'failed' ? colors.danger
      : item.status === 'active' ? colors.accent : colors.textDim;
    return (
      <View style={s.row}>
        <View style={[s.icon, { backgroundColor: colors.surface }]}>
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
            <View style={s.verifiedPill}><Ionicons name="shield-checkmark" size={11} color={colors.primary} /><Text style={s.verifiedTxt}>SHA-256</Text></View>
          )}
          {item.verified === false && (
            <View style={[s.verifiedPill, { backgroundColor: 'rgba(239,68,68,0.12)' }]}><Ionicons name="warning" size={11} color={colors.danger} /><Text style={[s.verifiedTxt, { color: colors.danger }]}>corrupt</Text></View>
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
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Transfers</Text>
        <TouchableOpacity onPress={onClear} style={s.hbtn} hitSlop={10}>
          <Ionicons name="trash-outline" size={20} color={colors.textDim} />
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
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={t => t.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12 }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Ionicons name="swap-horizontal-outline" size={36} color={colors.textFaint} />
              <Text style={{ color: colors.textDim, fontSize: 14, marginTop: 10 }}>No transfers yet</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => {
  const s = useS();
  return (
    <View style={s.statCard}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
};

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 12, paddingBottom: 8 },
  hbtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  statsRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, marginBottom: 6 },
  statCard: { flex: 1, backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingVertical: 10, alignItems: 'center' },
  statValue: { color: c.text, fontSize: 15, fontWeight: '800' },
  statLabel: { color: c.textDim, fontSize: 10, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12, marginBottom: 8 },
  icon: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  name: { color: c.text, fontSize: 14, fontWeight: '700' },
  meta: { color: c.textDim, fontSize: 11, marginTop: 2 },
  status: { fontSize: 12, fontWeight: '700' },
  barTrack: { height: 5, borderRadius: 3, backgroundColor: c.surface, marginTop: 6, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3, backgroundColor: c.accent },
  verifiedPill: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(16,185,129,0.12)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  verifiedTxt: { color: c.primary, fontSize: 10, fontWeight: '700' },
});
