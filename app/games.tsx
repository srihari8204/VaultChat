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

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { GameKind } from '../lib/gamesSocket';
import { useQuickMatch } from '../lib/games/useQuickMatch';
import { TableBackground, Panel, Btn, useType } from '../components/games/ui';
import { C, S, R, D3, E, mix, goldLine } from '../lib/games/theme';
import { playSfx, setSoundEnabled, soundEnabled } from '../lib/games/sfx';
import { useWallet } from '../lib/games/useWallet';
import { useLiveTables, agoLabel } from '../lib/games/useLiveTables';
import { openInvite } from '../lib/games/invite';
import { newPrivateCode } from '../lib/games/rummyTable';
import { getMyProfile } from '../lib/chatService';
import { useLeaderboard } from '../lib/games/useLeaderboard';
import { headline, medal, detail, type LeaderScope } from '../lib/games/leaderboard';
import { Sheet, SettingRow } from '../components/games/feedback';
import InviteSheet from '../components/games/InviteSheet';
import HistorySheet from '../components/games/HistorySheet';
import { ErrorBoundary } from '../components/ErrorBoundary';

import TicTacToe from '../components/games/TicTacToe';
import Chess from '../components/games/Chess';
import Ludo from '../components/games/Ludo';
import Rummy from '../components/games/Rummy';

type Entry = { kind: GameKind; name: string; icon: string; blurb: string; accent: string };

