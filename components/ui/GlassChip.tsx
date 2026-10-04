// components/ui/GlassChip.tsx — pill filter chip (U8). Figma: Chip (State=Default | Active).
//
// Idle: soft glass with a hairline rim. Active: the accent gradient with the
// accent glow, white label. Optional count pill. Replaces the folderChip /
// folderChipActive / folderCount trio the chats screen carried, so the next
// filter row (calls, contacts, files) is one line instead of six styles.

import React from 'react';
import { StyleSheet, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { GLASS, GLOW } from '../../constants/glass';
import { GRADIENT_INK } from '../../constants/theme';
import { useColors, useTheme } from '../../lib/theme';
import { AppText } from './Text';

export interface GlassChipProps {
  label: string;
  /** Shown as a small pill after the label when > 0. */
  count?: number;
  active?: boolean;
  onPress?: () => void;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function GlassChip({ label, count, active = false, onPress, icon, style, testID }: GlassChipProps) {
  const c = useColors();
  const { scheme } = useTheme();
  // White on the accent gradient (constants/theme GRADIENT_INK); idle text is
  // the dim token. Light's flat accentDeep is 6.33:1. Dark's gradient starts at
  // accentLight, where white is only 2.09:1 — pinned as "unchanged" by
  // lib/sharedLightRendering.selftest.ts, so changing it is a coordinated edit.
  const fg = active ? GRADIENT_INK : c.textDim;
  const showCount = typeof count === 'number' && count > 0;
  const inner = (
    <View style={styles.row}>
      {icon && <Ionicons name={icon} size={14} color={fg} />}
      <AppText variant="callout" color={fg} numberOfLines={1}>{label}</AppText>
      {showCount && (
        <View style={[styles.count, { backgroundColor: active ? (scheme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.22)') : c.glassSoft }]}>
          <AppText variant="tiny" color={fg} numberOfLines={1}>{count > 99 ? '99+' : String(count)}</AppText>
        </View>
      )}
    </View>
  );
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.hit, active && GLOW.accent, style]}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={showCount ? `${label}, ${count}` : label}
    >
      {active ? (
        <LinearGradient
          colors={[scheme === 'light' ? c.accentDeep : c.accentLight, c.accentDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.pill, { borderColor: c.glassStroke, borderWidth: scheme === 'light' ? 1 : StyleSheet.hairlineWidth }]}
        >
          {inner}
        </LinearGradient>
      ) : (
        <View style={[styles.pill, { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: scheme === 'light' ? 1 : StyleSheet.hairlineWidth }]}>{inner}</View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  hit: { borderRadius: GLASS.chip.radius },
  pill: {
    borderRadius: GLASS.chip.radius,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 15,
    paddingVertical: 8,
    ...GLASS.chip.shadow,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { minWidth: 18, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, alignItems: 'center' },
});

export default GlassChip;
