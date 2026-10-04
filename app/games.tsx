import { GamePaletteContext, lightHubPalette, useGamePalette } from '../components/games/appearance';
import { useTheme } from '../lib/theme';
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

import { AppText as Text } from '../components/ui/Text';
import React, { useState } from 'react';
import { Alert, BackHandler, Modal, Pressable, ScrollView, StatusBar, TextInput, View } from 'react-native';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { GameKind } from '../lib/gamesSocket';
import { useQuickMatch } from '../lib/games/useQuickMatch';
import Ionicons from '@expo/vector-icons/Ionicons';
import { TableBackground, Panel, Btn, useType, GameGlyph, Coin, GameTopBar, GameChrome, useAnnounce } from '../components/games/ui';
import { C, S, R, E, white, alpha, ACCENT } from '../lib/games/theme';
import { LIGHT_HUB } from '../constants/gamesPalette';
import { playSfx, setSoundEnabled, soundEnabled } from '../lib/games/sfx';
import { useWallet } from '../lib/games/useWallet';
import { useLiveTables, agoLabel } from '../lib/games/useLiveTables';
import { openInvite } from '../lib/games/invite';
import { newPrivateCode, type SeatIntent } from '../lib/games/rummyTable';
import { parseTableCode } from '../lib/games/tableCode';
import { Sheet, SettingRow } from '../components/games/feedback';
import InviteSheet from '../components/games/InviteSheet';
import HistorySheet from '../components/games/HistorySheet';
import LeaderboardSheet from '../components/games/LeaderboardSheet';
import { ErrorBoundary } from '../components/ErrorBoundary';

import TicTacToe from '../components/games/TicTacToe';
import Chess from '../components/games/Chess';
import Ludo from '../components/games/Ludo';
import Rummy from '../components/games/Rummy';

// A game's ICON and ACCENT are no longer written here. Both were duplicated —
// the hub said chess was #8ca2ad while the board drew its pieces from its own
// constants, so the card and the table it opened disagreed about what colour
// the game was. lib/games/theme.ts owns the accent, and the mark is drawn by
// GameGlyph from the same `kind` that routes the tap; four entries cannot
// drift from four keys that are the same four strings.
type Entry = { kind: GameKind; name: string; blurb: string };

const GAMES: Entry[] = [
  { kind: 'chess',     name: 'Chess',       blurb: 'Server-refereed. Your legal moves come from the table.' },
  { kind: 'rummy',     name: 'Rummy',       blurb: 'Points rummy, 2–6 players. Public tables or a private code.' },
  { kind: 'ludo',      name: 'Ludo',        blurb: 'Two to four players. Your phone helps roll the dice.' },
  { kind: 'tictactoe', name: 'Tic-Tac-Toe', blurb: 'Three in a row. Quick one.' },
];

/** Only these four are exposed; anything else falls back to the menu. */
const KINDS = new Set(GAMES.map(g => g.kind));

