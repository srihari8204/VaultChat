import { chessTttLayout } from '../../lib/games/chessTttLayout';
import Svg, { Path, Circle, G, Defs, LinearGradient as SvgLinear, Stop } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
/**
 * components/games/TicTacToe.tsx
 *
 * `board` is nine ints: -1 empty, 0 seat-0, 1 seat-1. The server decides the
 * turn, the winner and the winning line — `line` arrives with the result — so
 * there is no win check in this file.
 *
 * Visuals ported from games-web/tictactoe.css: two glowing marks, a pop as each
 * one lands, and the winning triple pulsing gold. The css teal and pink are now
 * the shared accents — see TEAL/PINK below.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, withSpring,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useGameSocket, isMyTurn, type AutoStart } from '../../lib/games/useGameSocket';
import { TableBackground, Panel, Btn, Banner, PlayerRow, Reconnecting, RematchBtn, TurnClock, useType, useBoardBox, useReduceMotion, useAnnounce } from './ui';
import { useAddBot, ADD_BOT_STALLED } from '../../lib/games/useAddBot';
import { startBlockedReason } from '../../lib/games/startHint';
import { useRematch } from '../../lib/games/useRematch';
import { RulesSheet, useFirstTimeRules } from './rules';
import { useCountdown } from '../../lib/games/useCountdown';
import { C, S, R, D3, alpha, white, ACCENT } from '../../lib/games/theme';
import { HIGHLIGHT } from '../../constants/gamesPalette';
import { playSfx, preloadSfx } from '../../lib/games/sfx';
import { Toasts, Confetti, VoiceBar } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { openInvite, shareResult } from '../../lib/games/invite';
import { tttCellLabel } from '../../lib/games/boardLabels';

/**
 * The two marks' colours.
 *
 * Seat 1 is the game's OWN accent — the same rose the hub card and this board's
 * banner use — rather than a pink invented here. Seat 0 borrows chess's ice so
 * the two players are far apart in hue; a board with two players needs its two
 * colours to be unmistakable at a glance more than it needs either of them to
 * be "the tic-tac-toe colour".
 */
const TEAL = ACCENT.chess;
const PINK = ACCENT.tictactoe;
const MARK = ['✕', '◯'];

