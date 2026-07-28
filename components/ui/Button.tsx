// components/ui/Button.tsx — shared button primitive (U4).
//
// Token-driven variants + sizes, built-in press haptic and loading state, so
// screens stop re-styling TouchableOpacity for every CTA.

import React, { useCallback } from 'react';
import {
  TouchableOpacity, ActivityIndicator, View, StyleSheet, Platform,
  type ViewStyle, type StyleProp,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING, ELEVATION } from '../../constants/theme';
import { useColors } from '../../lib/theme';
import { AppText } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

const HEIGHT: Record<Size, number> = { sm: 38, md: 46, lg: 54 };

export function Button({
  title, onPress, variant = 'primary', size = 'md', icon,
  loading, disabled, fullWidth, style,
}: ButtonProps) {
  const Aurora = useColors();
  const isDisabled = disabled || loading;
  const handlePress = useCallback(() => {
    if (isDisabled) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.();
  }, [isDisabled, onPress]);

  const bg =
    variant === 'primary' ? Aurora.primary
    : variant === 'danger' ? Aurora.danger
    : variant === 'secondary' ? Aurora.surfaceSolid : 'transparent';
  const fg =
    variant === 'primary' ? '#FFFFFF'
    : variant === 'danger' ? '#FFFFFF'
    : (variant === 'ghost' || variant === 'outline') ? Aurora.primary : Aurora.text;
  const border =
    variant === 'secondary' ? Aurora.border
    : variant === 'outline' ? Aurora.primary : 'transparent';
  const filled = variant === 'primary' || variant === 'danger';

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={[
        styles.base,
        { height: HEIGHT[size], backgroundColor: bg, borderColor: border, borderWidth: border === 'transparent' ? 0 : 1.5 },
        filled && !isDisabled && { ...ELEVATION.sm, shadowColor: bg },
        fullWidth && { alignSelf: 'stretch' },
        isDisabled && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <View style={styles.row}>
          {icon && <Ionicons name={icon} size={size === 'sm' ? 16 : 18} color={fg} />}
          <AppText variant="bodyStrong" color={fg} style={size === 'sm' ? { fontSize: 13 } : undefined}>{title}</AppText>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
});

export default Button;
