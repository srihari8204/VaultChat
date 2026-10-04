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

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import { getTrack } from '../lib/family/history';
import { getPlaces } from '../lib/family/store';
import { circleMembers } from '../lib/family/circle';
import { attendanceTiles } from '../lib/spaces/dashboard';
import {
  crossingsFromSamples, crossingsForDay, projectDay, summarise, makeShift, pickWorkZone, liveZones,
  STATE_LABELS, type AttendanceState, type DayAttendance,
} from '../lib/spaces/attendance';
import type { Geofence } from '../lib/family/geofence';
import { AuroraBackground } from '../components/ui';
import LoadError from '../components/spaces/LoadError';
import { loadShift } from '../lib/spaces/shift';

/** How many days back the weekly view folds. */
const DAYS = 7;

/** This viewer's chosen attendance zone for a space. A per-device convenience:
 *  losing it only falls back to pickWorkZone's default. */
const zoneKey = (spaceId: string) => `vc_space_att_zone_${spaceId}`;

interface Row {
  userId: string;
  name: string;
  today: DayAttendance;
  week: DayAttendance[];
}

export default function SpaceAttendanceScreen() {
  const params = useLocalSearchParams<{
    spaceId?: string; name?: string; groupType?: string;
    shiftStart?: string; shiftEnd?: string; shiftGrace?: string;
  }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [rows, setRows] = useState<Row[]>([]);
  const [zoneName, setZoneName] = useState<string | null>(null);
  const [zones, setZones] = useState<Geofence[]>([]);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The shift actually applied: route params, else the server's (GET
  // /chats/{id}/shift), else — when the server cannot answer — the copy this
  // device last saw (lib/spaces/shift.ts loadShift).
  const [activeShift, setActiveShift] = useState<ReturnType<typeof makeShift>>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const shift = useMemo(
    () => makeShift(
      params.shiftStart ? String(params.shiftStart) : null,
      params.shiftEnd ? String(params.shiftEnd) : null,
      params.shiftGrace ? Number(params.shiftGrace) : 10,
    ),
    [params.shiftStart, params.shiftEnd, params.shiftGrace],
  );

  const load = useCallback(async (chosen?: string) => {
    try {
      const [places, members, saved, stored] = await Promise.all([
        getPlaces(spaceId),
        circleMembers(spaceId),
        shift ? Promise.resolve(null) : loadShift(spaceId).then((r) => r.shift),
        chosen !== undefined ? Promise.resolve(chosen) : AsyncStorage.getItem(zoneKey(spaceId)).catch(() => null),
      ]);
      const sh = shift ?? (saved ? makeShift(saved.shiftStart, saved.shiftEnd, saved.shiftGraceMinutes) : null);
      setActiveShift(sh);
      setLoadError(null);
      // The workplace zone: this viewer's pick, else one named like a workplace,
      // else the first live zone (pickWorkZone). A space with none has no
      // attendance to report, which the empty state says outright rather than
      // showing everyone as absent.
      const zone = pickWorkZone(places, stored);
      setZones(liveZones(places));
      setZoneId(zone?.id ?? null);
      setZoneName(zone?.name ?? null);
      if (!zone) { setRows([]); return; }

      // ONE read of the space's track cache, grouped by member here: the old
      // per-member loop awaited one read per person, and caught each failure
      // to [] — which drew a member whose read failed as "No data". A failed
      // read now fails the screen, and says so.
      const from = Date.now() - DAYS * 24 * 3600_000;
      const samples = await getTrack(spaceId, { from });
      const byUser = new Map<string, typeof samples>();
      for (const smp of samples) {
        const list = byUser.get(smp.u);
        if (list) list.push(smp); else byUser.set(smp.u, [smp]);
      }
      const built: Row[] = members.map((m) => {
        const crossings = crossingsFromSamples(
          (byUser.get(m.id) ?? []).map((x) => ({ lat: x.lat, lng: x.lng, ts: x.ts })),
          { lat: zone.center.lat, lng: zone.center.lng, radiusM: zone.radiusM },
        );
        const week: DayAttendance[] = [];
        for (let d = DAYS - 1; d >= 0; d--) {
          const dayMs = Date.now() - d * 24 * 3600_000;
          week.push(projectDay(crossingsForDay(crossings, dayMs), sh, Math.min(Date.now(), endOfDay(dayMs))));
        }
        return { userId: m.id, name: m.name, today: week[week.length - 1], week };
      });
      setRows(built);
    } catch (e: any) {
      // Not "No workplace set": a failed read is not an absent zone.
      setLoadError(e?.message ?? 'Could not load attendance.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spaceId, shift]);

  const chooseZone = useCallback((id: string) => {
    if (id === zoneId) return;
    AsyncStorage.setItem(zoneKey(spaceId), id).catch(() => { /* convenience only */ });
    setRefreshing(true);
    void load(id);
  }, [zoneId, spaceId, load]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const tiles = useMemo(
    () => attendanceTiles(rows.map((r) => r.today.state)),
    [rows],
  );
  const weekTotals = useMemo(
    () => summarise(rows.flatMap((r) => r.week)),
    [rows],
  );

  const s = useMemo(() => styles(colors), [colors]);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Attendance')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <AuroraBackground />
    <ScrollView
      style={s.screen} contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
    >
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · Attendance` : 'Attendance', { id: spaceId, name: params.name })} />

      {loadError && <LoadError colors={colors} message={loadError} onRetry={() => { setRefreshing(true); void load(); }} />}
      {/* A failed refresh keeps the last rows below the error — and says so. */}
      {loadError && rows.length > 0 && (
        <Text style={s.footnote}>The list below is from the last successful load and may be out of date.</Text>
      )}

      {!loadError && !zoneName && (
        <View style={s.card}>
          <Text style={s.cardTitle}>No workplace set</Text>
          <Text style={s.muted}>
            Attendance is read from a safe zone. Add one for the workplace and arrivals
            and departures start being recognised — there is nothing else to switch on.
          </Text>
        </View>
      )}

      {/* Which zone counts as the workplace. Only drawn when there is a choice
          to make; the pick is remembered on this device. */}
      {!loadError && zones.length > 1 && (
        <View style={s.card} accessibilityRole="radiogroup" accessibilityLabel="Workplace zone">
          <Text style={s.cardTitle}>Workplace zone</Text>
          <View style={s.zoneChips}>
            {zones.map((z) => {
              const on = z.id === zoneId;
              return (
                <TouchableOpacity
                  key={z.id}
                  style={[s.zoneChip, on && s.zoneChipOn]}
                  onPress={() => chooseZone(z.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`Read attendance against ${z.name}`}
                >
                  <Text style={[s.zoneChipText, on && { color: colors.primary }]} numberOfLines={1}>{z.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {!!zoneName && !activeShift && (
        <View style={s.card}>
          <Text style={s.cardTitle}>No shift set</Text>
          <Text style={s.muted}>
            Times are shown, but nobody is marked late or absent without a shift to
            compare against. Set one under Admin → Shift and lateness.
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
            <View key={r.userId} style={s.card}>
              {/* The week sits OUTSIDE the touchable: inside it, the row's own
                  label would hide each day from a screen reader. */}
              <TouchableOpacity
                style={s.rowHit}
                onPress={() => setExpanded(expanded === r.userId ? null : r.userId)}
                accessibilityRole="button"
                accessibilityState={{ expanded: expanded === r.userId }}
                accessibilityLabel={`${r.name}, ${STATE_LABELS[r.today.state]} today`}
                accessibilityHint="Shows the last seven days"
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
              </TouchableOpacity>

              {expanded === r.userId && (
                <View style={s.week}>
                  {/* Each day says its state in words: the dot's colour alone
                      is unreadable to a screen reader and to colour-blind eyes. */}
                  {r.week.map((d, i) => (
                    <View
                      key={dayLabel(DAYS - 1 - i)} style={s.weekCell}
                      accessible accessibilityLabel={`${dayLabel(DAYS - 1 - i)}: ${STATE_LABELS[d.state]}`}
                    >
                      <View style={[s.weekDot, { backgroundColor: stateColour(d.state, colors) }]} />
                      <Text style={s.weekLabel}>{dayLabel(DAYS - 1 - i)} · {STATE_LABELS[d.state]}</Text>
                    </View>
                  ))}
                  <Text style={s.footnote}>
                    {Math.round(r.week.reduce((n, d) => n + d.minutesInside, 0) / 60)} hours on site
                    over {DAYS} days, from the position updates this device received.
                  </Text>
                </View>
              )}
            </View>
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
    </View>
  );
}

const endOfDay = (ms: number) => { const d = new Date(ms); d.setHours(23, 59, 59, 0); return d.getTime(); };
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function dayLabel(daysAgo: number): string {
  if (daysAgo === 0) return 'Today';
  const d = new Date(Date.now() - daysAgo * 24 * 3600_000);
  return d.toLocaleDateString([], { weekday: 'short' });
}

function stateIcon(s: AttendanceState): keyof typeof Ionicons.glyphMap {
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
    case 'late': return c.warning;
    case 'left_early': return c.warning;
    case 'absent': return c.danger;
    default: return c.textFaint;
  }
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 13, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowHit: { minHeight: 44, justifyContent: 'center' },
  badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  name: { color: c.text, fontSize: 15.5, fontWeight: '600' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    backgroundColor: c.glassSoft, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    minWidth: 92, flexGrow: 1,
  },
  tileValue: { color: c.text, fontSize: 22, fontWeight: '700' },
  tileLabel: { color: c.textDim, fontSize: 11.5 },
  week: { marginTop: 2, gap: 8 },
  weekCell: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  weekDot: { width: 10, height: 10, borderRadius: 5 },
  weekLabel: { color: c.textDim, fontSize: 12.5 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
  zoneChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  zoneChip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22,
    borderWidth: 1, borderColor: c.border, maxWidth: '100%',
  },
  zoneChipOn: { borderColor: c.primary, backgroundColor: c.primary + '18' },
  zoneChipText: { color: c.text, fontSize: 13.5, fontWeight: '600' },
});
