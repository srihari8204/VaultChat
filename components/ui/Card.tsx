// components/ui/Card.tsx — shared surface container (U4).
//
// A token-styled card (bg + border + radius + padding). Optionally pressable.

import React from 'react';
import { View, TouchableOpacity, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { Aurora, RADIUS, SPACING } from '../../constants/theme';

export interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, onPress, padded = true, style }: CardProps) {
  const content = <View style={[styles.card, padded && styles.padded, style]}>{children}</View>;
  if (onPress) {
    return <TouchableOpacity onPress={onPress} activeOpacity={0.85}>{content}</TouchableOpacity>;
  }
  return content;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Aurora.card,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: Aurora.border,
  },
  padded: { padding: SPACING.lg },
});

export default Card;
