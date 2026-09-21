// components/ui/Brand.tsx — the crazzychat logo, and the sky it stands in.
//
// WHY THESE TWO LIVE TOGETHER
// ---------------------------
// They are never used apart. `AuthSky` is the ground the splash screen is lit
// against and `BrandMark` is the thing standing on it; splitting them into two
// files would mean two places to keep one composition in sync.
//
// Mounted auth screens follow appearance. Native splash artwork stays unchanged.
//
// WHY THE LOGO IS TWO PNGs AND NOT ONE
// ------------------------------------
// logo.png ships as the app icon and is a single flat picture on WHITE, so
// dropping it on the night ground paints a white card. assets/images/
// brand-mark.png and brand-wordmark-on-dark.png are derived from it: the paper
// is keyed out to transparency, the mark and the wordmark are cut apart at the
// empty band between them, and the wordmark's near-black "crazzy" is lifted to
// white while the saturated "chat" gradient is left exactly as drawn. Cutting
// them apart is what lets the lockup breathe independently of the artwork's
// own padding, which is generous because it was drawn for an app icon.

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, RadialGradient, Stop } from 'react-native-svg';
import { BRAND_CYAN, BRAND_VIOLET, BRAND_ACCENT } from '../../constants/theme';
import { useAuthTheme } from '../../lib/useAuthTheme';
import { useTheme } from '../../lib/theme';

/* ── the sky ─────────────────────────────────────────────────────────── */

/** One bloom: colour, size, centre, and peak opacity at the centre. */
type Bloom = { c: string; rx: number; ry: number; cx: number; cy: number; o: number };

/**
 * The splash's own lighting, read off the artwork rather than invented: a cool
 * blue wash down the left, a violet flare on the right, and a cyan lift near
 * the horizon. Drawn in the same 390x844 reference box AuroraBackground uses,
 * so the two compositions stay comparable.
 */
const SKY: Bloom[] = [
  { c: BRAND_ACCENT, rx: 240, ry: 230, cx: 40,  cy: 120, o: 0.42 },
  { c: BRAND_VIOLET, rx: 210, ry: 200, cx: 390, cy: 330, o: 0.34 },
  { c: BRAND_CYAN,   rx: 230, ry: 130, cx: 195, cy: 700, o: 0.20 },
  { c: BRAND_ACCENT, rx: 170, ry: 120, cx: 340, cy: 830, o: 0.16 },
];

/**
 * The night ground plus its blooms. `pointerEvents="none"` so it never eats a
 * tap meant for the form on top of it.
 */
export function AuthSky() {
  const auth = useAuthTheme();
  const { scheme } = useTheme();
  const bloom = scheme === 'light' ? 0.2 : 1;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: auth.bg }]} pointerEvents="none">
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <Svg width="100%" height="100%" viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice">
        <Defs>
          {SKY.map((b, i) => (
            <RadialGradient key={i} id={`sky-${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor={b.c} stopOpacity={b.o * bloom} />
              {/* Mid stop keeps the falloff soft; a straight 0→1 ramp reads as a hard disc. */}
              <Stop offset="55%" stopColor={b.c} stopOpacity={b.o * 0.45 * bloom} />
              <Stop offset="100%" stopColor={b.c} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {SKY.map((b, i) => (
          <Ellipse key={i} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} fill={`url(#sky-${i})`} />
        ))}
      </Svg>
    </View>
  );
}

/* ── the lockup ──────────────────────────────────────────────────────── */

/**
 * The orbit rings from the splash: two tilted ellipses with a lit node riding
 * each one.
 *
 * STATIC, NOT ANIMATED. They sit behind a sign-in form that the keyboard is
 * about to cover, so a permanently running animation would be burning frames
 * behind a text field for something nobody is looking at. The splash earns its
 * motion because it is on screen for a second with nothing else happening.
 */
