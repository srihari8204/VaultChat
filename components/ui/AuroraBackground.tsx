// components/ui/AuroraBackground.tsx — the Aurora Glass ground (U6).
//
// WHY THIS EXISTS
// ---------------
// The design puts the personality in the BACKGROUND, not in the rows. Chat
// lists stay flat and undecorated so they read at a glance; what makes the
// screen feel expensive is a set of soft colour blooms drifting behind
// everything.
//
// WHY SVG RADIAL GRADIENTS AND NOT A BLUR
// ---------------------------------------
// Figma draws these as heavily blurred ellipses. Reproducing that with a real
// blur on device means either a filter react-native-svg does not support
// reliably on Android, or an offscreen pass every frame. A radial gradient that
// fades to fully transparent is visually the same thing at a fraction of the
// cost, and it is resolution independent — no exported PNG to ship per density.
//
// The viewBox is the 390x844 reference the design was drawn at; `slice` scales
// the composition to any device without distorting it.

import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';
import { useColors, useTheme } from '../../lib/theme';
import { AURORA_COMPOSITIONS, AURORA_LIGHT_OPACITY_SCALE } from '../../constants/auroraPalette';

// The bloom hues and per-screen compositions are fixed brand data, documented
// and contrast-checked in constants/auroraPalette.ts.
export type AuroraVariant = keyof typeof AURORA_COMPOSITIONS;

export function AuroraBackground({ variant = 'chats' }: { variant?: AuroraVariant }) {
  const c = useColors();
  const { scheme } = useTheme();
  const scale = scheme === 'light' ? AURORA_LIGHT_OPACITY_SCALE : 1;
  const blooms = AURORA_COMPOSITIONS[variant] ?? AURORA_COMPOSITIONS.chats;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice">
        <Defs>
          {blooms.map((b, i) => (
            <RadialGradient key={i} id={`bloom-${scheme}-${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={b.c} stopOpacity={b.o * scale} />
              {/* Mid stop keeps the falloff soft; a straight 0→1 ramp reads as a hard disc. */}
              <Stop offset="55%" stopColor={b.c} stopOpacity={b.o * scale * 0.45} />
              <Stop offset="100%" stopColor={b.c} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {blooms.map((b, i) => (
          <Ellipse key={i} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} fill={`url(#bloom-${scheme}-${i})`} />
        ))}
      </Svg>
    </View>
  );
}

export default AuroraBackground;
