// components/games/chess/Square.tsx — one square of the board, and the piece on it.
// Split out of components/games/Chess.tsx; behaviour unchanged.

import React, { useEffect, useRef } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import Svg, { Path, Ellipse, Defs, LinearGradient as SvgLinear, Stop } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import { CR } from '../../../lib/games/chessRoom';
import { chessSquareLabel } from '../../../lib/games/boardLabels';
import type { Piece } from '../../../lib/games/chessView';
import {
  CHECK_RED, DOT, PIECE_PATH, PIECE_INK, PIECE_SHADE, CONTACT_SHADOW, type Ink,
} from './style';

/* ── one square ─────────────────────────────────────────────────────── */

/**
 * MEMOISED, and it takes `onPress(sq)` rather than a closure.
 *
 * 64 of these mount, each owning a shared value and an effect, and every one
 * was rebuilt on every render of the screen — including the one-second clock
 * tick, which is what put the 250ms frames in this board's p90. The two things
 * that defeated memoisation were an `onPress={() => onSquare(idx)}` literal per
 * square and the unstable `legal`/`board` fallbacks feeding it; both are fixed,
 * so a tick now re-renders the clock and nothing else. A real move still
 * re-renders the squares, which is the point.
 *
 * Ludo's BoardSvg and Rummy's HandCard are both already memoised for the same
 * reason — chess was the board that missed it.
 */
export const Square = React.memo(function Square({
  d, sq, cell, bg, tint, check, piece, pieceSize,
  target, capture, selected, last, slideFrom, onPress, stroke, ink, dot, ring, still, interactive,
}: {
  /** Where it is DRAWN (0 = top-left of the board as this player sees it). */
  d: number;
  /** Which square it actually IS (0 = a8). These differ when the board is flipped. */
  sq: number;
  cell: number; bg: string; tint: string | null; check: boolean; selected: boolean; last: boolean;
  piece: Piece; pieceSize: number; target: boolean; capture: boolean;
  slideFrom: { dx: number; dy: number; key: string } | null;
  onPress: (sq: number) => void; stroke: number;
  /** All three fall back to the painted-board defaults. See BoardTheme. */
  ink?: Ink; dot?: string; ring?: string;
  /** Reduced motion: the check marker holds instead of pulsing. */
  still?: boolean;
  /** The board takes taps (your turn, connected, not watching). Announced as
   *  disabled otherwise, so a screen-reader player is not left tapping. */
  interactive: boolean;
}) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (check && !still) {
      pulse.value = withRepeat(withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
    return () => cancelAnimation(pulse);
  }, [check, still, pulse]);
  const aCheck = useAnimatedStyle(() => ({ opacity: check ? 0.55 - pulse.value * 0.25 : 0 }));

  return (
    <Pressable
      onPress={() => onPress(sq)}
      accessibilityLabel={chessSquareLabel(sq, piece, { target, capture, check, last })}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !interactive }}
      style={{
        position: 'absolute',
        left: (d & 7) * cell, top: (d >> 3) * cell,
        width: cell, height: cell,
        backgroundColor: bg,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* Keep the playing squares flat: glass belongs to the surrounding controls. */}
      {tint ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: tint }} /> : null}
      {last && !selected ? <View pointerEvents="none" style={{ position: 'absolute', left: 3, top: 3, width: cell * 0.16, height: cell * 0.16, borderTopWidth: 2, borderLeftWidth: 2, borderColor: CR.gold2 }} /> : null}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', inset: 0, backgroundColor: CHECK_RED }, aCheck]} />

      {selected ? <View pointerEvents="none" style={{ position: 'absolute', inset: 1, borderWidth: 2.5, borderRadius: 3, borderColor: CR.gold2 }} /> : null}
      {/* Capture ring sits behind the piece; the plain dot marks an empty target. */}
      {target && capture ? (
        <View pointerEvents="none" style={{
          position: 'absolute', width: cell * 0.92, height: cell * 0.92,
          borderRadius: cell * 0.46, borderWidth: Math.max(2, cell * 0.055), borderColor: ring ?? 'rgba(40,35,28,.3)',
        }} />
      ) : null}

      {piece ? <PieceGlyph piece={piece} size={pieceSize} slideFrom={slideFrom} stroke={stroke} ink={ink} still={still} /> : null}

      {target && !capture ? (
        <View pointerEvents="none" style={{
          position: 'absolute', width: cell * 0.3, height: cell * 0.3,
          borderRadius: cell * 0.15, backgroundColor: dot ?? DOT,
        }} />
      ) : null}
    </Pressable>
  );
});

/**
 * The piece, with the last-move slide.
 *
 * Ported from chess.js: the piece is placed at its ORIGIN offset with no
 * animation, then released to zero. Keying on history length as well as the
 * squares means a repeated shuffle still animates each time rather than once.
 */
