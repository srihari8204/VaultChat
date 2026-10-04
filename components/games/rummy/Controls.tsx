// components/games/rummy/Controls.tsx — the controls on and around the felt:
// the voice pill, the score readout, the action bar's buttons, the status pill
// and the header's icon buttons.
// Split out of components/games/Rummy.tsx; behaviour unchanged.

import React, { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import type { TableVoice } from '../../../lib/games/useTableVoice';
import { useAnnounce } from '../ui';
import { C, S, R, T, white } from '../../../lib/games/theme';
import { STAT, CYAN, INK as INK_ON_FELT, onFelt, ACTION_INK } from '../../../lib/games/rummyGlass';

const VOICE_LABEL: Record<string, string> = {
  off: 'Talk', asking: 'Mic…', connecting: 'Connecting…', live: 'Voice on',
  waiting: 'Waiting…', unavailable: 'No voice', error: 'Voice failed',
};

/**
 * The compact control that sits on the felt during play.
 *
 * Deliberately tiny and pinned to the table's chrome row, away from the cards
 * and the action bar: voice is a side channel and must never be something a
 * player hits while reaching for Discard. Everything else is one tap away in
 * the sheet.
 */
export function VoicePill({ voice, onPress, still }: { voice: TableVoice; onPress: () => void; still: boolean }) {
  const live = voice.phase === 'live';
  const busy = voice.phase === 'connecting' || voice.phase === 'asking';
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (live && !voice.muted && !still) {
      pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 150 });
    }
    return () => cancelAnimation(pulse);
  }, [live, voice.muted, still, pulse]);

  const a = useAnimatedStyle(() => ({ opacity: 0.75 + pulse.value * 0.25 }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        live
          ? `Table voice, ${voice.participants.length} in the channel, ${voice.muted ? 'you are muted' : 'microphone live'}`
          : `Table voice, ${VOICE_LABEL[voice.phase] ?? voice.phase}`
      }
      hitSlop={9}
      style={[
        // Teal glass when the channel is live, navy when it is not — the same
        // two-family rule as every other surface on the felt, from
        // lib/games/rummyGlass.ts rather than written out here. This pill used
        // to carry its own rgba(4,26,14): a green-black mixed for a felt the
        // table stopped using two restyles ago, which is exactly the drift one
        // source of colour exists to stop.
        onFelt(live ? 'teal' : 'navy', { radius: R.pill, active: live }),
        {
          flexDirection: 'row', alignItems: 'center', gap: 4,
          paddingHorizontal: S[2], paddingVertical: 4,
        },
      ]}
    >
      {busy
        ? <ActivityIndicator size="small" color={C.gold2} />
        : <Animated.View style={a}>
            {/* Was three emoji in one expression. `mic-off` / `mic` / `mic-outline`
                say the same three states in the family every other control uses,
                and unlike an emoji they take the pill's own colour. */}
            <Ionicons
              name={live ? (voice.muted ? 'mic-off' : 'mic') : 'mic-outline'}
              size={13}
              color={live ? (voice.muted ? C.bad : C.good) : C.gold2}
            />
          </Animated.View>}
      <Text style={{ color: live ? CYAN : INK_ON_FELT, fontSize: T.xs, fontWeight: '800' }}>
        {live ? `${voice.participants.length}` : VOICE_LABEL[voice.phase] ?? ''}
      </Text>
    </Pressable>
  );
}

/**
 * MELD · DEADWOOD · SCORE, at full size beside the hand.
 *
 * This is what let the turn/status strip give up its 30dp band: the numbers it
 * used to repeat are permanently on screen here instead. Pressing it opens the
 * standings, so the readout and the control are the same object.
 */
