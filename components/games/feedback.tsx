// components/games/feedback.tsx — toasts, confetti and the settings sheet.
//
// The web client's tables talk back constantly: a toast for every server
// `event`, confetti on a win, a sheet for the per-game options. The first
// native boards printed the last event as a line of grey text and showed
// nothing at all when you won, which is most of why they felt inert next to
// the same game on the web.

import React from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withSpring, withDelay,
  Easing, runOnJS, cancelAnimation,
} from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';
import { C, S, R, E, D3, mix, goldLine } from '../../lib/games/theme';
import { Btn, useType } from './ui';

/* ── toasts ─────────────────────────────────────────────────────────── */

/**
 * Show the tail of an event stream as transient toasts.
 *
 * Driven off the `events` array the socket hook accumulates, so it needs no
 * plumbing at each call site: a board renders <Toasts events={events} /> and
 * every server notice appears. Only the newest is shown — a stack of them
 * covers the board, and these are notices, not a log.
 */
export function Toasts({ events }: { events: string[] }) {
  const t = useType();
  const [msg, setMsg] = React.useState<string | null>(null);
  const shown = React.useRef(0);
  const y = useSharedValue(20);
  const op = useSharedValue(0);

  React.useEffect(() => {
    if (events.length === shown.current) return;
    shown.current = events.length;
    const next = events[events.length - 1];
    if (!next) return;
    setMsg(next);

    op.value = withTiming(1, { duration: 180 });
    y.value = withSpring(0, { damping: 16, stiffness: 220 });
    // Hold, then fade. The clear runs on the JS thread once the fade lands so
    // the view actually unmounts rather than sitting invisible over the board.
    op.value = withDelay(2600, withTiming(0, { duration: 260 }, (done) => {
      if (done) runOnJS(setMsg)(null);
    }));
    y.value = withDelay(2600, withTiming(20, { duration: 260 }));
  }, [events, op, y]);

  const a = useAnimatedStyle(() => ({ opacity: op.value, transform: [{ translateY: y.value }] }));

  if (!msg) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[{
        position: 'absolute', left: S[4], right: S[4], bottom: S[6],
        paddingVertical: S[3], paddingHorizontal: S[4],
        borderRadius: R.pill, alignItems: 'center',
        backgroundColor: 'rgba(20,6,6,0.94)',
        borderWidth: 1, borderColor: goldLine[28],
        boxShadow: E[2],
      }, a]}
    >
      <Text numberOfLines={2} style={{ color: C.text, fontSize: t.sm, fontWeight: '700', textAlign: 'center' }}>
        {msg}
      </Text>
    </Animated.View>
  );
}

/* ── confetti ───────────────────────────────────────────────────────── */

const CONFETTI_COLORS = [C.gold, C.gold2, '#5fe08c', '#6fa9ff', '#ff6b78', '#ffffff'];

/**
 * A win needs a moment.
 *
 * Deliberately cheap: ~40 absolutely positioned strips, each with one timing
 * animation, mounted only while `show` is true. The web version is a CSS
 * keyframe per piece; this is the same idea without a physics engine, because
 * nothing here needs to be accurate — it needs to be brief and celebratory.
 */
export function Confetti({ show }: { show: boolean }) {
  const { width, height } = useWindowDimensions();
  const [alive, setAlive] = React.useState(false);

  React.useEffect(() => {
    if (!show) { setAlive(false); return; }
    setAlive(true);
    const id = setTimeout(() => setAlive(false), 3200);
    return () => clearTimeout(id);
  }, [show]);

  const pieces = React.useMemo(
    () => Array.from({ length: 40 }, (_, i) => ({
      key: i,
      x: Math.random() * width,
      delay: Math.random() * 700,
      dur: 2200 + Math.random() * 900,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      spin: 360 + Math.random() * 400,
      drift: (Math.random() - 0.5) * 90,
    })),
    [width, alive],
  );

  if (!alive) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {pieces.map(p => <Piece key={p.key} {...p} height={height} />)}
    </View>
  );
}

function Piece({
  x, delay, dur, color, spin, drift, height,
}: { x: number; delay: number; dur: number; color: string; spin: number; drift: number; height: number }) {
  const fall = useSharedValue(0);
  React.useEffect(() => {
    fall.value = withDelay(delay, withTiming(1, { duration: dur, easing: Easing.linear }));
    return () => cancelAnimation(fall);
  }, [fall, delay, dur]);

  const a = useAnimatedStyle(() => ({
    opacity: fall.value > 0.92 ? (1 - fall.value) / 0.08 : 1,
    transform: [
      { translateY: fall.value * (height + 40) },
      { translateX: fall.value * drift },
      { rotate: `${fall.value * spin}deg` },
    ] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={[{
      position: 'absolute', top: -16, left: x,
      width: 9, height: 14, borderRadius: 2, backgroundColor: color,
    }, a]} />
  );
}

/* ── bottom sheet ───────────────────────────────────────────────────── */

/** The settings / confirm sheet every board shares. */
export function Sheet({
  visible, title, onClose, children,
}: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const t = useType();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close"
        style={{ flex: 1, backgroundColor: 'rgba(8,2,2,0.72)', justifyContent: 'flex-end' }}
      >
        {/* Stop taps inside the sheet from dismissing it. */}
        <Pressable onPress={() => {}} style={{
          backgroundColor: C.panel,
          borderTopLeftRadius: R[4], borderTopRightRadius: R[4],
          borderWidth: 1, borderColor: goldLine[28],
          padding: S[4], paddingBottom: S[6], gap: S[3],
          boxShadow: E[3],
        }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: goldLine[38], marginBottom: S[2] }} />
          <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>{title}</Text>
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: S[2] }}>
            {children}
          </ScrollView>
          <Btn label="Close" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One labelled row in a sheet, with a value on the right. */
export function SettingRow({
  label, hint, value, onPress,
}: { label: string; hint?: string; value: string; onPress: () => void }) {
  const t = useType();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3],
        paddingVertical: S[3], paddingHorizontal: S[3],
        borderRadius: R[2], borderWidth: 1, borderColor: goldLine[14],
        backgroundColor: mix(C.panel2, 86, '#ffffff'),
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '700' }}>{label}</Text>
        {hint ? <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{hint}</Text> : null}
      </View>
      <View style={{
        paddingHorizontal: S[3], paddingVertical: S[1], borderRadius: R.pill,
        borderWidth: 1, borderColor: goldLine[38], backgroundColor: C.panel2,
      }}>
        <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>{value}</Text>
      </View>
    </Pressable>
  );
}
