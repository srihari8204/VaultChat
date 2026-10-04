// components/spaces/Donut.tsx — the dashboard donut, drawn with react-native-svg.
//
// No chart library: a donut is N stroked arcs on one circle. Values arrive
// already computed from the server; this component only draws them.

import { AppText as Text } from '../ui/Text';
import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

export interface DonutSegment {
  value: number;
  color: string;
}

export default function Donut({
  segments, centre, label, size = 132, stroke = 14, accessibilityLabel,
  track = 'rgba(255,255,255,0.08)', textColor = '#FFFFFF', labelColor = 'rgba(255,255,255,0.55)',
}: {
  segments: DonutSegment[];
  /** The number in the middle. */
  centre: string;
  /** The line under it. */
  label?: string;
  size?: number;
  stroke?: number;
  track?: string;
  textColor?: string;
  labelColor?: string;
  /** What the chart says in words — its colours alone are unreadable to a
   *  screen reader. Defaults to the centre figure and its label. */
  accessibilityLabel?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, s) => n + Math.max(0, s.value), 0);

  let offset = 0;
  const arcs = total > 0 ? segments.filter((s) => s.value > 0).map((s, i) => {
    const len = (s.value / total) * c;
    const arc = (
      <Circle
        key={i}
        cx={size / 2} cy={size / 2} r={r}
        stroke={s.color} strokeWidth={stroke} fill="none"
        strokeDasharray={`${len} ${c - len}`}
        strokeDashoffset={-offset}
        strokeLinecap="butt"
      />
    );
    offset += len;
    return arc;
  }) : [];

  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessible accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? `${centre} ${label?.replace(/\n/g, ' ') ?? ''}`.trim()}
    >
      {/* Rotated so the first segment starts at 12 o'clock. */}
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }], position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {arcs}
      </Svg>
      <Text style={[st.centre, { color: textColor }]}>{centre}</Text>
      {!!label && <Text style={[st.label, { color: labelColor }]}>{label}</Text>}
    </View>
  );
}

const st = StyleSheet.create({
  centre: { fontSize: 26, fontWeight: '800' },
  label: { fontSize: 11, marginTop: 2, textAlign: 'center' },
});
