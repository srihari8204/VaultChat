// components/games/chess/Seat.tsx — the two seat cards and the status pill.
// Split out of components/games/Chess.tsx; behaviour unchanged apart from the
// screen-reader fixes noted inline (one stop per seat, the status announced).

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import { useType, useAnnounce } from '../ui';
import { S, R, white, alpha, ACCENT } from '../../../lib/games/theme';
import { CR, g } from '../../../lib/games/chessRoom';
import { GLYPH, resultText } from '../../../lib/games/chessView';
import { PIECE_NAME } from '../../../lib/games/pieceNames';
import { SEAT_CLOCK } from './style';

const GLYPH_NAME: Record<string, string> = Object.fromEntries(Object.entries(GLYPH).map(([k, gl]) => [gl, PIECE_NAME[k]]));

/* ── chrome ─────────────────────────────────────────────────────────── */

/**
 * A player card: who, what they are doing, and how long they have to do it.
 *
 * Every field is the LIVE one — `name` comes from the lobby roster, `clock`
 * from the server's clock frame through clockFor(), `role` from the same game
 * state the board renders, `bot` from the roster's own isBot flag. There is no
 * placeholder anywhere in here; an absent clock renders nothing rather than
 * a zero, exactly as TurnClock does in ui.tsx.
 *
 * The clock and bot badge wrap when the current width or font scale needs it.
 */
