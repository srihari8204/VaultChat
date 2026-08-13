// app/space-attendance.tsx — who is in today, and the week behind it
// (Spaces & Operations, S4.2 / S4.5).
//
// EVERYTHING ON THIS SCREEN IS COMPUTED HERE, ON THIS DEVICE, from position
// samples it already holds for the people it already shares location with.
// Nothing is fetched from an attendance endpoint because there is no attendance
// endpoint, and nothing is uploaded — not the states, not the totals, not the
// weekly summary.
//
// WHAT THAT MEANS FOR HONESTY. This device only holds samples for the times it
// was actually receiving them. A gap in the samples is a gap in what we know,
// and it renders as "No data" rather than as an absence. The distinction is the
// whole point: an attendance screen that reports a flat battery as a no-show
// gets switched off within a week, and deserves to be.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { getTrack } from '../lib/family/history';
import { getPlaces } from '../lib/family/store';
import { circleMembers } from '../lib/family/circle';
import { attendanceTiles } from '../lib/spaces/dashboard';
import {
  crossingsFromSamples, crossingsForDay, projectDay, summarise, makeShift,
  STATE_LABELS, type AttendanceState, type DayAttendance,
} from '../lib/spaces/attendance';

/** How many days back the weekly view folds. */
const DAYS = 7;

interface Row {
  userId: string;
  name: string;
  today: DayAttendance;
  week: DayAttendance[];
}

