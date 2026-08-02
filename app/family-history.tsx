// app/family-history.tsx — Family Space location history (mockup screen 8).
//
// Day / Week / Month over the device-local track store, drawn as a path on the
// map plus a timeline of that member's events. There was previously no history
// of any kind: MemberPresence was in-memory and discarded, so "where were they
// at 3pm" had no answer. lib/family/history.ts is the store; this is the view.
//
// Everything here is read from the device. There is no history endpoint and
// nothing on this screen was ever uploaded.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import FamilyMap from '../components/family/FamilyMap';
import { getTrack, summarize, type TrackSample } from '../lib/family/history';
import { useFamilyAlerts, loadAlerts, type FamilyAlert } from '../lib/family/alerts';

type Range = 'day' | 'week' | 'month';

const RANGES: { key: Range; label: string; ms: number }[] = [
  { key: 'day',   label: 'Day',   ms: 24 * 3600 * 1000 },
  { key: 'week',  label: 'Week',  ms: 7 * 24 * 3600 * 1000 },
  { key: 'month', label: 'Month', ms: 31 * 24 * 3600 * 1000 },
];

const dist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (ts: number) => {
  const d = new Date(ts), today = new Date();
  const same = d.toDateString() === today.toDateString();
  const yest = new Date(today.getTime() - 86400_000).toDateString() === d.toDateString();
  return same ? 'Today' : yest ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const ICON_FOR: Record<string, keyof typeof Ionicons.glyphMap> = {
  enter: 'enter-outline', leave: 'exit-outline', sos: 'alert-circle',
  checkin: 'checkmark-done-circle', battery: 'battery-dead', sharing: 'navigate-circle',
};

export default function FamilyHistoryScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ circleId?: string; userId?: string; name?: string }>();
  const circleId = String(params.circleId || '');
  const userId = params.userId ? String(params.userId) : undefined;
  const who = String(params.name || 'Family');

  const [range, setRange] = useState<Range>('day');
  const [samples, setSamples] = useState<TrackSample[]>([]);
  const [loading, setLoading] = useState(true);

  const from = useMemo(() => {
    const span = RANGES.find((r) => r.key === range)!.ms;
    if (range === 'day') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    return Date.now() - span;
  }, [range]);

  const alerts = useFamilyAlerts(circleId || null, 'all');

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      await loadAlerts();
      if (!circleId) { setLoading(false); return; }
      const t = await getTrack(circleId, { from, userId });
      if (!live) return;
      setSamples(t);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [circleId, userId, from]));

  const stats = useMemo(() => summarize(samples), [samples]);
  const path = useMemo(() => samples.map((s) => ({ lat: s.lat, lng: s.lng })), [samples]);

  // Timeline = the member's events in range, newest first, grouped by day.
  const timeline = useMemo(() => {
    const rows = alerts.filter((a: FamilyAlert) => a.at >= from && (!userId || a.actorId === userId));
    const groups: { day: string; items: FamilyAlert[] }[] = [];
    for (const a of rows) {
      const label = dayLabel(a.at);
      const g = groups.find((x) => x.day === label);
      if (g) g.items.push(a); else groups.push({ day: label, items: [a] });
    }
    return groups;
  }, [alerts, from, userId]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: userId ? `${who}'s history` : 'Location History', headerTitleAlign: 'center' }} />

      {/* range tabs */}
      <View style={[st.tabs, { borderColor: colors.border }]}>
        {RANGES.map((r) => {
          const on = r.key === range;
          return (
            <TouchableOpacity key={r.key} onPress={() => setRange(r.key)}
              style={[st.tab, { backgroundColor: on ? brandAlpha(0.14) : 'transparent', borderColor: on ? colors.primary : 'transparent' }]}>
              <Text style={{ color: on ? colors.primary : colors.textDim, fontWeight: on ? '800' : '600', fontSize: 13 }}>{r.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 6, paddingBottom: 40 }}>
          {/* path */}
          <View style={[st.mapCard, { borderColor: colors.border }]}>
            {path.length > 1 ? (
              <FamilyMap members={[]} path={path} style={{ flex: 1 }} />
            ) : (
              <View style={[st.center, { backgroundColor: colors.card }]}>
                <Ionicons name="map-outline" size={26} color={colors.textFaint} />
                <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 }}>
                  No track for this range yet. History builds up while location sharing is on.
                </Text>
              </View>
            )}
          </View>

          {/* stats */}
          <View style={[st.statRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={st.stat}>
              <Text style={[st.statVal, { color: colors.text }]}>{dist(stats.distanceM)}</Text>
              <Text style={[st.statLbl, { color: colors.textDim }]}>Distance</Text>
            </View>
            <View style={[st.statDiv, { backgroundColor: colors.border }]} />
            <View style={st.stat}>
              <Text style={[st.statVal, { color: colors.text }]}>{Math.round(stats.maxSpeed * 3.6)} km/h</Text>
              <Text style={[st.statLbl, { color: colors.textDim }]}>Top speed</Text>
            </View>
            <View style={[st.statDiv, { backgroundColor: colors.border }]} />
            <View style={st.stat}>
              <Text style={[st.statVal, { color: colors.text }]}>{stats.points}</Text>
              <Text style={[st.statLbl, { color: colors.textDim }]}>Points</Text>
            </View>
          </View>

          {/* timeline */}
          <Text style={[st.h, { color: colors.text }]}>Timeline</Text>
          {timeline.length === 0 ? (
            <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
              No arrivals, departures or check-ins recorded in this range.
            </Text>
          ) : timeline.map((g) => (
            <View key={g.day}>
              <Text style={[st.day, { color: colors.textDim }]}>{g.day}</Text>
              {g.items.map((a) => (
                <View key={a.id} style={[st.evt, { borderColor: colors.border }]}>
                  <Text style={{ color: colors.textDim, fontSize: 11.5, width: 52 }}>{clock(a.at)}</Text>
                  <View style={[st.evtIcon, { backgroundColor: brandAlpha(0.1) }]}>
                    <Ionicons name={ICON_FOR[a.kind] ?? 'ellipse'} size={14}
                      color={a.sev === 'critical' ? colors.danger : colors.primary} />
                  </View>
                  <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }} numberOfLines={2}>{a.text}</Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  mapCard: { height: 220, borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  statRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, paddingVertical: 14, marginTop: 14 },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statVal: { fontSize: 15, fontWeight: '800' },
  statLbl: { fontSize: 11 },
  statDiv: { width: 1, height: 28 },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 24, marginBottom: 8 },
  day: { fontSize: 11.5, fontWeight: '700', marginTop: 12, marginBottom: 2 },
  evt: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  evtIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