export default function TicTacToe({ roomId, auto, autoBot }: { roomId: string } & AutoStart) {
  const { phase, error, state, events, send, subscribe, retry } = useGameSocket('tictactoe', roomId, { auto, autoBot });
  const t = useType();
  const voice = useTableVoice('tictactoe', roomId, { you: state.you, send, subscribe });

  const G = state.game;
  // A tap while the socket is down goes nowhere — the intent is dropped and the
  // next snapshot puts the board back where the server has it.
  const mine = isMyTurn(state) && phase === 'connected';
  const reconnecting = phase !== 'connected' && !!state.game;
  const rematch = useRematch('tictactoe', roomId, state, send);
  // "Add a bot" watched for an outcome, like Chess and Ludo: the server can
  // accept addbot and never seat one, and a silent button reads as broken.
  const bot = useAddBot(send, state.lobby?.members?.length ?? 0);
  // Offered once, in the lobby — before a move is ever required.
  const rules = useFirstTimeRules('tictactoe');
  // The rules from the board too, not only the lobby — a quick-match player
  // never sees the lobby. Separate from the first-run sheet so it never pops
  // up uninvited mid-game.
  const [showRules, setShowRules] = useState(false);
  // The server's own clock, when it sends one. No deadline shows no clock — a
  // frozen zero would be this board inventing a fact about a game it does not
  // referee.
  const secs = useCountdown(state.raw?.deadline, !!state.game && state.game.phase !== 'finished');
  const board: number[] = Array.isArray(G?.board) ? G.board : [];
  const line: number[] = Array.isArray(G?.line) ? G.line : [];
  const finished = G?.phase === 'finished';

  // Three columns, two gaps, and the board's own padding. Floored so three
  // integer cells always fit inside the frame: flex-wrap with a fractional
  // width drops the third cell onto its own row, which is what put the grid
  // out of alignment.
  const viewport = useBoardBox(330);
  const { wide, size, controlsWidth } = chessTttLayout(viewport.width, viewport.height, viewport.size);
  const { fontScale } = useWindowDimensions();
  const stackSeats = controlsWidth < 280 || fontScale > 1.3;
  const gap = 10;
  const pad = 10;
  const cell = Math.floor((size - pad * 2 - gap * 2 - 2) / 3);
  const inner = cell * 3 + gap * 2 + pad * 2 + 2;

  useEffect(() => { void preloadSfx(['tick', 'win', 'lose', 'draw']); }, []);

  // Driven off `lastCell` so the opponent's mark clicks too.
  const lastHeard = useRef<number | null>(null);
  useEffect(() => {
    const c = typeof G?.lastCell === 'number' ? G.lastCell : null;
    if (c != null && c !== lastHeard.current) playSfx('tick');
    lastHeard.current = c;
  }, [G?.lastCell]);

  const ended = useRef(false);
  useEffect(() => {
    if (G?.phase !== 'finished') { ended.current = false; return; }
    if (ended.current) return;
    ended.current = true;
    playSfx(!G.winnerId ? 'draw' : G.winnerId === state.you ? 'win' : 'lose');
  }, [G?.phase, G?.winnerId, state.you]);

  // Mid-game the board stays up with a banner; this full-screen failure is for
  // a table we never reached.
  if (error && phase !== 'connected' && !state.game) {
    return (
      <TableBackground>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
          <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 46 }}>✕</Text>
          <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>Could not reach the table</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
          <Btn label="Try again" kind="gold" onPress={retry} />
        </View>
      </TableBackground>
    );
  }

  // Only take the screen back BEFORE there is a board: a mid-game drop keeps the
  // grid up with a banner over it.
  if (phase !== 'connected' && !G) {
    return (
      <TableBackground>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: S[3] }}>
          <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 46 }}>✕</Text>
          <Text style={{ color: C.muted, fontSize: t.md }}>
            {phase === 'minting' ? 'Taking your seat…' : 'Joining the table…'}
          </Text>
        </View>
      </TableBackground>
    );
  }

  if (!G) {
    const members = state.lobby?.members ?? [];
    const host = state.lobby?.hostId === state.you;
    return (
      <TableBackground>
        <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3] }}>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>Tic-Tac-Toe</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
            Three in a row. The table keeps score and calls the winner.
          </Text>
          <Panel style={{ gap: S[2] }}>
            {members.map(m => (
              <PlayerRow
                key={m.vaultId}
                name={m.name}
                tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
                subtitle={typeof m.wins === 'number' ? `${m.wins} wins` : undefined}
              />
            ))}
          </Panel>
          {/* A private room is worth nothing if its code is not on screen: the
              deep link covers people who have the app open, and this covers
              everyone who is being read the code out loud. */}
          {!!roomId && (
            <Text style={{ color: C.muted, fontSize: t.sm }} selectable>
              Room code: <Text style={{ color: C.gold, fontWeight: '800' }}>{roomId}</Text>
            </Text>
          )}
          {/* Voice at the table. A private room is people you know waiting for
              each other — the moment you most want to talk — and until now the
              control only existed once the game was already running. */}
          <VoiceBar
            phase={voice.phase}
            error={voice.error}
            canSpeak={voice.canSpeak}
            muted={voice.muted}
            participants={voice.participants}
            onJoin={voice.join}
            onLeave={voice.leave}
            onToggleMute={voice.toggleMute}
          />
          <Btn label="How to play" icon="rules" onPress={rules.open} />
          <Btn label="Add a bot" icon="bot" onPress={() => bot.addBot({ t: 'addbot' })} />
          {bot.stalled && (
            <Text style={{ color: C.bad, fontSize: t.sm, lineHeight: 18 }}>{ADD_BOT_STALLED}</Text>
          )}
          <Btn label="Invite a friend" icon="link" onPress={() => { void openInvite('tictactoe', roomId); }} disabled={!roomId} />
          <Btn label="Start game" kind="gold" onPress={() => send({ t: 'start' })} disabled={!host || members.length < 2} />
          {!!startBlockedReason(host, members.length) && (
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 18, textAlign: 'center' }}>{startBlockedReason(host, members.length)}</Text>
          )}
        </ScrollView>
        <Toasts events={events} />
        <RulesSheet game="tictactoe" visible={rules.visible} onClose={rules.close} />
      </TableBackground>
    );
  }

  const players: { id: string; seat: number; name: string }[] = Array.isArray(G.players) ? G.players : [];
  const me = players.find(p => p.id === state.you);
  const them = players.find(p => p.id !== state.you);

  const boardView = (
    <>
        <View style={{
          width: inner, height: inner, padding: pad, borderRadius: 26, gap,
          // Was a hand-mixed navy (rgba(6,10,24)) - a blue-black plate on the
          // maroon room, then alpha(C.bg2, .5), a darker well in the room's own
          // hue. Now glass: the plate is LIGHTER than the room rather than
          // darker, so the board reads as a pane laid over it instead of a hole
          // cut into it — and the cells, which were already translucent white,
          // finally sit on something of the same substance.
          backgroundColor: white(0.09),
          borderWidth: 1, borderColor: white(0.34),
          boxShadow: `inset 0 1px 0 ${white(0.18)}, 0 30px 70px rgba(0,0,0,0.5)`,
        }}>
          {[0, 1, 2].map(row => (
            <View key={row} style={{ flexDirection: 'row', gap }}>
              {[0, 1, 2].map(col => {
                const i = row * 3 + col;
                return (
                  <Cell
                    key={i}
                    value={board[i] ?? -1}
                    size={cell}
                    won={line.includes(i)}
                    fresh={G.lastCell === i}
                    playable={mine && !finished && (board[i] ?? -1) < 0}
                    onPress={() => {
                      if (!mine || finished || (board[i] ?? -1) >= 0) return;
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                      send({ t: 'mark', cell: i });
                    }}
                    index={i}
                    mySeat={me?.seat ?? null}
                  />
                );
              })}
            </View>
          ))}
        </View>
    </>
  );

  return (
    <TableBackground>
      <View onLayout={viewport.onLayout} style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
      {wide && <ScrollView style={{ width: size + 32, flexGrow: 0 }} contentContainerStyle={{ padding: 16, alignItems: 'center' }}>{boardView}</ScrollView>}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: S[4], gap: S[4], alignItems: 'center', paddingBottom: S[6] }}>

        {reconnecting && <Reconnecting error={error} onRetry={retry} />}

        <View style={{ width: controlsWidth, flexDirection: stackSeats ? 'column' : 'row', gap: S[2] }}>
          <SeatChip stacked={stackSeats} name={them?.name ?? 'Opponent'} mark={them ? MARK[them.seat] : '◯'} active={!mine && !finished} />
          <SeatChip stacked={stackSeats} name={me ? `${me.name} (you)` : 'You'} mark={me ? MARK[me.seat] : '✕'} active={mine && !finished} />
        </View>

        <TurnClock secs={secs} />

        {!wide && boardView}

        <View style={{ width: controlsWidth }}>
          {finished
            ? <Banner
                text={G.winnerId ? (G.winnerId === state.you ? 'You win!' : `${them?.name ?? 'Opponent'} wins`) : 'Draw — nobody blinked'}
                tone={G.winnerId ? (G.winnerId === state.you ? 'win' : 'lose') : 'info'}
              />
            : <TurnLine mine={mine} name={them?.name ?? 'your opponent'} />}
        </View>

        <VoiceBar
          width={controlsWidth}
          phase={voice.phase}
          error={voice.error}
          canSpeak={voice.canSpeak}
          muted={voice.muted}
          participants={voice.participants}
          onJoin={voice.join}
          onLeave={voice.leave}
          onToggleMute={voice.toggleMute}
        />

        {finished ? (
          <View style={{ width: controlsWidth, gap: S[2] }}>
            <View style={{ flexDirection: 'row' }}><RematchBtn rm={rematch} /></View>
            <Btn label="Share" icon="share" onPress={() => { void shareResult('tictactoe', G.winnerId === state.you); }} />
          </View>
        ) : (
          <Btn label="Invite a friend" icon="link" style={{ width: controlsWidth }} onPress={() => { void openInvite('tictactoe', roomId); }} disabled={!roomId} />
        )}
        <Btn label="How to play" icon="rules" compact style={{ width: controlsWidth }} onPress={() => setShowRules(true)} />
      </ScrollView>
      </View>
      <Toasts events={events} />
      <Confetti show={finished && G.winnerId === state.you} />
      <RulesSheet game="tictactoe" visible={showRules} onClose={() => setShowRules(false)} />
    </TableBackground>
  );
}

