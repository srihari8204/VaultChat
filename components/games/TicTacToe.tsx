/**
 * components/games/TicTacToe.tsx
 *
 * `board` is nine ints: -1 empty, 0 seat-0, 1 seat-1. The server decides the
 * turn, the winner and the winning line — `line` arrives with the result — so
 * there is no win check in this file.
 *
 * Visuals ported from games-web/tictactoe.css: teal ✕ and pink ◯ with a glow,
 * a pop as each mark lands, and the winning triple pulsing gold.
 */

import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, withSpring,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useGameSocket, isMyTurn, type AutoStart } from '../../lib/games/useGameSocket';
import { TableBackground, Panel, Btn, Banner, PlayerRow, useType, useBoardSize } from './ui';
import { C, S, R, D3, E, mix, goldLine, MOTION } from '../../lib/games/theme';
import { playSfx, preloadSfx } from '../../lib/games/sfx';
import { Toasts, Confetti, VoiceBar } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { inviteToTable, shareResult } from '../../lib/games/invite';

const TEAL = '#4be0c1';
const PINK = '#ff6fb5';
const WIN_GOLD = '#ffd479';
const MARK = ['✕', '◯'];

export default function TicTacToe({ roomId, auto, autoBot }: { roomId: string } & AutoStart) {
  const { phase, error, state, events, send, retry } = useGameSocket('tictactoe', roomId, { auto, autoBot });
  const t = useType();
  const { width } = useWindowDimensions();
  const voice = useTableVoice('tictactoe', roomId);

  const G = state.game;
  const mine = isMyTurn(state);
  const board: number[] = Array.isArray(G?.board) ? G.board : [];
  const line: number[] = Array.isArray(G?.line) ? G.line : [];
  const finished = G?.phase === 'finished';

  // Three columns, two gaps, and the board's own padding. Floored so three
  // integer cells always fit inside the frame: flex-wrap with a fractional
  // width drops the third cell onto its own row, which is what put the grid
  // out of alignment.
  const size = useBoardSize(330, 380);
  const gap = 10;
  const pad = 10;
  const cell = Math.floor((size - pad * 2 - gap * 2) / 3);
  const inner = cell * 3 + gap * 2 + pad * 2;

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

  if (error && phase !== 'connected') {
    return (
      <TableBackground>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
          <Text style={{ fontSize: 46 }}>✕</Text>
          <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>Could not reach the table</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
          <Btn label="Try again" kind="gold" onPress={retry} />
        </View>
      </TableBackground>
    );
  }

  if (phase !== 'connected') {
    return (
      <TableBackground>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: S[3] }}>
          <Text style={{ fontSize: 46 }}>✕</Text>
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
          <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>Tic-Tac-Toe</Text>
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
            {members.length < 2 && (
              <Text style={{ color: C.muted, fontSize: t.sm }}>Two players minimum — add a bot to start now.</Text>
            )}
          </Panel>
          <Btn label="Add a bot" icon="🤖" onPress={() => send({ t: 'addbot' })} />
          <Btn label="Invite a friend" icon="🔗" onPress={() => { void inviteToTable('tictactoe', roomId); }} disabled={!roomId} />
          <Btn label="Start game" kind="gold" onPress={() => send({ t: 'start' })} disabled={!host || members.length < 2} />
        </ScrollView>
        <Toasts events={events} />
      </TableBackground>
    );
  }

  const players: { id: string; seat: number; name: string }[] = Array.isArray(G.players) ? G.players : [];
  const me = players.find(p => p.id === state.you);
  const them = players.find(p => p.id !== state.you);

  return (
    <TableBackground>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[4], alignItems: 'center', paddingBottom: S[6] }}>

        <View style={{ width: size, flexDirection: 'row', gap: S[2] }}>
          <SeatChip name={them?.name ?? 'Opponent'} mark={them ? MARK[them.seat] : '◯'} active={!mine && !finished} />
          <SeatChip name={me ? `${me.name} (you)` : 'You'} mark={me ? MARK[me.seat] : '✕'} active={mine && !finished} />
        </View>

        <View style={{
          width: inner, height: inner, padding: pad, borderRadius: 24, gap,
          backgroundColor: 'rgba(6,10,24,0.5)',
          borderWidth: 1, borderColor: goldLine[18],
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 30px 70px rgba(0,0,0,0.5)',
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
                  />
                );
              })}
            </View>
          ))}
        </View>

        <View style={{ width: size }}>
          {finished
            ? <Banner
                text={G.winnerId ? (G.winnerId === state.you ? 'You win!' : `${them?.name ?? 'Opponent'} wins`) : 'Draw — nobody blinked'}
                tone={G.winnerId ? (G.winnerId === state.you ? 'win' : 'lose') : 'info'}
              />
            : <TurnLine mine={mine} name={them?.name ?? 'your opponent'} />}
        </View>

        <VoiceBar
          width={size}
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
          <View style={{ width: size, flexDirection: 'row', gap: S[2] }}>
            <Btn label="Rematch" kind="gold" icon="↻" style={{ flex: 1 }} onPress={() => send({ t: 'start' })} />
            <Btn label="Share" icon="📣" onPress={() => { void shareResult('tictactoe', G.winnerId === state.you); }} />
          </View>
        ) : (
          <Btn label="Invite a friend" icon="🔗" style={{ width: size }} onPress={() => { void inviteToTable('tictactoe', roomId); }} disabled={!roomId} />
        )}
      </ScrollView>
      <Toasts events={events} />
      <Confetti show={finished && G.winnerId === state.you} />
    </TableBackground>
  );
}

