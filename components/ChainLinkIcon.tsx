import React, { useMemo } from 'react';
import Svg, { Path } from 'react-native-svg';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { brandAlpha, type Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface Props {
  onPress: () => void;
  active?: boolean;
  size?:   number;
  /** Spoken name of the action; the glyph alone says nothing to a screen reader. */
  label?:  string;
}

export default function ChainLinkIcon({ onPress, active = false, size = 40, label = 'Link' }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  const stroke = active ? c.accentOn : c.textDim;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={size < 44 ? (44 - size) / 2 : undefined}
      style={[
        s.btn,
        { width: size, height: size, borderRadius: size * 0.3 },
        active && s.active,
      ]}
    >
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <Path
          d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"
          stroke={stroke}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
          stroke={stroke}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </TouchableOpacity>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  btn: {
    backgroundColor: c.glassSoft,
    borderWidth:     1,
    borderColor:     c.glassStroke,
    alignItems:      'center',
    justifyContent:  'center',
  },
  active: {
    backgroundColor: brandAlpha(0.18),
    borderColor:     brandAlpha(0.4),
  },
});
