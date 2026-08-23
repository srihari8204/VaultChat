/**
 * Ludo — native, server-refereed.
 *
 * The server owns the dice and the rules. It sends `movable` — the token
 * indices this roll permits — exactly the way chess sends `legal`, so this file
 * decides nothing: no capture rules, no safe-square logic, no six-rolls-again,
 * no "must leave base on a six". Tapping a token is a membership test against
 * `movable`. See docs/GAMES_PROTOCOL.md.
 *
 * GEOMETRY IS COPIED FROM THE REFERENCE CLIENT, NOT RE-DERIVED. RING,
 * START_OFFSET, HOME_COORDS and BASE_SPOTS below are the same tables
 * games-web/ludo.js uses, and that file carries an explicit warning that they
 * must match go-server/internal/games/ludo. A second, independently invented
 * mapping would put tokens on the wrong squares for the same authoritative
 * state — the kind of bug that looks like a server fault and is not.
 *
 * Token step encoding (server): -1 base · 0..50 ring · 51..55 home column ·
 * 56 HOME (finished).
 */

import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { useGameSocket } from '../../lib/games/useGameSocket';

/** 52-cell ring [row,col] on a 15x15 board, clockwise from red's start. */
const RING: [number, number][] = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0],
];
const START_OFFSET = [0, 13, 26, 39];
const HOME_STEP = 56;
const CENTER_RC: [number, number] = [7, 7];
const HOME_COORDS: [number, number][][] = [
  [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],       // 0 red (left)
  [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],       // 1 green (top)
  [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],   // 2 yellow (right)
  [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],   // 3 blue (bottom)
];
const BASE_SPOTS: [number, number][][] = [
  [[1,1],[1,4],[4,1],[4,4]], [[1,10],[1,13],[4,10],[4,13]],
  [[10,10],[10,13],[13,10],[13,13]], [[10,1],[10,4],[13,1],[13,4]],
];
const COLORS = ['#e23b3b', '#2bb24c', '#f0c419', '#2f7be0'];
const COLOR_NAMES = ['Red', 'Green', 'Yellow', 'Blue'];
/** Safe ring cells — starts and star squares. Decorative only; the server enforces. */
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Board pixel size. 15 cells, so a whole number keeps the grid crisp. */
const CELL = 22;
const BOARD = CELL * 15;

/** Where a token sits, given its owner's corner and its step. */
function coord(corner: number, tokenIdx: number, step: number): [number, number] {
  if (step < 0) return BASE_SPOTS[corner][tokenIdx];
  if (step <= 50) return RING[(START_OFFSET[corner] + step) % 52];
  if (step >= HOME_STEP) return CENTER_RC;
  return HOME_COORDS[corner][Math.min(step - 51, 4)];
}