function Cell({
  value, size, won, fresh, playable, onPress, index,
}: { value: number; size: number; won: boolean; fresh: boolean; playable: boolean; onPress: () => void; index: number }) {
  const pop = useSharedValue(value >= 0 ? 1 : 0);
  const glow = useSharedValue(0);
  const played = useRef(false);

  // pop, from tictactoe.css: scale .4 → 1 with an overshoot as the mark lands.
  useEffect(() => {
    if (value >= 0 && !played.current) {
      played.current = true;
      pop.value = 0.4;
      pop.value = withSpring(1, { damping: 9, stiffness: 260, mass: 0.6 });
    } else if (value < 0) {
      played.current = false;
      pop.value = 0;
    }
  }, [value, pop]);

  useEffect(() => {
    if (won) {
      glow.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(glow);
      glow.value = withTiming(0, { duration: 200 });
    }
    return () => cancelAnimation(glow);
  }, [won, glow]);

  const aMark = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }], opacity: pop.value }));
  const aCell = useAnimatedStyle(() => ({ shadowOpacity: won ? 0.2 + glow.value * 0.45 : 0 }));

  const color = value === 0 ? TEAL : PINK;

  return (
    <Animated.View style={[{
      width: size, height: size, borderRadius: R[3],
      borderWidth: 1, borderColor: won ? WIN_GOLD : goldLine[18],
      backgroundColor: won ? 'rgba(255,212,121,0.14)' : 'rgba(255,255,255,0.07)',
      alignItems: 'center', justifyContent: 'center',
      shadowColor: WIN_GOLD, shadowRadius: 26, shadowOffset: { width: 0, height: 0 },
    }, aCell]}>
      <Pressable
        onPress={onPress}
        disabled={!playable}
        accessibilityRole="button"
        accessibilityLabel={cellLabel(index, value, playable)}
        style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
      >
        {value >= 0 && (
          <Animated.Text style={[{
            fontSize: size * 0.55, fontWeight: '700', color,
            textShadowColor: value === 0 ? 'rgba(75,224,193,0.55)' : 'rgba(255,111,181,0.5)',
            textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 22,
          }, aMark]}>
            {MARK[value]}
          </Animated.Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** The turn line, with the blinking dot from tictactoe.css. */
function TurnLine({ mine, name }: { mine: boolean; name: string }) {
  const t = useType();
  const blink = useSharedValue(1);
  useEffect(() => {
    blink.value = withRepeat(withTiming(0.25, { duration: 700, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => cancelAnimation(blink);
  }, [blink]);
  const a = useAnimatedStyle(() => ({ opacity: blink.value }));

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2] }}>
      <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: mine ? TEAL : C.muted }, a]} />
      <Text style={{ color: C.text, fontSize: t.md, fontWeight: '700' }}>
        {mine ? 'Your move' : `Waiting for ${name}`}
      </Text>
    </View>
  );
}

function SeatChip({ name, mark, active }: { name: string; mark: string; active: boolean }) {
  const t = useType();
  return (
    <View style={{
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: S[2],
      paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
      borderWidth: 1, borderColor: active ? goldLine[55] : goldLine[14],
      backgroundColor: mix(C.panel2, 86, '#ffffff'),
      boxShadow: active ? '0 6px 18px rgba(0,0,0,0.35)' : D3.lift1,
    }}>
      <Text style={{ fontSize: t.md, color: mark === '✕' ? TEAL : PINK, fontWeight: '800' }}>{mark}</Text>
      <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }}>{name}</Text>
    </View>
  );
}

function cellLabel(i: number, value: number, playable: boolean): string {
  const where = `row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}`;
  if (value < 0) return `${where}, empty${playable ? ', tap to play' : ''}`;
  return `${where}, ${MARK[value] === '✕' ? 'cross' : 'nought'}`;
}
