import { useGamePalette } from './appearance';
import { AuroraBackground } from '../ui/AuroraBackground';
// components/games/ui.tsx — shared game-table furniture.
//
// Ported from games-web/theme.css. These exist so the four boards cannot drift
// apart: the web client's polish comes largely from every game reusing one
// panel, one button and one banner, and the first native attempt re-styled
// each board by hand and looked like four different apps.

import { AppText as Text } from '../ui/Text';
import React from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View,
  useWindowDimensions, type LayoutChangeEvent, type ViewStyle, type StyleProp,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect, Pattern, Circle, Path } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  withSequence, withDelay, Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  C, S, R, E, D3, T, glass, goldLine, mix, alpha, white, MOTION, AMBIENT, GRAIN,
  GOLD_FILL, GOLD_STOPS, RED_FILL, RED_STOPS, typeScale, ACCENT, type GameAccent,
} from '../../lib/games/theme';
import { boardFit } from '../../lib/games/boardFit';
// The four rooms, for ROOM_BG below. Imported rather than re-typed: a hex
// copied here is a hex that drifts the first time a room is repainted.
import { CR } from '../../lib/games/chessRoom';
import { LR } from '../../lib/games/ludoGlass';
import { ROOM } from '../../lib/games/rummyGlass';

const AnimPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The boards' icon set.
 *
 * These used to be emoji, and so came from four different families at once:
 * flat glyphs (↻, ⧉) sitting beside full-colour emoji (🎲, 🤖) that no theme
 * colour can reach and that redraw themselves differently on every Android
 * skin. The rest of crazzychat draws icons from Ionicons — 178 call sites — so
 * the boards now do too, and an icon simply takes its button's foreground
 * colour.
 *
 * `Btn` still renders an unrecognised string as text, so a one-off glyph is
 * always possible without adding a name here.
 */
const ICONS = {
  share: 'share-social-outline',
  link: 'link-outline',
  rules: 'book-outline',
  bot: 'hardware-chip-outline',
  dice: 'dice-outline',
  emote: 'happy-outline',
  lock: 'lock-closed-outline',
  copy: 'copy-outline',
  mic: 'mic-outline',
  // The voice controls passed 🔇 / 🎙 / 🔊 / 🎧 straight to `Btn`, which has no
  // name for them and so fell through to the raw-text branch below — four
  // full-colour emoji from a fifth family, on the one control row that already
  // had `mic` sitting here unused.
  micOff: 'mic-off-outline',
  speaker: 'volume-high-outline',
  headset: 'headset-outline',
  retry: 'refresh-outline',
  // The icon-only controls. These were typographic glyphs - a gear, a bolt,
  // and the box-drawing pair - which is a fourth family again, and the two
  // box glyphs are the kind of character a font may simply not have.
  settings: 'settings-outline',
  sort: 'flash-outline',
  group: 'layers-outline',
  ungroup: 'remove-circle-outline',
  trophy: 'trophy-outline',
  history: 'time-outline',
  declare: 'checkmark-circle-outline',
  drop: 'exit-outline',
} as const;

export type GameIconName = keyof typeof ICONS;

/**
 * The four games' identity marks.
 *
 * These were TYPOGRAPHIC CHARACTERS — ♛ ♠ ⚄ ✕ — which is the same mistake the
 * control icons made and were fixed for, one layer up. A glyph is drawn by
 * whatever font the platform resolves it to: ⚄ is a die on one Android skin and
 * a tofu box on another, ♛ arrives already black on several, and a character
 * the font paints itself does not take `color` at all. So the one thing this
 * change is FOR — giving each game a colour that carries from its card through
 * to its board — was not reachable while these were text.
 *
 * They are drawn here rather than taken from Ionicons because Ionicons has no
 * chess piece, and mixing a second icon family back in is precisely what the
 * commit above spent its effort removing. Control icons stay Ionicons; a game's
 * identity mark is artwork, and there are exactly four of them.
 */
