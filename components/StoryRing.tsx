// components/StoryRing.tsx — WhatsApp-style segmented status ring.
// One arc per story; seen arcs are muted, unseen arcs are the accent color.

import React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

export function StoryRing({
  size = 60, stroke = 2.5, segments, color, seenColor, children,
}: {
  size?: number;
  stroke?: number;
  segments: boolean[];        // true = seen (muted), false = unseen (accent)
  color: string;
  seenColor: string;
  children?: React.ReactNode;
}) {
  const n = Math.max(1, segments.length);
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const gapDeg = n > 1 ? 5 : 0;
  const segDeg = (360 - gapDeg * n) / n;
  const arcLen = (segDeg / 360) * circ;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        {(segments.length ? segments : [false]).map((seen, i) => {
          const startDeg = -90 + i * (segDeg + gapDeg);
          return (
            <Circle
              key={i} cx={cx} cy={cy} r={r} fill="none"
              stroke={seen ? seenColor : color} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={`${arcLen} ${circ - arcLen}`}
              transform={`rotate(${startDeg} ${cx} ${cy})`}
            />
          );
        })}
      </Svg>
      {children}
    </View>
  );
}