export default function Ludo({ roomId = 'ludo-main' }: { roomId?: string }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { phase, error, state, events, send, retry } = useGameSocket('ludo', roomId);

  const L = state.lobby;
  const G = state.game;

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

  const finished = G?.phase === 'finished';

  // ── lobby ──────────────────────────────────────────────────────────
  if (L.status === 'lobby' && !finished) {
    const isHost = L.hostId === state.you;
    const n = L.members?.length ?? 0;
    return (
      <ScrollView contentContainerStyle={s.lobbyWrap}>
        <Text style={s.title}>Ludo</Text>
        <Text style={s.muted}>Two to four players. The table rolls the dice and settles every capture — neither phone decides anything.</Text>
        <View style={s.seatList}>
          {(L.members ?? []).map((m: any, i: number) => (
            <View key={m.vaultId ?? i} style={s.seatRow}>
              <View style={[s.swatch, { backgroundColor: COLORS[i % 4] }]} />
              <Text style={s.seatName} numberOfLines={1}>
                {m.name}{m.vaultId === state.you ? ' (you)' : ''}{m.isBot ? ' 🤖' : ''}
              </Text>
              <Text style={s.seatSub}>{COLOR_NAMES[i % 4]}</Text>
            </View>
          ))}
          {n < 4 && <Text style={s.muted}>{n} seated · up to 4</Text>}
        </View>
        {state.spectator ? (
          <Text style={s.muted}>👁 You’re watching this table.</Text>
        ) : (
          <View style={s.lobbyActions}>
            {n < 4 && (
              <Pressable style={s.btn} onPress={() => send({ t: 'addbot' })}>
                <Text style={s.btnTxt}>Add a bot</Text>
              </Pressable>
            )}
            {isHost && n >= 2 && (
              <Pressable style={[s.btn, s.btnPrimary]} onPress={() => send({ t: 'start' })}>
                <Text style={[s.btnTxt, s.btnPrimaryTxt]}>Start game</Text>
              </Pressable>
            )}
            {isHost && n < 2 && <Text style={s.muted}>Two players minimum — add a bot to start now.</Text>}
            {!isHost && n >= 2 && <Text style={s.muted}>Waiting for the host to start…</Text>}
          </View>
        )}
        <Events events={events} s={s} />
      </ScrollView>
    );
  }

  // ── board ──────────────────────────────────────────────────────────
  const players: any[] = G?.players ?? [];
  const me = players.find(p => p.id === state.you);
  const myTurn = !state.spectator && !!me && G?.turnPlayerId === me.id;
  const movable: number[] = Array.isArray(G?.movable) ? G.movable : [];
  const die: number | null = G?.pendingDie ?? G?.lastDie ?? null;
  const toMove = players.find(p => p.id === G?.turnPlayerId);
  const winner = players.find(p => p.id === G?.winnerId);

  // A roll is pending until it has been spent on a move.
  const canRoll = myTurn && G?.pendingDie == null && !finished;
  const canMove = myTurn && G?.pendingDie != null && movable.length > 0;

  const status = finished
    ? (G?.winnerId === state.you ? 'You won' : `${winner?.name ?? 'Someone'} won`)
    : state.spectator ? `${toMove?.name ?? '…'} to play`
    : canRoll ? 'Your turn — roll'
    : canMove ? 'Pick a token'
    : myTurn ? 'No legal move — passing'
    : `${toMove?.name ?? 'Opponent'} to play`;

  return (
    <ScrollView contentContainerStyle={s.boardWrap}>
      <Text style={[s.status, finished && s.statusDone]}>{status}</Text>

      <View style={s.board}>
        {/* Home yards, one per corner, in seat colour. */}
        {[[0,0],[0,9],[9,9],[9,0]].map(([r, c], i) => (
          <View key={`yard${i}`} style={[s.yard, {
            top: r * CELL, left: c * CELL,
            borderColor: COLORS[[0,1,2,3][i]],
          }]} />
        ))}

        {/* The ring, drawn cell by cell so safe squares can be marked. */}
        {RING.map(([r, c], i) => (
          <View key={`ring${i}`} style={[s.cell, {
            top: r * CELL, left: c * CELL,
            backgroundColor: SAFE.has(i) ? 'rgba(0,0,0,0.10)' : '#FFFFFF',
          }]} />
        ))}

        {/* Home columns, in each corner's colour. */}
        {HOME_COORDS.map((col, ci) => col.map(([r, c], j) => (
          <View key={`home${ci}-${j}`} style={[s.cell, {
            top: r * CELL, left: c * CELL, backgroundColor: COLORS[ci], opacity: 0.55,
          }]} />
        )))}

        <View style={[s.centre, { top: 6 * CELL, left: 6 * CELL }]} />

        {/* Tokens. `seat` is the BOARD CORNER, not the players-array index —
            a 2-player game seats corners 0 and 2 so the players sit opposite,
            so indexing colours or coordinates by array position would put the
            second player's tokens in the wrong corner entirely. */}
        {players.map((p) => {
          const corner = typeof p.seat === 'number' ? p.seat : 0;
          const mine = p.id === state.you;
          return (p.tokens ?? []).map((step: number, ti: number) => {
            const [r, c] = coord(corner, ti, step);
            const selectable = mine && canMove && movable.includes(ti);
            return (
              <Pressable
                key={`${p.id}-${ti}`}
                style={[
                  s.token,
                  { top: r * CELL + 3, left: c * CELL + 3, backgroundColor: COLORS[corner] },
                  selectable && s.tokenLive,
                ]}
                onPress={() => selectable && send({ t: 'move', tokenIndex: ti })}
                disabled={!selectable}
                accessibilityLabel={`${COLOR_NAMES[corner]} token ${ti + 1}${selectable ? ', movable' : ''}`}
              />
            );
          });
        })}
      </View>

      <View style={s.controls}>
        <View style={s.die}>
          <Text style={s.dieTxt}>{die ?? '–'}</Text>
        </View>
        {canRoll && (
          <Pressable style={[s.btn, s.btnPrimary]} onPress={() => send({ t: 'roll', clientSeed: seed() })}>
            <Text style={[s.btnTxt, s.btnPrimaryTxt]}>Roll</Text>
          </Pressable>
        )}
      </View>

      <View style={s.playerRow}>
        {players.map((p) => (
          <View key={p.id} style={[s.chip, p.id === G?.turnPlayerId && !finished && s.chipOn]}>
            <View style={[s.swatch, { backgroundColor: COLORS[p.seat ?? 0] }]} />
            <Text style={s.chipName} numberOfLines={1}>
              {p.name}{p.id === state.you ? ' (you)' : ''}
            </Text>
            <Text style={s.chipHome}>{p.home ?? 0}/4</Text>
          </View>
        ))}
      </View>

      <Events events={events} s={s} />
    </ScrollView>
  );
}