export function GameGlyph({ game, size = 30, color }: { game: GameAccent; size?: number; color?: string }) {
  const c = color ?? ACCENT[game];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {game === 'chess' && (
        <>
          <Path d="M5 17.5h14l1.2-9.2-4.4 3.3L12 4.6 8.2 11.6 3.8 8.3 5 17.5Z" fill={c} />
          <Rect x={4.6} y={18.8} width={14.8} height={2.6} rx={1.3} fill={c} />
        </>
      )}
      {game === 'rummy' && (
        <>
          <Path d="M12 2.8c3.1 4.2 7.2 6.2 7.2 9.8A4.7 4.7 0 0 1 12 16.2a4.7 4.7 0 0 1-7.2-3.6C4.8 9 8.9 7 12 2.8Z" fill={c} />
          <Path d="M10.9 15.1c0 3.2-1 4.8-2.6 6h7.4c-1.6-1.2-2.6-2.8-2.6-6h-2.2Z" fill={c} />
        </>
      )}
      {game === 'ludo' && (
        <>
          <Rect x={3} y={3} width={18} height={18} rx={4.5} stroke={c} strokeWidth={2} fill="none" />
          {[[8.2, 8.2], [15.8, 8.2], [12, 12], [8.2, 15.8], [15.8, 15.8]].map(([cx, cy]) => (
            <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.7} fill={c} />
          ))}
        </>
      )}
      {game === 'tictactoe' && (
        <Path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" stroke={c} strokeWidth={3.2} strokeLinecap="round" />
      )}
    </Svg>
  );
}

/**
 * A board edge that fits THIS screen, not just its width.
 *
 * Sizing a square board off width alone overflows on short screens and on
 * landscape, where the height is the binding constraint — the board then runs
 * off the bottom and the controls under it become unreachable. `chrome` is the
 * vertical space the seats, buttons and status line need around it.
 *
 * NO UPPER CAP. It used to stop at 460 (380 for tic-tac-toe), so every display
 * bigger than a mid-size phone got the same board floating in empty space. The
 * board now takes the room it is given. It also sizes against the SAFE area,
 * so a cutout or a gesture bar eats into the margin rather than into the board.
 *
 * The arithmetic and its edge cases live in lib/games/boardFit.ts so they can
 * be checked without a renderer — the rummy hand shipped a fit bug that every
 * model-only test agreed was fine.
 */
const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * The same board edge, but measured off the CONTAINER the board actually sits
 * in rather than off the window.
 *
 * The window is not the box. A navigator header, a cutout and a gesture bar all
 * sit between the two, and the difference is not a constant — which is how the
 * rummy table ended up 76px off centre: geometry derived from the window, laid
 * out inside a container that had already had the inset taken out of it.
 *
 * So when a real measurement exists it is used with NO INSETS SUBTRACTED. That
 * is not an oversight: a measured layout box is already inside the safe area,
 * and taking the inset off a second time is precisely the bug. The window path
 * below is only the first frame, before onLayout has fired.
 *
 * `chrome` stays a declared per-game constant rather than a measured one. The
 * status line, voice bar and action row are all laid out `width: size`, so
 * their heights depend on the board — measuring them to compute the board
 * would close a feedback loop, and a layout that oscillates is worse than one
 * that estimates. The ScrollView absorbs any error in the estimate.
 */
export function useBoardBox(chrome = 300): { size: number; width: number; height: number; onLayout: (e: LayoutChangeEvent) => void } {
  const win = useWindowDimensions();
  // Destructured to four numbers on purpose: the inset OBJECT gets a new
  // identity on every render, so depending on it re-runs the memo constantly,
  // and depending on its fields while naming the object is what the linter
  // rightly complains about.
  const { top, bottom, left, right } = useSafeAreaInsets();
  const [box, setBox] = React.useState({ w: 0, h: 0 });

  // Identical measurements must return the SAME object, or every layout pass
  // sets state and the pass repeats forever.
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox(prev => (Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5)
      ? prev
      : { w: width, h: height });
  }, []);

  const size = React.useMemo(
    () => (box.w > 0 && box.h > 0
      ? boardFit({ width: box.w, height: box.h }, NO_INSETS, chrome).size
      : boardFit({ width: win.width, height: win.height }, { top, bottom, left, right }, chrome).size),
    [box.w, box.h, win.width, win.height, top, bottom, left, right, chrome],
  );

  return {
    size,
    width: box.w || win.width - left - right,
    height: box.h || win.height - top - bottom,
    onLayout,
  };
}

/**
 * A play coin.
 *
 * This was 🪙 — a full-colour emoji redrawn differently on every Android skin
 * and unreachable by any theme colour — and the icon pass replaced it with a
 * flat gold circle, which is honest but reads as a bullet point rather than as
 * money. This is the same idea drawn properly: a struck disc with a rim, a lit
 * top-left and a shadowed lower-right, so it catches the eye the way a coin
 * does without becoming a cartoon.
 *
 * Vector, so it scales to any size and takes its colour from the theme — the
 * whole reason the emoji had to go. Used by the hub's balance chip and by
 * ludo's stake panel, which are the two places a balance appears.
 */
