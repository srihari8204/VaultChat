// components/games/feedback.tsx — toasts, confetti and the settings sheet.
//
// The web client's tables talk back constantly: a toast for every server
// `event`, confetti on a win, a sheet for the per-game options. The first
// native boards printed the last event as a line of grey text and showed
// nothing at all when you won, which is most of why they felt inert next to
// the same game on the web.

import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withSpring, withDelay,
  Easing, runOnJS, cancelAnimation,
} from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';
import { C, S, R, E, white } from '../../lib/games/theme';
import { Btn, useType } from './ui';
import type { TableVoice } from '../../lib/games/useTableVoice';

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
  // A direct child of TableBackground on three of the four boards - nothing
  // upstream accounts for the safe area, so a fixed 32dp sat under the home
  // indicator/gesture bar on any device with one.
  const insets = useSafeAreaInsets();
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

    // CANCEL ON UNMOUNT. The fade above carries a 2600ms delay and a completion
    // callback that calls setMsg through runOnJS — so a board torn down inside
    // that window (leaving a rummy table, a rematch, or backing out mid-toast)
    // had the callback land on an unmounted component. Every other repeating
    // animation in this file already cancels; this one-shot did not, and a
    // delayed one-shot outlives its component exactly as easily.
    return () => { cancelAnimation(op); cancelAnimation(y); };
  }, [events, op, y]);

  const a = useAnimatedStyle(() => ({ opacity: op.value, transform: [{ translateY: y.value }] }));

  if (!msg) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[{
        position: 'absolute', left: S[4], right: S[4], bottom: S[6] + insets.bottom,
        paddingVertical: S[3], paddingHorizontal: S[4],
        borderRadius: R.pill, alignItems: 'center',
        // A toast is READ, and it lands over a board mid-game — so it stays the
        // most opaque surface in the set. It is glass only in its rim and its
        // neutral tint: the maroon-and-gold version was the old painted palette
        // sitting on four glass boards.
        backgroundColor: 'rgba(0,0,0,0.80)',
        borderWidth: 1, borderColor: white(0.22),
        boxShadow: `${E[2]}, inset 0 1px 0 ${white(0.18)}`,
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

  /**
   * The pieces are made WHEN THE CONFETTI STARTS, not memoised against it.
   *
   * They used to come from a `useMemo` keyed on `[width, alive]`, where `alive`
   * appears nowhere inside the factory — it was there purely as a cache-buster,
   * so a second win would not replay the first win's exact pattern. That works,
   * but it is load-bearing behaviour hidden in a dependency array, and it read
   * to the linter (correctly) as an unnecessary dependency: the next person to
   * "clean up" the warning by deleting `alive` would have frozen the confetti
   * into one fixed pattern for the life of the screen, with nothing failing.
   *
   * Generating them in the effect that starts the run says the same thing out
   * loud — new run, new pieces — and the warning goes away because the reason
   * is now expressed in code rather than in a dependency.
   */
  const [pieces, setPieces] = React.useState<{
    key: number; x: number; delay: number; dur: number;
    color: string; spin: number; drift: number;
  }[]>([]);

  React.useEffect(() => {
    if (!show) { setAlive(false); return; }
    setPieces(Array.from({ length: 40 }, (_, i) => ({
      key: i,
      x: Math.random() * width,
      delay: Math.random() * 700,
      dur: 2200 + Math.random() * 900,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      spin: 360 + Math.random() * 400,
      drift: (Math.random() - 0.5) * 90,
    })));
    setAlive(true);
    const id = setTimeout(() => setAlive(false), 3200);
    return () => clearTimeout(id);
  }, [show, width]);

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
  // A fixed 420dp cap ignored the actual window: rummy locks landscape while
  // playing, and Sheet's own scroller sat above the ENTIRE window on the
  // Redmi (393dp tall in landscape) with the drag handle and Close button
  // pushed off-screen below it. Bounded to the window instead, still capped
  // at 420 so a tall phone keeps its current, unshrunk sheet.
  const { height: winH } = useWindowDimensions();
  const scrollCap = Math.min(420, Math.round(winH * 0.6));
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* Both wrappers below exist purely to catch taps (dismiss on the
          backdrop, swallow it on the sheet body) — neither is content. A
          Pressable is `accessible` by default, and an accessible view
          collapses its ENTIRE subtree into one node: with both left at the
          default, the whole sheet — title, every row, the real Close button —
          announced as a single button labelled "Close", so nothing inside was
          reachable. `accessible={false}` on both stops that collapse.
          Dismissal doesn't need the backdrop to be a11y-reachable: the visible
          Close button and `Modal onRequestClose` (hardware back / swipe-down)
          already cover it. */}
      <Pressable
        onPress={onClose}
        accessible={false}
        style={{ flex: 1, backgroundColor: 'rgba(8,2,2,0.72)', justifyContent: 'flex-end' }}
      >
        {/* Stop taps inside the sheet from dismissing it. */}
        {/* A sheet is a LIFTED surface, so it is the most solid glass in the
            set: a near-opaque dark ground under a light rim. Fully translucent
            would let a busy board read straight through a panel carrying
            settings and body copy. It was C.panel + goldLine — the old painted
            palette, and this is the container every settings, rules, result,
            invite and history sheet renders inside, so it was the single most
            visible surface the restyle had missed. */}
        <Pressable onPress={() => {}} accessible={false} style={{
          backgroundColor: 'rgba(14,4,5,0.94)',
          borderTopLeftRadius: R[4], borderTopRightRadius: R[4],
          borderWidth: 1, borderColor: white(0.16),
          padding: S[4], paddingBottom: S[6], gap: S[3],
          boxShadow: `${E[3]}, inset 0 1px 0 ${white(0.18)}`,
        }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: white(0.30), marginBottom: S[2] }} />
          <Text numberOfLines={1} style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>{title}</Text>
          <ScrollView style={{ maxHeight: scrollCap }} contentContainerStyle={{ gap: S[2] }}>
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
        // Matches ui.tsx PlayerRow's inactive state — a row inside a sheet is
        // the same kind of surface as a row on a board, and these two had
        // drifted onto different palettes.
        borderRadius: R[2], borderWidth: 1, borderColor: white(0.12),
        backgroundColor: white(0.06),
        boxShadow: `inset 0 1px 0 ${white(0.12)}`,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '700' }}>{label}</Text>
        {hint ? <Text style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{hint}</Text> : null}
      </View>
      <View style={{
        paddingHorizontal: S[3], paddingVertical: S[1], borderRadius: R.pill,
        borderWidth: 1, borderColor: white(0.26), backgroundColor: white(0.10),
      }}>
        <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>{value}</Text>
      </View>
    </Pressable>
  );
}

