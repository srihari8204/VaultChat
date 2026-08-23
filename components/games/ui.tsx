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
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect, Pattern, Circle } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  withSequence, withDelay, Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  C, S, R, E, D3, T, glass, goldLine, mix, MOTION, AMBIENT, GRAIN,
  GOLD_FILL, GOLD_STOPS, PANEL_FILL, RED_FILL, RED_STOPS, typeScale,
} from '../../lib/games/theme';

const AnimPressable = Animated.createAnimatedComponent(Pressable);

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

type BtnKind = 'gold' | 'secondary' | 'danger' | 'ghost';

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

  const fill = kind === 'gold' ? GOLD_FILL : kind === 'danger' ? RED_FILL : PANEL_FILL;
  const stops = kind === 'gold' ? GOLD_STOPS : kind === 'danger' ? RED_STOPS : [0, 1];
  const fg = kind === 'gold' ? C.onGold : kind === 'danger' ? '#fff' : C.text;
  const border = kind === 'gold' ? C.goldDeep : kind === 'danger' ? '#7d0f2a' : goldLine[18];

  const shadow =
    kind === 'gold' ? '0 8px 24px rgba(243,194,69,0.35), ' + D3.rim
    : kind === 'danger' ? '0 8px 24px rgba(225,29,72,0.35), inset 0 1px 0 rgba(255,255,255,0.25)'
    : '0 6px 18px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)';

  const body = (
    <>
      {icon ? <Text style={{ fontSize: t.md, color: fg }}>{icon}</Text> : null}
      {busy
        ? <ActivityIndicator size="small" color={fg} />
        : <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? t.sm : t.md, fontWeight: '800', letterSpacing: 0.2 }}>{label}</Text>}
    </>
  );

  const inner: ViewStyle = {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2],
    paddingVertical: compact ? S[2] : S[3],
    paddingHorizontal: compact ? S[3] : S[4],
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