export function Coin({ size = 14 }: { size?: number }) {
  const id = `coin${Math.round(size)}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Defs>
        {/* Lit from the top-left, like every other raised surface in the games. */}
        <RadialGradient id={id} cx="34%" cy="28%" rx="78%" ry="78%">
          <Stop offset="0" stopColor={C.gold2} />
          <Stop offset="0.55" stopColor={C.gold} />
          <Stop offset="1" stopColor={C.goldDeep} />
        </RadialGradient>
      </Defs>
      <Circle cx="12" cy="12" r="10.5" fill={`url(#${id})`} stroke={C.goldDeep} strokeWidth="1.2" />
      {/* The inner ring is what makes a disc read as STRUCK rather than drawn. */}
      <Circle cx="12" cy="12" r="7.2" fill="none" stroke={C.gold2} strokeWidth="0.9" opacity="0.55" />
      {/* A single specular highlight. Two would read as plastic. */}
      <Circle cx="8.6" cy="8.2" r="2.5" fill="#FFFFFF" opacity="0.34" />
    </Svg>
  );
}

/** Fluid type sizes, resolved against the real screen width. */
export function useType() {
  const { width } = useWindowDimensions();
  return React.useMemo(() => typeScale(width), [width]);
}

/**
 * The table itself: flat felt, three ambient glows and a fine dot grain.
 *
 * The grain is not fussiness — a large expanse of one dark red bands visibly
 * on cheap panels, and the 22px dot pattern is what the web client uses to
 * break it up. Both layers are a single SVG so this costs one view, not a
 * stack of gradient wrappers.
 */
export type Glow = { color: string; opacity: number; cx: string; cy: string; rx: string; ry: string };

/** A defocused highlight. Percentages, so it holds its place on any screen. */
export type Bokeh = { cx: string; cy: string; r: string; color: string; opacity: number };

/**
 * `bg`, `ambient` and `grain` exist so a board can bring its OWN room without
 * a second copy of this component.
 *
 * Chess plays in an emerald club and Ludo in a midnight one; both were first
 * written as a private `ChessRoom`/`LudoRoom` doing exactly what this does with
 * different constants, which is the duplication this file exists to prevent.
 * The defaults are the shared maroon card table, so every existing caller is
 * unchanged — Rummy and Tic-Tac-Toe still get what they always got.
 *
 * `grain` is off for a board that covers its own middle: the 22px dot pattern
 * is there to stop a large flat expanse banding on cheap panels, and a board
 * across the centre of the screen leaves nothing large enough to band.
 */
export function TableBackground({
  children, style, bg = C.bg, ambient = AMBIENT as readonly Glow[], grain = true,
  bokeh, vignette = 0,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  bg?: string;
  ambient?: readonly Glow[];
  grain?: boolean;
  /** Defocused highlights over the wash. Off unless a room asks for them. */
  bokeh?: readonly Bokeh[];
  /** Edge darkness, 0..1. 0 is off, which is what every existing caller gets. */
  vignette?: number;
}) {
  const palette = useGamePalette();
  if (palette.light) return <View style={[{ flex: 1, backgroundColor: palette.bg }, style]}><AuroraBackground variant="mini" />{children}</View>;
  return (
    <View style={[{ flex: 1, backgroundColor: bg }, style]}>
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          {ambient.map((g, i) => (
            <RadialGradient key={i} id={'amb' + i} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
              <Stop offset="0" stopColor={g.color} stopOpacity={g.opacity} />
              {/* A mid stop, so a wide glow reads as light in the room rather
                  than as a ring. Linear falloff from full to zero across a 60%
                  radius is what made the first pass look like a vignette. */}
              <Stop offset="0.55" stopColor={g.color} stopOpacity={g.opacity * 0.42} />
              <Stop offset="1" stopColor={g.color} stopOpacity={0} />
            </RadialGradient>
          ))}
          {(bokeh ?? []).map((b, i) => (
            <RadialGradient key={'bk' + i} id={'bok' + i} cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0" stopColor={b.color} stopOpacity={b.opacity} />
              <Stop offset="0.55" stopColor={b.color} stopOpacity={b.opacity * 0.75} />
              {/* Brightest at the RIM. A defocused point of light is a ring,
                  not a dot — draw it as a dot and it reads as lens dirt. */}
              <Stop offset="0.88" stopColor={b.color} stopOpacity={b.opacity * 1.15} />
              <Stop offset="1" stopColor={b.color} stopOpacity={0} />
            </RadialGradient>
          ))}
          {vignette > 0 ? (
            <RadialGradient id="vig" cx="50%" cy="46%" rx="70%" ry="62%">
              <Stop offset="0" stopColor="#000000" stopOpacity={0} />
              <Stop offset="0.55" stopColor="#000000" stopOpacity={vignette * 0.24} />
              <Stop offset="1" stopColor="#000000" stopOpacity={vignette} />
            </RadialGradient>
          ) : null}
          <Pattern id="grain" width={GRAIN.size} height={GRAIN.size} patternUnits="userSpaceOnUse">
            <Circle cx={GRAIN.dot} cy={GRAIN.dot} r={GRAIN.dot} fill={GRAIN.color} />
          </Pattern>
        </Defs>
        {ambient.map((_, i) => <Rect key={i} x="0" y="0" width="100%" height="100%" fill={'url(#amb' + i + ')'} />)}
        {(bokeh ?? []).map((b, i) => (
          <Circle key={'bc' + i} cx={b.cx} cy={b.cy} r={b.r} fill={'url(#bok' + i + ')'} />
        ))}
        {/* Vignette over the light, grain over everything: the grain is there to
            break up banding, and a gradient laid on top of it would band again. */}
        {vignette > 0 ? <Rect x="0" y="0" width="100%" height="100%" fill="url(#vig)" /> : null}
        {grain ? <Rect x="0" y="0" width="100%" height="100%" fill="url(#grain)" opacity={GRAIN.opacity} /> : null}
      </Svg>
      {children}
    </View>
  );
}

