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
import { BIZ_WARN, BIZ_TEAL, BIZ_GRAY } from '../constants/businessTheme';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import { getOpsSummary, type OpsSummary } from '../lib/spaces/api';
import Donut from '../components/spaces/Donut';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui';
import LoadError from '../components/spaces/LoadError';
import { familyOf } from '../lib/spaces/layout';

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
  const { scheme } = useTheme();
  const warningTint = scheme === 'light' ? colors.warning : BIZ_WARN;
  const visitorTint = scheme === 'light' ? colors.success : BIZ_TEAL;

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

  const w = sum?.workforce;
  const checkedOut = w ? Math.max(0, w.checkedIn - w.stillIn) : 0;
  const noCheckIn = w ? Math.max(0, w.members - w.checkedIn - w.onLeave) : 0;
  const attendancePct = w && w.members > 0 ? Math.round((w.checkedIn / w.members) * 1000) / 10 : 0;
  const tasksTotal = sum?.tasks ? sum.tasks.open + sum.tasks.overdue + sum.tasks.doneToday : 0;

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
            /* ── Business Dashboard (reference design) ── */
            w && (
              <>
                {/* Top metric cards. */}
                <View style={s.metrics}>
                  <Metric s={s} icon="people" tint={colors.primary} value={dash(w.members)} label="Total People" />
                  <Metric s={s} icon="pulse" tint={colors.success} value={dash(w.stillIn)} label="Active Now" />
                  <Metric s={s} icon="log-in" tint={colors.purple} value={dash(w.checkedIn)} label="Checked In" />
                  <Metric s={s} icon="airplane" tint={warningTint} value={dash(w.onLeave)} label="On Leave" />
                  <Metric
                    s={s} icon="time" tint={(w.lateToday ?? 0) > 0 ? colors.danger : BIZ_GRAY}
                    value={dash(w.lateToday)} label="Late Today"
                  />
                  <Metric
                    s={s} icon="hourglass" tint={w.leavePending > 0 ? warningTint : BIZ_GRAY}
                    value={dash(w.leavePending)} label="Leave Requests"
                  />
                  <Metric s={s} icon="qr-code" tint={visitorTint} value={dash(sum.open.visitors)} label="Visitors On Site" />
                </View>
                {w.lateToday == null && (
                  <Text style={s.footnote}>
                    “—” means this space has no shift configured, so nobody can be counted late.
                  </Text>
                )}

                {/* EMPLOYEE MONITORING — the workforce donut. Every figure is a
                    server count of DECLARED check-ins; nobody is called
                    "offline" on the strength of silence. */}
                <View style={s.card}>
                  <Text style={s.sectionTitle}>EMPLOYEE MONITORING</Text>
                  <Text style={s.muted}>Today, from declared check-ins</Text>
                  <View style={s.monitorRow}>
                    <Donut
                      accessibilityLabel={`${w.members} people: ${w.stillIn} active now, ${checkedOut} checked out, ${w.onLeave} on leave, ${noCheckIn} no check-in`}
                      centre={dash(w.members)}
                      label={'Total\nPeople'}
                      textColor={colors.text}
                      labelColor={colors.textDim}
                      track={colors.border}
                      segments={[
                        { value: w.stillIn, color: colors.success },
                        { value: checkedOut, color: colors.primary },
                        { value: w.onLeave, color: warningTint },
                        { value: noCheckIn, color: BIZ_GRAY },
                      ]}
                    />
                    <View style={{ flex: 1, gap: 8 }}>
                      <Legend s={s} color={colors.success} label="Active now" value={w.stillIn} />
                      <Legend s={s} color={colors.primary} label="Checked out" value={checkedOut} />
                      <Legend s={s} color={warningTint} label="On leave" value={w.onLeave} />
                      <Legend s={s} color={BIZ_GRAY} label="No check-in" value={noCheckIn} />
                    </View>
                  </View>
                  {/* Same gate as the People quick action below. */}
                  {perms.has('view_space_ops') && (
                    <TouchableOpacity accessibilityRole="button" style={s.viewRow} onPress={() => go('/space-people')}>
                      <Text style={s.link}>View All Employees</Text>
                      <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  )}
                </View>

                {/* ATTENDANCE TODAY */}
                <View style={s.card}>
                  <Text style={s.sectionTitle}>ATTENDANCE TODAY</Text>
                  {/* One element with a value, not three fragments. */}
                  <View
                    accessible accessibilityRole="progressbar"
                    accessibilityLabel={`${w.checkedIn} of ${w.members} checked in`}
                    accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(attendancePct)), text: `${attendancePct}%` }}
                    style={{ gap: 8 }}
                  >
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                    <Text style={s.bigValue}>{w.checkedIn}</Text>
                    <Text style={[s.muted, { marginBottom: 6 }]}>/ {w.members} checked in</Text>
                  </View>
                  <View style={s.barTrack}>
                    <View style={[s.barFill, { width: `${Math.min(100, attendancePct)}%` }]} />
                  </View>
                  <Text style={s.muted}>{attendancePct}%</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" style={s.viewRow} onPress={() => go('/space-checkin')}>
                    <Text style={s.link}>View check-ins</Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                  </TouchableOpacity>
                </View>

                {/* TASKS SUMMARY — only when the server sends the breakdown
                    (migration 102); open.tasks alone cannot honestly fill a
                    three-way split. */}
                {sum.tasks && (
                  <View style={s.card}>
                    <Text style={s.sectionTitle}>TASKS SUMMARY</Text>
                    <View style={s.monitorRow}>
                      <Donut
                        accessibilityLabel={`${tasksTotal} tasks: ${sum.tasks.open} to do, ${sum.tasks.overdue} overdue, ${sum.tasks.doneToday} done today`}
                        size={104} stroke={12}
                        centre={String(tasksTotal)}
                        label="Tasks"
                        textColor={colors.text}
                        labelColor={colors.textDim}
                        track={colors.border}
                        segments={[
                          { value: sum.tasks.open, color: colors.primary },
                          { value: sum.tasks.overdue, color: colors.danger },
                          { value: sum.tasks.doneToday, color: colors.success },
                        ]}
                      />
                      <View style={{ flex: 1, gap: 8 }}>
                        <Legend s={s} color={colors.primary} label="To do" value={sum.tasks.open} />
                        <Legend s={s} color={colors.danger} label="Overdue" value={sum.tasks.overdue} />
                        <Legend s={s} color={colors.success} label="Done today" value={sum.tasks.doneToday} />
                      </View>
                    </View>
                    <TouchableOpacity accessibilityRole="button" style={s.viewRow} onPress={() => go('/space-tasks')}>
                      <Text style={s.link}>View Tasks</Text>
                      <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  </View>
                )}

                {/* Against a server without migration 102 the breakdown is
                    absent; the open count (089) still exists and must not
                    vanish from the dashboard. */}
                {!sum.tasks && (
                  <View style={s.card}>
                    <Text style={s.sectionTitle}>TASKS</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                      <Text style={s.bigValue}>{sum.open.tasks}</Text>
                      <Text style={[s.muted, { marginBottom: 6 }]}>open</Text>
                    </View>
                    <TouchableOpacity accessibilityRole="button" style={s.viewRow} onPress={() => go('/space-tasks')}>
                      <Text style={s.link}>View Tasks</Text>
                      <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  </View>
                )}

                {/* LEAVE SUMMARY — this month */}
                {sum.leaveMonth && (
                  <View style={s.card}>
                    <Text style={s.sectionTitle}>LEAVE SUMMARY</Text>
                    <Text style={s.muted}>This month</Text>
                    <View style={s.chips}>
                      <Chip s={s} tint={colors.primary} value={sum.leaveMonth.requests} label="Requests" />
                      <Chip s={s} tint={warningTint} value={sum.leaveMonth.pending} label="Pending" />
                      <Chip s={s} tint={colors.success} value={sum.leaveMonth.approved} label="Approved" />
                      <Chip s={s} tint={colors.danger} value={sum.leaveMonth.declined} label="Declined" />
                    </View>
                    <TouchableOpacity accessibilityRole="button" style={s.viewRow} onPress={() => go('/space-leave')}>
                      <Text style={s.link}>View Leave</Text>
                      <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  </View>
                )}
              </>
            )
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

          {!isSchool && (
            <>
              {/* LIVE LOCATIONS — a door, not an embedded map. Positions are
                  end-to-end encrypted and are only ever decrypted on the map
                  screen; a preview here would mean holding them somewhere the
                  design promised they never sit. */}
              <View style={s.card}>
                <View style={s.rowBetween}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons name="location" size={18} color={BIZ_TEAL} />
                    <Text style={s.cardTitle}>Live Locations</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" onPress={() => go('/space-ops-map')} style={s.linkHit}>
                    <Text style={s.link}>View Full Map</Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.muted}>
                  Positions stay end-to-end encrypted and appear only on the map, only for
                  people your organisation authorises.
                </Text>
              </View>

              {/* QUICK ACTIONS */}
              <View style={s.card}>
                <Text style={s.sectionTitle}>QUICK ACTIONS</Text>
                <View style={s.actions}>
                  <Action s={s} icon="log-in" tint={colors.success} label="Check In" onPress={() => go('/space-checkin')} />
                  <Action s={s} icon="calendar" tint={warningTint} label="Request Leave" onPress={() => go('/space-leave')} />
                  {/* Creating a task is the assign right (space-tasks canAssign). */}
                  {perms.has('view_space_ops') && (
                    <Action s={s} icon="clipboard" tint={colors.primary} label="Create Task" onPress={() => go('/space-tasks')} />
                  )}
                  {perms.has('view_space_ops') && (
                    <Action s={s} icon="people" tint={colors.purple} label="People" onPress={() => go('/space-people')} />
                  )}
                </View>
              </View>
            </>
          )}

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

