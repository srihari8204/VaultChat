/**
 * Rummy — native, server-refereed.
 *
 * The server holds the deck, deals, and validates every meld. It sends the
 * public table in `game` and THIS player's cards in a separate top-level
 * `hand` — the other players are only ever a `handCount`, which is what keeps
 * the game honest: nobody's cards are ever on another device to be read out of
 * a debugger. See docs/GAMES_PROTOCOL.md.
 *
 * So there is no meld validation here, no scoring, no wild-card substitution
 * logic. `declare` sends the player's grouping and the SERVER decides whether
 * it is a valid hand. A client-side "is this a valid sequence" check would be
 * a second rulebook, and the disagreement would land on the player as a
 * declaration that looked fine and lost them the round.
 *
 * Card: { id, suit: 'S'|'H'|'D'|'C'|'JOKER', rank } — id is unique per physical
 * card because two decks are in play and duplicates genuinely exist.
 */

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { useGameSocket } from '../../lib/games/useGameSocket';

type Card = { id: string; suit: string; rank: string };

const SUIT_GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣', JOKER: '★' };
const RED = new Set(['H', 'D']);

function label(c: Card): string {
  if (c.suit === 'JOKER' || !c.rank) return '★';
  return `${c.rank}${SUIT_GLYPH[c.suit] ?? ''}`;
}