export default function GamesScreen() {
  const { colors, scheme } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ game?: string; room?: string; auto?: string; bot?: string; seat?: string }>();

  // The focused route owns orientation; an older table left on the navigation
  // stack must not keep the next game locked. Follow the device's rotation setting.
  useFocusEffect(React.useCallback(() => {
    void ScreenOrientation.unlockAsync().catch(() => {});
  }, []));

  const kind = typeof params.game === 'string' && KINDS.has(params.game as GameKind)
    ? (params.game as GameKind)
    : null;
  const hubColors = !kind && scheme === 'light' ? lightHubPalette(colors) : null;
  const room = typeof params.room === 'string' ? params.room : '';
  const auto = params.auto === '1';
  const autoBot = params.bot === '1';
  // Rummy only: an INTENT instead of an id, because rummy tables are the
  // server's and any id we invent is silently substituted. See Rummy.tsx.
  const seat: SeatIntent | undefined =
    params.seat === 'auto' || params.seat === 'bot' ? params.seat : undefined;

  const title = kind ? (GAMES.find(g => g.kind === kind)?.name ?? 'Games') : 'Games';

  // NEVER A DEAD END. A board is usually reached by pushing /games over the
  // hub, so back is back — but a turn notification or an invite deep link opens
  // one cold, and there `router.back()` leaves the app. Fall through to the hub
  // instead; from the hub, to wherever the tabs are.
  const exit = React.useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(kind ? '/games' : '/(tabs)');
  }, [router, kind]);

  /**
   * LEAVING A TABLE ASKS FIRST.
   *
   * Not because leaving is destructive — none of these four servers has a
   * "leave" intent and none of them forfeits on absence; the table stays live
   * and the hub's "Your games" panel lists it for you to walk back into. It
   * asks because a mis-swipe mid-hand looks identical to quitting, and the
   * sentence below is the only thing that tells the player their game is not
   * gone. NOTHING IS FORFEITED HERE and nothing invents a forfeit: chess has
   * Resign and rummy has Drop, both on their own boards, and that is where a
   * player who means to give up goes.
   */
  const leave = React.useCallback(() => {
    if (!kind) { exit(); return; }
    Alert.alert(
      'Leave this table?',
      'The game keeps running on the server — you can walk back into it from “Your games”.',
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: exit },
      ],
    );
  }, [kind, exit]);

  // The hardware key must do what the on-screen control does. Without this the
  // button asks and the back gesture does not, which is worse than neither.
  // Only while a board is open — the hub's default back is already correct.
  React.useEffect(() => {
    if (!kind) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { leave(); return true; });
    return () => sub.remove();
  }, [kind, leave]);

  return (
    <GamePaletteContext.Provider value={hubColors}>
    <SafeAreaView style={{ flex: 1, backgroundColor: hubColors?.bg ?? C.bg }} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar barStyle={hubColors ? "dark-content" : "light-content"} backgroundColor={hubColors?.bg ?? C.bg} />
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
          // The bar is OUTSIDE the boundary on purpose: a board that threw is
          // exactly when the way out has to still be there.
          <GameChrome game={kind} title={title} onBack={leave}>
            <ErrorBoundary
              screen={`Game:${kind}`}
              fallbackTitle="That table had a problem"
              fallbackMessage="The game is still running on the server — try again, or go back and rejoin the table."
            >
              <Board kind={kind} room={room} auto={auto} autoBot={autoBot} seat={seat} />
            </ErrorBoundary>
          </GameChrome>
        )
        : (
          <Hub
            onBack={leave}
            onOpen={(g, opts) => router.push({ pathname: '/games', params: { game: g, ...opts } })}
          />
        )}
      {/* Mounted once for all four boards — they open it through openInvite(). */}
      <InviteSheet />
    </SafeAreaView>
    </GamePaletteContext.Provider>
  );
}

function Board({ kind, room, auto, autoBot, seat }: { kind: GameKind; room: string; auto: boolean; autoBot: boolean; seat?: SeatIntent }) {
  // A TABLE IS NOT AN IDLE SCREEN.
  //
  // Waiting for three other players to move looks exactly like doing nothing
  // to Android, so the display slept mid-game and the player came back to a
  // locked phone and a turn they had already lost. Held only while a board is
  // mounted - the hub, the sheets and the rest of the app sleep normally.
  useKeepAwake();

  const a = { auto, autoBot };
  switch (kind) {
    case 'chess':     return <Chess roomId={room} {...a} />;
    case 'ludo':      return <Ludo roomId={room || 'ludo-main'} {...a} />;
    case 'rummy':     return <Rummy tableId={room} seat={seat} {...a} />;
    case 'tictactoe': return <TicTacToe roomId={room} {...a} />;
  }
}

/* ── the hub ────────────────────────────────────────────────────────── */

