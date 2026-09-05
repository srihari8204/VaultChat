// app/family-history.tsx — Family Space location history (mockup screen 8).
//
// Day / Week / Month over the device-local track store, drawn as a path on the
// map plus a timeline of that member's events. There was previously no history
// of any kind: MemberPresence was in-memory and discarded, so "where were they
// at 3pm" had no answer. lib/family/history.ts is the store; this is the view.
//
// Everything here is read from the device. There is no history endpoint and
// nothing on this screen was ever uploaded.

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { SPACE_SHADOW } from '../constants/spaceTheme';
import FamilyMap from '../components/family/FamilyMap';
import { getTrack, summarize, type TrackSample } from '../lib/family/history';
import { segmentTrips } from '../lib/family/status';
import { useFamilyAlerts, loadAlerts, type FamilyAlert } from '../lib/family/alerts';
import { getGroup } from '../lib/groups/store';
import { getCurrentUserAsync } from './(constants)/authService';
import { can as hasPerm, type Permission } from '../lib/groups/permissions';

type Range = 'day' | 'week' | 'month';

const RANGES: { key: Range; label: string; ms: number }[] = [
  { key: 'day',   label: 'Day',   ms: 24 * 3600 * 1000 },
  { key: 'week',  label: 'Week',  ms: 7 * 24 * 3600 * 1000 },
  { key: 'month', label: 'Month', ms: 31 * 24 * 3600 * 1000 },
];