function PieceGlyph({
  piece, size, slideFrom, stroke, ink, still,
}: {
  piece: NonNullable<Piece>; size: number;
  slideFrom: { dx: number; dy: number; key: string } | null; stroke: number; ink?: Ink;
  still?: boolean;
}) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const played = useRef<string | null>(null);

  useEffect(() => {
    if (!slideFrom || played.current === slideFrom.key) return;
    played.current = slideFrom.key;
    // Reduced motion: the piece is simply THERE. The move still happened and
    // the last-move highlight still marks it; only the travel is dropped.
    if (still) { x.value = 0; y.value = 0; return; }
    x.value = slideFrom.dx;
    y.value = slideFrom.dy;
    const spec = { duration: 200, easing: Easing.bezier(0.2, 0.8, 0.2, 1) };
    x.value = withTiming(0, spec);
    y.value = withTiming(0, spec);
  }, [slideFrom, still, x, y]);

  // Cast: a mixed [{translateX},{translateY}] tuple widens to a union RN's
  // transform type will not accept.
  const a = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={a} pointerEvents="none">
      <OutlinedGlyph t={piece.t} c={piece.c} size={size} stroke={stroke} ink={ink} />
    </Animated.View>
  );
}

/**
 * A piece glyph with a REAL outline, not a glow.
 *
 * The reference client draws white with the hollow glyph set plus a CSS
 * -webkit-text-stroke; RN has neither, and the soft textShadow that stood in
 * for it read as a halo — on the green board a white piece blurred into the
 * light squares instead of sitting on them.
 *
 * Four offset copies of the SAME glyph behind the fill give a crisp edge.
 * Deliberately NOT the hollow set (♔ vs ♚): whether ♔ renders hollow is a
 * font-fallback question, and on a device that answers it the other way the
 * white king would come out solid black. A board where you cannot tell your own
 * pieces apart is a worse bug than a soft edge; one glyph set always renders as
 * one shape.
 *
 * Shared with the promotion picker, which shows the same four pieces at four
 * times the size — the place a mismatched piece style is most obvious.
 */
export function OutlinedGlyph({
  t, c, size, stroke, ink,
}: { t: string; c: 'w' | 'b'; size: number; stroke: number; ink?: Ink }) {
  const { fill, line } = (ink ?? PIECE_INK)[c];
  // A letter with no path would draw NOTHING, and an empty square on a chess
  // board reads as a piece that has been captured. Falling back to the pawn is
  // wrong in a way somebody notices rather than wrong in a way nobody does.
  const d = PIECE_PATH[t] ?? PIECE_PATH.p;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <SvgLinear id={`body${c}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={PIECE_SHADE[c].hi} />
            <Stop offset="0.4" stopColor={fill} />
            <Stop offset="1" stopColor={PIECE_SHADE[c].lo} />
          </SvgLinear>
          {/* Brass, lit from above: hot cap, body, dark underside. The same
              three tones the board rim uses, so the pieces and the frame read
              as one set of hardware rather than two golds. */}
          <SvgLinear id={`plinth${c}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={CR.gold2} />
            <Stop offset="0.55" stopColor={CR.gold} />
            <Stop offset="1" stopColor={CR.goldDeep} />
          </SvgLinear>
        </Defs>
        {/* CONTACT SHADOW. Without it a piece floats on the square instead of
            standing on it, and that is most of what made the old set read as
            flat glyphs rather than objects. */}
        <Ellipse cx="50" cy="91" rx="33" ry="5.2" fill={CONTACT_SHADOW} opacity={0.28} />
        {/* The gold ring the piece stands in. Drawn BEFORE the piece so its own
            base slab sits on top of it and only the rim shows. */}
        <Ellipse
          cx="50" cy="88.5" rx="31" ry="6.4"
          fill={`url(#plinth${c})`}
          stroke={CR.goldDeep} strokeWidth="1.1"
        />
        <Path d={d} fill={`url(#body${c})`} stroke={c === 'b' ? PIECE_SHADE.b.edge : line} strokeWidth={stroke} strokeLinejoin="round" />
        {/* Engraved details separate silhouettes at phone size without font glyphs. */}
        <Path d="M 28 83 L 72 83" fill="none" stroke={c === 'w' ? line : PIECE_SHADE.b.engrave} strokeWidth="1.8" opacity={0.55} />
        {t === 'r' ? <Path d="M 30 35 L 70 35 M 37 44 L 63 44 M 40 63 L 60 63" fill="none" stroke={c === 'w' ? line : PIECE_SHADE.b.engrave} strokeWidth="2.5" strokeLinecap="round" /> : null}
        {t === 'b' ? <Path d="M 53 30 L 44 45" fill="none" stroke={c === 'w' ? line : PIECE_SHADE.b.engrave} strokeWidth="3" strokeLinecap="round" /> : null}
        {t === 'n' ? <Ellipse cx="64" cy="29" rx="2.3" ry="2.3" fill={c === 'w' ? line : PIECE_SHADE.b.eye} /> : null}
        {t === 'q' || t === 'k' ? <Path d="M 37 62 L 63 62" fill="none" stroke={c === 'w' ? line : PIECE_SHADE.b.engrave} strokeWidth="2" strokeLinecap="round" /> : null}
      </Svg>
    </View>
  );
}