/** .glass / .panel / .lobby / .tablecard */
export function Panel({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const palette = useGamePalette();
  return <View style={[glass, palette.light && { backgroundColor: palette.card, borderColor: palette.line }, { padding: S[4] }, style]}>{children}</View>;
}

/**
 * 'good' is the winning move — declare, accept, deal. It reads green because a
 * table's two irreversible actions (declare and drop) must not look alike: one
 * ends the hand in your favour, the other forfeits it, and both sit side by side.
 */
type BtnKind = 'gold' | 'secondary' | 'danger' | 'good' | 'ghost';

/** Deep felt-green fill for `good`, matched to the table it sits on. */
const GOOD_FILL = ['#2FA36A', '#15794A', '#0B5233'];
const GOOD_STOPS = [0, 0.55, 1];

/**
 * The one button.
 *
 * Press feedback is scale-to-.97 plus a haptic tick, matching the web's
 * :active transform. Gold buttons additionally run the shimmer sweep from
 * theme.css — on the web that fires on hover, which a phone does not have, so
 * here it runs once per press and then idles. A sweep looping forever reads as
 * a loading spinner and pulls the eye off the board.
 */
export function Btn({
  label, onPress, kind = 'secondary', disabled, busy, icon, style, compact, accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  kind?: BtnKind;
  disabled?: boolean;
  busy?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const C = useGamePalette();
  const t = useType();
  const scale = useSharedValue(1);
  // Sweep travels in px across the measured width. Percentages would be
  // simpler, but `left: '120%'` is not an animatable dimension in Reanimated.
  const sweep = useSharedValue(0);
  const [w, setW] = React.useState(0);
  const off = !!disabled || !!busy;

  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // The cast is only needed because a mixed [{translateX}, {skewX}] tuple
  // widens to a union RN's transform type will not accept.
  const aSweep = useAnimatedStyle(() => ({
    transform: [{ translateX: sweep.value }, { skewX: '-18deg' }] as ViewStyle['transform'],
  }));

  const press = () => {
    if (off) return;
    scale.value = withSequence(withTiming(0.97, { duration: 90 }), withSpring(1, MOTION.settle));
    if (kind === 'gold' && w > 0) {
      sweep.value = -w * 0.7;
      sweep.value = withDelay(40, withTiming(w * 1.3, { duration: 900, easing: Easing.out(Easing.quad) }));
    }
    Haptics.impactAsync(
      kind === 'danger' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
    ).catch(() => {});
    onPress?.();
  };

  // 'secondary' is GLASS rather than a painted gradient. It is the button that
  // appears three and four to a row under a board, and a row of opaque panels
  // read as a toolbar bolted onto the table rather than as part of it. The
  // three coloured kinds stay painted: gold, danger and good are the buttons
  // that must not be missed, and a surface you can see through is by definition
  // one that recedes.
  const isGlass = kind === 'secondary';
  const fill = kind === 'gold' ? GOLD_FILL : kind === 'danger' ? RED_FILL : GOOD_FILL;
  const stops = kind === 'gold' ? GOLD_STOPS : kind === 'danger' ? RED_STOPS : GOOD_STOPS;
  const fg = kind === 'gold' ? C.onGold : kind === 'danger' || kind === 'good' ? '#fff' : C.text;
  const border = kind === 'gold' ? C.goldDeep : kind === 'danger' ? '#7d0f2a' : kind === 'good' ? '#0a4a2e' : goldLine[18];

  const shadow =
    kind === 'gold' ? '0 8px 24px rgba(243,194,69,0.35), ' + D3.rim
    : kind === 'danger' ? '0 8px 24px rgba(225,29,72,0.35), inset 0 1px 0 rgba(255,255,255,0.25)'
    : '0 6px 18px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)';

  // Not `glassy()` from the theme: that carries elevation 12, which is a PANEL's
  // lift. A button lifted as far as the panel it sits on has nothing to sit on.
  const glassFace: ViewStyle = {
    backgroundColor: C.light ? C.panel2 : white(0.09),
    borderWidth: 1,
    borderColor: C.light ? C.line : white(0.20),
    borderRadius: R[2],
    boxShadow: `0 6px 18px rgba(0,0,0,0.35), inset 0 1px 0 ${white(0.18)}`,
  };

  const body = (
    <>
      {icon ? (
        ICONS[icon as GameIconName]
          ? <Ionicons name={ICONS[icon as GameIconName]} size={Math.round(t.md * 1.15)} color={fg} />
          : <Text style={{ fontSize: t.md, color: fg }}>{icon}</Text>
      ) : null}
      {busy
        ? <ActivityIndicator size="small" color={fg} />
        : label
          ? <Text numberOfLines={2} style={{ flexShrink: 1, textAlign: 'center', color: fg, fontSize: compact ? t.sm : t.md, fontWeight: '800', letterSpacing: 0.2 }}>{label}</Text>
          : null}
    </>
  );

  const inner: ViewStyle = {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2],
    paddingVertical: compact ? S[2] : S[3],
    paddingHorizontal: compact ? S[3] : S[4],
    // 44dp is the floor for a touch target, and padding alone did not reach it:
    // a compact button measured 37dp tall on the Redmi. Padding sizes a button
    // to its TEXT, which is the wrong thing to size a finger against.
    //
    // minWidth matters for the same reason now that a button may carry an icon
    // and NO label: 17dp of glyph plus 12dp either side is 41dp, and a control
    // narrow enough to miss is not saved by being tall enough to hit.
    minHeight: 44,
    minWidth: 44,
    borderRadius: R[2],
    overflow: 'hidden',
  };

  return (
    <AnimPressable
      onPress={press}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: !!busy }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[aStyle, { opacity: off ? 0.5 : 1, borderRadius: R[2] }, style]}
    >
      {kind === 'ghost' ? (
        <View style={[inner, { borderWidth: 1, borderColor: 'transparent' }]}>{body}</View>
      ) : isGlass ? (
        <View style={[glassFace, inner]}>{body}</View>
      ) : (
        // Only gold/danger/good reach this branch now, and all three are lit
        // diagonally. The vertical gradient variant existed for `secondary`,
        // which is glass and no longer painted at all.
        <View
          onLayout={e => setW(e.nativeEvent.layout.width)}
          style={{ borderRadius: R[2], borderWidth: 1, borderColor: border, boxShadow: shadow, overflow: 'hidden' }}
        >
          <LinearGradient
            colors={fill as unknown as [string, string, ...string[]]}
            locations={stops as unknown as [number, number, ...number[]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={inner}
          >
            {body}
            {kind === 'gold' && (
              <Animated.View
                pointerEvents="none"
                style={[styles.sweep, aSweep]}
              >
                <LinearGradient
                  colors={['transparent', 'rgba(255,255,255,0.55)', 'transparent']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={{ flex: 1 }}
                />
              </Animated.View>
            )}
          </LinearGradient>
        </View>
      )}
    </AnimPressable>
  );
}

/** Result / status banner. `tone` drives the accent, matching .banner.win/.lose. */
export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'win' | 'lose' | 'turn' }) {
  const t = useType();
  const accent = tone === 'win' ? C.win : tone === 'lose' ? C.lose : tone === 'turn' ? C.gold : goldLine[28];
  const glow = useSharedValue(0);

  React.useEffect(() => {
    if (tone === 'win') {
      glow.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(glow);
      glow.value = withTiming(0, { duration: 200 });
    }
    return () => cancelAnimation(glow);
  }, [tone, glow]);

  // winglow in theme.css pulses the halo, not the text.
  const aGlow = useAnimatedStyle(() => ({ shadowOpacity: 0.25 + glow.value * 0.5 }));

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[{
        alignSelf: 'stretch', paddingVertical: S[3], paddingHorizontal: S[4],
        borderRadius: R[3], borderWidth: 1, borderColor: accent,
        // Glass, tinted by its accent rather than filled with it. A banner is
        // the one surface on a board that changes meaning mid-game, so it must
        // stay legible as a state without becoming a coloured slab.
        backgroundColor: white(0.10),
        boxShadow: `${E[2]}, inset 0 1px 0 ${white(0.18)}`,
        shadowColor: accent, shadowRadius: 18, shadowOffset: { width: 0, height: 0 },
      }, aGlow]}
    >
      <Text style={{ color: tone === 'info' ? C.text : accent, fontSize: t.lg, fontWeight: '800', textAlign: 'center' }}>
        {text}
      </Text>
    </Animated.View>
  );
}

