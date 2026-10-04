// components/ProgressRing.tsx — determinate circular progress (WhatsApp-style
// media download ring). Pure react-native-svg, no animation lib.

import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { ON_MEDIA_INK } from '../constants/theme';

export function ProgressRing({
  progress, size = 46, stroke = 3, color = ON_MEDIA_INK,
}: { progress: number; size?: number; stroke?: number; color?: string }) {
  const p = Math.max(0, Math.min(1, progress));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - p);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.28)" strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" />
      </Svg>
      <Text style={{ color, fontSize: 11, fontWeight: '800' }}>{Math.round(p * 100)}</Text>
    </View>
  );
}