function Cell({
  value, size, won, fresh, playable, onPress, index, mySeat,
}: { value: number; size: number; won: boolean; fresh: boolean; playable: boolean; onPress: () => void; index: number; mySeat: number | null }) {
  const still = useReduceMotion();
  const pop = useSharedValue(value >= 0 ? 1 : 0);
  const glow = useSharedValue(0);
  const played = useRef(false);

  // pop, from tictactoe.css: scale .4 → 1 with an overshoot as the mark lands.
  useEffect(() => {
    if (value >= 0 && !played.current) {
      played.current = true;
      pop.value = 0.4;
      pop.value = still ? 1 : withSpring(1, { damping: 9, stiffness: 260, mass: 0.6 });
    } else if (value < 0) {
      played.current = false;
      pop.value = 0;
    } else if (still) {
      cancelAnimation(pop);
      pop.value = 1;
    }
  }, [value, pop, still]);

  useEffect(() => {
    if (won && !still) {
      glow.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(glow);
      glow.value = still ? 0 : withTiming(0, { duration: 200 });
    }
    return () => cancelAnimation(glow);
  }, [won, glow, still]);

  const aMark = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }], opacity: pop.value }));
  const aCell = useAnimatedStyle(() => ({ shadowOpacity: won ? 0.2 + glow.value * 0.45 : 0 }));

  const color = value === 0 ? TEAL : PINK;

  return (
    <Animated.View style={[{
      width: size, height: size, borderRadius: Math.min(22, size * 0.2), overflow: 'hidden',
      borderWidth: won ? 1.6 : 1,
      borderColor: won ? C.gold2 : fresh ? color : white(playable ? 0.3 : 0.16),
      backgroundColor: won ? alpha(C.gold2, 0.18) : fresh ? alpha(color, 0.14) : white(0.08),
      alignItems: 'center', justifyContent: 'center',
      // The lit top edge is what separates a cell from the pane behind it now
      // that both are made of the same translucent white.
      boxShadow: `inset 0 1px 0 ${white(0.16)}`,
      shadowColor: C.gold2, shadowRadius: 26, shadowOffset: { width: 0, height: 0 },
    }, aCell]}>
      <LinearGradient pointerEvents="none" colors={[white(won ? 0.20 : 0.12), 'transparent', 'rgba(0,0,0,0.16)']} style={{ position: 'absolute', inset: 0 }} />
      {fresh && !won ? <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 8, width: 5, height: 5, borderRadius: 3, backgroundColor: color }} /> : null}
      <Pressable
        onPress={onPress}
        disabled={!playable}
        accessibilityRole="button"
        accessibilityLabel={`${tttCellLabel(index, value, mySeat, playable)}${won ? ', winning line' : fresh ? ', latest move' : ''}`}
        accessibilityState={{ disabled: !playable }}
        style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
      >
        {value >= 0 && (
          <Animated.View style={aMark} pointerEvents="none">
            <Mark cross={value === 0} size={size * 0.62} color={won ? C.gold2 : color} />
          </Animated.View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** Rounded vector marks stay crisp at any board size and never depend on fonts. */
function Mark({ cross, size, color }: { cross: boolean; size: number; color: string }) {
  const gradientId = `mark${useId().replace(/:/g, '')}`;
  const shape = cross ? <Path d="M 24 24 L 76 76 M 76 24 L 24 76" /> : <Circle cx="50" cy="50" r="29" />;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs><SvgLinear id={gradientId} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={HIGHLIGHT} /><Stop offset="0.35" stopColor={color} /><Stop offset="1" stopColor={color} /></SvgLinear></Defs>
      <G transform="translate(0 3)" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="14" strokeLinecap="round">{shape}</G>
      <G fill="none" stroke={`url(#${gradientId})`} strokeWidth="10" strokeLinecap="round">{shape}</G>
    </Svg>
  );
}

/** The turn line, with the blinking dot from tictactoe.css. */
function TurnLine({ mine, name }: { mine: boolean; name: string }) {
  const t = useType();
  const still = useReduceMotion();
  const blink = useSharedValue(1);
  useEffect(() => {
    if (still) { blink.value = 1; return; }
    blink.value = withRepeat(withTiming(0.25, { duration: 700, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => cancelAnimation(blink);
  }, [blink, still]);
  const a = useAnimatedStyle(() => ({ opacity: blink.value }));
  const text = mine ? 'Your move' : `Waiting for ${name}`;
  // iOS hears the turn change here; Android through the live region.
  useAnnounce(text);

  return (
    <View accessible accessibilityLiveRegion="polite" accessibilityLabel={text} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2], padding: S[3], borderRadius: R[3], borderWidth: 1, borderColor: white(0.16), backgroundColor: white(0.06) }}>
      <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: mine ? TEAL : C.muted }, a]} />
      <Text style={{ flexShrink: 1, textAlign: 'center', color: C.text, fontSize: t.md, fontWeight: '700' }}>
        {text}
      </Text>
    </View>
  );
}

function SeatChip({ name, mark, active, stacked }: { name: string; mark: string; active: boolean; stacked: boolean }) {
  const t = useType();
  return (
    <View accessible accessibilityLabel={`${name}, plays ${mark === '✕' ? 'crosses' : 'noughts'}${active ? ', to move' : ''}`} style={{
      flex: stacked ? undefined : 1, flexDirection: 'row', alignItems: 'center', gap: S[2],
      paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
      // Matches ui.tsx PlayerRow: an active seat is LIT, in its own mark's
      // colour. This block used to be a byte-for-byte copy of PlayerRow's, and
      // the two drifting apart is exactly what this restyle has to avoid.
      borderWidth: 1,
      borderColor: active ? (mark === '✕' ? TEAL : PINK) : white(0.12),
      backgroundColor: white(active ? 0.12 : 0.06),
      boxShadow: active
        ? `0 8px 22px rgba(0,0,0,0.38), inset 0 1px 0 ${white(0.20)}`
        : `${D3.lift1}, inset 0 1px 0 ${white(0.12)}`,
    }}>
      <Mark cross={mark === '✕'} size={24} color={mark === '✕' ? TEAL : PINK} />
      <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }}>{name}</Text>
    </View>
  );
}