/* ── Business dashboard pieces ─────────────────────────────────────── */

// The pieces take the screen's memoised styles rather than rebuilding them
// per render.
type Styles = ReturnType<typeof styles>;

function Metric({ s, icon, tint, value, label }: {
  s: Styles; icon: keyof typeof Ionicons.glyphMap; tint: string; value: string; label: string;
}) {
  return (
    // One element for a screen reader: "Total People, 42", not two fragments.
    <View
      style={[s.metric, { backgroundColor: tint + '14', borderColor: tint + '33' }]}
      accessible accessibilityLabel={`${label}, ${value === '—' ? 'not known' : value}`}
    >
      <View style={[s.metricIcon, { backgroundColor: tint + '26' }]}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <Text style={s.metricValue}>{value}</Text>
      <Text style={s.metricLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function Legend({ s, color, label, value }: { s: Styles; color: string; label: string; value: number }) {
  return (
    <View style={s.legendRow} accessible accessibilityLabel={`${label}, ${value}`}>
      <View style={[s.legendDot, { backgroundColor: color }]} />
      <Text style={s.legendLabel} numberOfLines={1}>{label}</Text>
      <Text style={s.legendValue}>{value}</Text>
    </View>
  );
}

function Chip({ s, tint, value, label }: { s: Styles; tint: string; value: number; label: string }) {
  return (
    <View style={[s.chip, { backgroundColor: tint + '14' }]} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={[s.chipValue, { color: tint }]}>{value}</Text>
      <Text style={s.chipLabel}>{label}</Text>
    </View>
  );
}

function Action({ s, icon, tint, label, onPress }: {
  s: Styles; icon: keyof typeof Ionicons.glyphMap; tint: string; label: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity accessibilityRole="button" style={[s.action, { backgroundColor: tint + '1C', borderColor: tint + '40' }]} onPress={onPress}>
      <Ionicons name={icon} size={20} color={tint} />
      <Text style={s.actionLabel}>{label}</Text>
    </TouchableOpacity>
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
  sectionTitle: { color: c.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: c.primary, fontSize: 12.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, minHeight: 44 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  runName: { color: c.text, flex: 1, fontSize: 14.5 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, minHeight: 44 },
  linkRowText: { color: c.text, flex: 1, fontSize: 14.5 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 4 },

  // business
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: {
    flexGrow: 1, flexBasis: '30%', borderRadius: 16, borderWidth: 1,
    padding: 12, gap: 6,
  },
  metricIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  metricValue: { color: c.text, fontSize: 24, fontWeight: '800' },
  metricLabel: { color: c.textDim, fontSize: 11.5 },
  monitorRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { color: c.textDim, fontSize: 12.5, flex: 1 },
  legendValue: { color: c.text, fontSize: 13, fontWeight: '800' },
  viewRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end', minHeight: 44 },
  linkHit: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  bigValue: { color: c.text, fontSize: 32, fontWeight: '800' },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: c.border, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: c.success },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center', gap: 2 },
  chipValue: { fontSize: 20, fontWeight: '800' },
  chipLabel: { color: c.textDim, fontSize: 11 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: {
    flexGrow: 1, flexBasis: '47%', borderRadius: 14, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingHorizontal: 14,
  },
  actionLabel: { color: c.text, fontSize: 13.5, fontWeight: '700' },
});