function Hub({ onBack, onOpen }: { onBack: () => void; onOpen: (g: GameKind, opts?: Record<string, string>) => void }) {
  const C = useGamePalette();
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
  // A typed room code that does not say which game it is for.
  const [codeRoom, setCodeRoom] = React.useState<string | null>(null);

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
    const parsed = parseTableCode(code);
    if (!parsed) return;
    setCode('');
    // An invite link names its game. A bare code is the same shape for every
    // game, so ask instead of guessing (it used to always open rummy).
    if (parsed.game) onOpen(parsed.game, { room: parsed.room });
    else setCodeRoom(parsed.room);
  };

  return (
    <TableBackground>
      {/* The hub's own heading IS the shared bar — the coin chip and the mute
          toggle ride in its `right` slot rather than in a second row. The hub
          needed a way out too: it is pushed from the tabs and from deep links,
          and had no control of its own. */}
      <GameTopBar
        title="Games"
        backLabel="Back"
        onBack={onBack}
        right={<><CoinChip balance={wallet.balance} /><SoundToggle /></>}
      />
      <KeyboardSafe keyboardOnly>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: S[4], paddingBottom: S[6], gap: S[3] }}>
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
        {live.failed && (
          <Pressable
            onPress={live.refresh}
            disabled={live.loading}
            accessibilityRole="button"
            accessibilityLabel="Your games could not be refreshed. Try again"
            accessibilityState={{ disabled: live.loading, busy: live.loading }}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: S[2] }}
          >
            <Ionicons name="refresh" size={16} color={C.muted} />
            <Text style={{ color: C.muted, fontSize: t.sm, flex: 1 }}>
              {live.loading ? 'Refreshing your games…' : 'Your games could not be refreshed. Tap to try again.'}
            </Text>
          </Pressable>
        )}
        {live.tables.length > 0 && (
          <Panel style={{ gap: S[2] }}>
            <Text accessibilityRole="header" style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Your games</Text>
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
            icon="trophy"
            style={{ flex: 1 }}
            onPress={() => { void playSfx('select'); setBoardOpen(true); }}
          />
          <Btn
            label="Recent games"
            icon="history"
            style={{ flex: 1 }}
            onPress={() => { void playSfx('select'); setHistOpen(true); }}
          />
        </View>

        <Panel style={{ gap: S[3], marginTop: S[2] }}>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Join a table by code</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 18 }}>
            Someone shared a room code or invite link with you? Paste it here.
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
                borderRadius: R[2], borderWidth: 1, borderColor: C.light ? C.line : white(0.14),
                // A field is the one control that should read as RECESSED — a
                // hole in the panel rather than another pane sitting on it.
                backgroundColor: C.light ? C.panel2 : 'rgba(0, 0, 0, 0.22)',
              }}
            />
            <Btn label="Join" kind="gold" onPress={joinCode} disabled={!code.trim()} />
          </View>
        </Panel>
      </ScrollView>
      </KeyboardSafe>

      <LeaderboardSheet visible={boardOpen} onClose={() => setBoardOpen(false)} />
      <HistorySheet visible={histOpen} onClose={() => setHistOpen(false)} />

      {seeking && (
        <Searching
          entry={seeking}
          status={qm.status}
          error={qm.error}
          onRetry={() => qm.start(seeking.kind)}
          onCancel={() => { qm.cancel(); setSeeking(null); }}
        />
      )}

      {mode && (
        <ModeSheet
          entry={mode}
          /* RUMMY DOES NOT GET AN INVENTED ID.
             Its tables belong to the server, which silently substitutes any id
             it does not know — so the matchmaker's roomId and a minted private
             code both left two players sitting alone at separate tables. Rummy
             is handed an INTENT and picks a real table from the server's own
             list; the other three create a room from whatever id they are given
             and are unchanged. */
          onOnline={() => {
            const e = mode; setMode(null);
            if (e.kind === 'rummy') { onOpen('rummy', { seat: 'auto' }); return; }
            quick(e);
          }}
          onPrivate={() => {
            const e = mode; setMode(null);
            // There is no private rummy on this server: no client-minted table
            // can be joined. Seat them where people actually are instead of
            // handing out a code nobody can use.
            if (e.kind === 'rummy') { onOpen('rummy', { seat: 'auto' }); return; }
            onOpen(e.kind, { room: newPrivateCode() });
          }}
          onBot={() => {
            const e = mode; setMode(null);
            if (e.kind === 'rummy') { onOpen('rummy', { seat: 'bot', auto: '1', bot: '1' }); return; }
            onOpen(e.kind, { room: newPrivateCode(), auto: '1', bot: '1' });
          }}
          onClose={() => setMode(null)}
        />
      )}

      {codeRoom !== null && (
        <Sheet visible title="Which game is this code for?" onClose={() => setCodeRoom(null)}>
          {GAMES.map(g => (
            <SettingRow
              key={g.kind}
              label={g.name}
              hint={`Join table ${codeRoom}`}
              value="Join"
              onPress={() => { const room = codeRoom; setCodeRoom(null); void playSfx('select'); onOpen(g.kind, { room }); }}
            />
          ))}
        </Sheet>
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
 * The coin balance.
 *
 * Labelled "play coins" wherever it appears. They are not money and cannot be
 * cashed out — the games server's own engines say "demo coins only" — and the
 * wording has to keep saying so rather than leaving a number that looks like a
 * wallet balance.
 */
function CoinChip({ balance }: { balance: number | null }) {
  const C = useGamePalette();
  if (balance == null) return null;
  return (
    <View
      // One stop; without `accessible` iOS ignores the label and reads the bare number.
      accessible
      accessibilityLabel={`${balance} play coins`}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: S[3], paddingVertical: S[2], borderRadius: R.pill,
        borderWidth: 1, borderColor: C.light ? C.line : white(0.22), backgroundColor: C.light ? C.card : white(0.10),
        boxShadow: `inset 0 1px 0 ${white(0.18)}`,
        marginRight: S[2],
      }}
    >
      {/* Was a 🪙 emoji, then a flat gold dot. See Coin in ui.tsx. */}
      <Coin size={15} />
      <Text style={{ color: C.gold, fontSize: 13, fontWeight: '800' }}>{balance}</Text>
    </View>
  );
}

