// app/space-overview.tsx — the operations dashboard
// (School design screen 6, Business Dashboard reference for offices).
//
// ── this screen holds no logic, and that is the design ──
//
// Every number here arrives already computed from space_ops_summary(). There is
// no aggregation in this file and there must not be any: a second implementation
// of "how many children are still waiting" ships to a thousand phones before
// anyone notices it disagrees with the server's.
//
// One request renders the whole screen. That is what keeps the app small —
// previously this would have meant fetching every run's manifest to add up six
// figures locally.
//
// The School and Business designs are the SAME payload with a different
// question on top: a school asks who is still on a bus, a company asks who is
// at their desk. So the layouts differ by space type and the fetch does not.
// Business gets the blue-on-navy Business palette (useSpaceColors); school
// keeps the app theme.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import { getOpsSummary, type OpsSummary } from '../lib/spaces/api';
import { BusinessDashboard, BusinessDoors } from '../components/spaces/BusinessDashboard';
import { AuroraBackground } from '../components/ui';
import LoadError from '../components/spaces/LoadError';
import { familyOf } from '../lib/spaces/layout';
import { errMsg } from '../lib/spaces/errors';

interface Tile {
  key: string;
  label: string;
  /** null renders as "—": a figure the server could not determine, which is
   *  different from zero and must never be shown as zero. */
  value: number | null;
  alert?: boolean;
  tone?: 'good' | 'warn';
}

const dash = (v: number | null | undefined) => (v == null ? '—' : String(v));

/** [label, icon, route, permission needed to draw it] — the same gates as
 *  space-admin's ENTRIES and lib/spaces/layout's sections. */
type Shortcut = readonly [string, keyof typeof Ionicons.glyphMap, string, string | null];
const SCHOOL_SHORTCUTS: readonly Shortcut[] = [
  ['Runs', 'bus-outline', '/space-runs-admin', 'manage_runs'],
  ['Roster', 'people-outline', '/space-roster', 'manage_roster'],
  // Named for the screen it opens (titled "Check in"); "Attendance" is
  // space-attendance, the location-derived view.
  ['Check in', 'log-in-outline', '/space-checkin', null],
  ['Incidents', 'alert-circle-outline', '/space-incidents', null],
  ['Visitors', 'qr-code-outline', '/space-visitors', 'manage_roster'],
];
const OFFICE_SHORTCUTS: readonly Shortcut[] = [
  ['Incidents', 'alert-circle-outline', '/space-incidents', null],
  ['Visitors', 'qr-code-outline', '/space-visitors', 'manage_roster'],
  ['Settings', 'settings-outline', '/space-admin', 'view_space_ops'],
];