/** A lobby seat row (.players li). */
export function PlayerRow({
  name, tag, subtitle, accent, active,
}: { name: string; tag?: string; subtitle?: string; accent?: string; active?: boolean }) {
  const t = useType();
  return (
    <View
      accessibilityLabel={name + (tag ? ', ' + tag : '') + (subtitle ? ', ' + subtitle : '')}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3],
        paddingVertical: S[3], paddingHorizontal: S[3],
        borderRadius: R[2], borderWidth: 1,
        // An active seat is LIT, not outlined. It borrows the player's own
        // accent when it has one, so at a four-seat table whose turn it is
        // reads from the colour rather than from a slightly brighter edge.
        borderColor: active ? (accent ?? white(0.30)) : white(0.12),
        backgroundColor: white(active ? 0.12 : 0.06),
        boxShadow: active
          ? `0 8px 22px rgba(0,0,0,0.38), inset 0 1px 0 ${white(0.20)}`
          : `${D3.lift1}, inset 0 1px 0 ${white(0.12)}`,
      }}
    >
      {accent ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: accent, boxShadow: D3.rim }} /> : null}
      <Text style={{ flex: 1, color: C.text, fontSize: t.md, fontWeight: '700' }} numberOfLines={1}>{name}</Text>
      {/* Shrinkable and capped at one line. The name beside it is `flex: 1`, so
          an unbounded subtitle here wins the row and pushes the Tag off the
          right edge — the subtitle is caller-supplied and short only by
          convention (a colour name, "N wins"), never by contract. */}
      {subtitle ? (
        <Text numberOfLines={1} style={{ flexShrink: 1, color: active ? C.text : C.muted, fontSize: t.sm }}>{subtitle}</Text>
      ) : null}
      {tag ? <Tag label={tag} /> : null}
    </View>
  );
}

