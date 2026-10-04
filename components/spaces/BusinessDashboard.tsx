// components/spaces/BusinessDashboard.tsx — the office/business half of
// app/space-overview.tsx (the Business Dashboard reference design), split out
// of the screen unchanged.
//
// Like the screen, it holds no aggregation: every figure arrives computed from
// space_ops_summary(). The only arithmetic here is the presentation split of
// the server's workforce counts into the donut's four parts.
//
// Two pieces, because the screen interleaves them with the shared Live Runs
// card: BusinessDashboard (metrics, donut, attendance, tasks, leave) above it,
// BusinessDoors (live-locations door and quick actions) below it.

import React, { useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import Donut from './Donut';
import { useTheme } from '../../lib/theme';
import { BIZ_WARN, BIZ_TEAL, BIZ_GRAY } from '../../constants/businessTheme';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';
import type { OpsSummary } from '../../lib/spaces/api';

const dash = (v: number | null | undefined) => (v == null ? '—' : String(v));

/** The Business identity's warning and visitor tints are tuned for its dark
 *  ground; in light mode the scheme's own AA tokens are used instead. */
function useBizTints(colors: Palette) {
  const { scheme } = useTheme();
  return {
    warningTint: scheme === 'light' ? colors.warning : BIZ_WARN,
    visitorTint: scheme === 'light' ? colors.success : BIZ_TEAL,
  };
}

interface Props {
  sum: OpsSummary;
  colors: Palette;
  /** The caller's permission keys. Presentation only: every screen behind
   *  these doors re-checks server-side. */
  perms: ReadonlySet<string>;
  go: (path: string) => void;
}

export function BusinessDashboard({ sum, colors, perms, go }: Props) {
  const s = useMemo(() => styles(colors), [colors]);
  const { warningTint, visitorTint } = useBizTints(colors);
  const w = sum.workforce;
  const checkedOut = Math.max(0, w.checkedIn - w.stillIn);
  const noCheckIn = Math.max(0, w.members - w.checkedIn - w.onLeave);
  const attendancePct = w.members > 0 ? Math.round((w.checkedIn / w.members) * 1000) / 10 : 0;
  const tasksTotal = sum.tasks ? sum.tasks.open + sum.tasks.overdue + sum.tasks.doneToday : 0;

  return (
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
          {/* One element: "3 open tasks", not "3" and "open". */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}
            accessible accessibilityLabel={`${sum.open.tasks} open ${sum.open.tasks === 1 ? 'task' : 'tasks'}`}>
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
  );
}

/** The live-locations door and the quick actions, drawn below Live Runs. */
export function BusinessDoors({ colors, perms, go }: Omit<Props, 'sum'>) {
  const s = useMemo(() => styles(colors), [colors]);
  const { warningTint } = useBizTints(colors);
  return (
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
  );
}

/* ── pieces ─────────────────────────────────────────────────────────── */

// The pieces take the memoised styles rather than rebuilding them per render.
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
  // Shared with the screen's own cards (app/space-overview.tsx), same values.
  card: { backgroundColor: c.glassSoft, borderRadius: 16, padding: 14, gap: 8, borderWidth: 1, borderColor: c.glassStroke },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  sectionTitle: { color: c.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: c.primary, fontSize: 12.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
  linkHit: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },

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
