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
import { Aurora, RADIUS, SPACING } from '../../constants/theme';
import { AppText } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
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
    variant === 'primary' ? '#04130D'
    : variant === 'danger' ? '#FFFFFF'
    : variant === 'ghost' ? Aurora.primary : Aurora.text;
  const border = variant === 'secondary' ? Aurora.border : 'transparent';

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={[
        styles.base,
        { height: HEIGHT[size], backgroundColor: bg, borderColor: border, borderWidth: border === 'transparent' ? 0 : 1 },
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
  base: { borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
});

export default Button;