export function ScorePanel({
  width, meld, deadwood, score, onPress,
}: { width: number; meld: number; deadwood: number; score: number; onPress: () => void }) {
  const cells: [string, number, string, string][] = [
    ['★', meld, 'MELD POINTS', STAT.meld],
    ['♠', deadwood, 'DEADWOOD', STAT.deadwood],
    ['◎', score, 'SCORE', STAT.score],
  ];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Standings. Meld ${meld}, deadwood ${deadwood}, score ${score}`}
      // A COLUMN of three rows, not a row of three columns — see SCORE_MIN_W.
      style={[
        onFelt('navy', { radius: 13 }),
        { width, flexDirection: 'column' },
      ]}
    >
      {cells.map(([glyph, value, label, tone], i) => (
        <View key={label} style={{
          flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: S[2], gap: S[1],
          borderTopWidth: i ? 1 : 0, borderTopColor: white(0.10),
        }}>
          <Text style={{ color: tone, fontSize: 12 }}>{glyph}</Text>
          <Text style={{ color: tone, fontSize: 17, fontWeight: '800' }}>{value}</Text>
          <View style={{ flex: 1 }} />
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: tone, opacity: 0.9, fontSize: 9, fontWeight: '800', letterSpacing: 0.3 }}>{label}</Text>
        </View>
      ))}
    </Pressable>
  );
}

/**
 * One action: a glyph over its name.
 *
 * The three decisions are coloured and the utilities are not, because Declare
 * and Drop sit inches apart and one wins the hand while the other forfeits it.
 */
const ACTION_ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  '↕': 'swap-vertical', '▣': 'albums-outline', '⊖': 'remove-circle-outline',
  '★': 'podium-outline', '◉': 'eye-outline', '🗑': 'trash-outline',
  '✓': 'checkmark-circle-outline', '⏻': 'exit-outline',
};

export function ActionBtn({
  glyph, label, onPress, disabled, tone, wide, active, w, accessibilityLabel,
}: {
  glyph: string;
  label: string;
  /** Mandatory controls take a computed width so the row can never overflow. */
  w?: number;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'blue' | 'good' | 'danger';
  wide?: boolean;
  active?: boolean;
  accessibilityLabel?: string;
}) {
  const ink = tone === 'good' ? ACTION_INK.good : tone === 'danger' ? ACTION_INK.danger : tone === 'blue' ? ACTION_INK.blue : INK_ON_FELT;
  const { fontScale } = useWindowDimensions();
  const surface = tone === 'good' ? onFelt('emerald', { radius: 11, active: true })
    : tone === 'danger' ? onFelt('danger', { radius: 11, active: true })
    : tone === 'blue' ? onFelt('blue', { radius: 11, active: true })
    : onFelt('navy', { radius: 11, active: !!active });
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={4}
      style={[surface, {
        minHeight: 36, minWidth: wide ? 118 : (w ?? 62), paddingVertical: 4,
        paddingHorizontal: w && w < 56 ? 2 : S[2],
        alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1,
      }]}
    >
      {fontScale <= 1.25 && (ACTION_ICONS[glyph]
        ? <Ionicons name={ACTION_ICONS[glyph]} size={13} color={ink} />
        : <Text style={{ color: ink, fontSize: 11 }}>{glyph}</Text>)}
      <Text numberOfLines={1} style={{ color: ink, fontSize: 11, fontWeight: '800', letterSpacing: 0.2 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * One cell of the score readout.
 *
 * Colour carries the meaning before the label does — gold is what you have
 * built, red is what it will cost you, cyan is the server's score — so the
 * three are never interchangeable and the values live in rummyGlass.STAT
 * rather than being written at each call site.
 */
export function Stat({
  glyph, value, label, tone, rule,
}: { glyph: string; value: number; label: string; tone: string; rule?: boolean }) {
  return (
    <View
      accessibilityLabel={`${label.toLowerCase()} ${value}`}
      style={{
        paddingHorizontal: S[2], alignItems: 'center', justifyContent: 'center',
        borderLeftWidth: rule ? 1 : 0, borderLeftColor: white(0.14),
      }}
    >
      <Text style={{ color: tone, fontSize: 12.5, fontWeight: '800' }}>{`${glyph} ${value}`}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={{ color: tone, opacity: 0.85, fontSize: 9, fontWeight: '800', letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

export function StatusPill({ tone, announce, children }: { tone: 'plain' | 'you' | 'warn'; announce?: string; children: React.ReactNode }) {
  // ANNOUNCED, NOT A LIVE REGION. The pill carries the turn clock, and a live
  // region re-reads on every change — once a second on Android. `announce` is
  // the status line alone, spoken once each time it changes, on both platforms.
  useAnnounce(announce, true);
  return (
    <View
      style={[
        // Gold glass when it is YOUR turn, plain navy when it is not: the pill
        // is the one place the table says whether it is waiting on you, so the
        // surface itself carries that rather than only the words on it.
        onFelt(tone === 'plain' ? 'navy' : 'gold', { radius: R.pill, lift: 2, active: tone !== 'plain' }),
        {
          flexDirection: 'row', alignItems: 'center', gap: S[2],
          paddingHorizontal: S[3], paddingVertical: 3, maxWidth: '96%',
        },
      ]}
    >
      {children}
    </View>
  );
}

export function IconBtn({ glyph, label, onPress }: { glyph: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // 26dp drawn, so 9dp of slop left the target at 44 only on the diagonal.
      // The table header is deliberately small — it must not compete with the
      // felt — so the touch area is what grows: 26 + 2x9 = 44 exactly.
      hitSlop={9}
      style={[
        onFelt('navy', { radius: 13 }),
        { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
      ]}
    >
      <Text style={{ color: INK_ON_FELT, fontSize: 13, fontWeight: '800' }}>{glyph}</Text>
    </Pressable>
  );
}
