// app/group-insights.tsx — group insights (Groups & Circles, G6).
//
// Everything on this screen is computed from data ALREADY ON THIS PHONE — the
// local track store and the local alert inbox. Nothing is fetched for it and
// nothing is uploaded, not even a total. That is stated in the footer, because
// a screen full of numbers about where people went is exactly the kind of thing
// a user is entitled to be suspicious of.
//
// Distances are estimates: history is deliberately throttled, so the figures
// understate real travel. The copy says "estimated" rather than implying an
// odometer.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { getTrack } from '../lib/family/history';
import { loadAlerts, selectAlerts } from '../lib/family/alerts';
import { circleMembers } from '../lib/family/circle';
import { getGroup } from '../lib/groups/store';
import { can as hasPerm, type Permission } from '../lib/groups/permissions';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  summarise, groupSummary, weekBounds, formatDistance,
  foldTripHistory, frequentDestinations,
  type MemberInsight, type Range, type TripRecord, type TripAnnounce,
} from '../lib/groups/analytics';
import { announceFromMessage } from '../lib/groups/tripSession';
import { unionWithLocalHistoryAsc } from '../lib/messageHistory';
import { getMessages } from '../lib/chatService';
import { type CircleMember } from '../lib/family/types';

type Span = 'week' | 'month';

const AVATAR_COLORS = ['#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316'];
const colorFor = (id: string) => AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

