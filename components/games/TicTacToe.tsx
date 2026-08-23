/**
 * Tic-Tac-Toe — native, server-refereed.
 *
 * Replaces the WebView. The games server owns the rules: it decides whose turn
 * it is, whether a cell is legal, and who won. This file sends `mark` intents
 * and renders the snapshot that comes back — see docs/GAMES_PROTOCOL.md.
 *
 * That split is deliberate and worth keeping. A local win-checker would be
 * twenty lines and would be a second source of truth, so the moment it
 * disagreed with the server the two players would see different boards. There
 * is no reconciliation problem if only one side ever decides anything.
 *
 * board: number[9] — -1 empty, 0 seat-0 (✕), 1 seat-1 (◯).
 */

import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { useGameSocket, isMyTurn } from '../../lib/games/useGameSocket';

const MARKS = ['✕', '◯'];

export default function TicTacToe({ roomId = '' }: { roomId?: string }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { phase, error, state, events, send, retry } = useGameSocket('tictactoe', roomId);

  const L = state.lobby;
  const G = state.game;
  const myTurn = isMyTurn(state);
  const finished = G?.phase === 'finished';

  // ── connecting / failed ────────────────────────────────────────────
  if (error && phase !== 'connected') {
    return (
      <View style={s.center}>
        <Text style={s.title}>Can’t reach the table</Text>
        <Text style={s.muted}>{error}</Text>
        <Pressable style={s.btn} onPress={retry}><Text style={s.btnTxt}>Try again</Text></Pressable>
      </View>
    );
  }
  if (!L) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={s.muted}>{phase === 'minting' ? 'Taking your seat…' : 'Joining the table…'}</Text>
      </View>
    );
  }

  // ── lobby ──────────────────────────────────────────────────────────
  // A finished board outranks a 'lobby' status: the result belongs on the
  // board the player was just looking at, not behind a bounce back to a seat
  // list. Same rule the web client follows.
  if (L.status === 'lobby' && !finished) {
    const isHost = L.hostId === state.you;
    const full = (L.members?.length ?? 0) >= 2;
    return (
      <ScrollView contentContainerStyle={s.lobbyWrap}>
        <Text style={s.title}>Tic-Tac-Toe</Text>
        <Text style={s.muted}>Three in a row. Server-refereed — every move is validated by the table, not by either phone.</Text>

        <View style={s.seats}>
          {(L.members ?? []).map((m, i) => (
            <View key={m.vaultId ?? i} style={s.seat}>
              <Text style={s.seatMark}>{MARKS[i] ?? '◌'}</Text>
              <Text style={s.seatName} numberOfLines={1}>
                {m.name}{m.vaultId === state.you ? ' (you)' : ''}{m.isBot ? ' 🤖' : ''}
              </Text>
              <Text style={s.seatSub}>{m.wins ?? 0} won here</Text>
            </View>
          ))}
          {(L.members?.length ?? 0) < 2 && (
            <View style={[s.seat, s.seatOpen]}>
              <Text style={s.seatMark}>◌</Text>
              <Text style={s.seatName}>Open seat</Text>
              <Text style={s.seatSub}>invite someone, or add a bot</Text>
            </View>
          )}
        </View>

        {state.spectator ? (
          <Text style={s.muted}>👁 You’re watching. The next free seat is yours.</Text>
        ) : (
          <View style={s.lobbyActions}>
            {!full && (
              <Pressable style={s.btn} onPress={() => send({ t: 'addbot' })}>
                <Text style={s.btnTxt}>Add a bot</Text>
              </Pressable>
            )}
            {isHost && full && (
              <Pressable style={[s.btn, s.btnPrimary]} onPress={() => send({ t: 'start' })}>
                <Text style={[s.btnTxt, s.btnPrimaryTxt]}>Start game</Text>
              </Pressable>
            )}
            {!isHost && full && <Text style={s.muted}>Waiting for the host to start…</Text>}
          </View>
        )}
        <Events events={events} s={s} />
      </ScrollView>
    );
  }

  // ── board ──────────────────────────────────────────────────────────
  const board: number[] = Array.isArray(G?.board) ? G.board : Array(9).fill(-1);
  const line: number[] = Array.isArray(G?.line) ? G.line : [];
  const players: { id: string; seat: number; name: string }[] = G?.players ?? [];
  const toMove = players.find(p => p.id === G?.turnPlayerId);
  const winner = players.find(p => p.id === G?.winnerId);

  const status = finished
    ? (G?.winnerId
        ? (G.winnerId === state.you ? 'You won' : `${winner?.name ?? 'Opponent'} won`)
        : 'Draw')
    : state.spectator
      ? `${toMove?.name ?? '…'} to play`
      : myTurn ? 'Your move' : `${toMove?.name ?? 'Opponent'} to play`;

  return (
    <ScrollView contentContainerStyle={s.boardWrap}>
      <Text style={[s.status, finished && s.statusDone]}>{status}</Text>

      <View style={s.grid}>
        {board.map((v, i) => {
          // Playability comes from the server's turn, never from a local guess.
          // If something slips through anyway the server answers `error` and
          // the next snapshot puts the board right.
          const playable = !finished && myTurn && v < 0;
          return (
            <Pressable
              key={i}
              style={[s.cell, line.includes(i) && s.cellWin, playable && s.cellPlayable]}
              onPress={() => playable && send({ t: 'mark', cell: i })}
              disabled={!playable}
              accessibilityLabel={v >= 0 ? `cell ${i + 1}, ${MARKS[v]}` : `cell ${i + 1}, empty`}
            >
              <Text style={[s.cellMark, v === 0 && s.markX, v === 1 && s.markO]}>
                {v >= 0 ? MARKS[v] : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={s.playerRow}>
        {players.map(p => (
          <View key={p.id} style={[s.playerChip, p.id === G?.turnPlayerId && !finished && s.playerChipOn]}>
            <Text style={s.playerMark}>{MARKS[p.seat] ?? '?'}</Text>
            <Text style={s.playerName} numberOfLines={1}>
              {p.name}{p.id === state.you ? ' (you)' : ''}
            </Text>
          </View>
        ))}
      </View>

      {finished && !state.spectator && (
        <Pressable style={[s.btn, s.btnPrimary]} onPress={() => send({ t: 'start' })}>
          <Text style={[s.btnTxt, s.btnPrimaryTxt]}>Play again</Text>
        </Pressable>
      )}
      <Events events={events} s={s} />
    </ScrollView>
  );
}

/** Server notices — the only channel that explains a refused move. */
function Events({ events, s }: { events: string[]; s: any }) {
  if (!events.length) return null;
  return (
    <View style={s.events}>
      {events.slice(-3).map((e, i) => <Text key={i} style={s.eventTxt}>{e}</Text>)}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 28 },
  title:       { color: c.text, fontSize: 22, fontWeight: '800' },
  muted:       { color: c.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },

  lobbyWrap:   { padding: 20, gap: 14 },
  seats:       { flexDirection: 'row', gap: 10, marginTop: 6 },
  seat:        { flex: 1, alignItems: 'center', gap: 4, padding: 14, borderRadius: 14,
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  seatOpen:    { borderStyle: 'dashed' },
  seatMark:    { fontSize: 30, color: c.text },
  seatName:    { color: c.text, fontSize: 14, fontWeight: '700' },
  seatSub:     { color: c.textDim, fontSize: 11 },
  lobbyActions:{ gap: 10, marginTop: 6 },

  boardWrap:   { padding: 20, gap: 16, alignItems: 'center' },
  status:      { color: c.text, fontSize: 17, fontWeight: '800' },
  statusDone:  { color: c.primary },
  grid:        { width: 300, height: 300, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell:        { width: 96, height: 96, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  cellPlayable:{ borderColor: c.primary },
  cellWin:     { backgroundColor: c.primary },
  cellMark:    { fontSize: 44, color: c.text, fontWeight: '700' },
  markX:       { color: c.primary },
  markO:       { color: c.purple },

  playerRow:   { flexDirection: 'row', gap: 10, flexWrap: 'wrap', justifyContent: 'center' },
  playerChip:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7,
                 borderRadius: 20, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  playerChipOn:{ borderColor: c.primary },
  playerMark:  { fontSize: 15, color: c.text },
  playerName:  { color: c.text, fontSize: 13, fontWeight: '600', maxWidth: 130 },

  btn:         { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12, alignItems: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  btnTxt:      { color: c.text, fontSize: 15, fontWeight: '700' },
  btnPrimary:  { backgroundColor: c.primary, borderColor: c.primary },
  btnPrimaryTxt:{ color: '#fff' },

  events:      { marginTop: 8, gap: 3, alignSelf: 'stretch' },
  eventTxt:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
});