export default function SpaceAttendanceScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    spaceId?: string; name?: string;
    shiftStart?: string; shiftEnd?: string; shiftGrace?: string;
  }>();
  const spaceId = String(params.spaceId || '');

  const [rows, setRows] = useState<Row[]>([]);
  const [zoneName, setZoneName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const shift = useMemo(
    () => makeShift(
      params.shiftStart ? String(params.shiftStart) : null,
      params.shiftEnd ? String(params.shiftEnd) : null,
      params.shiftGrace ? Number(params.shiftGrace) : 10,
    ),
    [params.shiftStart, params.shiftEnd, params.shiftGrace],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [places, members] = await Promise.all([
        getPlaces(spaceId).catch(() => []),
        circleMembers(spaceId).catch(() => []),
      ]);
      // The workplace is the space's first safe zone. A space with none has no
      // attendance to report, which the empty state says outright rather than
      // showing everyone as absent.
      const zone = places[0];
      setZoneName(zone?.name ?? null);
      if (!zone) { setRows([]); return; }

      const from = Date.now() - DAYS * 24 * 3600_000;
      const built: Row[] = [];
      for (const m of members) {
        const samples = await getTrack(spaceId, { from, userId: m.id }).catch(() => []);
        const crossings = crossingsFromSamples(
          samples.map((s) => ({ lat: s.lat, lng: s.lng, ts: s.ts })),
          { lat: zone.center.lat, lng: zone.center.lng, radiusM: zone.radiusM },
        );
        const week: DayAttendance[] = [];
        for (let d = DAYS - 1; d >= 0; d--) {
          const dayMs = Date.now() - d * 24 * 3600_000;
          week.push(projectDay(crossingsForDay(crossings, dayMs), shift, Math.min(Date.now(), endOfDay(dayMs))));
        }
        built.push({
          userId: m.id,
          name: m.name,
          today: week[week.length - 1],
          week,
        });
      }
      setRows(built);
    } finally {
      setLoading(false);
    }
  }, [spaceId, shift]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const tiles = useMemo(
    () => attendanceTiles(rows.map((r) => r.today.state)),
    [rows],
  );
  const weekTotals = useMemo(
    () => summarise(rows.flatMap((r) => r.week)),
    [rows],
  );

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
        <Stack.Screen options={{ title: 'Attendance' }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Stack.Screen options={{ title: params.name ? `${params.name} · Attendance` : 'Attendance' }} />

      {!zoneName && (
        <View style={s.card}>
          <Text style={s.cardTitle}>No workplace set</Text>
          <Text style={s.muted}>
            Attendance is read from a safe zone. Add one for the workplace and arrivals
            and departures start being recognised — there is nothing else to switch on.
          </Text>
        </View>
      )}

      {!!zoneName && !shift && (
        <View style={s.card}>
          <Text style={s.cardTitle}>No shift set</Text>
          <Text style={s.muted}>
            Times are shown, but nobody is marked late or absent without a shift to
            compare against. Set one in the space’s settings.
          </Text>
        </View>
      )}

      {!!zoneName && (
        <>
          <View style={s.tiles}>
            {tiles.map((t) => (
              <View key={t.key} style={s.tile}>
                <Text style={s.tileValue}>{t.value}</Text>
                <Text style={s.tileLabel}>{t.label}</Text>
              </View>
            ))}
          </View>

          {rows.map((r) => (
            <TouchableOpacity
              key={r.userId}
              style={s.card}
              onPress={() => setExpanded(expanded === r.userId ? null : r.userId)}
            >
              <View style={s.row}>
                <View style={[s.badge, { backgroundColor: stateColour(r.today.state, colors) + '22' }]}>
                  <Ionicons name={stateIcon(r.today.state)} size={16} color={stateColour(r.today.state, colors)} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.name} numberOfLines={1}>{r.name}</Text>
                  <Text style={s.muted}>
                    {STATE_LABELS[r.today.state]}
                    {r.today.firstIn ? ` · in ${clock(r.today.firstIn)}` : ''}
                    {r.today.lastOut ? ` · out ${clock(r.today.lastOut)}` : ''}
                    {r.today.lateBy > 0 ? ` · ${r.today.lateBy} min late` : ''}
                  </Text>
                </View>
                <Ionicons name={expanded === r.userId ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textDim} />
              </View>

              {expanded === r.userId && (
                <View style={s.week}>
                  {r.week.map((d, i) => (
                    <View key={i} style={s.weekCell}>
                      <View style={[s.weekDot, { backgroundColor: stateColour(d.state, colors) }]} />
                      <Text style={s.weekLabel}>{dayLabel(DAYS - 1 - i)}</Text>
                    </View>
                  ))}
                  <Text style={s.footnote}>
                    {Math.round(r.week.reduce((n, d) => n + d.minutesInside, 0) / 60)} hours on site
                    over {DAYS} days, from the position updates this device received.
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          ))}

          <View style={s.card}>
            <Text style={s.cardTitle}>Last {DAYS} days</Text>
            <Text style={s.muted}>
              {weekTotals.present + weekTotals.late} days attended · {weekTotals.late} late ·{' '}
              {weekTotals.leftEarly} left early · {weekTotals.absent} absent
            </Text>
            {weekTotals.unknown > 0 && (
              <Text style={s.footnote}>
                {weekTotals.unknown} {weekTotals.unknown === 1 ? 'day has' : 'days have'} no data —
                a phone that was off or not sharing produces no record, and that is not counted
                against anyone.
              </Text>
            )}
            <Text style={s.footnote}>
              Computed on this device and not uploaded. It reflects only the position
              updates this device received, so it is a view, not a payroll record.
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const endOfDay = (ms: number) => { const d = new Date(ms); d.setHours(23, 59, 59, 0); return d.getTime(); };
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function dayLabel(daysAgo: number): string {
  if (daysAgo === 0) return 'Today';
  const d = new Date(Date.now() - daysAgo * 24 * 3600_000);
  return d.toLocaleDateString([], { weekday: 'short' });
}

function stateIcon(s: AttendanceState): any {
  switch (s) {
    case 'present': return 'checkmark-circle';
    case 'late': return 'time';
    case 'left_early': return 'exit';
    case 'absent': return 'close-circle';
    default: return 'help-circle-outline';
  }
}

/** "No data" is grey, never red: it is a gap in knowledge, not a verdict. */
function stateColour(s: AttendanceState, c: Palette): string {
  switch (s) {
    case 'present': return c.success;
    case 'late': return '#F59E0B';
    case 'left_early': return '#F59E0B';
    case 'absent': return c.danger;
    default: return c.textFaint;
  }
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 13, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  name: { color: c.text, fontSize: 15.5, fontWeight: '600' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    backgroundColor: c.card, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    minWidth: 92, flexGrow: 1,
  },
  tileValue: { color: c.text, fontSize: 22, fontWeight: '700' },
  tileLabel: { color: c.textDim, fontSize: 11.5 },
  week: { marginTop: 10, gap: 8 },
  weekCell: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  weekDot: { width: 10, height: 10, borderRadius: 5 },
  weekLabel: { color: c.textDim, fontSize: 12.5 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
});