/**
 * Mute.
 *
 * Sound in a game is feedback, but a phone is often played somewhere it cannot
 * make noise. The preference is persisted, so this is not a per-session toggle
 * the player has to hunt for again every time.
 */
function SoundToggle() {
  const C = useGamePalette();
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
        borderWidth: 1, borderColor: C.light ? C.line : white(on ? 0.26 : 0.12), backgroundColor: C.light ? C.card : white(on ? 0.10 : 0.05),
        boxShadow: `inset 0 1px 0 ${white(0.18)}`,
      }}
    >
      <Ionicons
        name={on ? 'volume-high' : 'volume-mute'}
        size={18}
        color={on ? C.text : C.muted}
      />
    </Pressable>
  );
}

function GameCard({ entry, onOpen, onQuick }: { entry: Entry; onOpen: () => void; onQuick: () => void }) {
  const C = useGamePalette();
  const t = useType();
  const accent = C.light ? LIGHT_HUB.accent[entry.kind] : ACCENT[entry.kind];
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
        // The card is one accessible element, so on iOS the Quick match button
        // inside it cannot be focused on its own. It is offered here as an
        // action (VoiceOver rotor / TalkBack actions menu) on the card itself.
        accessibilityHint="Opens the ways to play. Quick match is in the actions."
        accessibilityActions={[{ name: 'activate' }, { name: 'quickMatch', label: `Quick match at ${entry.name}` }]}
        onAccessibilityAction={e => {
          if (e.nativeEvent.actionName === 'quickMatch') onQuick();
          else if (e.nativeEvent.actionName === 'activate') onOpen();
        }}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: S[3],
          padding: S[4], borderRadius: R[3],
          backgroundColor: C.light ? C.card : white(0.075),
          borderWidth: 1, borderColor: C.light ? C.line : white(0.16),
          boxShadow: `${E[2]}, inset 0 1px 0 ${white(0.18)}`,
        }}
      >
        {/* The tile is tinted with the game's own accent rather than filled
            with panel grey: four identical grey wells is what made the hub read
            as a settings list, and the tint is the first place the player meets
            the colour they will then see on the board. */}
        <View style={{
          width: 54, height: 54, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
          backgroundColor: alpha(accent, 0.14),
          borderWidth: 1, borderColor: alpha(accent, 0.42),
          boxShadow: `0 4px 14px ${alpha(accent, 0.30)}, inset 0 1px 0 ${white(0.18)}`,
        }}>
          <GameGlyph game={entry.kind} size={30} />
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>{entry.name}</Text>
          <Text style={{ color: C.muted, fontSize: 12.5, lineHeight: 17 }}>{entry.blurb}</Text>
        </View>

        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); onQuick(); }}
          accessibilityRole="button"
          accessibilityLabel={`Quick match at ${entry.name}`}
          hitSlop={8}
          style={{
            width: 40, height: 40, borderRadius: R.pill,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1, borderColor: C.light ? C.line : white(0.26), backgroundColor: C.light ? C.panel2 : white(0.10),
            boxShadow: `inset 0 1px 0 ${white(0.18)}`,
          }}
        >
          <Ionicons name="flash" size={17} color={C.gold} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