/**
 * This player's half of the die roll.
 *
 * The server combines it with its own secret and publishes a commit hash, so
 * neither side alone decides the number and either can check afterwards. Sending
 * a constant would hand the whole roll to the server and quietly void that.
 */
function seed(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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
  seatList:    { gap: 8, marginTop: 4 },
  seatRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12,
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  swatch:      { width: 14, height: 14, borderRadius: 7 },
  seatName:    { flex: 1, color: c.text, fontSize: 14, fontWeight: '700' },
  seatSub:     { color: c.textDim, fontSize: 12 },
  lobbyActions:{ gap: 10, marginTop: 6 },

  boardWrap:   { padding: 16, gap: 14, alignItems: 'center' },
  status:      { color: c.text, fontSize: 16, fontWeight: '800' },
  statusDone:  { color: c.primary },

  board:       { width: BOARD, height: BOARD, backgroundColor: '#F3F0E7', borderRadius: 10, overflow: 'hidden' },
  yard:        { position: 'absolute', width: CELL * 6, height: CELL * 6, borderWidth: 3, borderRadius: 8, opacity: 0.5 },
  cell:        { position: 'absolute', width: CELL, height: CELL, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.18)' },
  centre:      { position: 'absolute', width: CELL * 3, height: CELL * 3, backgroundColor: '#DCd6c4', borderRadius: 6 },
  token:       { position: 'absolute', width: CELL - 6, height: CELL - 6, borderRadius: (CELL - 6) / 2,
                 borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)' },
  tokenLive:   { borderColor: '#111', borderWidth: 3 },

  controls:    { flexDirection: 'row', alignItems: 'center', gap: 14 },
  die:         { width: 52, height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  dieTxt:      { color: c.text, fontSize: 24, fontWeight: '800' },

  playerRow:   { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  chip:        { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6,
                 borderRadius: 18, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  chipOn:      { borderColor: c.primary },
  chipName:    { color: c.text, fontSize: 12, fontWeight: '600', maxWidth: 96 },
  chipHome:    { color: c.textDim, fontSize: 11 },

  btn:         { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12, alignItems: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  btnTxt:      { color: c.text, fontSize: 15, fontWeight: '700' },
  btnPrimary:  { backgroundColor: c.primary, borderColor: c.primary },
  btnPrimaryTxt:{ color: '#fff' },

  events:      { marginTop: 6, gap: 3, alignSelf: 'stretch' },
  eventTxt:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
});
