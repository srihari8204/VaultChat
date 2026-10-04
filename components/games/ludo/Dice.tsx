// components/games/ludo/Dice.tsx — the die and the tray it is thrown into.
// Split out of components/games/Ludo.tsx; behaviour unchanged.

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, LinearGradient as SvgLinear, Stop, Rect, Ellipse, Path } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat, withSequence,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import { S, R, white } from '../../../lib/games/theme';
import { LR, SEAT, TRAY, GLINT, DIE, TRAY_WARM, w, seatA } from '../../../lib/games/ludoGlass';

/* ── the die ────────────────────────────────────────────────────────── */

/** Pip positions per face, as indices into a 3x3 grid. */
const PIPS: Record<number, number[]> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

/**
 * The die.
 *
 * `armed` is "your turn, not yet rolled" — a slow breath, an invitation.
 * `tumbling` is the roll itself: the cube spins hard and the FACE CHANGES,
 * which is what reads as a roll. A die that only wobbles while keeping the same
 * pips looks like a stuck animation.
 *
 * The face shown while tumbling is deliberately random and means nothing; the
 * server's number replaces it the moment the animation ends. Rolling the real
 * result early would be showing an answer the player has not seen arrive.
 */
export function Die({ value, tumbling, armed, seat, size }: { value: number | null; tumbling: boolean; armed: boolean; seat: number; size: number }) {
  const shake = useSharedValue(0);
  const spin = useSharedValue(0);
  const [flicker, setFlicker] = useState(6);

  useEffect(() => {
    if (tumbling) {
      spin.value = 0;
      spin.value = withTiming(1, { duration: 850, easing: Easing.out(Easing.cubic) });
      shake.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 70, easing: Easing.inOut(Easing.quad) }),
          withTiming(-1, { duration: 70, easing: Easing.inOut(Easing.quad) }),
        ), -1, true);
      // Cycle the face so the cube is visibly changing, not merely shaking.
      const id = setInterval(() => setFlicker(1 + Math.floor(Math.random() * 6)), 90);
      return () => { clearInterval(id); cancelAnimation(shake); cancelAnimation(spin); };
    }
    cancelAnimation(shake);
    shake.value = withSpring(0, { damping: 14, stiffness: 200 });
    if (armed) {
      // A slow breath while it is the player's turn to roll.
      shake.value = withRepeat(withTiming(0.22, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
    }
    spin.value = withTiming(0, { duration: 200 });
    return () => { cancelAnimation(shake); cancelAnimation(spin); };
  }, [tumbling, armed, shake, spin]);

  const a = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${shake.value * 12 + spin.value * 540}deg` },
      { translateY: -Math.abs(shake.value) * 6 },
      { scale: 1 + Math.abs(shake.value) * 0.06 },
    ] as ViewStyle['transform'],
  }));

  const face = tumbling ? flicker : (value ?? 6);
  const on = new Set(PIPS[face] ?? []);

  return (
    <Animated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={tumbling ? 'Rolling the dice' : value == null ? 'Dice, not rolled' : `Dice showing ${value}`}
      style={[{
        width: size, height: size, borderRadius: size * 0.24, padding: size * 0.15,
        // Frosted glass rather than cream ivory. The cream was mixed for the
        // maroon table; against the midnight room it read as a yellow tile.
        backgroundColor: LR.text,
        borderWidth: 1.5, borderColor: armed || tumbling ? SEAT[2].light : white(0.9),
        // CLIPPED, so the sheen below stays inside the cube. Shadows are drawn
        // outside a clipped view either way, so the halo survives.
        overflow: 'hidden',
        boxShadow:
          '0 7px 14px rgba(0,0,0,0.5), '
          // The gold halo is what makes it float over the tray rather than sit
          // on it. It is spent here and on the CTA, nowhere else on the board.
          + `0 0 16px ${seatA(2, 'base', armed || tumbling ? 0.4 : 0.16)}, `
          + 'inset 0 3px 1px rgba(255,255,255,1), inset 0 -5px 1px rgba(90,80,140,0.24)',
        opacity: value == null && !tumbling && !armed ? 0.78 : 1,
      }, a]}
    >
      {/* The corner sheen — one band of light across the top-left. It is what
          reads as a glass CUBE rather than a rounded square, and it is static,
          so it costs one SVG that never re-renders while the die spins. */}
      <Svg width={size} height={size} viewBox="0 0 62 62" pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinear id="dface" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={GLINT} />
            <Stop offset="0.52" stopColor={LR.text} />
            <Stop offset="1" stopColor={DIE.faceLo} />
          </SvgLinear>
          <RadialGradient id="dsheen" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor={GLINT} stopOpacity="0.55" />
            <Stop offset="1" stopColor={GLINT} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="2" y="2" width="58" height="54" rx="12" fill="url(#dface)" stroke={w(0.85)} strokeWidth="0.8" />
        <Path d="M 10 5 H 43" stroke={GLINT} strokeWidth="1.8" strokeLinecap="round" />
        <Ellipse cx="20" cy="12" rx="26" ry="14" fill="url(#dsheen)" transform="rotate(18 20 12)" />
      </Svg>
      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: 9 }, (_, i) => (
          <View key={i} style={{ width: '33.33%', height: '33.33%', alignItems: 'center', justifyContent: 'center' }}>
            {on.has(i) && (
              <View style={{
                width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08,
                backgroundColor: tumbling || value == null ? DIE.pipIdle : LR.bg,
                borderWidth: 0.8, borderColor: white(0.75),
                // A pip only glows once it is a real published result — while
                // the cube is tumbling the face means nothing and must not be
                // dressed up as an answer.
                boxShadow: !tumbling && value != null ? `0 0 4px ${seatA(seat, 'base', 0.55)}` : undefined,
              }} />
            )}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

/**
 * The tray the die is thrown into.
 *
 * A recessed well plus one warm pool of light under the cube. Purely a surface:
 * it holds the die and the server's clock and decides nothing.
 */
export function DiceTray({ children, wide }: { children?: React.ReactNode; wide: boolean }) {
  return (
    <View style={{
      width: wide ? '100%' : 112, minHeight: 110, borderRadius: R[4],
      flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap',
      alignItems: 'center', justifyContent: 'center', gap: S[2], padding: S[3],
      backgroundColor: TRAY,
      borderWidth: 1, borderColor: seatA(2, 'light', 0.4),
      boxShadow: 'inset 0 3px 8px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,255,255,0.1)',
    }}>
      {/* The pool of warm light the cube sits in. Static and behind the die, so
          it costs one SVG that never re-renders — the die animating above it
          does not touch this. */}
      <Svg width={96} height={44} pointerEvents="none" style={{ position: 'absolute', top: '50%', left: '50%', marginLeft: -48, marginTop: -10 }}>
        <Defs>
          <RadialGradient id="ltray" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0"   stopColor={SEAT[2].base} stopOpacity="0.45" />
            <Stop offset="0.5" stopColor={TRAY_WARM} stopOpacity="0.18" />
            <Stop offset="1"   stopColor={SEAT[2].base} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx={48} cy={22} rx={48} ry={22} fill="url(#ltray)" />
      </Svg>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: SEAT[2].light, fontSize: 10, fontWeight: '800', letterSpacing: 1.8 }}>DICE</Text>
      {children}
    </View>
  );
}