function Orbits({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={BRAND_ACCENT} stopOpacity={0.30} />
          <Stop offset="60%" stopColor={BRAND_ACCENT} stopOpacity={0.10} />
          <Stop offset="100%" stopColor={BRAND_ACCENT} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {/* the glow the mark sits in */}
      <Circle cx={50} cy={50} r={48} fill="url(#halo)" />
      <G opacity={0.55}>
        <G rotation={-18} origin="50, 50">
          <Ellipse cx={50} cy={50} rx={46} ry={20} stroke={BRAND_CYAN} strokeOpacity={0.45} strokeWidth={0.6} fill="none" />
          <Circle cx={96} cy={50} r={2.2} fill={BRAND_CYAN} />
        </G>
        <G rotation={62} origin="50, 50">
          <Ellipse cx={50} cy={50} rx={46} ry={22} stroke={BRAND_VIOLET} strokeOpacity={0.40} strokeWidth={0.6} fill="none" />
          <Circle cx={4} cy={50} r={2} fill={BRAND_VIOLET} />
        </G>
      </G>
    </Svg>
  );
}

export interface BrandMarkProps {
  /** Width of the "C" mark. The wordmark is sized off it, not set separately. */
  size?: number;
  /** The orbit rings and halo. Off for tight spots like a step header. */
  orbits?: boolean;
  /** "CONNECT INSTANTLY", as on the splash. */
  tagline?: boolean;
  /** Hide the wordmark and show the mark alone. */
  markOnly?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The full lockup: mark, wordmark, and optionally the tagline.
 *
 * The wordmark's width is derived from the mark rather than passed in, because
 * the two have a fixed relationship in the artwork and letting a caller set
 * them independently is how a logo ends up subtly wrong on one screen.
 */
export function BrandMark({
  size = 96, orbits = true, tagline = false, markOnly = false, style,
}: BrandMarkProps) {
  const auth = useAuthTheme();
  const { scheme } = useTheme();
  // Measured off assets/images/brand-mark.png (512x562).
  const markH = Math.round(size * (562 / 512));
  // The rings need room around the mark or they crop to a rectangle.
  const ring = Math.round(size * 1.9);

  return (
    <View style={[{ alignItems: 'center' }, style]}>
      <View style={{ width: ring, height: ring, alignItems: 'center', justifyContent: 'center' }}>
        {orbits && <Orbits size={ring} />}
        <Image
          source={require('../../assets/images/brand-mark.png')}
          style={{ width: size, height: markH }}
          resizeMode="contain"
          // Decorative here: the wordmark underneath already says the name, and
          // a screen reader announcing "crazzy chat logo, crazzychat" is noise.
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      </View>

      {!markOnly && (
        <Image
          source={scheme === 'light' ? require('../../assets/images/brand-wordmark.png') : require('../../assets/images/brand-wordmark-on-dark.png')}
          // 768x152 in the asset; width is 1.72x the mark in the original lockup.
          style={{ width: Math.round(size * 1.72), height: Math.round(size * 1.72 * (152 / 768)), marginTop: 2 }}
          resizeMode="contain"
          accessibilityRole="image"
          accessibilityLabel="crazzychat"
        />
      )}

      {tagline && <Text style={[S.tagline, scheme === 'light' && { color: auth.dim }]}>CONNECT INSTANTLY</Text>}
    </View>
  );
}

/* ── the three-step chain ────────────────────────────────────────────── */

export interface StepRailProps {
  /** How many segments are lit, 1-based. Step 2 of 3 → `step={2}`. */
  step: number;
  total?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Where the user is in profile → security → MPIN, as three segments.
 *
 * DECORATIVE, AND HIDDEN FROM SCREEN READERS ON PURPOSE. Three bare Views
 * announce as nothing useful; the "Step 2 of 3" line next to it is the real
 * statement and is left as plain text so it is read once, not twice.
 *
 * Lives here rather than in each screen because all three steps draw it, and
 * three copies of a progress indicator is how they end up three different
 * widths.
 */
export function StepRail({ step, total = 3, style }: StepRailProps) {
  const { scheme } = useTheme();
  const auth = useAuthTheme();
  return (
    <View
      style={[S.rail, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[S.seg, { backgroundColor: i < step ? auth.accent : scheme === 'light' ? auth.stroke : auth.hairline }]} />
      ))}
    </View>
  );
}

const S = StyleSheet.create({
  rail: { flexDirection: 'row', gap: 6 },
  seg: { flex: 1, height: 3, borderRadius: 2 },

  tagline: {
    // Original night tagline; the light appearance overrides its ink.
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11,
    fontWeight: '600',
    // The splash sets this very wide; it is most of what makes it read as a
    // brand line rather than a sentence.
    letterSpacing: 4.5,
    marginTop: 10,
  },
});
