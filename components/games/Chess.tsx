/**
 * Chess — native, server-refereed.
 *
 * THE SERVER SENDS THE LEGAL MOVES. Every `state` frame carries
 * `legal: [{from,to,promo}]` — the complete move list for the player to move —
 * plus `check`. So this file contains no chess rules at all: no sliding-piece
 * generation, no pin detection, no castling or en-passant special-casing, no
 * checkmate search. Tapping a piece filters `legal` by `from`; that is the
 * whole "move generator".
 *
 * Which is the point. A second rules engine on the client would be hundreds of
 * lines of the most bug-prone code in board games, and every disagreement with
 * the server would show the two players different positions. See
 * docs/GAMES_PROTOCOL.md.
 *
 * Board: 64 entries, index = row*8 + col, row 0 = rank 8 (black back rank).
 * A square is null (empty) or {t:'p'|'n'|'b'|'r'|'q'|'k', c:'w'|'b'}.
 */

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { useGameSocket } from '../../lib/games/useGameSocket';

type Piece = { t: string; c: string } | null;
type Move = { from: number; to: number; promo?: string };

/** Figurine glyphs — one lookup, no image assets to ship or scale. */
const GLYPH: Record<string, string> = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};

const FILES = 'abcdefgh';
const alg = (i: number) => `${FILES[i & 7]}${8 - (i >> 3)}`;