/* ── table voice ────────────────────────────────────────────────────── */

/**
 * The voice control every board shares.
 *
 * Deliberately one control rather than a panel: at a game table the microphone
 * is a thing you switch on and then forget, and the only state worth showing
 * once you are in is who is talking and whether you are muted.
 */
export function VoiceBar({
  phase, error, canSpeak, muted, participants, onJoin, onLeave, onToggleMute, width,
}: {
  phase: string;
  error: string | null;
  canSpeak: boolean;
  muted: boolean;
  participants: string[];
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  width?: number;
}) {
  const t = useType();

  if (phase === 'unavailable') {
    return (
      <Text style={{ width, color: C.muted, fontSize: 12, textAlign: 'center' }}>
        {error ?? 'Voice is not available at this table.'}
      </Text>
    );
  }

  if (phase === 'off' || phase === 'error') {
    return (
      <View style={{ width, gap: S[1] }}>
        <Btn label="Talk at the table" icon="mic" compact onPress={onJoin} />
        {error ? <Text style={{ color: C.bad, fontSize: 11, textAlign: 'center' }}>{error}</Text> : null}
      </View>
    );
  }

  if (phase === 'asking' || phase === 'connecting') {
    return <Btn label={phase === 'asking' ? 'Microphone…' : 'Connecting…'} compact busy style={{ width }} onPress={() => {}} />;
  }

  return (
    <View style={{
      width, flexDirection: 'row', alignItems: 'center', gap: S[2],
      paddingVertical: S[2], paddingHorizontal: S[3],
      // Sits directly under a glass board on all four games — it was the last
      // painted strip on those screens.
      borderRadius: R[2], borderWidth: 1, borderColor: white(0.22),
      backgroundColor: white(0.09),
      boxShadow: `inset 0 1px 0 ${white(0.16)}`,
    }}>
      {/* Amber while nobody else has joined: the player IS in voice, they just
          have no one to talk to yet. Green would claim a connection that is not
          there, and "reconnecting" would claim a fault that is not either. */}
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: phase === 'waiting' ? C.gold : C.good }} />
      <Text style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }}>
        {phase === 'waiting'
          ? 'In voice — waiting for others'
          : canSpeak ? `Voice on · ${participants.length}` : `Listening · ${participants.length}`}
      </Text>
      {canSpeak && (
        <Btn
          label={muted ? 'Unmute' : 'Mute'}
          icon={muted ? 'micOff' : 'mic'}
          compact
          onPress={onToggleMute}
          accessibilityLabel={muted ? 'Unmute your microphone' : 'Mute your microphone'}
        />
      )}
      <Btn label="Leave" compact kind="danger" onPress={onLeave} accessibilityLabel="Leave voice" />
    </View>
  );
}

