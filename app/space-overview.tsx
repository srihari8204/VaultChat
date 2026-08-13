// app/space-overview.tsx — the operations dashboard
// (School design screen 6, Employee design screen 5).
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
// The School and Employee designs are the SAME payload with a different
// question on top: a school asks who is still on a bus, a company asks who is
// at their desk. So the tiles differ by space type and the fetch does not.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { getOpsSummary, type OpsSummary } from '../lib/spaces/api';

interface Tile {
  key: string;
  label: string;
  /** null renders as "—": a figure the server could not determine, which is
   *  different from zero and must never be shown as zero. */
  value: number | null;
  alert?: boolean;
  tone?: 'good' | 'warn';
}

export default function SpaceOverviewScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const spaceId = String(params.spaceId || '');

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
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the dashboard.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const isSchool = useMemo(() => {
    const t = String(params.groupType || sum?.groupType || '');
    return t === 'school' || t === 'school_transport';
  }, [params.groupType, sum?.groupType]);

  const tiles: Tile[] = useMemo(() => {
    if (!sum) return [];
    if (isSchool) {
      // School Overview (design screen 6).
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
    }
    // Employee Dashboard (design screen 5).
    return [
      { key: 'members', label: 'Total People', value: sum.workforce.members },
      { key: 'in', label: 'Active Now', value: sum.workforce.stillIn, tone: 'good' },
      { key: 'leave', label: 'On Leave', value: sum.workforce.onLeave },
      // null when no shift is configured — rendered as "—", never as 0.
      { key: 'late', label: 'Late Today', value: sum.workforce.lateToday, alert: (sum.workforce.lateToday ?? 0) > 0 },
      { key: 'checked', label: 'Checked In', value: sum.workforce.checkedIn },
      { key: 'leavereq', label: 'Leave Requests', value: sum.workforce.leavePending, alert: sum.workforce.leavePending > 0 },
      { key: 'tasks', label: 'Open Tasks', value: sum.open.tasks },
      { key: 'visitors', label: 'Visitors On Site', value: sum.open.visitors },
    ];
  }, [sum, isSchool]);

  const s = styles(colors);
  const go = (path: string) => router.push({
    pathname: path as any,
    params: { spaceId, name: params.name ?? '', groupType: params.groupType ?? '' },
  });

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
        <Stack.Screen options={{ title: 'Overview' }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
    >
      <Stack.Screen options={{ title: params.name ? `${params.name} · Overview` : 'Overview' }} />

      {error && (
        <View style={[s.card, { borderColor: colors.danger, borderWidth: 1 }]}>
          <Text style={s.cardTitle}>Not available</Text>
          <Text style={s.muted}>{error}</Text>
        </View>
      )}

      {sum && (
        <>
          {/* An open emergency outranks every number on the screen. */}
          {sum.open.sos > 0 && (
            <TouchableOpacity style={s.sos} onPress={() => go('/space-incidents')}>
              <Ionicons name="warning" size={20} color="#fff" />
              <Text style={s.sosText}>
                {sum.open.sos === 1 ? 'An emergency alert is open' : `${sum.open.sos} emergency alerts are open`}
              </Text>
            </TouchableOpacity>
          )}

          <View style={s.tiles}>
            {tiles.map((t) => (
              <View key={t.key} style={[s.tile, t.alert && { borderColor: colors.danger }]}>
                <Text style={[
                  s.tileValue,
                  t.alert && { color: colors.danger },
                  t.tone === 'good' && !t.alert && { color: colors.success },
                ]}>
                  {t.value == null ? '—' : t.value}
                </Text>
                <Text style={s.tileLabel} numberOfLines={2}>{t.label}</Text>
              </View>
            ))}
          </View>

          {/* "—" is load-bearing: it appears when the server could not
              determine a figure, and saying so beats printing a confident 0. */}
          {tiles.some((t) => t.value == null) && (
            <Text style={s.footnote}>
              “—” means this space has no shift configured, so nobody can be counted late.
            </Text>
          )}

          {/* Live runs (design screen 6's "Live Buses" list). */}
          {sum.runs.length > 0 && (
            <View style={s.card}>
              <View style={s.rowBetween}>
                <Text style={s.cardTitle}>{isSchool ? 'Live Buses' : 'Live Runs'}</Text>
                <TouchableOpacity onPress={() => go('/space-ops-map')}>
                  <Text style={s.link}>Map</Text>
                </TouchableOpacity>
              </View>
              {sum.runs.map((r) => (
                <TouchableOpacity
                  key={r.id}
                  style={s.runRow}
                  onPress={() => router.push({ pathname: '/space-run' as any, params: { spaceId, runId: r.id } })}
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

          {/* Shortcuts to the screens these numbers come from. */}
          <View style={s.card}>
            {([
              ['Runs', 'bus-outline', '/space-runs-admin'],
              ['Roster', 'people-outline', '/space-roster'],
              ['Attendance', 'calendar-number-outline', '/space-checkin'],
              ['Incidents', 'alert-circle-outline', '/space-incidents'],
              ['Visitors', 'qr-code-outline', '/space-visitors'],
            ] as const).map(([label, icon, path]) => (
              <TouchableOpacity key={label} style={s.linkRow} onPress={() => go(path)}>
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
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  sos: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.danger, borderRadius: 12, padding: 14,
  },
  sosText: { color: '#fff', fontWeight: '700', flex: 1 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    backgroundColor: c.card, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 13,
    minWidth: 104, flexGrow: 1, flexBasis: '30%', borderWidth: 1, borderColor: 'transparent',
  },
  tileValue: { color: c.text, fontSize: 23, fontWeight: '800' },
  tileLabel: { color: c.textDim, fontSize: 11.5, marginTop: 2 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 14, gap: 6 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: c.primary, fontSize: 12.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  runName: { color: c.text, flex: 1, fontSize: 14.5 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  linkRowText: { color: c.text, flex: 1, fontSize: 14.5 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});
