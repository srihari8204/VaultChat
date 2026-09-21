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

/** One bloom: colour, size, centre, and peak opacity at the centre. */
type Bloom = { c: string; rx: number; ry: number; cx: number; cy: number; o: number };

/**
 * Per-screen compositions. These are deliberately NOT palette tokens: each is a
 * one-off arrangement for that screen, the way a photograph is not a colour.
 */
const COMPOSITIONS = {
  chats:   [
    { c: '#33DDFE', rx: 190, ry: 170, cx: 78,  cy: 44,  o: 0.42 },
    { c: '#8C49FC', rx: 188, ry: 170, cx: 366, cy: 220, o: 0.36 },
    { c: '#22C55E', rx: 150, ry: 135, cx: 54,  cy: 622, o: 0.18 },
    { c: '#F59E0B', rx: 132, ry: 122, cx: 342, cy: 742, o: 0.16 },
  ],
  chat:    [
    { c: '#33DDFE', rx: 180, ry: 160, cx: 48,  cy: 48,  o: 0.30 },
    { c: '#8C49FC', rx: 164, ry: 150, cx: 360, cy: 450, o: 0.22 },
    { c: '#22C55E', rx: 146, ry: 136, cx: 52,  cy: 700, o: 0.13 },
  ],
  calls:   [
    { c: '#33DDFE', rx: 202, ry: 184, cx: 80,  cy: 50,  o: 0.38 },
    { c: '#22C55E', rx: 174, ry: 162, cx: 370, cy: 230, o: 0.24 },
    { c: '#8C49FC', rx: 168, ry: 150, cx: 60,  cy: 620, o: 0.20 },
  ],
  status:  [
    { c: '#22C55E', rx: 194, ry: 178, cx: 80,  cy: 50,  o: 0.32 },
    { c: '#8C49FC', rx: 176, ry: 164, cx: 375, cy: 285, o: 0.30 },
    { c: '#33DDFE', rx: 160, ry: 150, cx: 50,  cy: 670, o: 0.18 },
  ],
  profile: [
    { c: '#F59E0B', rx: 210, ry: 190, cx: 190, cy: 30,  o: 0.28 },
    { c: '#8C49FC', rx: 176, ry: 160, cx: 380, cy: 370, o: 0.28 },
    { c: '#33DDFE', rx: 160, ry: 150, cx: 40,  cy: 690, o: 0.16 },
  ],
  mini:    [
    { c: '#33DDFE', rx: 194, ry: 176, cx: 70,  cy: 40,  o: 0.32 },
    { c: '#8C49FC', rx: 170, ry: 160, cx: 370, cy: 420, o: 0.24 },
    { c: '#F59E0B', rx: 154, ry: 140, cx: 50,  cy: 710, o: 0.14 },
  ],
} satisfies Record<string, Bloom[]>;

export type AuroraVariant = keyof typeof COMPOSITIONS;

/**
 * On a light ground the same opacities read as garish stains rather than light,
 * because the blooms are ADDING colour to something already bright instead of
 * lifting something dark. Scaling them back is what keeps the composition
 * recognisably the same picture in both themes.
 */
const LIGHT_OPACITY_SCALE = 0.32;

export function AuroraBackground({ variant = 'chats' }: { variant?: AuroraVariant }) {
  const c = useColors();
  const { scheme } = useTheme();
  const scale = scheme === 'light' ? LIGHT_OPACITY_SCALE : 1;
  const blooms = COMPOSITIONS[variant] ?? COMPOSITIONS.chats;
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