export default function Rummy({ tableId = '' }: { tableId?: string }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { phase, error, state, events, send, retry } = useGameSocket('rummy', tableId);
  // Selection is local: which cards the player has picked for a discard or a
  // declaration. Nothing about it is game truth, so it never leaves this file
  // except as an explicit intent.
  const [picked, setPicked] = useState<string[]>([]);

  const L = state.lobby;
  const G = state.game;
  const hand: Card[] = Array.isArray(state.raw?.hand) ? state.raw.hand : [];

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
        <Text style={s.title}>Rummy</Text>
        <Text style={s.muted}>Thirteen cards, two decks. The table deals and judges every declaration — your cards are never sent to another player’s device.</Text>
        <View style={s.seatList}>
          {(L.members ?? []).map((m: any, i: number) => (
            <View key={m.vaultId ?? i} style={s.seatRow}>
              <Text style={s.seatName} numberOfLines={1}>
                {m.name}{m.vaultId === state.you ? ' (you)' : ''}{m.isBot ? ' 🤖' : ''}
              </Text>
            </View>
          ))}
          <Text style={s.muted}>{n} seated</Text>
        </View>
        {state.spectator ? (
          <Text style={s.muted}>👁 You’re watching this table.</Text>
        ) : (
          <View style={s.lobbyActions}>
            <Pressable style={s.btn} onPress={() => send({ t: 'addbot' })}>
              <Text style={s.btnTxt}>Add a bot</Text>
            </Pressable>
            {isHost && n >= 2 && (
              <Pressable style={[s.btn, s.btnPrimary]} onPress={() => send({ t: 'start' })}>
                <Text style={[s.btnTxt, s.btnPrimaryTxt]}>Start game</Text>
              </Pressable>
            )}
            {!isHost && n >= 2 && <Text style={s.muted}>Waiting for the host to start…</Text>}
          </View>
        )}
        <Events events={events} s={s} />
      </ScrollView>
    );
  }

  // ── table ──────────────────────────────────────────────────────────
  const players: any[] = G?.players ?? [];
  const myTurn = !state.spectator && G?.turnPlayerId === state.you;
  const openTop: Card | null = G?.openTop ?? null;
  const wild: Card | null = G?.wildJokerCard ?? null;
  const toMove = players.find(p => p.id === G?.turnPlayerId);
  const winner = players.find(p => p.id === G?.winnerId);

  // 13 cards means the draw is spent and a discard is owed; 14 means it is not.
  // The server enforces this — the count only decides which controls to show.
  const mustDiscard = myTurn && hand.length > 13;
  const canDraw = myTurn && hand.length <= 13;

  const toggle = (id: string) =>
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));

  const status = finished
    ? (G?.winnerId === state.you ? 'You won' : `${winner?.name ?? 'Someone'} won`)
    : state.spectator ? `${toMove?.name ?? '…'} to play`
    : canDraw ? 'Your turn — draw a card'
    : mustDiscard ? 'Discard one card'
    : `${toMove?.name ?? 'Opponent'} to play`;

  return (
    <ScrollView contentContainerStyle={s.tableWrap}>
      <Text style={[s.status, finished && s.statusDone]}>{status}</Text>

      <View style={s.pilesRow}>
        <Pressable
          style={[s.pile, canDraw && s.pileLive]}
          onPress={() => canDraw && send({ t: 'draw', source: 'closed' })}
          disabled={!canDraw}
        >
          <Text style={s.pileBack}>🂠</Text>
          <Text style={s.pileLabel}>{G?.closedCount ?? 0} left</Text>
        </Pressable>

        <Pressable
          style={[s.pile, canDraw && !!openTop && s.pileLive]}
          onPress={() => canDraw && openTop && send({ t: 'draw', source: 'open' })}
          disabled={!canDraw || !openTop}
        >
          <Text style={[s.pileCard, openTop && RED.has(openTop.suit) && s.red]}>
            {openTop ? label(openTop) : '–'}
          </Text>
          <Text style={s.pileLabel}>Open</Text>
        </Pressable>

        <View style={s.pile}>
          <Text style={[s.pileCard, wild && RED.has(wild.suit) && s.red]}>
            {wild ? label(wild) : '–'}
          </Text>
          <Text style={s.pileLabel}>Wild</Text>
        </View>
      </View>

      <View style={s.playerRow}>
        {players.map((p) => (
          <View key={p.id} style={[s.chip, p.id === G?.turnPlayerId && !finished && s.chipOn]}>
            <Text style={s.chipName} numberOfLines={1}>
              {p.name}{p.id === state.you ? ' (you)' : ''}
            </Text>
            {/* Other players are a COUNT, never cards. That is the privacy
                property, not a rendering shortcut. */}
            <Text style={s.chipSub}>{p.handCount ?? 0} cards</Text>
          </View>
        ))}
      </View>

      <Text style={s.handLabel}>Your hand · {hand.length} cards</Text>
      <View style={s.hand}>
        {hand.map((c) => {
          const on = picked.includes(c.id);
          return (
            <Pressable
              key={c.id}
              style={[s.card, on && s.cardOn]}
              onPress={() => toggle(c.id)}
              accessibilityLabel={`${label(c)}${on ? ', selected' : ''}`}
            >
              <Text style={[s.cardTxt, RED.has(c.suit) && s.red]}>{label(c)}</Text>
            </Pressable>
          );
        })}
      </View>

      {!finished && !state.spectator && (
        <View style={s.actions}>
          <Pressable
            style={[s.btn, mustDiscard && picked.length === 1 && s.btnPrimary]}
            disabled={!mustDiscard || picked.length !== 1}
            onPress={() => { send({ t: 'discard', cardId: picked[0] }); setPicked([]); }}
          >
            <Text style={[s.btnTxt, mustDiscard && picked.length === 1 && s.btnPrimaryTxt]}>
              Discard{picked.length === 1 ? '' : ' (pick 1)'}
            </Text>
          </Pressable>

          <Pressable
            style={s.btn}
            disabled={!mustDiscard || picked.length !== 1}
            onPress={() => {
              // The server validates the melds. Sending the hand as one group
              // is honest about what this client knows: it has not grouped
              // anything, and pretending otherwise would be inventing a rulebook.
              const rest = hand.filter(c => c.id !== picked[0]).map(c => c.id);
              send({ t: 'declare', discardId: picked[0], groups: [rest] });
              setPicked([]);
            }}
          >
            <Text style={s.btnTxt}>Declare</Text>
          </Pressable>

          <Pressable style={s.btn} onPress={() => send({ t: 'drop' })}>
            <Text style={s.btnTxt}>Drop</Text>
          </Pressable>
        </View>
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

const makeStyles = (c: Palette) => StyleSheet.create({
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 28 },
  title:       { color: c.text, fontSize: 22, fontWeight: '800' },
  muted:       { color: c.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },

  lobbyWrap:   { padding: 20, gap: 14 },
  seatList:    { gap: 8, marginTop: 4 },
  seatRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12,
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  seatName:    { flex: 1, color: c.text, fontSize: 14, fontWeight: '700' },
  lobbyActions:{ gap: 10, marginTop: 6 },

  tableWrap:   { padding: 16, gap: 14 },
  status:      { color: c.text, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  statusDone:  { color: c.primary },

  pilesRow:    { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  pile:        { width: 78, height: 96, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 4,
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  pileLive:    { borderColor: c.primary, borderWidth: 2 },
  pileBack:    { fontSize: 34, color: c.textDim },
  pileCard:    { fontSize: 22, fontWeight: '800', color: c.text },
  pileLabel:   { fontSize: 11, color: c.textDim },
  red:         { color: '#D64545' },

  playerRow:   { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  chip:        { alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  chipOn:      { borderColor: c.primary },
  chipName:    { color: c.text, fontSize: 12, fontWeight: '700', maxWidth: 110 },
  chipSub:     { color: c.textDim, fontSize: 11 },

  handLabel:   { color: c.textDim, fontSize: 12, fontWeight: '700', marginTop: 4 },
  hand:        { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  card:        { width: 46, height: 64, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
                 backgroundColor: c.surfaceSolid, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  cardOn:      { borderColor: c.primary, borderWidth: 2, transform: [{ translateY: -6 }] },
  cardTxt:     { fontSize: 16, fontWeight: '800', color: c.text },

  actions:     { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  btn:         { paddingVertical: 11, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center',
                 backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  btnTxt:      { color: c.text, fontSize: 14, fontWeight: '700' },
  btnPrimary:  { backgroundColor: c.primary, borderColor: c.primary },
  btnPrimaryTxt:{ color: '#fff' },

  events:      { marginTop: 6, gap: 3 },
  eventTxt:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
});
