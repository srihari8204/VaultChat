// components/family/MeetHereSheet.tsx — pick a place, see every family member's
// road distance and ETA to it (spec §40–43, §69, §78–79).
//
// A SHEET, NOT A SCREEN. §4/§33 are explicit that the family map is one primary
// experience and that most operations happen without leaving it, so this mounts
// over the map and hands the chosen destination back up for the map to draw.
//
// The arithmetic lives in lib/family/meetHere (pure, self-checked); this file is
// input, layout and one network call. Search reuses the existing /nav/geocode
// proxy and distances the new /nav/matrix batch — ten members are ONE routing
// request, not ten.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { brandAlpha } from '../../constants/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { geocodeSearch, type GeoHit } from '../../lib/nav/geocode';
import { fetchMatrix, type MatrixResult } from '../../lib/nav/routing';
import { type LatLng } from '../../lib/nav/geo';
import { type MemberInput, formatMetres } from '../../lib/family/distance';
import {
  meetRows, meetSummary, arrivalOf, familyCenter, formatEta, ARRIVAL_LABEL,
  type ArrivalStatus,
} from '../../lib/family/meetHere';

/** The category chips of §77 — one tap instead of typing the obvious things. */
const CATEGORIES = ['Restaurant', 'Cafe', 'Park', 'Mall', 'Cinema', 'Hotel', 'Hospital', 'Petrol', 'School', 'College', 'Bank', 'ATM'];

const SEARCH_DEBOUNCE_MS = 350;

export interface MeetDestination extends LatLng { name: string }

