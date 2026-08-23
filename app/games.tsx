// app/games.tsx — Games hub. Native, no WebView.
//
// WAS a WebView onto games.corefinite.com. The four games are now React Native
// screens talking to the same server over a native WebSocket
// (lib/gamesSocket.ts + lib/games/useGameSocket.ts), so the page, its cookie
// jar and the whole launch-handshake dance are gone.
//
// The server is unchanged and still authoritative — it owns the deck, the dice
// and the rules, and the native screens render its snapshots exactly as the web
// clients did. See docs/GAMES_PROTOCOL.md.
//
// `game` and `room` params are preserved because deep links and the turn
// notifications already in the wild point here with them
// (gamesNotifySlug in the backend mints those slugs), so an invite that opened
// the WebView keeps working and now lands on the native board instead.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import type { GameKind } from '../lib/gamesSocket';

import TicTacToe from '../components/games/TicTacToe';
import Chess from '../components/games/Chess';
import Ludo from '../components/games/Ludo';
import Rummy from '../components/games/Rummy';

const GAMES: { kind: GameKind; name: string; icon: string; blurb: string }[] = [
  { kind: 'chess',     name: 'Chess',        icon: '♛', blurb: 'Server-refereed. Your legal moves come from the table.' },
  { kind: 'rummy',     name: 'Rummy',        icon: '🂡', blurb: '13 cards, two decks. Your hand never leaves the server.' },
  { kind: 'ludo',      name: 'Ludo',         icon: '🎲', blurb: 'Two to four players, provably fair dice.' },
  { kind: 'tictactoe', name: 'Tic-Tac-Toe',  icon: '✕', blurb: 'Three in a row. Quick one.' },
];

/** Only these four are exposed; anything else falls back to the menu. */
const KINDS = new Set(GAMES.map(g => g.kind));

export default function GamesScreen() {
  const { colors } = useTheme();
  const s = React.useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ game?: string; room?: string }>();

  const kind = typeof params.game === 'string' && KINDS.has(params.game as GameKind)
    ? (params.game as GameKind)
    : null;
  const room = typeof params.room === 'string' ? params.room : '';

  const title = kind ? (GAMES.find(g => g.kind === kind)?.name ?? 'Games') : 'Games';

  return (
    <>
      <Stack.Screen options={{ title, headerBackTitle: 'Games' }} />
      {kind ? <Board kind={kind} room={room} /> : (
        <ScrollView contentContainerStyle={s.wrap}>
          <Text style={s.h1}>Games</Text>
          <Text style={s.sub}>Play someone in your chats, or add a bot. Every table is refereed by the server, so both players always see the same board.</Text>

          {GAMES.map(g => (
            <Pressable
              key={g.kind}
              style={s.card}
              onPress={() => router.push({ pathname: '/games', params: { game: g.kind } } as any)}
              accessibilityLabel={`Play ${g.name}`}
            >
              <Text style={s.icon}>{g.icon}</Text>
              <View style={s.cardBody}>
                <Text style={s.cardName}>{g.name}</Text>
                <Text style={s.cardBlurb}>{g.blurb}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </>
  );
}

function Board({ kind, room }: { kind: GameKind; room: string }) {
  switch (kind) {
    case 'chess':     return <Chess roomId={room} />;
    case 'ludo':      return <Ludo roomId={room || 'ludo-main'} />;
    case 'rummy':     return <Rummy tableId={room} />;
    case 'tictactoe': return <TicTacToe roomId={room} />;
  }
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap:      { padding: 20, gap: 12 },
  h1:        { color: c.text, fontSize: 26, fontWeight: '800' },
  sub:       { color: c.textDim, fontSize: 13, lineHeight: 19, marginBottom: 6 },
  card:      { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 16,
               backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  icon:      { fontSize: 30, width: 40, textAlign: 'center', color: c.text },
  cardBody:  { flex: 1, gap: 3 },
  cardName:  { color: c.text, fontSize: 17, fontWeight: '800' },
  cardBlurb: { color: c.textDim, fontSize: 12.5, lineHeight: 17 },
});
