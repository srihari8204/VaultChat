// components/ui/Card.tsx — shared surface container (U4).
//
// A token-styled card (bg + border + radius + padding). Optionally pressable.

import React from 'react';
import { View, TouchableOpacity, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { RADIUS, SPACING, ELEVATION } from '../../constants/theme';
import { glassShadow, lipGradient, lipPeak } from '../../constants/glass';
import { useColors, useTheme } from '../../lib/theme';

export interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, onPress, padded = true, style }: CardProps) {
  const c = useColors();
  const { scheme } = useTheme();
  const content = (
    <View style={[
      styles.card,
      scheme === 'light' ? glassShadow('card', scheme) : ELEVATION.sm,
      { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: scheme === 'light' ? 1 : StyleSheet.hairlineWidth },
      padded && styles.padded,
      style,
    ]}>
      {children}
      <LinearGradient
        pointerEvents="none"
        colors={lipGradient(lipPeak('card', scheme))}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.lip}
      />
    </View>
  );
  if (onPress) {
    return <TouchableOpacity accessibilityRole="button" onPress={onPress} activeOpacity={0.85}>{content}</TouchableOpacity>;
  }
  return content;
}

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS.xl, borderWidth: StyleSheet.hairlineWidth },
  padded: { padding: SPACING.lg },
  lip: { position: 'absolute', top: 0, left: RADIUS.xl, right: RADIUS.xl, height: 1 },
});

export default Card;
