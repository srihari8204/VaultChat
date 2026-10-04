// components/nav/NavBanner.tsx — the Smart Mini Navigation Banner. A compact top
// strip (the spec's ~10%) that reads the live nav state and shows the direction
// icon, next maneuver, distance, a shrinking progress line, and ETA — so the
// driver rarely needs the full map. Renders nothing when navigation is inactive.

import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, AccessibilityInfo, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { useNavBanner } from '../../lib/nav/navigationService';
import { type HapticEvent } from '../../lib/nav/hapticLanguage';

const ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  left: 'arrow-back', slightLeft: 'arrow-back-outline',
  right: 'arrow-forward', slightRight: 'arrow-forward-outline',
  uturn: 'arrow-undo', roundabout: 'sync', destination: 'flag',
};
/** Exported: the family map's member turn indicator draws the same glyphs. */
export const iconFor = (e: HapticEvent | null) => (e && ICON[e]) || 'arrow-up';

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function fmtEta(epochMs: number): string {
  if (!epochMs) return '';
  try { return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

export default function NavBanner() {
  const { colors } = useTheme();
  const b = useNavBanner();
  const line = b.rerouting ? 'Rerouting…' : (b.instruction || (b.event === 'destination' ? 'Arriving' : 'Continue'));
  // Each new instruction is announced: Android through the live region below,
  // iOS (no live regions) through an explicit announcement. Keyed on the text,
  // so distance ticks do not repeat it.
  useEffect(() => {
    if (b.active && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(line);
  }, [b.active, line]);
  if (!b.active) return null;

  const dim = colors.text + '99';
  const remain = Math.max(4, Math.min(100, (1 - b.progress) * 100)); // line shrinks as we approach

  return (
    <View style={[styles.wrap, { backgroundColor: colors.glassSoft, borderBottomColor: colors.glassStroke }]}>
      <View style={styles.row}>
        <View style={[styles.iconBox, { backgroundColor: colors.primary + '22' }]}>
          <Ionicons name={iconFor(b.event)} size={26} color={colors.primary} />
        </View>
        <View style={styles.mid}>
          <Text numberOfLines={1} accessibilityLiveRegion="polite" style={[styles.instruction, { color: colors.text }]}>
            {line}
          </Text>
          {/* The trip's remaining distance lives in the screen's bottom sheet;
              repeating it here had it read twice. */}
          {!!b.roadName && (
            <Text numberOfLines={1} style={[styles.sub, { color: dim }]}>{b.roadName}</Text>
          )}
        </View>
        <View style={styles.right}>
          {b.rerouting
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Text style={[styles.dist, { color: colors.primary }]}>{fmtDist(b.distanceToManeuver)}</Text>}
          {!!b.etaEpochMs && <Text style={[styles.eta, { color: dim }]}>{fmtEta(b.etaEpochMs)}</Text>}
        </View>
      </View>
      {/* shrinking progress line toward the maneuver */}
      <View style={[styles.track, { backgroundColor: colors.border }]}>
        <View style={[styles.fill, { width: `${remain}%`, backgroundColor: colors.primary }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8, gap: 12 },
  iconBox: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  mid: { flex: 1 },
  instruction: { fontSize: 16, fontWeight: '700' },
  sub: { fontSize: 12.5, marginTop: 2 },
  right: { alignItems: 'flex-end' },
  dist: { fontSize: 17, fontWeight: '800' },
  eta: { fontSize: 11.5, marginTop: 1 },
  track: { height: 3, width: '100%' },
  fill: { height: 3 },
});
