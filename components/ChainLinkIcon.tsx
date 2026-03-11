import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { TouchableOpacity, StyleSheet } from 'react-native';

interface Props {
  onPress: () => void;
  active?: boolean;
  size?:   number;
}

export default function ChainLinkIcon({ onPress, active = false, size = 40 }: Props) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        s.btn,
        { width: size, height: size, borderRadius: size * 0.3 },
        active && s.active,
      ]}
    >
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <Path
          d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"
          stroke={active ? '#4A9FFF' : 'rgba(255,255,255,0.75)'}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
          stroke={active ? '#4A9FFF' : 'rgba(255,255,255,0.75)'}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  btn: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth:     1,
    borderColor:     'rgba(255,255,255,0.15)',
    alignItems:      'center',
    justifyContent:  'center',
  },
  active: {
    backgroundColor: 'rgba(74,159,255,0.18)',
    borderColor:     'rgba(74,159,255,0.4)',
  },
});
