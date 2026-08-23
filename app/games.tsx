// app/games.tsx — Games hub. Native, no WebView.
//
// The four games are React Native screens talking to the games server over a
// native WebSocket (lib/gamesSocket.ts + lib/games/useGameSocket.ts). The
// server is unchanged and still authoritative — it owns the deck, the dice and
// the rules, and these screens render its snapshots. See docs/GAMES_PROTOCOL.md.
//
// Quick Match is the reason this screen is more than a menu: the games server
// runs a real matchmaker, and without it the only opponent reachable from the
// app is a bot. Playing a stranger and playing a friend by code are the two
// ways in that make these tables feel online rather than single-player.
//
// `game` and `room` params are preserved because deep links and the turn
// notifications already in the wild point here with them (gamesNotifySlug in
// the backend mints those slugs).

import React from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { GameKind } from '../lib/gamesSocket';
import { useQuickMatch } from '../lib/games/useQuickMatch';
import { TableBackground, Panel, Btn, useType } from '../components/games/ui';
import { C, S, R, D3, E, mix, goldLine } from '../lib/games/theme';

import TicTacToe from '../components/games/TicTacToe';
import Chess from '../components/games/Chess';
import Ludo from '../components/games/Ludo';
import Rummy from '../components/games/Rummy';

type Entry = { kind: GameKind; name: string; icon: string; blurb: string; accent: string };

const GAMES: Entry[] = [
  { kind: 'chess',     name: 'Chess',       icon: '♛', accent: '#8ca2ad', blurb: 'Server-refereed. Your legal moves come from the table.' },
  { kind: 'rummy',     name: 'Rummy',       icon: '🂡', accent: '#5fe08c', blurb: '13 cards, two decks. Your hand never leaves the server.' },
  { kind: 'ludo',      name: 'Ludo',        icon: '🎲', accent: '#f3c245', blurb: 'Two to four players, provably fair dice.' },
  { kind: 'tictactoe', name: 'Tic-Tac-Toe', icon: '✕', accent: '#ff8080', blurb: 'Three in a row. Quick one.' },
];

/** Only these four are exposed; anything else falls back to the menu. */
const KINDS = new Set(GAMES.map(g => g.kind));

export default function GamesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ game?: string; room?: string; auto?: string; bot?: string }>();

  const kind = typeof params.game === 'string' && KINDS.has(params.game as GameKind)
    ? (params.game as GameKind)
    : null;
  const room = typeof params.room === 'string' ? params.room : '';
  const auto = params.auto === '1';
  const autoBot = params.bot === '1';

  const title = kind ? (GAMES.find(g => g.kind === kind)?.name ?? 'Games') : 'Games';

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerBackTitle: 'Games',
          headerStyle: { backgroundColor: C.bg2 },
          headerTintColor: C.text,
          headerTitleStyle: { color: C.text, fontWeight: '800' },
        }}
      />
      {kind
        ? <Board kind={kind} room={room} auto={auto} autoBot={autoBot} />
        : <Hub onOpen={(g, opts) => router.push({ pathname: '/games', params: { game: g, ...opts } } as any)} />}
    </>
  );
}

function Board({ kind, room, auto, autoBot }: { kind: GameKind; room: string; auto: boolean; autoBot: boolean }) {
  const a = { auto, autoBot };
  switch (kind) {
    case 'chess':     return <Chess roomId={room} {...a} />;
    case 'ludo':      return <Ludo roomId={room || 'ludo-main'} {...a} />;
    case 'rummy':     return <Rummy tableId={room} {...a} />;
    case 'tictactoe': return <TicTacToe roomId={room} {...a} />;
  }
}

/* ── the hub ────────────────────────────────────────────────────────── */