export default function MeetHereSheet({ members, myPos, destination, onDestination, onClose, onStartTrip, tripActive }: {
  /** Everyone in the circle, in a STABLE order — matrix results map by index. */
  members: MemberInput[];
  myPos?: LatLng | null;
  destination: MeetDestination | null;
  onDestination: (d: MeetDestination | null) => void;
  onClose: () => void;
  /** Broadcast this destination to the whole circle as a family trip. The
   *  sheet only offers it; starting (and the consent that implies) is the
   *  screen's job. Absent = the plain viewer-local Meet Here. */
  onStartTrip?: (d: MeetDestination) => void;
  /** A trip is already running — offer no second one. */
  tripActive?: boolean;
}) {
  const { colors } = useTheme();
  // Solid sheet tones: this mounts over the live family map, where translucent
  // glass costs readability (same rule as family-map's floating bars).
  const G = useSpaceGlass();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeoHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [matrix, setMatrix] = useState<MatrixResult[] | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Debounced search. The ref guards against an older, slower response landing
  // after a newer one and repainting stale results.
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await geocodeSearch(term, myPos ?? null);
        if (seq.current === mine) setHits(r);
      } catch {
        if (seq.current === mine) setHits([]);
      } finally {
        if (seq.current === mine) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  // Keyed on my COORDINATES, not the object — myPos is rebuilt on every fix,
  // and depending on its identity would restart the debounce mid-typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, myPos?.lat, myPos?.lng]);

  // Road distances for the chosen destination. One call for the whole family.
  const load = useCallback(async (dest: LatLng) => {
    setRouting(true);
    setRouteError(null);
    try {
      // Index alignment is the contract: send EVERY member so index i here is
      // index i in `members`, and let the backend skip unusable coordinates.
      // Filtering first would silently shift everyone's results by one.
      const origins = members.map((m) => m.pos ?? { lat: 0, lng: 0 });
      setMatrix(await fetchMatrix(origins, dest, 'auto'));
    } catch (e: any) {
      setMatrix(null);
      // Straight-line distances still render — the screen degrades to the
      // honest subset rather than going blank.
      setRouteError(e?.message ?? 'Road distances unavailable right now.');
    } finally {
      setRouting(false);
    }
  }, [members]);

  useEffect(() => {
    if (destination) load(destination);
    else { setMatrix(null); setRouteError(null); }
  // Only a genuinely different PLACE re-routes. Depending on the destination
  // object would fire a fresh matrix request on every parent render — ten
  // members' worth of routing, repeatedly, for a destination that never moved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng, load]);

  const rows = useMemo(
    () => (destination ? meetRows(members, destination, matrix) : []),
    [members, destination, matrix],
  );
  const summary = useMemo(() => meetSummary(rows), [rows]);
  const centre = useMemo(() => familyCenter(members), [members]);

  const pick = (name: string, lat: number, lng: number) => {
    onDestination({ name, lat, lng });
    setQ('');
    setHits([]);
  };

  // Status is a TEXT label (§69/§70), so it takes the AA-deep tints.
  const statusColor = (s: ArrivalStatus) =>
    s === 'arrived' ? G.goodText : s === 'nearby' ? G.accentText : colors.textDim;

  return (
    <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge }]}>
      <View style={st.head}>
        <Ionicons name="location" size={16} color={colors.primary} />
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15, flex: 1 }} numberOfLines={1}>
          {destination ? destination.name : 'Meet here'}
        </Text>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close meet here" style={{ padding: 4 }}>
          <Ionicons name="close" size={20} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {!destination ? (
        <>
          <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}>
            <Ionicons name="search" size={17} color={colors.textDim} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search a place to meet"
              placeholderTextColor={colors.textFaint}
              style={[st.input, { color: colors.text }]}
              autoCorrect={false}
              returnKeyType="search"
            />
            {searching && <ActivityIndicator size="small" color={colors.primary} />}
            {!!q && !searching && (
              <TouchableOpacity onPress={() => setQ('')} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={17} color={colors.textFaint} />
              </TouchableOpacity>
            )}
          </View>

          {!q.trim() && (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.cats}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setQ(c)}
                    accessibilityRole="button"
                    style={[st.cat, { borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}
                  >
                    <Text style={{ color: colors.text, fontSize: 12.5 }}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* FAMILY CENTER (§43/§79). An AREA to search near, not a venue —
                  labelled as such, because suggesting "meet here" at a point
                  that may be the middle of a field would be worse than useless. */}
              {centre && (
                <TouchableOpacity
                  onPress={() => pick('Family centre', centre.center.lat, centre.center.lng)}
                  accessibilityRole="button"
                  style={[st.centre, { borderColor: G.chipEdge, backgroundColor: brandAlpha(0.1) }]}
                >
                  <Ionicons name="git-merge" size={17} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>Find the best meeting point</Text>
                    <Text style={{ color: colors.textDim, fontSize: 11.5 }}>
                      Balanced for {centre.count} members · furthest travels {formatMetres(centre.worstM)} straight-line
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                </TouchableOpacity>
              )}
            </>
          )}

          <ScrollView style={{ maxHeight: 240 }} keyboardShouldPersistTaps="handled">
            {hits.map((h, i) => (
              <TouchableOpacity
                key={`${h.lat},${h.lng},${i}`}
                onPress={() => pick(h.name || h.label, h.lat, h.lng)}
                style={[st.hit, { borderTopColor: G.line }]}
              >
                <Ionicons name="location-outline" size={16} color={colors.textDim} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{h.name || h.label}</Text>
                  <Text style={{ color: colors.textDim, fontSize: 11.5 }} numberOfLines={1}>{h.label}</Text>
                </View>
              </TouchableOpacity>
            ))}
            {!!q.trim() && !searching && hits.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13, padding: 12, textAlign: 'center' }}>
                Nothing found for “{q.trim()}”.
              </Text>
            )}
          </ScrollView>
        </>
      ) : (
        <>
          {routing && (
            <View style={st.note}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={{ color: colors.textDim, fontSize: 12 }}>Getting road distances…</Text>
            </View>
          )}
          {/* Never silently downgrade: if routing failed, say the numbers below
              are straight-line rather than letting them be read as drive times. */}
          {!!routeError && !routing && (
            <View style={st.note}>
              <Ionicons name="cloud-offline-outline" size={14} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12, flex: 1 }}>
                Straight-line distances only — {routeError}
              </Text>
            </View>
          )}

          <ScrollView style={{ maxHeight: 250 }} contentContainerStyle={{ paddingBottom: 4 }}>
            {rows.map((r) => {
              const status = arrivalOf(r.straightM);
              return (
                <View key={r.id} style={[st.row, { borderTopColor: G.line }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                      {r.self ? 'You' : r.name}
                    </Text>
                    <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
                      {r.straightM == null
                        ? 'Location unavailable'
                        : r.roadM != null
                          // Road figures say so explicitly. §8: a road distance
                          // must never be presentable as a straight-line one.
                          ? `${formatMetres(r.roadM)} by road · ${formatEta(r.etaS)}`
                          : `${formatMetres(r.straightM)} straight-line`}
                    </Text>
                  </View>
                  {/* Text label, not colour alone — §69/§70. */}
                  <Text style={{ color: statusColor(status), fontSize: 11, fontWeight: '800' }}>
                    {ARRIVAL_LABEL[status]}
                  </Text>
                </View>
              );
            })}
          </ScrollView>

          <View style={[st.sum, { borderTopColor: G.line }]}>
            {summary.nearest && (
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                Nearest <Text style={{ color: colors.text, fontWeight: '700' }}>{summary.nearest.name}</Text>
                {summary.farthest && summary.farthest.id !== summary.nearest.id
                  ? <> · Farthest <Text style={{ color: colors.text, fontWeight: '700' }}>{summary.farthest.name}</Text></>
                  : null}
              </Text>
            )}
            {/* Only claimed when every located member has a real ETA — see
                meetSummary. A "family arrives in 20 min" that quietly ignores
                three people is worse than no estimate at all. */}
            {summary.familyArrivalS != null ? (
              <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '700' }}>
                Everyone can be there in {formatEta(summary.familyArrivalS)}
              </Text>
            ) : summary.located > 0 ? (
              <Text style={{ color: colors.textDim, fontSize: 11.5 }}>
                {summary.routed} of {summary.located} located members have a road ETA
              </Text>
            ) : null}
          </View>

          {/* FAMILY TRIP: one tap broadcasts this destination to the circle —
              every member's phone shows the trip, draws their own route and
              shares their ETA. Only derived numbers travel; see tripSession. */}
          {!!onStartTrip && !tripActive && (
            <TouchableOpacity
              onPress={() => onStartTrip(destination)}
              accessibilityRole="button"
              style={[st.btn, { borderColor: colors.primary, backgroundColor: brandAlpha(0.14), marginTop: 10 }]}
            >
              <Ionicons name="car" size={16} color={colors.primary} />
              <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 13 }}>Start family trip here</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={() => onDestination(null)}
            accessibilityRole="button"
            style={[st.btn, { borderColor: G.chipEdge, marginTop: onStartTrip && !tripActive ? 8 : 10 }]}
          >
            <Ionicons name="swap-horizontal" size={16} color={colors.primary} />
            <Text style={{ color: G.accentText, fontWeight: '700', fontSize: 13 }}>Change destination</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, minHeight: 44 },
  input: { flex: 1, fontSize: 14.5, paddingVertical: 0 },
  cats: { gap: 7, paddingVertical: 11 },
  cat: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 30, justifyContent: 'center' },
  centre: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 13, padding: 11, marginBottom: 4 },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  sum: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 9, gap: 3 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderRadius: 14, minHeight: 42, marginTop: 10 },
});