/** .tag / .tag.you */
export function Tag({ label, tone = 'gold' }: { label: string; tone?: 'gold' | 'plain' }) {
  return (
    <View style={{
      paddingHorizontal: S[2], paddingVertical: 2, borderRadius: R.pill,
      backgroundColor: tone === 'gold' ? C.gold : white(0.13),
      borderWidth: tone === 'gold' ? 0 : 1,
      borderColor: white(0.18),
      boxShadow: tone === 'gold' ? '0 4px 12px rgba(243,194,69,0.30)' : undefined,
    }}>
      <Text style={{ color: tone === 'gold' ? C.onGold : C.muted, fontSize: T.xs, fontWeight: '800', letterSpacing: 0.3 }}>
        {label}
      </Text>
    </View>
  );
}

/** Small rimmed pill used for counts and status ("50 left", "Open"). */
export function Chip({ label, tone = 'plain' }: { label: string; tone?: 'plain' | 'good' | 'gold' }) {
  const color = tone === 'good' ? C.good : tone === 'gold' ? C.gold : C.muted;
  return (
    <View style={{
      paddingHorizontal: S[2], paddingVertical: S[1], borderRadius: R[1],
      borderWidth: 1, borderColor: mix(color, 45, C.line),
      backgroundColor: white(0.08),
    }}>
      <Text style={{ color, fontSize: T.xs, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sweep: { position: 'absolute', top: 0, bottom: 0, left: 0, width: '60%' },
});


/**
 * Whether the player has asked the system for less motion.
 *
 * Shared because it is a system setting, not a board's opinion: chess uses it
 * for the check pulse, the status breath and the piece slide; ludo for the dice
 * tumble, which is the longest self-running animation in the games.
 */
export function useReduceMotion(): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (alive) setOn(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', v => setOn(!!v));
    return () => { alive = false; sub.remove(); };
  }, []);
  return on;
}

/** One dock slot. `ion` is an Ionicons name, not a `Btn` icon key. */
export type DockAction = {
  key: string;
  ion: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  tone?: 'glass' | 'accent' | 'danger';
  disabled?: boolean;
  /** Live text appended to the label — a voice count, a stake. Never a constant. */
  badge?: string;
};

/**
 * The action row under a board.
 *
 * Each slot is `flex: 1` rather than a computed width, and that is the whole of
 * its responsive story: four actions or five, on a 320dp phone or a tablet, the
 * row divides the width it is given and every slot matches its neighbours. The
 * rummy action bar budgets its width by hand and still pushed a control off the
 * edge at 666dp; this cannot, because there is no width in it to get wrong.
 *
 * `accent` is the lit tone — gold on the chess table, electric blue on the ludo
 * one. It is a prop rather than a token so one dock can serve both rooms.
 */