/** Full-screen searching state, with the bolt pulsing while the queue works. */
function Searching({
  entry, status, error, onRetry, onCancel,
}: { entry: Entry; status: string; error: string | null; onRetry: () => void; onCancel: () => void }) {
  const C = useGamePalette();
  const t = useType();
  const pulse = useSharedValue(0);
  // The status line below is Android's live region; iOS hears it from here.
  useAnnounce(error ?? status);

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

  // A Modal, so hardware back cancels the search (onRequestClose) and a screen
  // reader stays inside it instead of wandering into the hub underneath.
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
    <ScrollView style={{ flex: 1, backgroundColor: C.light ? C.bg : 'rgba(20,4,4,0.92)' }} contentContainerStyle={{
      flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[4],
    }}>
      <Animated.View style={aBolt} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Ionicons name="flash" size={64} color={C.gold} />
      </Animated.View>
      <Text accessibilityRole="header" style={{ color: C.text, fontSize: t.xl, fontWeight: '800', textAlign: 'center' }}>
        {error ? 'No luck' : `Finding a ${entry.name} opponent…`}
      </Text>
      <Text accessibilityLiveRegion="polite" style={{ color: error ? C.bad : C.muted, fontSize: t.md, textAlign: 'center' }}>
        {error ?? status}
      </Text>
      {!error && (
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center', lineHeight: 18 }}>
          Real players only. If nobody is queuing, you will be offered the house bot —
          you will not be put in a bot game without being told.
        </Text>
      )}
      {!!error && <Btn label="Try again" kind="gold" onPress={onRetry} />}
      <Btn label="Cancel" onPress={onCancel} />
    </ScrollView>
    </Modal>
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
  const C = useGamePalette();
  const t = useType();
  const rummy = entry.kind === 'rummy';
  return (
    <Sheet visible title={entry.name} onClose={onClose}>
      <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>{entry.blurb}</Text>

      <SettingRow
        label="Play online"
        hint={rummy
          ? 'Sit at a public table — you will be seated where people already are'
          : 'Find someone who is looking for a game right now'}
        value="Find"
        onPress={() => { void playSfx('select'); onOnline(); }}
      />
      {/* RUMMY HAS NO PRIVATE TABLES, so it must not offer one.
          Its tables are the server's own and a code we mint is silently
          substituted — the player got a code, shared it, and both ended up at
          different tables. Say so, and send them where the people are. */}
      <SettingRow
        label={rummy ? 'Open tables' : 'Private room'}
        hint={rummy
          ? 'Rummy tables are the server’s own — pick one with a seat free'
          : 'Your own table with a code to share — and voice chat at it'}
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
  const C = useGamePalette();
  const t = useType();
  // A Modal for the same reasons as Searching: back means "Not now".
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
    <ScrollView style={{ flex: 1, backgroundColor: C.light ? C.bg : 'rgba(20,4,4,0.92)' }} contentContainerStyle={{
      flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3],
    }}>
      <GameGlyph game={entry.kind} size={56} color={C.light ? C.gold : undefined} />
      <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800', textAlign: 'center' }}>
        Nobody is waiting for {entry.name}
      </Text>
      <Text style={{ color: C.muted, fontSize: t.md, textAlign: 'center', lineHeight: 21 }}>
        No one else is queuing right now. Play the house bot, or invite someone — your
        table stays open and they can join it whenever they answer.
      </Text>
      <Btn label={`Play the house bot`} icon="bot" kind="gold" onPress={onBot} />
      <Btn label="Invite someone" icon="link" onPress={onInvite} />
      <Btn label="Not now" onPress={onCancel} />
    </ScrollView>
    </Modal>
  );
}