export default function SpaceOverviewScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string; perms?: string }>();
  const spaceId = String(params.spaceId || '');
  const colors = useSpaceColors(params.groupType);

  const [sum, setSum] = useState<OpsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getOpsSummary(spaceId);
      // The SQL answers with {"error":"not_permitted"} rather than throwing, so
      // a caller who lost the permission mid-session gets a clear screen instead
      // of a wall of zeros that looks like an empty school.
      if (s?.error) { setError('You no longer have access to this space’s operations.'); setSum(null); }
      else { setSum(s); setError(null); }
    } catch (e) {
      setError(errMsg(e) ?? 'Could not load the dashboard.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // familyOf, not string equality: the type list is data, and 'college' or a
  // new school_* type must get the school board, the same as the hub does.
  const isSchool = useMemo(
    () => familyOf(String(params.groupType || sum?.groupType || '')) === 'school',
    [params.groupType, sum?.groupType],
  );
  // Presentation only — every screen behind these re-checks server-side. A
  // shortcut the caller cannot use is not drawn (the space-admin rule).
  const perms = useMemo(() => new Set(String(params.perms || '').split(',').filter(Boolean)), [params.perms]);

  // School Overview tiles (design screen 6) — unchanged.
  const schoolTiles: Tile[] = useMemo(() => {
    if (!sum || !isSchool) return [];
    return [
      { key: 'students', label: 'Total Students', value: sum.roster.children || sum.roster.total },
      { key: 'buses', label: 'Active Buses', value: sum.transport.active, tone: 'good' },
      { key: 'picked', label: 'Students Picked', value: sum.riders.picked },
      { key: 'pending', label: 'Pending Pickup', value: sum.riders.pending },
      { key: 'dropped', label: 'Students Dropped', value: sum.riders.dropped },
      { key: 'delayed', label: 'Not Reporting', value: sum.transport.notReporting, alert: sum.transport.notReporting > 0 },
      // The figure a school actually acts on: marked neither way on a run
      // that has finished. Never folded into "absent".
      { key: 'unaccounted', label: 'Unaccounted', value: sum.riders.unaccounted, alert: sum.riders.unaccounted > 0 },
      { key: 'sos', label: 'Emergencies', value: sum.open.sos, alert: sum.open.sos > 0 },
    ];
  }, [sum, isSchool]);

  const s = useMemo(() => styles(colors), [colors]);
  // perms travel with every hop so Tasks/Leave keep their compose and decide
  // affordances when reached from here rather than from the hub.
  const go = (path: string) => router.push({
    pathname: path,
    params: {
      spaceId, name: params.name ?? '', groupType: params.groupType ?? '',
      perms: params.perms ?? '',
      // Roster reads this (it also derives it from perms).
      canManage: perms.has('manage_roster') ? '1' : '0',
    },
  });

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Overview')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <AuroraBackground />
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
    >
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · Overview` : 'Overview', { id: spaceId, name: params.name })} />

      {error && (
        <LoadError colors={colors} title="Not available" message={error} onRetry={() => { setRefreshing(true); void load(); }} />
      )}
      {error && sum && (
        <Text style={s.muted}>The figures below are from the last successful refresh and may be out of date.</Text>
      )}

      {sum && (
        <>
          {/* An open emergency outranks every number on the screen. */}
          {sum.open.sos > 0 && (
            <TouchableOpacity
              accessibilityRole="button" style={s.sos} onPress={() => go('/space-incidents')}
              accessibilityLabel={`${sum.open.sos === 1 ? 'An emergency alert is open' : `${sum.open.sos} emergency alerts are open`}. Open incidents`}
            >
              <Ionicons name="warning" size={20} color={colors.onDanger} />
              <Text style={s.sosText}>
                {sum.open.sos === 1 ? 'An emergency alert is open' : `${sum.open.sos} emergency alerts are open`}
              </Text>
            </TouchableOpacity>
          )}

          {isSchool ? (
            /* ── School Overview (design screen 6) — unchanged ── */
            <>
              <View style={s.tiles}>
                {schoolTiles.map((t) => (
                  <View
                    key={t.key} style={[s.tile, t.alert && { borderColor: colors.danger }]}
                    accessible accessibilityLabel={`${t.label}, ${t.value == null ? 'not known' : t.value}${t.alert ? ', needs attention' : ''}`}
                  >
                    <Text style={[
                      s.tileValue,
                      t.alert && { color: colors.danger },
                      t.tone === 'good' && !t.alert && { color: colors.success },
                    ]}>
                      {dash(t.value)}
                    </Text>
                    <Text style={s.tileLabel} numberOfLines={2}>{t.label}</Text>
                  </View>
                ))}
              </View>
              {schoolTiles.some((t) => t.value == null) && (
                <Text style={s.footnote}>
                  “—” means this space has no shift configured, so nobody can be counted late.
                </Text>
              )}
            </>
          ) : (
            /* ── Business Dashboard (reference design): components/spaces/BusinessDashboard ── */
            sum.workforce && <BusinessDashboard sum={sum} colors={colors} perms={perms} go={go} />
          )}

          {/* Live runs (school: design screen 6's "Live Buses"; office: cabs). */}
          {sum.runs.length > 0 && (
            <View style={s.card}>
              <View style={s.rowBetween}>
                <Text style={s.cardTitle}>{isSchool ? 'Live Buses' : 'Live Runs'}</Text>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open the live map" onPress={() => go('/space-ops-map')} style={s.linkHit}>
                  <Text style={s.link}>Map</Text>
                </TouchableOpacity>
              </View>
              {sum.runs.map((r) => (
                <TouchableOpacity accessibilityRole="button"
                  key={r.id}
                  style={s.runRow}
                  onPress={() => router.push({ pathname: '/space-run', params: { spaceId, runId: r.id, groupType: params.groupType ?? '', name: params.name ?? '' } })}
                  accessibilityLabel={`${r.name}, ${r.status === 'started' ? `${r.total - r.pending} of ${r.total} done` : 'not started'}${r.stale && r.status === 'started' ? ', not reporting' : ''}`}
                >
                  <View style={[s.dot, {
                    backgroundColor: r.status !== 'started' ? colors.textFaint
                      : r.stale ? colors.danger : colors.success,
                  }]} />
                  <Text style={s.runName} numberOfLines={1}>{r.name}</Text>
                  <Text style={s.muted}>
                    {r.status === 'started'
                      ? `${r.total - r.pending}/${r.total}`
                      : 'Not started'}
                  </Text>
                  {r.stale && r.status === 'started' && (
                    <Text style={{ color: colors.danger, fontSize: 11.5 }}>not reporting</Text>
                  )}
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {!isSchool && <BusinessDoors colors={colors} perms={perms} go={go} />}

          {/* Shortcuts to the screens these numbers come from. */}
          <View style={s.card}>
            {(isSchool ? SCHOOL_SHORTCUTS : OFFICE_SHORTCUTS)
              .filter(([, , , needs]) => !needs || perms.has(needs))
              .map(([label, icon, path]) => (
              <TouchableOpacity accessibilityRole="button" key={label} style={s.linkRow} onPress={() => go(path)}>
                <Ionicons name={icon} size={18} color={colors.primary} />
                <Text style={s.linkRowText}>{label}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.footnote}>
            Figures are for {sum.day} and are computed on the server, so every device sees the
            same numbers. Vehicle positions are not included here — those stay end-to-end
            encrypted and are only ever on the map.
          </Text>
        </>
      )}
    </ScrollView>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  sos: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.danger, borderRadius: 12, padding: 14,
  },
  // On-danger ink on the solid danger fill.
  sosText: { color: c.onDanger, fontWeight: '700', flex: 1 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    backgroundColor: c.glassSoft, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 13,
    minWidth: 104, flexGrow: 1, flexBasis: '30%', borderWidth: 1, borderColor: 'transparent',
  },
  tileValue: { color: c.text, fontSize: 23, fontWeight: '800' },
  tileLabel: { color: c.textDim, fontSize: 11.5, marginTop: 2 },
  card: { backgroundColor: c.glassSoft, borderRadius: 16, padding: 14, gap: 8, borderWidth: 1, borderColor: c.glassStroke },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: c.primary, fontSize: 12.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, minHeight: 44 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  runName: { color: c.text, flex: 1, fontSize: 14.5 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, minHeight: 44 },
  linkRowText: { color: c.text, flex: 1, fontSize: 14.5 },
  linkHit: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});