export function ActionDock({
  width, actions, accent,
}: { width: number; actions: DockAction[]; accent: string }) {
  return (
    <View style={{ width, flexDirection: 'row', gap: S[2] }}>
      {actions.map(a => <DockBtn key={a.key} a={a} accent={accent} />)}
    </View>
  );
}

function DockBtn({ a, accent }: { a: DockAction; accent: string }) {
  const scale = useSharedValue(1);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const lit = a.tone === 'accent';
  const danger = a.tone === 'danger';
  const fg = lit ? accent : danger ? '#FFB3B8' : C.text;

  const press = () => {
    if (a.disabled) return;
    scale.value = withSequence(withTiming(0.96, { duration: 90 }), withTiming(1, { duration: 150 }));
    Haptics.impactAsync(
      danger ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
    ).catch(() => {});
    a.onPress();
  };

  return (
    <AnimPressable
      onPress={press}
      disabled={a.disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!a.disabled }}
      accessibilityLabel={a.badge ? `${a.label}, ${a.badge} at the table` : a.label}
      style={[aStyle, { flex: 1, opacity: a.disabled ? 0.45 : 1 }]}
    >
      <View style={{
        // 62 is the FLOOR, not the height: at a large system font scale the
        // label grows and the tile grows with it rather than clipping.
        minHeight: 62,
        alignItems: 'center', justifyContent: 'center', gap: S[1],
        paddingVertical: S[2], paddingHorizontal: S[1],
        borderRadius: R[3], borderWidth: 1,
        borderColor: lit ? alpha(accent, 0.85) : danger ? 'rgba(255,125,134,.50)' : white(0.18),
        backgroundColor: lit ? alpha(accent, 0.20) : danger ? 'rgba(255,125,134,.12)' : white(0.08),
        // The bottom inset is the half that was missing. A lit top edge alone
        // reads as a sticker; a lit top AND a shaded bottom read as a pane with
        // thickness, which is the whole illusion.
        boxShadow: lit
          ? `0 8px 20px ${alpha(accent, 0.26)}, inset 0 1px 0 ${white(0.26)}, inset 0 -1px 0 rgba(0,0,0,0.30)`
          : `0 6px 16px rgba(0,0,0,0.34), inset 0 1px 0 ${white(0.18)}, inset 0 -1px 0 rgba(0,0,0,0.30)`,
      }}>
        {/* The sheen. Kept gentle on purpose: it sits under the label, and a
            brighter surface needs brighter ink — see the contrast note on
            CR.muted, which had to be raised once already for exactly this. */}
        <LinearGradient
          pointerEvents="none"
          colors={[white(0.09), white(0.02), 'transparent']}
          locations={[0, 0.5, 1]}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { borderRadius: R[3] }]}
        />
        <Ionicons name={a.ion} size={19} color={fg} />
        <Text numberOfLines={1} style={{ color: fg, fontSize: 10.5, fontWeight: '800' }}>
          {a.badge ? `${a.label} ${a.badge}` : a.label}
        </Text>
      </View>
    </AnimPressable>
  );
}

/**
 * A round glass control — the small ones that sit in a top strip.
 *
 * 36dp of surface plus 4dp of slop is exactly the 44dp floor the boards hold
 * everywhere else, and it is why uiautomator reports these as undersized when
 * they are not: it cannot see hitSlop.
 */
