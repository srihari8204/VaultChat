// components/family/HubDistancePanel.tsx — the Family hub's distance block,
// moved out of app/family.tsx: the FAMILY DISTANCE summary (spec §11), the
// "Distance from" origin chips (§34–39) and the roster sort chips (§9). The
// numbers come from the hub's useHubDistances; this file only draws them.

import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { brandAlpha } from '../../constants/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { formatMetres, summaryBasis, type SortMode, type FamilySummary } from '../../lib/family/distance';
import { type Geofence } from '../../lib/family/geofence';
import { st } from './hubStyles';

const SORTS = [['nearest', 'Nearest'], ['farthest', 'Farthest'], ['alpha', 'A–Z'], ['recent', 'Recent']] as const;

/** One single-choice chip: a radio with a ≥44 dp target (7 dp vertical slop on a 30 dp chip). */
function Choice({ on, label, a11y, onPress }: { on: boolean; label: string; a11y?: string; onPress: () => void }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, selected: on }}
      accessibilityLabel={a11y ?? label}
      hitSlop={{ top: 7, bottom: 7 }}
      style={[st.sortChip, {
        borderColor: on ? colors.primary : G.chipEdge,
        backgroundColor: on ? brandAlpha(0.14) : G.paneFaint,
      }]}
    >
      <Text style={{ color: on ? G.accentText : colors.textDim, fontSize: 12, fontWeight: on ? '800' : '600' }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function HubDistancePanel({
  summary, originName, onOrigin, places, showOrigins, showSort, sortMode, onSort,
}: {
  summary: FamilySummary;
  originName: string | null;
  onOrigin: (name: string | null) => void;
  places: Geofence[];
  /** There is a place to pick and someone to measure. */
  showOrigins: boolean;
  /** Enough members that ordering means something. */
  showSort: boolean;
  sortMode: SortMode;
  onSort: (m: SortMode) => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <>
      {/* FAMILY DISTANCE (spec §11). Only once there is something to
          compare — a one-person circle has no nearest and no average, and
          printing "Nearest: —" would be noise, not information. */}
      {summary.available > 0 && (
        <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
          <View style={st.distRow}>
            <View style={st.distCell}>
              <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                {formatMetres(summary.nearest!.fromMe!)}
              </Text>
              <Text style={[st.distLbl, { color: colors.textDim }]} numberOfLines={1}>
                Nearest · {summary.nearest!.name}
              </Text>
            </View>
            <View style={[st.distDiv, { backgroundColor: G.line }]} />
            <View style={st.distCell}>
              <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                {formatMetres(summary.farthest!.fromMe!)}
              </Text>
              <Text style={[st.distLbl, { color: colors.textDim }]} numberOfLines={1}>
                Farthest · {summary.farthest!.name}
              </Text>
            </View>
            <View style={[st.distDiv, { backgroundColor: G.line }]} />
            <View style={st.distCell}>
              <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                {formatMetres(summary.averageM!)}
              </Text>
              <Text style={[st.distLbl, { color: colors.textDim }]}>Average</Text>
            </View>
          </View>
          {/* "9 / 10 available" is a statement about the CIRCLE, so the
              total counts everyone — including the members we could not
              measure and who are therefore absent from the figures above. */}
          <Text style={{ color: colors.textDim, fontSize: 11.5, textAlign: 'center', marginTop: 8 }}>
            {/* Names the ORIGIN and the KIND of distance, always: the figures
                turn from straight-line into road ones as the router answers.
                A distance with no stated origin is the easiest number on this
                screen to misread. */}
            {summaryBasis(summary)} from {originName ?? 'you'} · {summary.available} of{' '}
            {summary.total - (originName ? 0 : 1)} members located
          </Text>
        </View>
      )}

      {/* DISTANCE FROM (spec §34–39). "Near Me" is the default; picking a
          saved place re-measures EVERY member against it, which is the
          "how far is everyone from Home" question. Only appears once
          there is a place to pick, so a circle with none is unchanged. */}
      {showOrigins && (
        <View style={st.sortRow} accessibilityRole="radiogroup" accessibilityLabel="Measure distances from">
          <Choice on={!originName} label="Near me" onPress={() => onOrigin(null)} />
          {places.map((p) => {
            const on = originName === p.name;
            return (
              <Choice key={p.id} on={on} label={`Near ${p.name}`} a11y={`Measure everyone from ${p.name}`}
                onPress={() => onOrigin(on ? null : p.name)} />
            );
          })}
        </View>
      )}

      {/* sort (spec §9) */}
      {showSort && (
        <View style={st.sortRow} accessibilityRole="radiogroup" accessibilityLabel="Order members by">
          {SORTS.map(([mode, label]) => (
            <Choice key={mode} on={sortMode === mode} label={label} onPress={() => onSort(mode)} />
          ))}
        </View>
      )}
    </>
  );
}