const GAMES: Entry[] = [
  { kind: 'chess',     name: 'Chess',       icon: '♛', accent: '#8ca2ad', blurb: 'Server-refereed. Your legal moves come from the table.' },
  { kind: 'rummy',     name: 'Rummy',       icon: '🂡', accent: '#5fe08c', blurb: 'Points rummy, 2–6 players. Public tables or a private code.' },
  { kind: 'ludo',      name: 'Ludo',        icon: '🎲', accent: '#f3c245', blurb: 'Two to four players. Your phone helps roll the dice.' },
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
        ? (
          // A BOARD MUST NOT BE ABLE TO TAKE THE APP DOWN WITH IT.
          //
          // Without a boundary a render error unmounts the whole tree and the
          // player is left staring at a blank screen with no way back — which
          // is what "the app crashed while I was playing" looks like from the
          // outside, and it leaves no trace in the crash log because nothing
          // native ever crashed. The four boards render fields from a
          // reverse-engineered protocol, so a shape we did not expect is a
          // question of when, not if. This turns that into a message with a way
          // out. Every other screen that renders untrusted shapes already does
          // this (archive-viewer, dashboard, docscanner).
          <ErrorBoundary
            screen={`Game:${kind}`}
            fallbackTitle="That table had a problem"
            fallbackMessage="The game is still running on the server — try again, or go back and rejoin the table."
          >
            <Board kind={kind} room={room} auto={auto} autoBot={autoBot} />
          </ErrorBoundary>
        )
        : <Hub onOpen={(g, opts) => router.push({ pathname: '/games', params: { game: g, ...opts } } as any)} />}
      {/* Mounted once for all four boards — they open it through openInvite(). */}
      <InviteSheet />
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
  const wallet = useWallet();
  const live = useLiveTables();
  const [boardOpen, setBoardOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [seeking, setSeeking] = React.useState<Entry | null>(null);
  const [offer, setOffer] = React.useState<{ entry: Entry; roomId: string } | null>(null);
  // Which game the player tapped, waiting on HOW they want to play it.
  const [mode, setMode] = React.useState<Entry | null>(null);

  // A found room is opened once, then the searching sheet is dismissed.
  //
  // A BOT OFFER IS NOT A MATCH. The matchmaker answers `botoffer` when nobody
  // was waiting, and this used to open that room with bot:'1' — so a player who
  // asked for an opponent was silently seated against the house and only found
  // out from the seat label. It is the one moment this feature is tempted to
  // lie, and with ~19 players registered it is also the common case. So the
  // search stops here and the player chooses: play the bot, or invite someone
  // and come back to a real game later.
  React.useEffect(() => {
    if (qm.match && seeking) {
      const { roomId, withBot } = qm.match;
      const e = seeking;
      setSeeking(null);
      qm.cancel();
      if (withBot) { setOffer({ entry: e, roomId }); return; }
      onOpen(e.kind, { room: roomId, auto: '1' });
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
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, color: C.text, fontSize: t['2xl'], fontWeight: '800', letterSpacing: 0.3 }}>Games</Text>
          <CoinChip balance={wallet.balance} />
          <SoundToggle />
        </View>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
          Every table is refereed by the server, so both players always see the same board. Play a stranger, a friend, or the house bot.
        </Text>
        {/* The chip above is a number next to a coin, which reads as a wallet
            unless something says otherwise. Every surface showing a balance or
            a stake states this. */}
        <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
          Coins are play coins — not money. They cannot be bought or cashed out.
        </Text>

        {/* Games already in progress come FIRST. With ~19 players registered and
            usually none online, the game you are already in the middle of is
            the likeliest one to play — a menu of four new tables is not. */}
        {live.tables.length > 0 && (
          <Panel style={{ gap: S[2] }}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Your games</Text>
            {live.tables.map(tb => (
              <SettingRow
                key={`${tb.game}:${tb.room}`}
                label={`${GAMES.find(g => g.kind === tb.game)?.name ?? tb.game}${tb.yourTurn ? ' · your move' : ''}`}
                hint={tb.body || tb.title || agoLabel(tb.updatedAt)}
                value={tb.yourTurn ? 'Play' : 'Open'}
                onPress={() => { void playSfx('select'); onOpen(tb.game, { room: tb.room }); }}
              />
            ))}
            <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
              What the table last told us. The board itself is always the server’s.
            </Text>
          </Panel>
        )}

        {GAMES.map(g => (
          <GameCard key={g.kind} entry={g} onOpen={() => setMode(g)} onQuick={() => quick(g)} />
        ))}

        <View style={{ flexDirection: 'row', gap: S[2], marginTop: S[2] }}>
          <Btn
            label="Leaderboard"
            icon="🏆"
            style={{ flex: 1 }}
            onPress={() => { void playSfx('select'); setBoardOpen(true); }}
          />
          <Btn
            label="Recent games"
            icon="🕘"
            style={{ flex: 1 }}
            onPress={() => { void playSfx('select'); setHistOpen(true); }}
          />
        </View>

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

      <LeaderboardSheet visible={boardOpen} onClose={() => setBoardOpen(false)} />
      <HistorySheet visible={histOpen} onClose={() => setHistOpen(false)} />

      {seeking && (
        <Searching
          entry={seeking}
          status={qm.status}
          error={qm.error}
          onCancel={() => { qm.cancel(); setSeeking(null); }}
        />
      )}

      {mode && (
        <ModeSheet
          entry={mode}
          onOnline={() => { const e = mode; setMode(null); quick(e); }}
          onPrivate={() => { const e = mode; setMode(null); onOpen(e.kind, { room: newPrivateCode() }); }}
          onBot={() => { const e = mode; setMode(null); onOpen(e.kind, { room: newPrivateCode(), auto: '1', bot: '1' }); }}
          onClose={() => setMode(null)}
        />
      )}

      {offer && (
        <BotOffer
          entry={offer.entry}
          onBot={() => { const o = offer; setOffer(null); onOpen(o.entry.kind, { room: o.roomId, auto: '1', bot: '1' }); }}
          onInvite={() => { const o = offer; setOffer(null); openInvite(o.entry.kind, o.roomId); }}
          onCancel={() => setOffer(null)}
        />
      )}
    </TableBackground>
  );
}

/**
 * Mute.
 *
 * Sound in a game is feedback, but a phone is often played somewhere it cannot
 * make noise. The preference is persisted, so this is not a per-session toggle
 * the player has to hunt for again every time.
 */
/**
 * The coin balance.
 *
 * Labelled "play coins" wherever it appears. They are not money and cannot be
 * cashed out — the games server's own engines say "demo coins only" — and the
 * wording has to keep saying so rather than leaving a number that looks like a
 * wallet balance.
 */
function CoinChip({ balance }: { balance: number | null }) {
  if (balance == null) return null;
  return (
    <View
      accessibilityLabel={`${balance} play coins`}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: S[3], paddingVertical: S[2], borderRadius: R.pill,
        borderWidth: 1, borderColor: goldLine[38], backgroundColor: C.panel2,
        marginRight: S[2],
      }}
    >
      <Text style={{ fontSize: 13 }}>🪙</Text>
      <Text style={{ color: C.gold, fontSize: 13, fontWeight: '800' }}>{balance}</Text>
    </View>
  );
}

