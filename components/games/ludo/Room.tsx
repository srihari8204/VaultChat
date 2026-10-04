// components/games/ludo/Room.tsx — the midnight room, the light under the board,
// and the static board itself. Split out of components/games/Ludo.tsx;
// behaviour unchanged. The board is one SVG and is hidden from assistive tech:
// it is a picture, and every token on it is its own labelled control.

import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, {
  Defs, RadialGradient, LinearGradient as SvgLinear, Stop, Rect, G as SvgG, Polygon,
  Text as SvgText, Circle, Ellipse, Path,
} from 'react-native-svg';
import {
  LR, LR_AMBIENT, LR_STAGE, SEAT, P, PL, PD, SHAPE, LG, WELL, TRACK, YARD, GLINT, w, seatA,
} from '../../../lib/games/ludoGlass';
import { RING, START_OFFSET, HOME_COORDS, BASE_SPOTS, SAFE, YARD_RC } from '../../../lib/games/ludoBoard';

/* ── the room ───────────────────────────────────────────────────────── */

/**
 * The room this board plays in.
 *
 * Local rather than the shared TableBackground for the same reason ChessRoom
 * is: that surface is a maroon card table and other games sit on it. Ludo was
 * redesigned to a midnight room (2026-09-06) and changing the shared ground
 * would have taken Rummy and Tic-Tac-Toe with it.
 *
 * One SVG for all four glows, so the whole room costs a single view rather than
 * a stack of gradient wrappers. No dot grain: the shared table needs one because
 * a large expanse of flat maroon bands on cheap panels, and there is never an
 * area of flat colour that large on this screen.
 */