export function Seat({
  name, role, bot, glyph, clock, taken, edge, active, width,
}: {
  name: string; role: string; bot: boolean; glyph: string; clock: string | null;
  taken: string[]; edge: number; active: boolean; width: number;
}) {
  const t = useType();
  const material = `${taken.join('')}${edge > 0 ? `  +${edge}` : ''}`;
  const spokenMaterial = `${taken.map(g => GLYPH_NAME[g] ?? g).join(', ')}${edge > 0 ? `, ahead by ${edge}` : ''}`;
  return (
    <View
      // One stop per seat. Without `accessible` iOS ignores this label and
      // reads the glyph, name, role and clock as separate fragments.
      accessible
      accessibilityLabel={
        `${name}${bot ? ', bot' : ''}. ${role}.` +
        (material ? ` Captured ${spokenMaterial}.` : '') +
        (clock ? ` ${clock} on the clock.` : '')
      }
      style={{
        width, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: S[3],
        paddingVertical: S[2], paddingHorizontal: S[3],
        borderRadius: R[4], borderWidth: 1,
        // An active seat is LIT and gold-edged. Gold is this screen's one
        // accent and the seat to move is where it earns its place.
        borderColor: active ? CR.lineSoft : white(0.16),
        backgroundColor: white(active ? 0.12 : 0.07),
        boxShadow: active
          ? `0 10px 26px rgba(0,0,0,0.44), inset 0 1px 0 ${white(0.26)}, inset 0 -1px 0 rgba(0,0,0,0.32)`
          : `0 6px 18px rgba(0,0,0,0.30), inset 0 1px 0 ${white(0.16)}, inset 0 -1px 0 rgba(0,0,0,0.30)`,
      }}
    >
      {/* The sheen that makes a pane look like glass rather than a tinted box.
          Gentle by necessity, not by taste: it brightens the surface exactly
          where the role line sits, and CR.muted carries a contrast note that
          had to be recomputed for it. */}
      <LinearGradient
        pointerEvents="none"
        colors={[white(0.10), white(0.02), 'transparent']}
        locations={[0, 0.5, 1]}
        start={{ x: 0.08, y: 0 }}
        end={{ x: 0.92, y: 1 }}
        style={[StyleSheet.absoluteFillObject, { borderRadius: R[4] }]}
      />
      <View>
        <View style={{
          width: 40, height: 40, borderRadius: 20,
          alignItems: 'center', justifyContent: 'center',
          borderWidth: 1, borderColor: g(active ? 0.55 : 0.28),
          backgroundColor: white(0.12),
        }}>
          <Text allowFontScaling={false} style={{ fontSize: 22, color: CR.gold2 }}>{glyph}</Text>
        </View>
        {/* THE AVATAR IS A GLYPH, NOT A PHOTO, and that is a protocol fact
            rather than a style choice: the lobby roster is
            {vaultId, name, isBot, wins} and carries no image anywhere, so a
            photograph would need a server change. The crown is the reference's
            seat mark and costs nothing. */}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ position: 'absolute', top: -5, right: -3, fontSize: 12, color: CR.gold2 }}
        >
          ♛
        </Text>
      </View>

      <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 96 }}>
        <Text numberOfLines={1} style={{ color: CR.text, fontSize: t.md, fontWeight: '800' }}>{name}</Text>
        <Text numberOfLines={1} style={{ color: CR.muted, fontSize: t.sm }}>
          {material ? `${role}  ·  ${material}` : role}
        </Text>
      </View>

      {clock ? (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: S[1] + 2, maxWidth: '100%',
          paddingHorizontal: S[3], paddingVertical: S[1] + 2, borderRadius: R.pill,
          borderWidth: 1, borderColor: g(active ? 0.60 : 0.35),
          backgroundColor: active ? g(0.16) : white(0.07),
        }}>
          <Ionicons name="time-outline" size={15} color={active ? SEAT_CLOCK.active : CR.gold2} />
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: active ? SEAT_CLOCK.active : SEAT_CLOCK.idle, fontSize: t.md, fontWeight: '800', fontFamily: 'monospace' }}
          >
            {clock}
          </Text>
        </View>
      ) : null}

      {/* AI PRO — the opponent's own mark, and only when the roster says bot. */}
      {bot ? (
        <View style={{
          minWidth: 40, paddingHorizontal: S[1], paddingVertical: S[1], borderRadius: R[2], alignItems: 'center',
          borderWidth: 1, borderColor: g(0.6), backgroundColor: g(0.14),
        }}>
          <Text style={{ color: CR.gold2, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 }}>AI</Text>
          <Text style={{ color: CR.line, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 }}>PRO</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * What the table is doing, in one pill.
 *
 * REPLACES the full-width Banner. The banner was a slab as wide as the board
 * carrying two words, and on a phone it cost more vertical space than the seat
 * card above it. The information did not shrink with it — this says strictly
 * more than the banner did, because connecting and reconnecting are now states
 * it can express rather than a separate row somewhere else.
 *
 * The dot is never the only signal. Every state ships a word, so the pill is
 * readable with no colour vision at all, and `accessibilityLiveRegion` is
 * carried over from Banner so the change is announced rather than merely drawn.
 */
export function StatusPill({
  game, myColor, mine, spectator, phase, reconnecting, still, width,
}: {
  game: any; myColor: 'w' | 'b' | null; mine: boolean; spectator: boolean;
  phase: string; reconnecting: boolean; still: boolean; width: number;
}) {
  const t = useType();
  const s = statusOf(game, myColor, mine, spectator, phase, reconnecting);
  // The live region below is Android's announcement; this is iOS's. Turn
  // changes and the result are spoken without the player having to find the pill.
  useAnnounce(s.text);
  const pulse = useSharedValue(0);

  // Only the seat to move breathes, and only when the player has not asked the
  // system for less motion.
  const live = s.beat && !still;
  useEffect(() => {
    if (live) {
      pulse.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
    return () => cancelAnimation(pulse);
  }, [live, pulse]);
  const aDot = useAnimatedStyle(() => ({ opacity: 1 - pulse.value * 0.55 }));

  return (
    <View style={{ width, alignItems: 'center', gap: S[2] }}>
      <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: S[3] }}>
        {/* The two rules the reference runs out to the edges. Decorative, and
            hidden from a screen reader for exactly that reason. */}
        <View accessibilityElementsHidden importantForAccessibility="no"
          style={{ flex: 1, height: 1, backgroundColor: g(0.26) }} />
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={s.text}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: S[2],
            paddingVertical: S[2] + 2, paddingHorizontal: S[4],
            borderRadius: R.pill, borderWidth: 1, borderColor: s.tone,
            backgroundColor: alpha(s.tone, 0.14),
            boxShadow: `0 8px 22px rgba(0,0,0,0.36), inset 0 1px 0 ${white(0.18)}`,
          }}
        >
          <Animated.View
            style={[{ width: 9, height: 9, borderRadius: 5, backgroundColor: s.tone }, aDot]}
          />
          <Text numberOfLines={1} style={{ color: CR.text, fontSize: t.md, fontWeight: '800' }}>{s.text}</Text>
        </View>
        <View accessibilityElementsHidden importantForAccessibility="no"
          style={{ flex: 1, height: 1, backgroundColor: g(0.26) }} />
      </View>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ color: CR.muted, fontSize: 11.5, fontWeight: '500' }}
      >
        Good moves create great stories
      </Text>
    </View>
  );
}

/**
 * The whole status vocabulary, in one place.
 *
 * Nothing here is invented: every branch is a state the socket already puts on
 * screen somewhere. `result` and `winner` come off the game frame, `check` off
 * the same frame the board reads, `phase` off the shared socket hook, and
 * `spectator` off the seat the server gave this client.
 */
function statusOf(
  game: any, myColor: 'w' | 'b' | null, mine: boolean,
  spectator: boolean, phase: string, reconnecting: boolean,
): { text: string; tone: string; beat?: boolean } {
  if (game.result) {
    const won = game.winner && game.winner === myColor;
    return { text: resultText(game, myColor), tone: won ? CR.ok : game.winner ? CR.bad : CR.warn };
  }
  if (reconnecting) return { text: 'Reconnecting', tone: CR.warn, beat: true };
  if (phase !== 'connected') return { text: 'Connecting', tone: CR.warn, beat: true };
  if (spectator) return { text: 'Watching', tone: ACCENT.chess };
  if (game.check) return { text: mine ? 'Check — your move' : 'Check', tone: CR.bad, beat: mine };
  return mine
    ? { text: 'Your move', tone: CR.line, beat: true }
    : { text: 'Opponent’s move', tone: ACCENT.chess };
}
