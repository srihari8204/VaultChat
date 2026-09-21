// app/lock-history.tsx — Lock History & Statistics. Sessions newest-first with
// event filters (all / exits / returns / alarms), expandable per-session event
// timeline, Today / 7-day / 30-day rollups (pure SQL, offline), JSON/CSV export
// via the OS share sheet, and per-session / clear-all deletion. Local-only:
// these screens make no network requests (spec: lock-history).

import React, { useCallback, useEffect, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, FlatList, Alert, Share, TextInput } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import {
  getSessions, getEvents, statsForRange, distancePerDay, deleteSession, clearAllHistory,
  exportHistoryJSON, exportHistoryCSV, setSessionNotes,
  type LockSessionRow, type LockEventRow, type HistoryFilter, type LockStats,
} from '../lib/lock/lockStore';
import { fmtDistance } from '../lib/lock/format';
import { useLockSettings } from '../lib/lock/lockSettings';
import { AppText as Text, AuroraBackground } from '../components/ui';

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'exits', label: 'Exits' },
  { key: 'returns', label: 'Returns' }, { key: 'alarms', label: 'Alerts' },
];
const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
] as const;

const fmtMs = (ms: number) => {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m` : `${Math.floor(ms / 1000)}s`;
};
const fmtT = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const EVENT_META: Record<string, { icon: any; color: string; label: string }> = {
  armed:       { icon: 'lock-closed',   color: '#4A9FFF', label: 'Locked' },
  warning:     { icon: 'alert',         color: '#EAB308', label: 'Near boundary' },
  exit:        { icon: 'exit',          color: '#EF4444', label: 'Exited zone' },
  alarm_start: { icon: 'volume-high',   color: '#DC2626', label: 'Alarm started' },
  alarm_stop:  { icon: 'volume-mute',   color: '#F97316', label: 'Alarm stopped' },
  return:      { icon: 'enter',         color: '#22C55E', label: 'Returned to safe zone' },
  unlocked:    { icon: 'lock-open',     color: '#9CA3AF', label: 'Unlocked' },
};

export default function LockHistoryScreen() {
  const { colors } = useTheme();
  const settings = useLockSettings();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('today');
  const [sessions, setSessions] = useState<LockSessionRow[]>([]);
  const [stats, setStats] = useState<LockStats | null>(null);
  const [trend, setTrend] = useState<{ day: string; meters: number }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [events, setEvents] = useState<LockEventRow[]>([]);
  const [noteDraft, setNoteDraft] = useState('');

  const reload = useCallback(async () => {
    setSessions(await getSessions(filter));
    const days = RANGES.find((r) => r.key === range)!.days;
    const now = new Date();
    const from = days === 1
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      : Date.now() - days * 86_400_000;
    setStats(await statsForRange(from, Date.now() + 1));
    setTrend(await distancePerDay(7));
  }, [filter, range]);

  useEffect(() => { reload().catch(() => {}); }, [reload]);

  const toggle = async (id: number) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setNoteDraft(sessions.find((s) => s.id === id)?.notes ?? '');
    setEvents(await getEvents(id));
  };

  const doExport = () => {
    Alert.alert('Export history', 'Choose a format', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'CSV', onPress: async () => { try { await Share.share({ message: await exportHistoryCSV(), title: 'location-lock-history.csv' }); } catch {} } },
      { text: 'JSON', onPress: async () => { try { await Share.share({ message: await exportHistoryJSON(), title: 'location-lock-history.json' }); } catch {} } },
    ]);
  };

  const doClear = () => {
    Alert.alert('Delete all history?', 'This is immediate and irreversible.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete all', style: 'destructive', onPress: async () => { await clearAllHistory(); reload(); } },
    ]);
  };

  const removeOne = (id: number) => {
    Alert.alert('Delete this session?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteSession(id); if (open === id) setOpen(null); reload(); } },
    ]);
  };

  const Chip = ({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) => (
    <TouchableOpacity onPress={onPress}
      style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary + '1a' : 'transparent' }]}>
      <Text style={{ color: on ? colors.primary : colors.text, fontWeight: on ? '700' : '500', fontSize: 12.5 }}>{label}</Text>
    </TouchableOpacity>
  );

  const header = (
    <View>
      {/* statistics */}
      <View style={[st.chips, { marginTop: 4 }]}>
        {RANGES.map((r) => <Chip key={r.key} on={range === r.key} label={r.label} onPress={() => setRange(r.key)} />)}
      </View>
      {stats && (
        <View style={[st.statsCard, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <StatCell label="Locks" value={String(stats.locks)} colors={colors} />
          <StatCell label="Exits" value={String(stats.exits)} colors={colors} />
          <StatCell label="Alarms" value={String(stats.alarms)} colors={colors} />
          <StatCell label="Time outside" value={fmtMs(stats.timeOutsideMs)} colors={colors} />
          <StatCell label="Protected" value={fmtMs(stats.timeProtectedMs)} colors={colors} />
          <StatCell label="Avg duration" value={stats.avgDurationMs ? fmtMs(stats.avgDurationMs) : '—'} colors={colors} />
          <StatCell label="Distance" value={fmtDistance(stats.distanceTraveled, settings.units)} colors={colors} />
          <StatCell label="Avg GPS ±" value={stats.avgAccuracyM ? fmtDistance(stats.avgAccuracyM, settings.units) : '—'} colors={colors} />
          <StatCell label="Avg radius" value={stats.avgRadiusM ? fmtDistance(stats.avgRadiusM, settings.units) : '—'} colors={colors} />
        </View>
      )}

      {/* 7-day distance trend (plain Views — no chart lib) */}
      {trend.some((t) => t.meters > 0) && (
        <View style={[st.trendCard, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <Text style={{ color: colors.textDim, fontSize: 11.5, fontWeight: '700', marginBottom: 8 }}>
            DISTANCE WHILE LOCKED — LAST 7 DAYS
          </Text>
          <View style={st.trendRow}>
            {trend.map((t, i) => {
              const max = Math.max(...trend.map((x) => x.meters), 1);
              return (
                <View key={i} style={st.trendCol}>
                  <View style={[st.trendBar, {
                    height: Math.max(3, (t.meters / max) * 56),
                    backgroundColor: t.meters > 0 ? colors.primary : colors.border,
                  }]} />
                  <Text style={{ color: colors.textDim, fontSize: 10, marginTop: 4 }}>{t.day}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* filters + actions */}
      <View style={[st.rowBetween, { marginTop: 16 }]}>
        <View style={st.chips}>
          {FILTERS.map((f) => <Chip key={f.key} on={filter === f.key} label={f.label} onPress={() => setFilter(f.key)} />)}
        </View>
      </View>
      <View style={[st.rowBetween, { marginTop: 10, marginBottom: 6 }]}>
        <TouchableOpacity onPress={doExport} style={st.linkRow}>
          <Ionicons name="share-outline" size={15} color={colors.primary} />
          <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>Export</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={doClear} style={st.linkRow}>
          <Ionicons name="trash-outline" size={15} color={colors.danger} />
          <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 13 }}>Delete all</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={st.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: true, title: 'Lock History', headerTitleAlign: 'center', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
      <FlatList
        data={sessions}
        keyExtractor={(s) => String(s.id)}
        ListHeaderComponent={header}
        contentContainerStyle={st.body}
        ListEmptyComponent={
          <Text style={{ color: colors.textDim, textAlign: 'center', marginTop: 40, fontSize: 13.5 }}>
            No lock sessions {filter !== 'all' ? 'matching this filter ' : ''}yet.
          </Text>
        }
        renderItem={({ item: s }) => (
          <TouchableOpacity onPress={() => toggle(s.id)} onLongPress={() => removeOne(s.id)}
            style={[st.session, { backgroundColor: colors.glass, borderColor: colors.glassStroke }]}>
            <View style={st.rowBetween}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>{fmtT(s.started_at)}</Text>
              <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
                {fmtDistance(s.radius, settings.units)} · {s.ended_at ? fmtMs(s.ended_at - s.started_at) : 'active'}
              </Text>
            </View>
            <View style={[st.rowBetween, { marginTop: 6 }]}>
              <Text style={{ color: s.exits ? colors.danger : colors.success, fontSize: 12.5, fontWeight: '600' }}>
                {s.exits ? `${s.exits} exit${s.exits > 1 ? 's' : ''} · max ${fmtDistance(s.max_distance, settings.units)}` : 'Stayed inside'}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
                {s.alarm_ms > 0 ? `alarm ${fmtMs(s.alarm_ms)} · ` : ''}outside {fmtMs(s.time_outside_ms)}
              </Text>
            </View>
            {!!s.notes && open !== s.id && (
              <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>📝 {s.notes}</Text>
            )}

            {open === s.id && (
              <View style={[st.timeline, { borderColor: colors.glassStroke }]}>
                {events.map((e) => {
                  const meta = EVENT_META[e.type] ?? EVENT_META.armed;
                  return (
                    <View key={e.id} style={st.eventRow}>
                      <Ionicons name={meta.icon} size={14} color={meta.color} />
                      <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>{meta.label}</Text>
                      {e.distance != null && <Text style={{ color: colors.textDim, fontSize: 12 }}>{Math.round(e.distance)} m</Text>}
                      <Text style={{ color: colors.textDim, fontSize: 12 }}>
                        {new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </Text>
                    </View>
                  );
                })}
                {/* optional note (v2.1) */}
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <TextInput
                    value={noteDraft} onChangeText={setNoteDraft}
                    placeholder="Add a note (e.g. “parked at north gate”)…"
                    placeholderTextColor={colors.textFaint}
                    style={{ flex: 1, borderWidth: 1, borderColor: colors.glassStroke, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, color: colors.text, fontSize: 12, backgroundColor: colors.glass }}
                  />
                  <TouchableOpacity
                    accessibilityRole="button" accessibilityLabel="Save note"
                    onPress={async () => { await setSessionNotes(s.id, noteDraft); reload(); }}>
                    <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 12 }}>Save</Text>
                  </TouchableOpacity>
                </View>
                <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 6 }}>
                  {s.center_lat.toFixed(5)}, {s.center_lng.toFixed(5)} · long-press card to delete
                </Text>
              </View>
            )}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

function StatCell({ label, value, colors }: { label: string; value: string; colors: any }) {
  return (
    <View style={st.statCell}>
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, paddingBottom: 48 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  statsCard: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderRadius: 14, marginTop: 12, paddingVertical: 6 },
  statCell: { width: '33.33%', alignItems: 'center', paddingVertical: 10 },
  trendCard: { borderWidth: 1, borderRadius: 14, marginTop: 10, padding: 12 },
  trendRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  trendCol: { alignItems: 'center', flex: 1 },
  trendBar: { width: 18, borderRadius: 5 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  session: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10 },
  timeline: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 8 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
});