export function LudoRoom({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flex: 1, backgroundColor: LR.bg }, style]}>
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          {LR_AMBIENT.map((g, i) => (
            <RadialGradient key={i} id={'lr' + i} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
              {/* Four stops, not two. A two-stop falloff left a visible hard
                  ring where the mid stop sat, and a gradient that ends abruptly
                  reads as a drawn circle rather than as light. */}
              <Stop offset="0"    stopColor={g.color} stopOpacity={g.opacity} />
              <Stop offset="0.35" stopColor={g.color} stopOpacity={g.opacity * 0.55} />
              <Stop offset="0.68" stopColor={g.color} stopOpacity={g.opacity * 0.18} />
              <Stop offset="1"    stopColor={g.color} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {LR_AMBIENT.map((_, i) => (
          <Rect key={i} x="0" y="0" width="100%" height="100%" fill={'url(#lr' + i + ')'} />
        ))}
      </Svg>
      {children}
    </View>
  );
}

/**
 * The light the board sits on.
 *
 * Not decoration, and the single highest-leverage thing in this restyle: every
 * surface ON the board is translucent white, so without a lit ground beneath
 * them the whole board composites toward the room's near-black and no amount of
 * tinting the cells recovers it. The first pass of this design was a grey smudge
 * for exactly this reason.
 *
 * Sized against the BOARD, not the screen. At screen scale it lit the chrome
 * instead and the room stopped being midnight.
 *
 * Memoised on `size` alone, like BoardSvg — it must not re-render per move.
 */
export const StageLight = React.memo(function StageLight({ size }: { size: number }) {
  const d = size * LR_STAGE.scale;
  return (
    <Svg
      width={d} height={d} pointerEvents="none"
      style={{ position: 'absolute', left: (size - d) / 2, top: (size - d) / 2 }}
    >
      <Defs>
        <RadialGradient id="lstage" cx="50%" cy="50%" rx="50%" ry="50%">
          {LR_STAGE.stops.map(s => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </RadialGradient>
      </Defs>
      <Ellipse cx={d / 2} cy={d / 2} rx={d / 2} ry={d / 2} fill="url(#lstage)" />
    </Svg>
  );
});

/* ── the board ──────────────────────────────────────────────────────── */

/**
 * The whole static board in one SVG, drawn in grid units (0..15) so every
 * coordinate below reads as a cell reference rather than a pixel.
 *
 * MEMOISED, and it matters more than it looks: this is ~80 SVG nodes with
 * gradient fills, and `size` is the only thing it reads — a number fixed for
 * the life of the screen. Without the memo every dice roll, every token move
 * and every turn change rebuilt the entire board underneath the pieces, which
 * is the most expensive thing on the screen being redrawn to show exactly the
 * same picture.
 */
export const BoardSvg = React.memo(function BoardSvg({ size }: { size: number }) {
  const homeCells = useMemo(() => {
    const out: { rc: [number, number]; seat: number }[] = [];
    for (let s = 0; s < 4; s++) for (let i = 0; i < 5; i++) out.push({ rc: HOME_COORDS[s][i], seat: s });
    return out;
  }, []);
  const stars = useMemo(() => [...SAFE].filter(i => !START_OFFSET.includes(i)), []);

  return (
    <Svg width={size} height={size} viewBox="0 0 15 15" style={{ position: 'absolute', borderRadius: 20 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        {/* Glass frame surrounds the familiar light track and colored homes. */}
        <RadialGradient id="lfelt" cx="50%" cy="50%" rx="65%" ry="65%">
          <Stop offset="0.42" stopColor={GLINT} stopOpacity={LG.pane} />
          <Stop offset="1" stopColor={GLINT} stopOpacity={LG.pane * 0.42} />
        </RadialGradient>
        <RadialGradient id="lsheen" cx="26%" cy="18%" rx="60%" ry="60%">
          <Stop offset="0" stopColor={GLINT} stopOpacity={LG.sheen} />
          <Stop offset="0.55" stopColor={GLINT} stopOpacity="0" />
        </RadialGradient>
        {SEAT.map((s, i) => (
          <SvgLinear key={i} id={`lyard${i}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={s.light} stopOpacity={YARD.fillTop} />
            <Stop offset="0.55" stopColor={s.base} stopOpacity={YARD.fillMid} />
            <Stop offset="1" stopColor={s.deep} stopOpacity={YARD.fillBottom} />
          </SvgLinear>
        ))}
        {P.map((_, i) => (
          <SvgLinear
            key={i} id={`lhome${i}`}
            x1="0" y1="0"
            x2={i === 1 || i === 3 ? '0' : '1'}
            y2={i === 1 || i === 3 ? '1' : '0'}
          >
            <Stop offset="0" stopColor={PL[i]} />
            <Stop offset="0.55" stopColor={P[i]} />
            <Stop offset="1" stopColor={PD[i]} />
          </SvgLinear>
        ))}
      </Defs>

      <Rect x="0.025" y="0.025" width="14.95" height="14.95" rx="0.55" fill="url(#lfelt)" stroke={w(0.42)} strokeWidth="0.05" />
      <Rect x="0.1" y="0.1" width="14.8" height="14.8" rx="0.48" fill="url(#lsheen)" stroke={w(0.12)} strokeWidth="0.035" />

      {RING.map(([r, c], i) => (
        <SvgG key={`r${i}`}>
        <Rect
          x={c + 0.03} y={r + 0.03} width="0.94" height="0.94" rx="0.07"
          fill={SAFE.has(i) ? TRACK.safe : TRACK.cell}
          stroke={TRACK.edge} strokeWidth="0.035"
        />
        <Path d={`M ${c + 0.2} ${r + 0.13} H ${c + 0.8}`} stroke={w(0.3)} strokeWidth="0.035" strokeLinecap="round" />
        </SvgG>
      ))}

      {homeCells.map(({ rc: [r, c], seat }, i) => (
        <Rect key={`h${i}`} x={c + 0.03} y={r + 0.03} width="0.94" height="0.94" rx="0.07" fill={`url(#lhome${seat})`} stroke={w(0.55)} strokeWidth="0.045" />
      ))}

      {/* start squares — solid colour plus an arrow pointing into the track */}
      {START_OFFSET.map((off, seat) => {
        const [r, c] = RING[off];
        return (
          <SvgG key={`s${seat}`}>
            <Rect x={c + 0.03} y={r + 0.03} width="0.94" height="0.94" rx="0.07" fill={seatA(seat, 'base', 0.92)} stroke={w(0.7)} strokeWidth="0.045" />
            <Path d={`M ${c + 0.25} ${r + 0.5} H ${c + 0.73} M ${c + 0.53} ${r + 0.29} L ${c + 0.74} ${r + 0.5} L ${c + 0.53} ${r + 0.71}`}
              fill="none" stroke={TRACK.ink} strokeWidth="0.085" strokeLinecap="round" strokeLinejoin="round"
              transform={`rotate(${seat * 90} ${c + 0.5} ${r + 0.5})`} />
          </SvgG>
        );
      })}

      {stars.map(i => {
        const [r, c] = RING[i];
        return <Path key={`st${i}`} d="M .5 .17 L .6 .38 L .84 .41 L .66 .58 L .71 .82 L .5 .7 L .29 .82 L .34 .58 L .16 .41 L .4 .38 Z"
          transform={`translate(${c} ${r})`} fill="none" stroke={TRACK.ink} strokeWidth="0.065" strokeLinejoin="round" />;
      })}

      {/* centre — four triangles meeting in the middle, one per seat */}
      <Polygon points="6,6 9,6 7.5,7.5" fill="url(#lhome1)" stroke={w(0.35)} strokeWidth="0.035" />
      <Polygon points="9,6 9,9 7.5,7.5" fill="url(#lhome2)" stroke={w(0.35)} strokeWidth="0.035" />
      <Polygon points="9,9 6,9 7.5,7.5" fill="url(#lhome3)" stroke={w(0.35)} strokeWidth="0.035" />
      <Polygon points="6,9 6,6 7.5,7.5" fill="url(#lhome0)" stroke={w(0.35)} strokeWidth="0.035" />
      <Rect x="6" y="6" width="3" height="3" rx="0.14" fill="none" stroke={w(0.55)} strokeWidth="0.08" />
      <Circle cx="7.5" cy="7.5" r="0.64" fill={LR.bg} stroke={SEAT[2].light} strokeWidth="0.065" />
      <Circle cx="7.5" cy="7.5" r="0.5" fill={w(0.06)} stroke={w(0.3)} strokeWidth="0.025" />
      <SvgText x="7.5" y="7.72" fontSize="0.67" fill={SEAT[2].light} textAnchor="middle">★</SvgText>

      {/* the four yards */}
      {YARD_RC.map(([r, c], seat) => (
        <SvgG key={`y${seat}`}>
          <Rect
            x={c + 0.25} y={r + 0.25} width="5.5" height="5.5" rx="0.7"
            fill={`url(#lyard${seat})`}
            // The rim is the seat's LIGHT tone, not its base: on a quadrant now
            // filled with that same base, a base-coloured edge disappeared into
            // it and the yard lost its shape.
            stroke={seatA(seat, 'light', YARD.rim)} strokeWidth="0.07"
          />
          <Rect x={c + 0.48} y={r + 0.48} width="5.04" height="5.04" rx="0.52"
            fill={TRACK.cell} stroke={w(0.8)} strokeWidth="0.035" />
          <Path d={`M ${c + 0.85} ${r + 0.64} H ${c + 5.15}`}
            stroke={w(0.65)} strokeWidth="0.055" strokeLinecap="round" />
          <Circle cx={c + 3} cy={r + 3} r="0.68" fill={seatA(seat, 'deep', 0.55)} stroke={seatA(seat, 'light', 0.8)} strokeWidth="0.045" />
          <Circle cx={c + 3} cy={r + 3} r="0.54" fill="none" stroke={w(0.24)} strokeWidth="0.025" />
          <SvgText x={c + 3} y={r + 3.24} fontSize="0.7" fill={LR.text} textAnchor="middle">{SHAPE[seat]}</SvgText>
          {BASE_SPOTS[seat].map(([br, bc], i) => (
            // Inset sockets retain a visible seat-colored rim beneath each pawn.
            <SvgG key={i}>
              <Circle cx={bc + 0.5} cy={br + 0.54} r="0.64" fill={seatA(seat, 'deep', 0.6)} />
              <Circle cx={bc + 0.5} cy={br + 0.5} r="0.6" fill={WELL} stroke={PD[seat]} strokeWidth="0.055" />
              <Circle cx={bc + 0.5} cy={br + 0.5} r="0.46" fill={seatA(seat, 'base', 0.18)} stroke={seatA(seat, 'deep', 0.35)} strokeWidth="0.025" />
            </SvgG>
          ))}
        </SvgG>
      ))}
    </Svg>
  );
});