/**
 * The full voice panel.
 *
 * Joining, leaving and muting here are independent of the game: leaving voice
 * never leaves the table, and voice failing never stops the hand. The two live
 * on different sockets — the game on the games server, the audio on LiveKit —
 * which is what makes that separation real rather than a promise.
 */
export function VoiceSheet({
  visible, voice, nameOf, onClose,
}: { visible: boolean; voice: TableVoice; nameOf?: (id: string) => string; onClose: () => void }) {
  const t = useType();
  const secs = useElapsed(voice.since);

  const status =
    voice.phase === 'live' ? (voice.canSpeak ? 'Connected' : 'Listening only — you are a spectator here')
    : voice.phase === 'waiting' ? 'You are in voice. Nobody else has joined yet.'
    : voice.phase === 'connecting' ? 'Connecting…'
    : voice.phase === 'asking' ? 'Waiting for microphone permission…'
    : voice.phase === 'unavailable' ? (voice.error ?? 'Voice is not switched on for these tables yet.')
    : voice.phase === 'error' ? (voice.error ?? 'Voice failed.')
    : 'Not connected.';

  const denied = voice.phase === 'error' && /permission/i.test(voice.error ?? '');

  return (
    <Sheet visible={visible} title="Table voice" onClose={onClose}>
      <Text style={{ color: voice.phase === 'error' ? C.bad : C.muted, fontSize: t.sm, lineHeight: 19 }}>{status}</Text>

      {denied && (
        <Text style={{ color: C.muted, fontSize: 12, lineHeight: 18 }}>
          The microphone is blocked for crazzychat. Turn it on in your phone’s app settings, then join again — you can keep playing without it.
        </Text>
      )}

      {(voice.phase === 'live' || voice.phase === 'waiting') && (
        <>
          <Text style={{ color: C.muted, fontSize: 12 }}>
            {`${voice.participants.length} in the channel · ${fmtDuration(secs)}`}
          </Text>
          <View style={{ gap: S[1] }}>
            {voice.participants.map(id => (
              <View key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: S[2], paddingVertical: 4 }}>
                <View style={{
                  width: 8, height: 8, borderRadius: 4,
                  backgroundColor: voice.speaking.has(id) ? C.good : 'rgba(255,255,255,0.22)',
                }} />
                <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: t.sm }}>{nameOf ? nameOf(id) : id}</Text>
                {voice.speaking.has(id) && <Text style={{ color: C.good, fontSize: 11, fontWeight: '700' }}>speaking</Text>}
              </View>
            ))}
          </View>
        </>
      )}

      <View style={{ flexDirection: 'row', gap: S[2], flexWrap: 'wrap' }}>
        {voice.phase === 'live' || voice.phase === 'waiting' ? (
          <>
            {voice.canSpeak && (
              <Btn
                label={voice.muted ? 'Unmute' : 'Mute'}
                icon={voice.muted ? 'micOff' : 'mic'}
                compact
                onPress={voice.toggleMute}
                accessibilityLabel={voice.muted ? 'Unmute your microphone' : 'Mute your microphone'}
              />
            )}
            <Btn
              label={voice.speaker ? 'Speaker on' : 'Speaker off'}
              icon={voice.speaker ? 'speaker' : 'headset'}
              compact
              onPress={voice.toggleSpeaker}
              accessibilityLabel={voice.speaker ? 'Loudspeaker on' : 'Following your headset'}
            />
            <Btn label="Leave voice" kind="danger" compact onPress={voice.leave} accessibilityLabel="Leave voice but stay at the table" />
          </>
        ) : voice.phase === 'unavailable' ? null : (
          <Btn label="Join voice" icon="mic" kind="gold" compact onPress={voice.join} />
        )}
      </View>

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        Leaving voice keeps your seat. Audio goes straight between players’ phones — never through the games server — nothing is recorded, and the microphone is only requested when you join.
      </Text>
    </Sheet>
  );
}

/** Seconds since a timestamp, ticking. Null timestamp costs no timer. */
function useElapsed(since: number | null): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (since == null) { setSecs(0); return; }
    const tick = () => setSecs(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  return secs;
}

function fmtDuration(s: number): string {
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
}