export function RoundBtn({
  ion, label, onPress,
}: {
  ion: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
}) {
  const C = useGamePalette();
  const scale = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimPressable
      onPress={() => {
        scale.value = withSequence(withTiming(0.94, { duration: 90 }), withTiming(1, { duration: 150 }));
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={[a, {
        width: 36, height: 36, borderRadius: 18,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: C.light ? C.line : white(0.20), backgroundColor: C.light ? C.panel : white(0.08),
        boxShadow: `0 4px 12px rgba(0,0,0,0.30), inset 0 1px 0 ${white(0.16)}`,
      }]}
    >
      <Ionicons name={ion} size={17} color={C.text} />
    </AnimPressable>
  );
}

/**
 * The room each game is played in.
 *
 * Read from the rooms themselves rather than re-typed, so a room that is
 * repainted brings its chrome strip with it. This is the whole reason the bar
 * below is not a navigator header: the chess board was moved onto its own
 * emerald room precisely because a shared maroon stripe across the top of it
 * read as a bar from a different screen.
 */
export const ROOM_BG: Record<GameAccent, string> = {
  chess: CR.bg,
  ludo: LR.bg,
  rummy: ROOM[0],
  tictactoe: C.bg,
};

/**
 * THE WAY OUT. One bar, one back control, every game screen.
 *
 * The boards were written against a navigator header that does not exist —
 * app/_layout.tsx sets `headerShown: false` for the whole stack, so the
 * `Stack.Screen` options games.tsx passed were inert and Chess's own comment
 * ("the navigator header already owns Back and the title") described a header
 * nobody ever saw. The result: no visible way off a board, off a lobby, or off
 * "Joining the table…" — the player's only exit was the hardware key, which on
 * a deep link out of a turn notification exits the app.
 *
 * Drawn from the same furniture as everything else on a table (RoundBtn, the
 * `C`/`S`/`R` tokens), so it is the room's own trim rather than a second design.
 */
export function GameTopBar({
  title, onBack, backLabel = 'Back to games', right,
}: {
  title: string;
  onBack: () => void;
  /** What the screen reader says. Name the destination, not the gesture. */
  backLabel?: string;
  /** Controls that belong to the screen, not to navigation. */
  right?: React.ReactNode;
}) {
  const C = useGamePalette();
  const t = useType();
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: S[3],
      paddingHorizontal: S[4], paddingVertical: S[2],
    }}>
      <RoundBtn ion="chevron-back" label={backLabel} onPress={onBack} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: C.text, fontSize: t.xl, fontWeight: '800', letterSpacing: 0.3 }}
      >
        {title}
      </Text>
      {right}
    </View>
  );
}

/** `GameTopBar` plus the room behind it, for a board that brings its own. */
export function GameChrome({
  game, children, ...bar
}: React.ComponentProps<typeof GameTopBar> & { game: GameAccent; children?: React.ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: ROOM_BG[game] }}>
      <GameTopBar {...bar} />
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/**
 * The table is not reachable right now.
 *
 * Shown OVER a board that already exists, rather than replacing it. A mid-game
 * drop used to take the whole screen back to "Joining the table…", which reads
 * as if the game were gone and loses the position the player was looking at —
 * every reference client leaves the board up and greys it out.
 *
 * It says nothing about whose turn it is or what the position is: the board
 * underneath is the last thing the server said, and the next snapshot replaces
 * it wholesale. Input is disabled by the caller while this is up, because a tap
 * that goes nowhere is worse than a disabled button.
 */
export function Reconnecting({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  const t = useType();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3],
        paddingVertical: S[2], paddingHorizontal: S[3],
        // Renders OVER a live board, so it was the one shared component still
        // painting an opaque maroon slab across four glass tables. Dark glass,
        // because it must stay readable on top of whatever the board shows.
        borderRadius: R[2], borderWidth: 1, borderColor: mix(C.bad, 55, C.line),
        backgroundColor: 'rgba(0,0,0,0.55)',
        boxShadow: `inset 0 1px 0 ${white(0.16)}`,
      }}
    >
      <ActivityIndicator size="small" color={C.gold} />
      <Text style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }} numberOfLines={2}>
        {error ? `Lost the table — ${error}` : 'Reconnecting to the table…'}
      </Text>
      {onRetry ? <Btn label="Retry" compact onPress={onRetry} /> : null}
    </View>
  );
}

/** The server's turn clock. Nothing to show is shown as nothing. */
export function TurnClock({ secs }: { secs: number | null }) {
  if (secs == null) return null;
  return <Chip label={`${secs}s`} tone={secs <= 5 ? 'gold' : 'plain'} />;
}

/**
 * The rematch control, in whichever of its four states applies.
 *
 * One component because the states are the point and four boards must not
 * disagree about them: asking, waiting (with a way out), they-did-not-come-back,
 * and nobody-is-there. The last two both end in the same offer — invite them
 * back to this table — because an invite is the only thing that brings a player
 * who has closed the app.
 */
export function RematchBtn({ rm, label = 'Rematch' }: { rm: import('../../lib/games/useRematch').Rematch; label?: string }) {
  if (rm.waiting) {
    return (
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
        <ActivityIndicator size="small" color={C.gold} />
        <Text style={{ flex: 1, color: C.muted, fontSize: T.sm, fontWeight: '700' }}>Waiting for them…</Text>
        <Btn label="Stop" compact onPress={rm.cancel} />
      </View>
    );
  }
  if (rm.alone || rm.timedOut) {
    return (
      <Btn
        label={rm.timedOut ? 'They didn’t come back — invite' : 'Invite them back'}
        icon="link"
        kind="gold"
        style={{ flex: 1 }}
        onPress={rm.invite}
      />
    );
  }
  return <Btn label={label} kind="gold" icon="retry" style={{ flex: 1 }} onPress={rm.ask} />;
}
