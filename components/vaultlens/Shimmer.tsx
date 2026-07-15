// components/vaultlens/Shimmer.tsx — token-driven shimmer skeleton (no spinners).
// A soft highlight sweeps across a rounded surface, matching the app's loading
// idiom. Used for the generation placeholder + preview thumbnails.

import React, { useEffect } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../lib/theme';
import { RADIUS } from '../../constants/theme';

export function Shimmer({ width, height, radius = RADIUS.lg, style }:
  { width: number | `${number}%`; height: number; radius?: number; style?: ViewStyle }) {
  const { colors } = useTheme();
  const x = useSharedValue(-1);
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, false);
  }, [x]);
  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: `${x.value * 100}%` as any }] }));

  return (
    <View style={[{ width, height, borderRadius: radius, overflow: 'hidden', backgroundColor: colors.surface }, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
        <LinearGradient
          colors={['transparent', colors.text === '#FFFFFF' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)', 'transparent']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

export default Shimmer;
