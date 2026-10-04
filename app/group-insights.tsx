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
import { View, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { getTrack } from '../lib/family/history';
import { loadAlerts, selectAlerts } from '../lib/family/alerts';
import { circleMembers } from '../lib/family/circle';
import { getGroup, historyAccess } from '../lib/groups/store';
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
import { initialOf } from '../lib/format';

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
  const { colors, scheme } = useTheme();
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
  /** Bumped by Retry. getCurrentUserAsync() failing used to end the screen on
   *  "Nothing recorded yet" with no way back — the load only ever re-ran on a
   *  fresh focus, so the user had to know to leave and come back (2026-09-17). */
  const [reload, setReload] = useState(0);

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
      // try/finally: a rejection from getTrack/getGroup/loadAlerts used to leave
      // the spinner up for good.
      try {
        const u = await getCurrentUserAsync().catch(() => null);
        const myId = u ? String(u.id) : null;

        const g = await getGroup(groupId);
        // Untyped legacy groups keep their previous openness rather than being
        // silently tightened on upgrade — and a group whose permissions have
        // never been CACHED is unknown, not denied (2026-09-17). The registry
        // only learns permissions from a successful getChat, so a migrated
        // circle, an unvisited space and every group read offline had an absent
        // list; treating that as an empty permission set locked this screen down
        // to "showing only your own activity" for people who own the circle.
        // See historyAccess() for the three cases.
        const allowed = historyAccess(g) !== 'denied';

        // Withhold the LOAD, not just the computation (2026-09-17). getTrack with
        // no userId returns EVERY member's positions, and `allowed` gated only the
        // summarise() below — so a denied viewer's device had already been handed
        // the whole group's track before anything was filtered. Scope the read to
        // your own id instead: your own positions are the one reading that needs
        // no permission. Fails closed when the id is unknown.
        const [mem, track] = await Promise.all([
          circleMembers(groupId).catch(() => [] as CircleMember[]),
          allowed ? getTrack(groupId, { from: range.from, to: range.to })
            : myId ? getTrack(groupId, { from: range.from, to: range.to, userId: myId })
              : [],
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
      } catch { /* nothing loaded: the screen's empty state applies */ }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [groupId, range, reload]));

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
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Insights', headerTitleAlign: 'center' }} />

      <View style={[st.tabs, { borderColor: colors.glassStroke }]}>
        {(['week', 'month'] as Span[]).map((sp) => {
          const on = sp === span;
          return (
            <TouchableOpacity key={sp} onPress={() => {
              // Re-tapping the ACTIVE tab used to strand the spinner forever.
              // setSpan(sp) with sp === span is a React bail-out, so `span` does
              // not change; `range` is useMemo([span]) so it keeps its identity;
              // the useFocusEffect callback's deps [groupId, range, reload] are
              // therefore unchanged and the effect never re-runs — and the only
              // setLoading(false) for this screen lives inside it. The screen sat
              // under an ActivityIndicator with no way out, and the obvious
              // recovery (tap the tab again) was the thing causing it.
              //
              // A `finally` in the effect does NOT fix this: the effect body never
              // runs. Not entering the loading state is the only fix at this site.
              if (sp === span) return;
              setSpan(sp); setLoading(true);
            }}
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
          <View style={[st.card, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
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
            <View style={[st.notice, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              <Ionicons name={me ? 'lock-closed-outline' : 'alert-circle-outline'} size={15} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1 }}>
                {me
                  ? 'Showing only your own activity — this group does not let your role view other members’ history.'
                  // Without an identity the denied branch cannot even read your
                  // OWN track, so the screen was empty for a reason that had
                  // nothing to do with the week. Say which, and offer the way out.
                  : 'We could not confirm who you are, so not even your own figures were read. This is not an empty week — nothing was looked up.'}
              </Text>
              {!me && (
                <TouchableOpacity
                  onPress={() => { setLoading(true); setReload((n) => n + 1); }}
                  accessibilityRole="button"
                  accessibilityLabel="Try loading insights again"
                  style={[st.retry, { borderColor: colors.primary }]}
                >
                  <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '700' }}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          <Text style={[st.h, { color: colors.text }]}>By member</Text>
          {ranked.length === 0 && (
            <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
              {!mayViewOthers && !me
                ? 'Nothing could be read until we know who you are.'
                : 'Nothing recorded yet. Insights build up while location sharing is on.'}
            </Text>
          )}

          {ranked.map((i) => (
            <View key={i.userId} style={[st.row, { borderColor: colors.glassStroke }]}>
              <View style={[st.avatar, { backgroundColor: colorFor(i.userId) }]}>
                <Text style={[st.avatarTxt, scheme === 'light' && { color: '#070A18' }]}>{initialOf(nameOf(i.userId))}</Text>
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
                <View key={t.id} style={[st.row, { borderColor: colors.glassStroke }]}>
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

          <View style={[st.footer, { borderColor: colors.glassStroke }]}>
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
  // flexWrap so the Retry chip drops below the sentence rather than crushing it
  // at 320dp or font scale 1.5; minHeight, never height, for the same reason.
  notice: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9, padding: 11, borderWidth: 1, borderRadius: 12, marginTop: 12 },
  retry: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, minHeight: 34, justifyContent: 'center' },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 26, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  footer: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 24, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
