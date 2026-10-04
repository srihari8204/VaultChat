// components/comfort/EyeCheckCharts.tsx — the Eye Check test charts (split out of
// app/eye-check.tsx; drawing unchanged). All of them sit on the fixed white
// field (eyeCheckField.ts), whatever the app theme.
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import { useTheme } from '../../lib/theme';
import { EYE_FIELD, PLATE_COLORS } from './eyeCheckField';

/** The white card a chart is drawn on. Its border follows the theme; its paper does not. */
export function ChartField({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[styles.chartCard, { backgroundColor: EYE_FIELD.paper, borderColor: colors.glassStroke }]}>{children}</View>;
}

export function LandoltC({ size, angle }: { size: number; angle: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel="C gap symbol">
      <G rotation={angle} origin="50,50">
        <Path d="M 70 27 A 32 32 0 1 0 70 73" stroke={EYE_FIELD.ink} strokeWidth={14} strokeLinecap="butt" fill="none" />
      </G>
    </Svg>
  );
}

const DIGIT_MASK: Record<string, readonly string[]> = {
  '2': ['11110', '00001', '00001', '01110', '10000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01111', '10000', '10000', '11110', '10001', '10001', '01110'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '11110'],
};

export function ColorPlate({ digit, variant, size }: { digit: string; variant: number; size: number }) {
  const mask = DIGIT_MASK[digit];
  const [figure, background] = PLATE_COLORS[variant];
  return (
    <Svg width={size} height={size} viewBox="0 0 220 220" accessibilityLabel="Coloured dot number plate">
      <Circle cx={110} cy={110} r={106} fill={EYE_FIELD.plate} />
      {Array.from({ length: 225 }, (_, index) => {
        const col = index % 15, row = Math.floor(index / 15);
        const x = 14 + col * 13.7 + ((index * 7) % 5 - 2), y = 14 + row * 13.7 + ((index * 11) % 5 - 2);
        if ((x - 110) ** 2 + (y - 110) ** 2 > 99 ** 2) return null;
        const inDigit = row >= 4 && row < 11 && col >= 5 && col < 10 && mask[row - 4][col - 5] === '1';
        return <Circle key={index} cx={x} cy={y} r={4.2 + index % 3} fill={inDigit ? figure : background} />;
      })}
    </Svg>
  );
}

export function AstigChart({ size }: { size: number }) {
  return (
    <Svg width={size} height={size * 0.85} viewBox="0 0 220 190" accessibilityLabel="Semicircle line chart">
      {Array.from({ length: 13 }, (_, index) => {
        const angle = Math.PI + index * Math.PI / 12;
        return <Line key={index} x1={110} y1={175} x2={110 + Math.cos(angle) * 90} y2={175 + Math.sin(angle) * 90} stroke={EYE_FIELD.ink} strokeWidth={2} />;
      })}
      <Circle cx={110} cy={175} r={5} fill={EYE_FIELD.ink} />
    </Svg>
  );
}

export function AmslerGrid({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 220 220" accessibilityLabel="Amsler grid with centre dot">
      {Array.from({ length: 21 }, (_, index) => (
        <G key={index}>
          <Line x1={10 + index * 10} y1={10} x2={10 + index * 10} y2={210} stroke={EYE_FIELD.grid} strokeWidth={0.8} />
          <Line x1={10} y1={10 + index * 10} x2={210} y2={10 + index * 10} stroke={EYE_FIELD.grid} strokeWidth={0.8} />
        </G>
      ))}
      <Circle cx={110} cy={110} r={3} fill={EYE_FIELD.ink} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  chartCard: { minHeight: 170, borderWidth: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginVertical: 16, padding: 16, gap: 24 },
});