function SoundToggle() {
  const [on, setOn] = React.useState(soundEnabled());
  return (
    <Pressable
      onPress={() => {
        const next = !on;
        setOn(next);
        void setSoundEnabled(next);
        if (next) playSfx('select');
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={on ? 'Game sound on' : 'Game sound off'}
      hitSlop={10}
      style={{
        width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: on ? goldLine[38] : goldLine[14], backgroundColor: C.panel2,
      }}
    >
      <Text style={{ fontSize: 17, opacity: on ? 1 : 0.45 }}>{on ? '🔊' : '🔇'}</Text>
    </Pressable>
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
      {!error && (
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center', lineHeight: 18 }}>
          Real players only. If nobody is queuing, you will be offered the house bot —
          you will not be put in a bot game without being told.
        </Text>
      )}
      <Btn label="Cancel" onPress={onCancel} />
    </View>
  );
}

/**
 * How do you want to play?
 *
 * THIS IS WHY THE GAMES LOOKED BROKEN. Tapping a game used to open it with no
 * room at all, which lands the player in the server's DEFAULT table — a shared
 * room somebody else already hosts. Only the host may seat a bot or deal, so
 * "Add a bot" and "Start" did nothing, with no error to explain it: a lobby you
 * cannot leave and cannot start.
 *
 * The three ways in are the three real answers to "who am I playing", and each
 * one puts the player somewhere they can actually act:
 *
 *   Online   — the matchmaker's room, and it says so honestly when nobody is
 *              queuing rather than seating a bot behind your back.
 *   Private  — a fresh code the player HOSTS, to share with one person. Voice
 *              is at that table, because a private room is people you know.
 *   Bot      — the same private room, seated and dealt for you.
 */
function ModeSheet({
  entry, onOnline, onPrivate, onBot, onClose,
}: { entry: Entry; onOnline: () => void; onPrivate: () => void; onBot: () => void; onClose: () => void }) {
  const t = useType();
  return (
    <Sheet visible title={entry.name} onClose={onClose}>
      <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>{entry.blurb}</Text>

      <SettingRow
        label="Play online"
        hint="Find someone who is looking for a game right now"
        value="Find"
        onPress={() => { void playSfx('select'); onOnline(); }}
      />
      <SettingRow
        label="Private room"
        hint="Your own table with a code to share — and voice chat at it"
        value="Open"
        onPress={() => { void playSfx('select'); onPrivate(); }}
      />
      <SettingRow
        label="Play the house bot"
        hint="Start straight away, against the table"
        value="Play"
        onPress={() => { void playSfx('select'); onBot(); }}
      />

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        A bot is always labelled a bot. Coins are play coins — not money.
      </Text>
    </Sheet>
  );
}

/**
 * Nobody was waiting.
 *
 * The honest end of a search. It names the bot as a bot, and puts the thing
 * that actually fixes an empty room next to it: invite someone. The room the
 * matchmaker minted is kept either way — accepting the bot uses it, and so does
 * the invite, so a friend who taps the card lands at this same table.
 */
function BotOffer({
  entry, onBot, onInvite, onCancel,
}: { entry: Entry; onBot: () => void; onInvite: () => void; onCancel: () => void }) {
  const t = useType();
  return (
    <View style={{
      position: 'absolute', inset: 0, backgroundColor: 'rgba(20,4,4,0.92)',
      alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3],
    }}>
      <Text style={{ fontSize: 56 }}>{entry.icon}</Text>
      <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800', textAlign: 'center' }}>
        Nobody is waiting for {entry.name}
      </Text>
      <Text style={{ color: C.muted, fontSize: t.md, textAlign: 'center', lineHeight: 21 }}>
        No one else is queuing right now. Play the house bot, or invite someone — your
        table stays open and they can join it whenever they answer.
      </Text>
      <Btn label={`Play the house bot`} icon="🤖" kind="gold" onPress={onBot} />
      <Btn label="Invite someone" icon="🔗" onPress={onInvite} />
      <Btn label="Not now" onPress={onCancel} />
    </View>
  );
}

/* ── leaderboard ────────────────────────────────────────────────────── */

const SCOPES: { key: LeaderScope; label: string }[] = [
  { key: 'all', label: 'Overall' },
  { key: 'chess', label: 'Chess' },
  { key: 'rummy', label: 'Rummy' },
  { key: 'ludo', label: 'Ludo' },
  { key: 'tictactoe', label: 'Tic-Tac-Toe' },
];

/**
 * The server's standings, its ordering, its cut.
 *
 * `Overall` and a single game are different tables, not a filter over one:
 * overall ranks by coins and sends no rating, a game ranks by Elo. `headline`
 * is what keeps each tab printing the number it actually has — see
 * lib/games/leaderboard.ts.
 *
 * Ten rows is the server's limit, not a page size; it ignores `?limit=`, so
 * there is nothing to page through and no "show more" to offer.
 */
function LeaderboardSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [scope, setScope] = React.useState<LeaderScope>('all');
  const { rows, loading, error, refresh } = useLeaderboard(scope);
  const t = useType();

  // Which row is ME. The server returns ten rows and no rank for anyone else,
  // so this can highlight a place in the table but must NOT invent a position
  // for a player who is not on it — "not in the top ten" is the whole truth we
  // have, and claiming a number would be claiming a standing the server never
  // sent (the same rule the rest of this screen follows).
  const [meVault, setMeVault] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!visible || meVault) return;
    getMyProfile().then(p => setMeVault(p.vaultId ?? null)).catch(() => {});
  }, [visible, meVault]);
  const myIndex = meVault ? rows.findIndex(r => r.vaultId === meVault) : -1;

  return (
    <Sheet visible={visible} title="Leaderboard" onClose={onClose}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: S[1], paddingBottom: S[1] }}
      >
        {SCOPES.map(sc => (
          <Pressable
            key={sc.key}
            onPress={() => setScope(sc.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === sc.key }}
            style={{
              paddingHorizontal: S[3], paddingVertical: S[2], borderRadius: R[3],
              borderWidth: 1,
              borderColor: scope === sc.key ? goldLine[55] : 'rgba(255,255,255,.10)',
              backgroundColor: scope === sc.key ? mix(C.panel2, 78, '#ffffff') : 'transparent',
            }}
          >
            <Text style={{
              color: scope === sc.key ? C.text : C.muted,
              fontSize: t.sm, fontWeight: '700',
            }}>
              {sc.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {loading && rows.length === 0 ? (
        <View style={{ paddingVertical: S[5], alignItems: 'center' }}>
          <ActivityIndicator color={C.gold} />
        </View>
      ) : error ? (
        <View style={{ gap: S[2], paddingVertical: S[2] }}>
          <Text style={{ color: C.bad, fontSize: t.sm }}>{error}</Text>
          <Btn label="Try again" compact onPress={refresh} />
        </View>
      ) : rows.length === 0 ? (
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19, paddingVertical: S[2] }}>
          Nobody has finished a game here yet. Win one and this is where you show up.
        </Text>
      ) : (
        <View style={{ gap: 2 }}>
          {rows.map((r, i) => {
            const h = headline(r, scope);
            return (
              <View
                key={r.vaultId}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: S[2],
                  paddingVertical: S[2], paddingHorizontal: S[2], borderRadius: R[1],
                  backgroundColor: i === myIndex ? mix(C.gold, 14, C.panel2)
                    : i < 3 ? mix(C.panel2, 88, '#ffffff') : 'transparent',
                  borderWidth: i === myIndex ? 1 : 0, borderColor: goldLine[38],
                }}
              >
                <Text style={{ width: 26, textAlign: 'center', color: C.muted, fontSize: t.sm, fontWeight: '800' }}>
                  {medal(i)}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: t.sm, fontWeight: '700' }}>{r.name}</Text>
                  <Text numberOfLines={1} style={{ color: C.muted, fontSize: 11.5 }}>{detail(r)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>{h.value}</Text>
                  <Text style={{ color: C.muted, fontSize: 10.5 }}>{h.label}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {myIndex >= 0
          ? `You are ${medal(myIndex)} in this table. Top ten, ranked by the games server.`
          : rows.length > 0
            ? 'You are not in the top ten. The server ranks and cuts this table; it does not send a position for anyone below it.'
            : 'Top ten, ranked by the games server.'}
        {' '}Coins are demo coins — they are not money and cannot be cashed out.
      </Text>
    </Sheet>
  );
}