const ago = (ts: number) => {
  const h = (Date.now() - ts) / 3600_000;
  if (h < 1) return 'within the hour';
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export default function GroupInsightsScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');

  const [span, setSpan] = useState<Span>('week');
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [insights, setInsights] = useState<MemberInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<string | null>(null);
  // Whether this user may see OTHER members' figures. Starts denied.
  const [mayViewOthers, setMayViewOthers] = useState(false);
  const [trips, setTrips] = useState<TripRecord[]>([]);

  const range: Range = useMemo(() => {
    const now = Date.now();
    if (span === 'week') return weekBounds(now);
    const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0);
    const end = new Date(d.getTime()); end.setMonth(end.getMonth() + 1);
    return { from: d.getTime(), to: end.getTime() - 1 };
  }, [span]);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      if (!groupId) { setLoading(false); return; }
      const u = await getCurrentUserAsync().catch(() => null);
      const myId = u ? String(u.id) : null;

      const g = await getGroup(groupId);
      const perms = new Set((g?.permissions ?? []) as Permission[]);
      // Untyped legacy groups keep their previous openness rather than being
      // silently tightened on upgrade.
      const allowed = !g?.groupType || hasPerm(perms, 'view_history');

      const [mem, track] = await Promise.all([
        circleMembers(groupId).catch(() => [] as CircleMember[]),
        getTrack(groupId, { from: range.from, to: range.to }),
      ]);
      await loadAlerts();
      const alerts = selectAlerts(groupId, 'all');

      if (!live) return;
      setMe(myId);
      setMayViewOthers(allowed);
      setMembers(mem);
      // Without the permission, only your own figures are computed at all —
      // filtering at render would still have built everyone else's numbers.
      const ids = allowed ? mem.map((m) => m.id) : (myId ? [myId] : []);
      setInsights(summarise(ids, track, alerts, range));

      // Trip history is a FOLD over the group thread's own announcements plus
      // the local alert inbox — nothing new is stored and nothing is fetched
      // for it beyond messages this device already syncs.
      try {
        const msgs = await unionWithLocalHistoryAsc(
          groupId, await getMessages(groupId, { limit: 300 }), 1200);
        const announces: TripAnnounce[] = [];
        for (const m of msgs) {
          const a = announceFromMessage(m);
          if (a?.trip) {
            announces.push({
              id: a.trip.id,
              destinationName: a.trip.destinationName,
              startedBy: a.trip.startedBy,
              startedAt: a.trip.startedAt,
              leaderId: a.trip.leaderId ?? null,
            });
          }
        }
        if (live) setTrips(foldTripHistory(announces, alerts, range));
      } catch { /* offline: the rest of the screen still works */ }

      setLoading(false);
    })();
    return () => { live = false; };
  }, [groupId, range]));

  const summary = useMemo(() => groupSummary(insights), [insights]);
  const nameOf = (id: string) => (id === me ? 'You' : members.find((m) => m.id === id)?.name ?? 'Member');
  const ranked = useMemo(
    () => [...insights].sort((a, b) => b.distanceM - a.distanceM),
    [insights],
  );

  const stat = (label: string, value: string) => (
    <View style={st.stat}>
      <Text style={[st.statVal, { color: colors.text }]}>{value}</Text>
      <Text style={[st.statLbl, { color: colors.textDim }]}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Insights', headerTitleAlign: 'center' }} />

      <View style={[st.tabs, { borderColor: colors.border }]}>
        {(['week', 'month'] as Span[]).map((sp) => {
          const on = sp === span;
          return (
            <TouchableOpacity key={sp} onPress={() => { setSpan(sp); setLoading(true); }}
              style={[st.tab, { borderColor: on ? colors.primary : 'transparent', backgroundColor: on ? colors.primary + '22' : 'transparent' }]}>
              <Text style={{ color: on ? colors.primary : colors.textDim, fontWeight: on ? '800' : '600', fontSize: 13 }}>
                {sp === 'week' ? 'This week' : 'This month'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={st.statRow}>
              {stat('Travelled', formatDistance(summary.distanceM))}
              <View style={[st.vr, { backgroundColor: colors.border }]} />
              {stat('Arrivals', String(summary.arrivals))}
              <View style={[st.vr, { backgroundColor: colors.border }]} />
              {stat('Check-ins', String(summary.checkIns))}
            </View>
            {summary.busiest && (
              <Text style={{ color: colors.textDim, fontSize: 12.5, textAlign: 'center', marginTop: 12 }}>
                Furthest this {span}: {nameOf(summary.busiest.userId)} · {formatDistance(summary.busiest.distanceM)}
              </Text>
            )}
          </View>

          {!mayViewOthers && (
            <View style={[st.notice, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1 }}>
                Showing only your own activity — this group does not let your role view other
                members&apos; history.
              </Text>
            </View>
          )}

          <Text style={[st.h, { color: colors.text }]}>By member</Text>
          {ranked.length === 0 && (
            <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
              Nothing recorded yet. Insights build up while location sharing is on.
            </Text>
          )}

          {ranked.map((i) => (
            <View key={i.userId} style={[st.row, { borderColor: colors.border }]}>
              <View style={[st.avatar, { backgroundColor: colorFor(i.userId) }]}>
                <Text style={st.avatarTxt}>{nameOf(i.userId).trim()[0]?.toUpperCase() ?? '?'}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                  {nameOf(i.userId)}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                  {i.activeDays ? `${i.activeDays} active day${i.activeDays === 1 ? '' : 's'}` : 'No activity'}
                  {i.arrivals ? ` · ${i.arrivals} arrival${i.arrivals === 1 ? '' : 's'}` : ''}
                  {i.deviations ? ` · ${i.deviations} off-route` : ''}
                </Text>
                {i.lastSeen != null && (
                  <Text style={{ color: colors.textFaint, fontSize: 11 }}>Last seen {ago(i.lastSeen)}</Text>
                )}
              </View>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                {formatDistance(i.distanceM)}
              </Text>
            </View>
          ))}

          <Text style={[st.h, { color: colors.text }]}>Trips</Text>
          {trips.length === 0 ? (
            <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
              No group trips this {span}.
            </Text>
          ) : (
            <>
              {frequentDestinations(trips, 3).filter((d) => d.count > 1).length > 0 && (
                <Text style={{ color: colors.textDim, fontSize: 12.5, marginBottom: 10 }}>
                  Most visited: {frequentDestinations(trips, 3).filter((d) => d.count > 1)
                    .map((d) => `${d.name} (${d.count})`).join(' · ')}
                </Text>
              )}
              {trips.map((t) => (
                <View key={t.id} style={[st.row, { borderColor: colors.border }]}>
                  <View style={[st.avatar, { backgroundColor: colors.primary + '22' }]}>
                    <Ionicons name="car" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                      {t.destinationName}
                    </Text>
                    <Text style={{ color: colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                      {new Date(t.startedAt).toLocaleDateString()} · {nameOf(t.startedBy)}
                      {t.arrivals.length ? ` · ${t.arrivals.length} arrived` : ' · nobody arrived'}
                      {t.deviations ? ` · ${t.deviations} off-route` : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}

          <View style={[st.footer, { borderColor: colors.border }]}>
            <Ionicons name="phone-portrait-outline" size={15} color={colors.textDim} />
            <Text style={{ color: colors.textDim, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
              Worked out on this phone from data it already holds. Nothing on this screen is sent
              anywhere — not even a total. Distances are estimated from periodic position samples,
              so they read low rather than high.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16 },
  statRow: { flexDirection: 'row', alignItems: 'center' },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statVal: { fontSize: 16, fontWeight: '800' },
  statLbl: { fontSize: 11 },
  vr: { width: 1, height: 30 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 11, borderWidth: 1, borderRadius: 12, marginTop: 12 },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 26, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 24, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