const dist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
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
  const G = useSpaceGlass();
  const params = useLocalSearchParams<{ circleId?: string; userId?: string; name?: string }>();
  const circleId = String(params.circleId || '');
  const userId = params.userId ? String(params.userId) : undefined;
  const who = String(params.name || 'Family');

  const [range, setRange] = useState<Range>('day');
  const [samples, setSamples] = useState<TrackSample[]>([]);
  // Selected trip index; null = the whole range's path on the map.
  const [tripSel, setTripSel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether THIS user may see OTHER people's history in this group. Viewing
  // your own is always allowed — it is your data. Starts denied: a permission
  // that has not loaded must not reveal anything.
  const [mayViewOthers, setMayViewOthers] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);

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
      const me = await getCurrentUserAsync().catch(() => null);
      if (live) setSelfId(me ? String(me.id) : null);
      const g = await getGroup(circleId);
      const perms = new Set((g?.permissions ?? []) as Permission[]);
      // An untyped legacy group has no matrix; the pre-existing behaviour there
      // was that any member could see the circle's history, so preserve it.
      const allowed = !g?.groupType || hasPerm(perms, 'view_history');
      if (!live) return;
      setMayViewOthers(allowed);
      const t = await getTrack(circleId, { from, userId });
      if (!live) return;
      setSamples(t);
      setTripSel(null); // a stale index into the previous range's trips would highlight the wrong drive
      setLoading(false);
    })();
    return () => { live = false; };
  }, [circleId, userId, from]));

  const stats = useMemo(() => summarize(samples), [samples]);


  /** TRAVELLED distance, map-matched to roads; the summed track is the
   *  fallback. Summing straight lines between fixes cuts every bend into a
   *  chord and understates the day. */
  const [roadTravelledM, setRoadTravelledM] = useState<number | null>(null);
  const trackKey = useMemo(
    () => (samples.length < 2 ? '' : `${samples.length}:${samples[0]?.ts}:${samples[samples.length - 1]?.ts}`),
    [samples]);
  useEffect(() => {
    if (!trackKey) { setRoadTravelledM(null); return; }
    let cancel = false;
    (async () => {
      try {
        const { fetchTraceDistance } = require('../lib/nav/routing');
        const r = await fetchTraceDistance(samples.map((p: any) => ({ lat: p.lat, lng: p.lng })));
        if (!cancel) setRoadTravelledM(r?.distanceM ?? null);
      } catch { if (!cancel) setRoadTravelledM(null); }
    })();
    return () => { cancel = true; };
  }, [trackKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Trips are re-derived from the same samples on every load — computed on
  // read cannot be stale, and nothing is ever stored or uploaded for them.
  const trips = useMemo(() => segmentTrips(samples), [samples]);
  const path = useMemo(() => {
    const sel = tripSel != null ? trips[tripSel] : null;
    const src = sel ? samples.filter((s) => s.ts >= sel.startTs && s.ts <= sel.endTs) : samples;
    return src.map((s) => ({ lat: s.lat, lng: s.lng }));
  }, [samples, trips, tripSel]);

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
    <View style={{ flex: 1, backgroundColor: G.bgMid }}>
      {/* Native header opted back in (root hides them app-wide): it owns the
          status-bar inset, so the range tabs sit BELOW the dead top strip —
          without it "Week"/"Month" landed under the status bar and ate taps,
          and the screen had no back button. Same fix as the space module. */}
      <Stack.Screen options={{
        headerShown: true, title: userId ? `${who}'s history` : 'Location History', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SpaceGround />

      {/* range tabs */}
      <View style={[st.tabs, { borderColor: G.line }]}>
        {RANGES.map((r) => {
          const on = r.key === range;
          return (
            <TouchableOpacity key={r.key} onPress={() => setRange(r.key)}
              accessibilityRole="button" accessibilityState={{ selected: on }}
              style={[st.tab, { backgroundColor: on ? brandAlpha(0.14) : G.paneFaint, borderColor: on ? colors.primary : G.chipEdge }]}>
              <Text style={{ color: on ? G.accentText : colors.textDim, fontWeight: on ? '800' : '600', fontSize: 13 }}>{r.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (!mayViewOthers && !!userId && userId !== selfId) ? (
        <View style={[st.center, { padding: 32 }]}>
          <Ionicons name="lock-closed-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>Not shared with you</Text>
          <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 4 }}>
            This group does not let your role view location history.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 6, paddingBottom: 40 }}>
          {/* path */}
          <View style={[st.mapCard, { borderColor: G.edge }]}>
            {path.length > 1 ? (
              <FamilyMap members={[]} path={path} style={{ flex: 1 }} />
            ) : (
              <View style={[st.center, { backgroundColor: G.pane }]}>
                <Ionicons name="map-outline" size={26} color={colors.textFaint} />
                <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 }}>
                  No track for this range yet. History builds up while location sharing is on.
                </Text>
              </View>
            )}
          </View>

          {/* stats */}
          <View style={[st.statRow, { backgroundColor: G.pane, borderColor: G.edge }]}>
            <View style={st.stat}>
              {/* Map-matched onto the roads — see family-member.tsx. The summed
                  straight lines survive as the fallback, never as the answer. */}
              <Text style={[st.statVal, { color: colors.text }]}>
                {dist(roadTravelledM ?? stats.distanceM)}
              </Text>
              <Text style={[st.statLbl, { color: colors.textDim }]}>Distance</Text>
            </View>
            <View style={[st.statDiv, { backgroundColor: G.line }]} />
            <View style={st.stat}>
              <Text style={[st.statVal, { color: colors.text }]}>{Math.round(stats.maxSpeed * 3.6)} km/h</Text>
              <Text style={[st.statLbl, { color: colors.textDim }]}>Top speed</Text>
            </View>
            <View style={[st.statDiv, { backgroundColor: G.line }]} />
            <View style={st.stat}>
              <Text style={[st.statVal, { color: colors.text }]}>{stats.points}</Text>
              <Text style={[st.statLbl, { color: colors.textDim }]}>Points</Text>
            </View>
          </View>

          {/* trips — segmented from the same on-device samples (spec: travel
              route history). Speeds show only when the trip actually carried
              them; a trip with no speed data says nothing about speed. */}
          {trips.length > 0 && (
            <>
              <Text style={[st.h, { color: colors.textDim }]}>Trips</Text>
              {trips.map((t, i) => {
                const on = tripSel === i;
                return (
                  <TouchableOpacity
                    key={t.startTs}
                    onPress={() => setTripSel(on ? null : i)}
                    style={[st.evt, { borderColor: G.line }]}
                  >
                    <View style={[st.evtIcon, { backgroundColor: on ? brandAlpha(0.22) : brandAlpha(0.1) }]}>
                      <Ionicons name="car-outline" size={14} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>
                        {dayLabel(t.startTs)} · {clock(t.startTs)} – {clock(t.endTs)} · {dist(t.distanceM)}
                      </Text>
                      <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
                        {dur(t.durationMs)} · avg {Math.round(t.avgKmh)} km/h
                        {t.maxKmh != null ? ` · max ${Math.round(t.maxKmh)} km/h` : ''}
                        {t.stops.length ? ` · ${t.stops.length} stop${t.stops.length === 1 ? '' : 's'}` : ''}
                      </Text>
                    </View>
                    <Text style={{ color: on ? G.accentText : colors.textDim, fontSize: 11.5, fontWeight: '700' }}>
                      {on ? 'On map' : 'View'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </>
          )}

          {/* timeline */}
          <Text style={[st.h, { color: colors.textDim }]}>Timeline</Text>
          {timeline.length === 0 ? (
            <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
              No arrivals, departures or check-ins recorded in this range.
            </Text>
          ) : timeline.map((g) => (
            <View key={g.day}>
              <Text style={[st.day, { color: colors.textDim }]}>{g.day}</Text>
              {g.items.map((a) => (
                <View key={a.id} style={[st.evt, { borderColor: G.line }]}>
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
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
  mapCard: { height: 220, borderWidth: 1, borderRadius: 24, overflow: 'hidden', ...SPACE_SHADOW.raised },
  statRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 20, paddingVertical: 14, marginTop: 12, ...SPACE_SHADOW.rest },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statVal: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLbl: { fontSize: 11 },
  statDiv: { width: 1, height: 28 },
  h: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 24, marginBottom: 8 },
  day: { fontSize: 11.5, fontWeight: '700', marginTop: 12, marginBottom: 2 },
  evt: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  evtIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
