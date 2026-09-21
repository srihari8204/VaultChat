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
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { BRAND_GRADIENT_CTA, RADIUS, SPACING, ELEVATION } from '../../constants/theme';
import { glassShadow } from '../../constants/glass';
import { useColors, useTheme } from '../../lib/theme';
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

const HEIGHT: Record<Size, number> = { sm: 44, md: 48, lg: 56 };

export function Button({
  title, onPress, variant = 'primary', size = 'md', icon,
  loading, disabled, fullWidth, style,
}: ButtonProps) {
  const Aurora = useColors();
  const { scheme } = useTheme();
  const isDisabled = disabled || loading;
  const handlePress = useCallback(() => {
    if (isDisabled) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.();
  }, [isDisabled, onPress]);

  const bg =
    variant === 'primary' ? Aurora.accentDeep
    : variant === 'danger' ? Aurora.danger
    : variant === 'secondary' ? Aurora.glass : 'transparent';
  const fg =
    variant === 'primary' ? '#FFFFFF'
    : variant === 'danger' ? '#FFFFFF'
    : (variant === 'ghost' || variant === 'outline') ? Aurora.accentOn : Aurora.text;
  const border =
    variant === 'secondary' ? Aurora.glassStroke
    : variant === 'outline' ? Aurora.primary : 'transparent';
  const filled = variant === 'primary' || variant === 'danger';
  const gradient = variant === 'primary'
    ? BRAND_GRADIENT_CTA
    : variant === 'danger' ? ['#FB7185', '#B42318'] as const : null;

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      activeOpacity={0.85}
      style={[
        styles.base,
        {
          minHeight: HEIGHT[size],
          backgroundColor: gradient ? 'transparent' : bg,
          borderColor: border,
          borderWidth: border === 'transparent' ? 0 : 1.5,
        },
        variant === 'secondary' && {
          borderWidth: scheme === 'light' ? 1.25 : 1,
          ...glassShadow('chip', scheme),
        },
        filled && !isDisabled && { ...ELEVATION.sm, shadowColor: bg },
        fullWidth && { alignSelf: 'stretch' },
        isDisabled && { opacity: 0.5 },
        style,
      ]}
    >
      {gradient ? (
        <LinearGradient
          pointerEvents="none"
          colors={gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <View style={styles.row}>
          {icon && <Ionicons name={icon} size={size === 'sm' ? 16 : 18} color={fg} />}
          <AppText variant="bodyStrong" color={fg} style={[styles.label, size === 'sm' && { fontSize: 13 }]}>{title}</AppText>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl, paddingVertical: SPACING.sm, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, maxWidth: '100%' },
  label: { flexShrink: 1, textAlign: 'center' },
});

export default Button;
