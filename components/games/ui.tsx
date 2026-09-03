// components/games/ui.tsx — shared game-table furniture.
//
// Ported from games-web/theme.css. These exist so the four boards cannot drift
// apart: the web client's polish comes largely from every game reusing one
// panel, one button and one banner, and the first native attempt re-styled
// each board by hand and looked like four different apps.

import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View,
  useWindowDimensions, type ViewStyle, type StyleProp,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect, Pattern, Circle } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  withSequence, withDelay, Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  C, S, R, E, D3, T, glass, goldLine, mix, MOTION, AMBIENT, GRAIN,
  GOLD_FILL, GOLD_STOPS, PANEL_FILL, RED_FILL, RED_STOPS, typeScale,
} from '../../lib/games/theme';
import { boardFit } from '../../lib/games/boardFit';

const AnimPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The boards' icon set.
 *
 * These used to be emoji, and so came from four different families at once:
 * flat glyphs (↻, ⧉) sitting beside full-colour emoji (🎲, 🤖) that no theme
 * colour can reach and that redraw themselves differently on every Android
 * skin. The rest of VaultChat draws icons from Ionicons — 178 call sites — so
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
  retry: 'refresh-outline',
} as const;

export type GameIconName = keyof typeof ICONS;

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
export function useBoardSize(chrome = 300): number {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return React.useMemo(
    () => boardFit({ width, height }, insets, chrome).size,
    [width, height, insets.top, insets.bottom, insets.left, insets.right, chrome],
  );
}

/** Landscape when the screen is meaningfully wider than it is tall. */
export function useLandscape(): boolean {
  const { width, height } = useWindowDimensions();
  return width > height * 1.2;
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
export function TableBackground({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flex: 1, backgroundColor: C.bg }, style]}>
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          {AMBIENT.map((g, i) => (
            <RadialGradient key={i} id={'amb' + i} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
              <Stop offset="0" stopColor={g.color} stopOpacity={g.opacity} />
              <Stop offset="1" stopColor={g.color} stopOpacity={0} />
            </RadialGradient>
          ))}
          <Pattern id="grain" width={GRAIN.size} height={GRAIN.size} patternUnits="userSpaceOnUse">
            <Circle cx={GRAIN.dot} cy={GRAIN.dot} r={GRAIN.dot} fill={GRAIN.color} />
          </Pattern>
        </Defs>
        {AMBIENT.map((_, i) => <Rect key={i} x="0" y="0" width="100%" height="100%" fill={'url(#amb' + i + ')'} />)}
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#grain)" opacity={GRAIN.opacity} />
      </Svg>
      {children}
    </View>
  );
}

/** .glass / .panel / .lobby / .tablecard */
export function Panel({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[glass, { padding: S[4] }, style]}>{children}</View>;
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

  const fill = kind === 'gold' ? GOLD_FILL : kind === 'danger' ? RED_FILL : kind === 'good' ? GOOD_FILL : PANEL_FILL;
  const stops = kind === 'gold' ? GOLD_STOPS : kind === 'danger' ? RED_STOPS : kind === 'good' ? GOOD_STOPS : [0, 1];
  const fg = kind === 'gold' ? C.onGold : kind === 'danger' || kind === 'good' ? '#fff' : C.text;
  const border = kind === 'gold' ? C.goldDeep : kind === 'danger' ? '#7d0f2a' : kind === 'good' ? '#0a4a2e' : goldLine[18];

  const shadow =
    kind === 'gold' ? '0 8px 24px rgba(243,194,69,0.35), ' + D3.rim
    : kind === 'danger' ? '0 8px 24px rgba(225,29,72,0.35), inset 0 1px 0 rgba(255,255,255,0.25)'
    : '0 6px 18px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)';

  const body = (
    <>
      {icon ? (
        ICONS[icon as GameIconName]
          ? <Ionicons name={ICONS[icon as GameIconName]} size={Math.round(t.md * 1.15)} color={fg} />
          : <Text style={{ fontSize: t.md, color: fg }}>{icon}</Text>
      ) : null}
      {busy
        ? <ActivityIndicator size="small" color={fg} />
        : <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? t.sm : t.md, fontWeight: '800', letterSpacing: 0.2 }}>{label}</Text>}
    </>
  );

  const inner: ViewStyle = {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2],
    paddingVertical: compact ? S[2] : S[3],
    paddingHorizontal: compact ? S[3] : S[4],
    // 44dp is the floor for a touch target, and padding alone did not reach it:
    // a compact button measured 37dp tall on the Redmi. Padding sizes a button
    // to its TEXT, which is the wrong thing to size a finger against.
    minHeight: 44,
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
      ) : (
        <View
          onLayout={e => setW(e.nativeEvent.layout.width)}
          style={{ borderRadius: R[2], borderWidth: 1, borderColor: border, boxShadow: shadow, overflow: 'hidden' }}
        >
          <LinearGradient
            colors={fill as unknown as [string, string, ...string[]]}
            locations={stops as unknown as [number, number, ...number[]]}
            start={kind === 'secondary' ? { x: 0.5, y: 0 } : { x: 0, y: 0 }}
            end={kind === 'secondary' ? { x: 0.5, y: 1 } : { x: 1, y: 1 }}
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
        backgroundColor: mix(C.panel, 90, '#ffffff'),
        boxShadow: E[2],
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
        borderColor: active ? goldLine[55] : goldLine[14],
        backgroundColor: mix(C.panel2, 86, '#ffffff'),
        boxShadow: active ? '0 6px 18px rgba(0,0,0,0.35)' : D3.lift1,
      }}
    >
      {accent ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: accent, boxShadow: D3.rim }} /> : null}
      <Text style={{ flex: 1, color: C.text, fontSize: t.md, fontWeight: '700' }} numberOfLines={1}>{name}</Text>
      {subtitle ? <Text style={{ color: C.muted, fontSize: t.sm }}>{subtitle}</Text> : null}
      {tag ? <Tag label={tag} /> : null}
    </View>
  );
}

/** .tag / .tag.you */
export function Tag({ label, tone = 'gold' }: { label: string; tone?: 'gold' | 'plain' }) {
  return (
    <View style={{
      paddingHorizontal: S[2], paddingVertical: 2, borderRadius: R.pill,
      backgroundColor: tone === 'gold' ? C.gold : mix(C.panel2, 80, '#ffffff'),
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
      borderWidth: 1, borderColor: mix(color, 30, C.line), backgroundColor: C.panel2,
    }}>
      <Text style={{ color, fontSize: T.xs, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sweep: { position: 'absolute', top: 0, bottom: 0, left: 0, width: '60%' },
});

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
        borderRadius: R[2], borderWidth: 1, borderColor: mix(C.bad, 40, C.line),
        backgroundColor: mix(C.panel2, 88, '#ffffff'),
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