export default function Chess({ roomId = '' }: { roomId?: string }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { phase, error, state, events, send, retry } = useGameSocket('chess', roomId);
  const [sel, setSel] = useState<number | null>(null);
  // A pawn reaching the last rank produces several legal moves differing only
  // by `promo`, so the piece has to be chosen before the move can be sent.
  const [promo, setPromo] = useState<{ from: number; to: number; opts: Move[] } | null>(null);

  const L = state.lobby;
  const G = state.game;
  // Chess seats by COLOUR, not seat index, and the legal-move list rides at the
  // TOP level of the frame beside `game` — both come from state.raw.
  const myColor: string | null = state.raw?.color ?? null;
  const legal: Move[] = Array.isArray(state.raw?.legal) ? state.raw.legal : [];

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

  const finished = !!G?.result;

  // ── lobby ──────────────────────────────────────────────────────────
  if (L.status === 'lobby' && !finished) {
    const isHost = L.hostId === state.you;
    const full = (L.members?.length ?? 0) >= 2;
    return (
      <ScrollView contentContainerStyle={s.lobbyWrap}>
        <Text style={s.title}>Chess</Text>
        <Text style={s.muted}>Every move is validated by the table. Your legal moves arrive from the server, so the board you see is the board your opponent sees.</Text>
        <View style={s.seats}>
          {(L.members ?? []).map((m: any, i: number) => (
            <View key={m.vaultId ?? i} style={s.seat}>
              <Text style={s.seatMark}>{m.color === 'b' ? '♚' : '♔'}</Text>
              <Text style={s.seatName} numberOfLines={1}>
                {m.name}{m.vaultId === state.you ? ' (you)' : ''}{m.isBot ? ' 🤖' : ''}
              </Text>
              <Text style={s.seatSub}>{m.color === 'b' ? 'Black' : m.color === 'w' ? 'White' : 'seated'}</Text>
            </View>
          ))}
          {!full && (
            <View style={[s.seat, s.seatOpen]}>
              <Text style={s.seatMark}>◌</Text>
              <Text style={s.seatName}>Open seat</Text>
              <Text style={s.seatSub}>invite, or add a bot</Text>
            </View>
          )}
        </View>
        {state.spectator ? (
          <Text style={s.muted}>👁 You’re watching this table.</Text>
        ) : (
          <View style={s.lobbyActions}>
            {!full && (
              <Pressable style={s.btn} onPress={() => send({ t: 'addbot', level: 2 })}>
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
  const board: Piece[] = Array.isArray(G?.board) ? G.board : Array(64).fill(null);
  const lastMove: Move | null = G?.lastMove ?? null;
  const myTurn = !state.spectator && myColor != null && G?.turn === myColor;

  // Black plays from the far side, so the board is flipped for them — a player
  // should always see their own pieces nearest.
  const flipped = myColor === 'b';
  const order = flipped
    ? Array.from({ length: 64 }, (_, i) => 63 - i)
    : Array.from({ length: 64 }, (_, i) => i);

  const movesFromSel = sel == null ? [] : legal.filter(m => m.from === sel);
  const targets = new Set(movesFromSel.map(m => m.to));

  const onSquare = (i: number) => {
    if (!myTurn || finished) return;
    if (sel != null && targets.has(i)) {
      const opts = movesFromSel.filter(m => m.to === i);
      // Several moves to the same square means promotion — ask which piece.
      if (opts.length > 1 && opts.some(o => o.promo)) { setPromo({ from: sel, to: i, opts }); return; }
      send({ t: 'move', from: sel, to: i, promo: opts[0]?.promo });
      setSel(null);
      return;
    }
    // Only squares the server says can move are selectable, so an illegal
    // selection is impossible rather than merely rejected.
    setSel(legal.some(m => m.from === i) ? i : null);
  };

  const status = finished
    ? (G?.winner ? (G.winner === myColor ? 'You won' : 'You lost') : (G?.result ?? 'Game over'))
    : state.spectator ? `${G?.turn === 'w' ? 'White' : 'Black'} to move`
    : myTurn ? (G?.check ? 'Your move — you’re in check' : 'Your move')
    : 'Opponent thinking…';

  return (
    <ScrollView contentContainerStyle={s.boardWrap}>
      <Text style={[s.status, finished && s.statusDone, G?.check && !finished && s.statusCheck]}>{status}</Text>

      <View style={s.board}>
        {order.map((i) => {
          const p = board[i];
          const dark = ((i >> 3) + (i & 7)) % 2 === 1;
          const isSel = sel === i;
          const isTarget = targets.has(i);
          const isLast = lastMove != null && (lastMove.from === i || lastMove.to === i);
          return (
            <Pressable
              key={i}
              style={[s.sq, dark ? s.sqDark : s.sqLight, isLast && s.sqLast, isSel && s.sqSel]}
              onPress={() => onSquare(i)}
              disabled={!myTurn || finished}
              accessibilityLabel={`${alg(i)}${p ? `, ${p.c === 'w' ? 'white' : 'black'} ${p.t}` : ', empty'}`}
            >
              {p && <Text style={[s.piece, p.c === 'w' ? s.pieceW : s.pieceB]}>{GLYPH[`${p.c}${p.t}`] ?? '?'}</Text>}
              {/* A dot for an empty target, a ring for a capture — the standard
                  affordance, and it reads without colour. */}
              {isTarget && !p && <View style={s.dot} />}
              {isTarget && !!p && <View style={s.ring} />}
            </Pressable>
          );
        })}
      </View>

      {promo && (
        <View style={s.promoBar}>
          <Text style={s.muted}>Promote to</Text>
          <View style={s.promoRow}>
            {promo.opts.filter(o => o.promo).map(o => (
              <Pressable
                key={o.promo}
                style={s.promoBtn}
                onPress={() => { send({ t: 'move', from: promo.from, to: promo.to, promo: o.promo }); setPromo(null); setSel(null); }}
              >
                <Text style={s.promoGlyph}>{GLYPH[`${myColor}${o.promo}`] ?? o.promo}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {!finished && !state.spectator && (
        <View style={s.actions}>
          <Pressable style={s.btn} onPress={() => send({ t: 'draw-offer' })}>
            <Text style={s.btnTxt}>Offer draw</Text>
          </Pressable>
        </View>
      )}
      {finished && !state.spectator && (
        <Pressable style={[s.btn, s.btnPrimary]} onPress={() => send({ t: 'start' })}>
          <Text style={[s.btnTxt, s.btnPrimaryTxt]}>Play again</Text>
        </Pressable>
      )}
      <Events events={events} s={s} />
    </ScrollView>
  );
}

function Events({ events, s }: { events: string[]; s: any }) {
  if (!events.length) return null;
  return (
    <View style={s.events}>
      {events.slice(-3).map((e, i) => <Text key={i} style={s.eventTxt}>{e}</Text>)}
    </View>
  );
}

const SQ = 42;

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

  boardWrap:   { padding: 16, gap: 14, alignItems: 'center' },
  status:      { color: c.text, fontSize: 16, fontWeight: '800' },
  statusDone:  { color: c.primary },
  statusCheck: { color: c.danger },

  board:       { width: SQ * 8, height: SQ * 8, flexDirection: 'row', flexWrap: 'wrap',
                 borderRadius: 8, overflow: 'hidden' },
  sq:          { width: SQ, height: SQ, alignItems: 'center', justifyContent: 'center' },
  sqLight:     { backgroundColor: '#EDE6D6' },
  sqDark:      { backgroundColor: '#9A7B5A' },
  sqLast:      { backgroundColor: '#C7C34E' },
  sqSel:       { backgroundColor: '#7FB069' },
  piece:       { fontSize: 30, lineHeight: 36 },
  pieceW:      { color: '#FFFFFF' },
  pieceB:      { color: '#1A1A1A' },
  dot:         { position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.35)' },
  ring:        { position: 'absolute', width: SQ - 6, height: SQ - 6, borderRadius: (SQ - 6) / 2,
                 borderWidth: 3, borderColor: 'rgba(0,0,0,0.35)' },

  promoBar:    { alignItems: 'center', gap: 8 },
  promoRow:    { flexDirection: 'row', gap: 10 },
  promoBtn:    { width: 52, height: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  promoGlyph:  { fontSize: 30, color: c.text },

  actions:     { flexDirection: 'row', gap: 10 },
  btn:         { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12, alignItems: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  btnTxt:      { color: c.text, fontSize: 15, fontWeight: '700' },
  btnPrimary:  { backgroundColor: c.primary, borderColor: c.primary },
  btnPrimaryTxt:{ color: '#fff' },

  events:      { marginTop: 6, gap: 3, alignSelf: 'stretch' },
  eventTxt:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
});
