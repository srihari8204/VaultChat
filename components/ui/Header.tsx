// components/ui/Header.tsx — shared screen header (U4).
//
// Back chevron + centered/leading title + optional right slot, with safe-area
// top padding. Replaces the per-screen header markup repeated across the app.

import React from 'react';
import { View, TouchableOpacity, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SPACING } from '../../constants/theme';
import { glassShadow } from '../../constants/glass';
import { useColors, useTheme } from '../../lib/theme';
import { AppText } from './Text';

export interface HeaderProps {
  title?: string;
  /** Show the back chevron (default true). */
  back?: boolean;
  onBack?: () => void;
  /** Right-aligned content (icon buttons etc). */
  right?: React.ReactNode;
  /** Border under the header. */
  border?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Header({ title, back = true, onBack, right, border, style }: HeaderProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const { scheme } = useTheme();
  return (
    <View
      style={[
        styles.header,
        glassShadow('chrome', scheme),
        { paddingTop: insets.top + SPACING.xs, backgroundColor: c.glass, borderBottomWidth: border ? 1 : StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
        style,
      ]}
    >
      <View style={styles.side}>
        {back && (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={onBack ?? (() => router.back())} hitSlop={4} style={[styles.iconBtn, { backgroundColor: c.glassSoft, borderColor: c.glassStroke }]}>
            <Ionicons name="arrow-back" size={24} color={c.text} />
          </TouchableOpacity>
        )}
      </View>
      <AppText variant="h3" numberOfLines={1} style={styles.title}>{title}</AppText>
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.sm, paddingBottom: SPACING.sm,
  },
  side: { minWidth: 44, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  iconBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center' },
});

export default Header;