function Hub({ onOpen }: { onOpen: (g: GameKind, opts?: Record<string, string>) => void }) {
  const t = useType();
  const [code, setCode] = React.useState('');
  const qm = useQuickMatch();
  const [seeking, setSeeking] = React.useState<Entry | null>(null);

  // A found room is opened once, then the searching sheet is dismissed.
  React.useEffect(() => {
    if (qm.match && seeking) {
      const { roomId, withBot } = qm.match;
      const g = seeking.kind;
      setSeeking(null);
      qm.cancel();
      onOpen(g, { room: roomId, auto: '1', ...(withBot ? { bot: '1' } : {}) });
    }
  }, [qm.match, seeking, qm, onOpen]);

  const quick = (e: Entry) => { setSeeking(e); qm.start(e.kind); };

  const joinCode = () => {
    const c = code.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!c) return;
    // A bare code is ambiguous across games, so it opens the game the player
    // last tapped rather than guessing; default to rummy's table naming.
    onOpen('rummy', { room: c });
    setCode('');
  };

  return (
    <TableBackground>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3], paddingBottom: S[6] }}>
        <Text style={{ color: C.text, fontSize: t['2xl'], fontWeight: '800', letterSpacing: 0.3 }}>Games</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
          Every table is refereed by the server, so both players always see the same board. Play a stranger, a friend, or the house bot.
        </Text>

        {GAMES.map(g => (
          <GameCard key={g.kind} entry={g} onOpen={() => onOpen(g.kind)} onQuick={() => quick(g)} />
        ))}

        <Panel style={{ gap: S[3], marginTop: S[2] }}>
          <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Join a table by code</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 18 }}>
            Someone shared a room code with you? Type it here.
          </Text>
          <View style={{ flexDirection: 'row', gap: S[2] }}>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="Room code"
              placeholderTextColor={C.muted}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Room code"
              style={{
                flex: 1, color: C.text, fontSize: t.md, paddingHorizontal: S[3], paddingVertical: S[3],
                borderRadius: R[2], borderWidth: 1, borderColor: goldLine[18], backgroundColor: C.panel2,
              }}
            />
            <Btn label="Join" kind="gold" onPress={joinCode} disabled={!code.trim()} />
          </View>
        </Panel>
      </ScrollView>

      {seeking && (
        <Searching
          entry={seeking}
          status={qm.status}
          error={qm.error}
          onCancel={() => { qm.cancel(); setSeeking(null); }}
        />
      )}
    </TableBackground>
  );
}

function GameCard({ entry, onOpen, onQuick }: { entry: Entry; onOpen: () => void; onQuick: () => void }) {
  const t = useType();
  const scale = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={a}>
      <Pressable
        onPressIn={() => { scale.value = withTiming(0.98, { duration: 90 }); }}
        onPressOut={() => { scale.value = withTiming(1, { duration: 140 }); }}
        onPress={() => { Haptics.selectionAsync().catch(() => {}); onOpen(); }}
        accessibilityRole="button"
        accessibilityLabel={`${entry.name}. ${entry.blurb}`}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: S[3],
          padding: S[4], borderRadius: R[3],
          backgroundColor: mix(C.panel, 92, '#ffffff'),
          borderWidth: 1, borderColor: goldLine[22],
          boxShadow: E[2],
        }}
      >
        <View style={{
          width: 52, height: 52, borderRadius: R[2], alignItems: 'center', justifyContent: 'center',
          backgroundColor: C.panel2, borderWidth: 1, borderColor: mix(entry.accent, 30, C.line),
          boxShadow: D3.well,
        }}>
          <Text style={{ fontSize: 26, color: entry.accent }}>{entry.icon}</Text>
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>{entry.name}</Text>
          <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 17 }}>{entry.blurb}</Text>
        </View>

        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); onQuick(); }}
          accessibilityRole="button"
          accessibilityLabel={`Quick match at ${entry.name}`}
          hitSlop={8}
          style={{
            paddingHorizontal: S[3], paddingVertical: S[2], borderRadius: R.pill,
            borderWidth: 1, borderColor: goldLine[38], backgroundColor: C.panel2,
          }}
        >
          <Text style={{ color: C.gold, fontSize: 15 }}>⚡</Text>
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

/** Full-screen searching state, with the bolt pulsing while the queue works. */
function Searching({
  entry, status, error, onCancel,
}: { entry: Entry; status: string; error: string | null; onCancel: () => void }) {
  const t = useType();
  const pulse = useSharedValue(0);

  React.useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 700, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 700, easing: Easing.in(Easing.quad) }),
      ), -1, false);
    return () => cancelAnimation(pulse);
  }, [pulse]);

  const aBolt = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.14 }],
    opacity: 0.75 + pulse.value * 0.25,
  }));

  return (
    <View style={{
      position: 'absolute', inset: 0, backgroundColor: 'rgba(20,4,4,0.92)',
      alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[4],
    }}>
      <Animated.Text style={[{ fontSize: 64 }, aBolt]}>⚡</Animated.Text>
      <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800', textAlign: 'center' }}>
        {error ? 'No luck' : `Finding a ${entry.name} opponent…`}
      </Text>
      <Text style={{ color: error ? C.bad : C.muted, fontSize: t.md, textAlign: 'center' }}>
        {error ?? status}
      </Text>
      <Btn label="Cancel" onPress={onCancel} />
    </View>
  );
}
