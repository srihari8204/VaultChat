// components/games/ludo/Token.tsx — one pawn on the board. Split out of
// components/games/Ludo.tsx; the label now says where the token is.

import React, { useEffect, useRef } from 'react';
import { Pressable, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, LinearGradient as SvgLinear, Stop, Circle, Ellipse, Path, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat, withSequence,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import { white } from '../../../lib/games/theme';
import { LR, P, PL, PD, COLOR_NAMES, SHAPE, PAWN, PAWN_BODY, PAWN_BASE, GLINT, w, seatA } from '../../../lib/games/ludoGlass';
import { HOME_STEP, coord } from '../../../lib/games/ludoBoard';
import { ludoTokenLabel } from '../../../lib/games/boardLabels';

/* ── a token ────────────────────────────────────────────────────────── */

/**
 * A glass pawn on a rimmed medallion, with its seat's shape embossed on top.
 *
 * Position animates with a springy overshoot — the classic Ludo hop, and the
 * same curve ludo.css uses on left/top. Movable tokens breathe so the player
 * can see at a glance which ones this roll allows rather than trying each.
 */
export function TokenView({
  seat, index, step, cell, movable, onPress,
}: { seat: number; index: number; step: number; cell: number; movable: boolean; onPress: () => void }) {
  const [r, c] = coord(seat, index, step);
  const d = cell * 0.78;
  // Tokens sharing a square are nudged apart so a stack is still countable.
  const nudge = step >= 0 && step < HOME_STEP ? (index - 1.5) * cell * 0.11 : 0;
  const tx = c * cell + (cell - d) / 2 + nudge;
  const ty = r * cell + (cell - d) / 2;

  const x = useSharedValue(tx);
  const y = useSharedValue(ty);
  const lift = useSharedValue(0);
  const pulse = useSharedValue(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; x.value = tx; y.value = ty; return; }
    x.value = withSpring(tx, { damping: 12, stiffness: 220, mass: 0.8 });
    y.value = withSpring(ty, { damping: 12, stiffness: 220, mass: 0.8 });
    // A brief rise on the way makes the move read as a hop, not a slide.
    lift.value = withSequence(
      withTiming(1, { duration: 90, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) }),
    );
  }, [tx, ty, x, y, lift]);

  useEffect(() => {
    if (movable) {
      pulse.value = withRepeat(withTiming(1, { duration: 620, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(pulse);
  }, [movable, pulse]);

  const a = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value - lift.value * cell * 0.35 },
      { scale: 1 + lift.value * 0.12 + pulse.value * 0.1 },
    ] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: d, height: d }, a]}>
      <Pressable
        onPress={movable ? onPress : undefined}
        disabled={!movable}
        // A ludo board is fifteen cells across, so on a phone a token is drawn
        // at about 19dp however big the board gets — measured on the Redmi at
        // 51px, which is 19dp, against a 44dp minimum target. The token cannot
        // grow without the board lying about where pieces sit, so the TOUCH
        // area grows instead: enough slop on each side to reach 44dp, and never
        // less than the 6 it always had.
        hitSlop={Math.max(6, Math.ceil((44 - d) / 2))}
        accessibilityRole="button"
        accessibilityState={{ disabled: !movable }}
        accessibilityLabel={ludoTokenLabel(COLOR_NAMES[seat] ?? 'Red', index, step, movable)}
        style={{
          width: '100%', height: '100%',
          alignItems: 'center', justifyContent: 'center',
          // The glow is a shadow on the WRAPPER, not on the vector — a coloured
          // drop shadow around an SVG path is far more expensive than one
          // around a plain view, and at this size the halo is a soft disc
          // either way.
          boxShadow:
            `0 3px 6px rgba(0,0,0,0.5), `
            + `0 0 ${movable ? 10 : 5}px ${seatA(seat, 'base', movable ? PAWN.glowMovable : PAWN.glowRest)}`,
        }}
      >
        {/* A TOKEN, not a disc. Head, waist, flared skirt, plinth — the
            silhouette is what makes a piece readable at 18.5dp, which is the
            only size it is ever drawn at. Geometry lives in ludoGlass so it can
            be checked without a renderer. */}
        <Svg width={d} height={d} viewBox="0 0 100 100">
          <Defs>
            <SvgLinear id={`pw${seat}`} x1="0.15" y1="0" x2="0.85" y2="1">
              <Stop offset="0" stopColor={PL[seat]} />
              <Stop offset="0.45" stopColor={P[seat]} />
              <Stop offset="1" stopColor={PD[seat]} />
            </SvgLinear>
            <SvgLinear id={`pb${seat}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={P[seat]} />
              <Stop offset="1" stopColor={PD[seat]} />
            </SvgLinear>
            {/* Reads PAWN.specular rather than restating it. Hardcoding the
                stop here is how the token module and the pixels drift apart —
                ludoGlass.selftest §11 fails if any PAWN token goes unused. */}
            <RadialGradient id={`ps${seat}`} cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0" stopColor={GLINT} stopOpacity={PAWN.specular} />
              <Stop offset="1" stopColor={GLINT} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="50" cy="53" r="45" fill={seatA(seat, 'deep', 0.9)}
            stroke={movable ? LR.text : PL[seat]} strokeWidth={movable ? 5 : 3} />
          <Circle cx="50" cy="51" r="38" fill={`url(#pb${seat})`} stroke={w(0.4)} strokeWidth="1.8" />
          {/* plinth first — it sits under the body */}
          <Path d={PAWN_BASE} fill={`url(#pb${seat})`} stroke={seatA(seat, 'light', 0.6)} strokeWidth="2.8" />
          <Path
            d={PAWN_BODY}
            fill={`url(#pw${seat})`}
            // White only when the roll permits it, so "can move" is a change of
            // material rather than merely a thicker edge.
            stroke={movable ? white(PAWN.rimMovable) : seatA(seat, 'light', PAWN.rimRest)}
            strokeWidth={movable ? 5 : 3.4}
          />
          {/* one specular on the head. Two would read as plastic. */}
          <Ellipse cx="44" cy="22.5" rx="6.5" ry="4.5" fill={`url(#ps${seat})`} transform="rotate(28 44 22.5)" />
          {/* the colourblind marker rides the SKIRT, the widest part — in the
              head it would be ~3dp on a real phone and simply gone. */}
          <SvgText
            x="50" y="70" fontSize="26" fontWeight="bold"
            fill={PAWN.markerInk} textAnchor="middle"
          >{SHAPE[seat]}</SvgText>
        </Svg>
      </Pressable>
    </Animated.View>
  );
}
