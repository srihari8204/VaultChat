// components/family/MapBars.tsx — the floating bars of the family live map,
// moved out of app/family-map.tsx unchanged: trip, leave-now, follow (top
// slots), the routed member's next turn and the active-route bar (bottom
// slots), plus the text action they all share. The screen decides which are
// shown and where (its slot model); these only draw.

import React from 'react';
import { View, TouchableOpacity, StyleSheet, type TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { iconFor } from '../nav/NavBanner';
import { formatMetres } from '../../lib/family/distance';
import { formatLeaveIn, type LeavePlan } from '../../lib/family/leaveNow';
import { type NextTurn } from '../../lib/nav/routing';

/**
 * A text action on an overlay bar (END, CLEAR, NAVIGATE, Route…). These were
 * bare <Text onPress> at 11–12 px: no role for a screen reader and a target
 * the height of one line. Same look; a real button with a ≥44 dp hit area.
 */
export function BarAction({ label, a11y, onPress, style }: {
  label: string; a11y?: string; onPress: () => void; style: TextStyle;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
    >
      <Text style={style}>{label}</Text>
    </TouchableOpacity>
  );
}

/** FAMILY TRIP BAR: whose trip, where to, when everyone is in — and the way out of it. */
export function TripBar({ top, destinationName, startedBy, etaMin, action, actionA11y, danger, onAction }: {
  top: number;
  destinationName: string;
  /** "you" or the starter's name. */
  startedBy: string;
  /** Minutes until everyone is in, when known. */
  etaMin: number | null;
  action: 'END' | 'LEAVE' | 'JOIN';
  actionA11y: string;
  /** END and LEAVE read as the way out. */
  danger: boolean;
  onAction: () => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.tripBar, { top, backgroundColor: G.sheet, borderColor: colors.primary }]}>
      <Ionicons name="car" size={16} color={colors.primary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }} numberOfLines={1}>
          Trip to {destinationName}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 11 }} numberOfLines={1}>
          started by {startedBy}
          {etaMin != null ? ` · all in by ~${etaMin} min` : ''}
        </Text>
      </View>
      <BarAction onPress={onAction} label={action} a11y={actionA11y}
        style={{ color: danger ? G.dangerText : G.accentText, fontWeight: '800', fontSize: 12 }} />
    </View>
  );
}

/**
 * LEAVE NOW. Only offered once a road duration exists — without one there is
 * no honest leave time, and this refuses to invent one (leaveNow.leavePlan
 * returns null and the picker shows instead).
 */
export function LeaveBar({ top, leave, arriveBy, choices, onArriveBy }: {
  top: number;
  leave: LeavePlan | null;
  arriveBy: number | null;
  /** Round arrival times to offer: one tap, no picker. */
  choices: number[];
  onArriveBy: (t: number | null) => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <View style={[st.leaveBar, { top, backgroundColor: G.sheet, borderColor: leave?.warn ? colors.danger : G.edge }]}>
      <Ionicons name="alarm-outline" size={15} color={leave?.warn ? colors.danger : colors.primary} />
      {leave ? (
        <>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 11.5, flex: 1 }} numberOfLines={1}>
            {leave.late ? 'Running late' : `Leave ${formatLeaveIn(leave.inMs)}`}
            <Text style={{ color: colors.textDim, fontWeight: '400' }}>
              {'  ·  arrive '}{arriveBy != null ? clock(arriveBy) : ''}
            </Text>
          </Text>
          <BarAction onPress={() => onArriveBy(null)} label="CLEAR" a11y="Clear the arrive-by time"
            style={{ color: G.accentText, fontWeight: '800', fontSize: 11 }} />
        </>
      ) : (
        <>
          <Text style={{ color: colors.textDim, fontSize: 11.5 }}>Arrive by</Text>
          {choices.map((t) => {
            const hhmm = clock(t);
            return (
              <BarAction key={t} onPress={() => onArriveBy(t)} label={hhmm} a11y={`Arrive by ${hhmm}`}
                style={{ color: G.accentText, fontWeight: '800', fontSize: 11.5, paddingHorizontal: 7 }} />
            );
          })}
        </>
      )}
    </View>
  );
}

/** Following banner (spec: "Following X" + "Stop following") — the way OUT of a follow. */
export function FollowBar({ top, name, onStop }: { top: number; name: string; onStop: () => void }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.followBar, { top, backgroundColor: G.sheet, borderColor: colors.primary }]}>
      <Ionicons name="navigate-circle" size={16} color={colors.primary} />
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
        Following {name}
      </Text>
      <BarAction onPress={onStop} label="STOP" a11y="Stop following"
        style={{ color: G.accentText, fontWeight: '800', fontSize: 12.5 }} />
    </View>
  );
}

/** NEXT TURN of the routed member — the watcher's indicator. */
export function TurnBar({ bottom, name, turn }: { bottom: number; name: string; turn: NextTurn }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.turnBar, { bottom, backgroundColor: G.sheet, borderColor: G.edge }]}
      accessible accessibilityLabel={`${name}: ${turn.instruction || turn.event} in ${formatMetres(turn.distM)}`}>
      <Ionicons name={iconFor(turn.event)} size={16} color={colors.primary} />
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12, flex: 1 }} numberOfLines={1}>
        {name} · {turn.instruction || turn.event}
      </Text>
      <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 12, fontVariant: ['tabular-nums'] }}>
        {formatMetres(turn.distM)}
      </Text>
    </View>
  );
}

/** The active road route: whose it is, what it costs BY ROAD, and its actions. */
export function RouteBar({ bottom, label, children }: { bottom: number; label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.routeBar, { bottom, backgroundColor: G.sheet, borderColor: colors.primary }]}>
      <Ionicons name="navigate-circle" size={16} color={colors.primary} />
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>{label}</Text>
      {children}
    </View>
  );
}

const st = StyleSheet.create({
  routeBar: {
    position: 'absolute', left: 12, right: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 32, elevation: 3,
  },
  followBar: {
    position: 'absolute', left: 12, right: 12, top: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 6,
  },
  // Sits UNDER the search bar — the trip is context, the search stays a search.
  tripBar: {
    position: 'absolute', left: 12, right: 12, top: 64,
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 5, elevation: 4,
  },
  // Between the trip bar and the map: the leave-now countdown / arrive-by picker.
  leaveBar: {
    position: 'absolute', left: 12, right: 12, top: 122,
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1, borderRadius: 11, paddingHorizontal: 11, minHeight: 32, elevation: 3,
  },
  // Rides just above the route bar: the routed member's next left/right.
  turnBar: {
    position: 'absolute', left: 12, right: 12, bottom: 58,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, minHeight: 36, elevation: 3,
  },
});
