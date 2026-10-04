/**
 * Ludo — native, server-refereed.
 *
 * The server owns the dice and the rules. It sends `movable` — the token
 * indices this roll permits — exactly the way chess sends `legal`, so this file
 * decides nothing: no capture rules, no safe-square logic, no six-rolls-again,
 * no "must leave base on a six". Tapping a token is a membership test against
 * `movable`. See docs/GAMES_PROTOCOL.md.
 *
 * Where a token sits (the ring, the home columns, the yards) is
 * lib/games/ludoBoard.ts — copied from the reference client, not re-derived,
 * and checked by its selftest. The pieces of this screen live beside it in
 * components/games/ludo/: the room and static board (Room.tsx), a token
 * (Token.tsx), the die and tray (Dice.tsx), and the seat cards and turn
 * indicator (Chrome.tsx).
 *
 * The board is one SVG because a 15x15 grid is 225 views otherwise, and the
 * glass surface needs gradients per cell. Tokens sit above it as animated views
 * so they can hop independently of a static board.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import { Panel, Btn, Banner, PlayerRow, Reconnecting, RematchBtn, TurnClock, useType, useBoardBox, Coin } from './ui';
import { useRematch } from '../../lib/games/useRematch';
import { RulesSheet, useFirstTimeRules } from './rules';
import { rollSeed, receiptFrom, pushReceipt, type RollReceipt } from '../../lib/games/fairness';
import { useCountdown } from '../../lib/games/useCountdown';
// Spacing, radii and elevation stay SHARED — ludo lays out on the same grid as
// its siblings. Only the light in the room is local, and that is ludoGlass.
import { S, R, white } from '../../lib/games/theme';
import { LR, SEAT, P, COLOR_NAMES, LG, ludoControls, ludoLayout } from '../../lib/games/ludoGlass';
import { HOME_STEP, pid, type LPlayer } from '../../lib/games/ludoBoard';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar, VoiceSheet } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { openInvite, shareResult } from '../../lib/games/invite';
import { useWallet, STAKES, stakeLabel } from '../../lib/games/useWallet';
import { useAddBot, ADD_BOT_STALLED } from '../../lib/games/useAddBot';
import { startBlockedReason } from '../../lib/games/startHint';
import { emoteLabel } from '../../lib/games/boardLabels';
import { LudoRoom, StageLight, BoardSvg } from './ludo/Room';
import { TokenView } from './ludo/Token';
import { Die, DiceTray } from './ludo/Dice';
import { SeatCard, TurnIndicator } from './ludo/Chrome';

/**
 * The seat palette, the shape markers and the room now live in
 * lib/games/ludoGlass.ts.
 *
 * They were declared here, which meant a game's colour was written in this file
 * AND in app/games.tsx — the drift the ACCENT change exists to prevent. SEAT[2]
 * IS ACCENT.ludo now rather than a near-miss of it, and ludoGlass.selftest
 * asserts that they stay equal.
 */

/**
 * How long a connected socket may go without a lobby frame before the screen
 * stops saying "Joining the table…" and offers a retry. The lobby normally
 * arrives within a second of connecting; an endless spinner tells the player
 * nothing they can act on.
 */
const LOBBY_STALL_MS = 10_000;


export default function Ludo({ roomId = 'ludo-main', auto, autoBot }: { roomId?: string } & AutoStart) {
  const { phase, error, state, events, send, subscribe, retry } = useGameSocket('ludo', roomId, { auto, autoBot });
  const t = useType();

  const rematch = useRematch('ludo', roomId, state, send);
  const rules = useFirstTimeRules('ludo');

  // How many seats we are waiting for before dealing. null = not waiting.
  const [wantStart, setWantStart] = useState<number | null>(null);

  // The server's own turn clock, when it sends one — no deadline, no clock.
  //
  // MUST LIVE UP HERE WITH THE OTHER HOOKS. It was written next to the board's
  // `mine`, which sits AFTER the lobby's early return — so the hook ran only
  // once a game existed, the hook count changed the instant the lobby became a
  // board, and React threw "Rendered more hooks than during the previous
  // render." That is a crash on the exact frame a game starts, which is the
  // single worst place to put one.
  const secs = useCountdown(state.raw?.deadline, !!state.game && state.game.phase !== 'finished');

  // The dice have always been commit-reveal and it has always been invisible.
  // Keep what this device sent alongside what the server published, so a player
  // who suspects the dice can look instead of guessing. Nothing is recomputed
  // here — this is a record, not a second referee.
  const lastSeed = useRef<string | null>(null);
  const [receipts, setReceipts] = useState<RollReceipt[]>([]);
  const [showFair, setShowFair] = useState(false);
  const L = state.lobby;
  const G = state.game;
  const [showSettings, setShowSettings] = useState(false);
  const [showEmotes, setShowEmotes] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [sound, setSound] = useState(soundEnabled());
  const [stake, setStake] = useState(0);
  const wallet = useWallet();
  const voice = useTableVoice('ludo', roomId, { you: state.you, send, subscribe });
  // MUST live with the other hooks, above the lobby's early return — a hook
  // added below it changes the hook count the frame a game starts.
  const bot = useAddBot(send, state.lobby?.members?.length ?? 0);
  /** In the channel — the two phases VoiceBar shows its live row for. */
  const voiceLive = voice.phase === 'live' || voice.phase === 'waiting';
  // The tumble is local and deliberate. The server answers in tens of
  // milliseconds, so without a held animation the number simply appears and the
  // player never sees a roll happen — which is the single thing that makes dice
  // feel fair. See rollFor() below.
  const [tumbling, setTumbling] = useState(false);
  const tumbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (tumbleTimer.current) clearTimeout(tumbleTimer.current); }, []);
  // The rules from the table, not only from the lobby (Settings → How to play).
  const [showRules, setShowRules] = useState(false);

  // Connected, but no lobby frame yet. After LOBBY_STALL_MS say so and offer a
  // retry rather than "Joining the table…" for ever.
  const waitingForLobby = !L && !G;
  const [lobbyStalled, setLobbyStalled] = useState(false);
  useEffect(() => {
    if (!waitingForLobby || phase !== 'connected') { setLobbyStalled(false); return; }
    const id = setTimeout(() => setLobbyStalled(true), LOBBY_STALL_MS);
    return () => clearTimeout(id);
  }, [waitingForLobby, phase]);

  // The parent owns system orientation and safe areas; fit its measured viewport.
  const { width, height, onLayout: onBoardBox } = useBoardBox(0);
  const { fontScale } = useWindowDimensions();
  const layout = ludoLayout(width, height, fontScale);
  const size = layout.boardSize;
  const cell = size / 15;
  const controlsWidth = layout.controlsWidth;
  const controls = ludoControls(controlsWidth, fontScale);

  useEffect(() => { void preloadSfx(['roll', 'move', 'capture', 'home', 'six', 'win', 'lose']); }, []);

  // Every token's step from the previous snapshot, so a change can be told
  // apart: back to base is a CAPTURE, past the last home step is a token in,
  // anything else forward is a plain move. Without the comparison all three
  // would sound identical, and a capture is the one moment in Ludo that has to
  // land.
  const prevSteps = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!G?.players) return;
    const next: Record<string, number> = {};
    let captured = false, homed = false, moved = false;
    for (const p of G.players as LPlayer[]) {
      (p.tokens ?? []).forEach((step, i) => {
        const k = `${p.seat}:${i}`;
        next[k] = step;
        const was = prevSteps.current[k];
        if (was === undefined) return;
        if (step < 0 && was >= 0) captured = true;
        else if (step >= HOME_STEP && was < HOME_STEP) homed = true;
        else if (step > was) moved = true;
      });
    }
    const first = Object.keys(prevSteps.current).length === 0;
    prevSteps.current = next;
    if (first) return;                       // the deal is not a move
    if (captured) playSfx('capture');
    else if (homed) playSfx('home');
    else if (moved) playSfx('move');
  }, [G?.players]);

  // The die is announced by the snapshot, so a six sounds different the moment
  // the server publishes it rather than when this phone guessed.
  const prevDie = useRef<number | null>(null);
  useEffect(() => {
    const d = typeof G?.pendingDie === 'number' ? G.pendingDie : null;
    if (d != null && d !== prevDie.current) {
      playSfx(d === 6 ? 'six' : 'roll');
      // File the receipt for OUR roll only: a seed we did not send proves
      // nothing about a number we did not ask for.
      if (lastSeed.current) {
        const cs = lastSeed.current;
        lastSeed.current = null;
        setReceipts(r => pushReceipt(r, receiptFrom(cs, state.raw)));
      }
    }
    prevDie.current = d;
  }, [G?.pendingDie, state.raw]);

  // Deal once the seats the player asked for have actually appeared.
  //
  // Guarded on `startedRef` because the server answers a second `start` with an
  // error, which reads to a player as a broken table on a game that was fine.
  const startedRef = useRef(false);
  useEffect(() => {
    if (wantStart == null || G) return;
    if (!L || L.hostId !== state.you) return;
    if ((L.members?.length ?? 0) < wantStart) return;
    if (startedRef.current) return;
    startedRef.current = true;
    send({ t: 'start', mode: 'classic', stake });
  }, [wantStart, L, G, state.you, send, stake]);
  useEffect(() => { startedRef.current = false; }, [roomId]);

  const ended = useRef(false);
  useEffect(() => {
    if (G?.phase !== 'finished') { ended.current = false; return; }
    if (ended.current) return;
    ended.current = true;
    playSfx(G.winnerId === state.you ? 'win' : 'lose');
  }, [G?.phase, G?.winnerId, state.you]);

  // Mid-game the board stays up with a banner; this full-screen failure is for
  // a table we never reached.
  if (error && phase !== 'connected' && !state.game) {
    return (
      <LudoRoom style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 46 }}>🎲</Text>
        <Text style={{ color: LR.text, fontSize: t.lg, fontWeight: '800' }}>Can’t reach the table</Text>
        <Text style={{ color: LR.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
        <Btn label="Try again" kind="gold" onPress={retry} />
      </LudoRoom>
    );
  }

  // Only take the screen back BEFORE there is a board.
  if ((phase !== 'connected' && !G) || !L) {
    return (
      <LudoRoom style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 46 }}>🎲</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: LR.muted, fontSize: t.md, textAlign: 'center' }}>
          {lobbyStalled
            ? 'The table has not answered yet. It may be busy, or the connection may have dropped.'
            : phase === 'minting' ? 'Taking your seat…' : 'Joining the table…'}
        </Text>
        {lobbyStalled && (
          <Btn label="Try again" kind="gold" onPress={() => { setLobbyStalled(false); retry(); }} />
        )}
      </LudoRoom>
    );
  }

  /**
   * Seat `n` bots, then deal.
   *
   * The bots have to be seated before `start`, and each `addbot` is answered by
   * a fresh lobby snapshot, so this fires them together and lets the auto-start
   * in useGameSocket deal once the seats appear — sending `start` immediately
   * would race the last bot into an empty chair.
   */
  const fillAndStart = (n: number) => {
    const seated = L?.members?.length ?? 1;
    for (let i = seated; i < n + 1; i++) send({ t: 'addbot' });
    // Deal when the SEATS ARRIVE, not on a timer. A fixed 400ms was a race the
    // table lost every time on a slow link: `start` reached the server while it
    // still had one player, the server refused it, and the screen sat in the
    // lobby with a bot in it and no way forward. That is what "the games don't
    // work" looked like. The effect below fires once the snapshot shows enough
    // seats — the same rule useGameSocket's auto-start already follows.
    setWantStart(n + 1);
  };

  const finished = G?.phase === 'finished';

  // ── lobby ─────────────────────────────────────────────────────────
  if (!G || (L.status === 'lobby' && !finished)) {
    const members = L.members ?? [];
    const host = L.hostId === state.you;
    return (
      <LudoRoom>
        <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3], width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <Text accessibilityRole="header" style={{ color: LR.text, fontSize: t.xl, fontWeight: '800' }}>Ludo</Text>
          <Text style={{ color: LR.muted, fontSize: t.sm, lineHeight: 19 }}>
            Two to four players. The table rolls the dice and settles every capture — neither phone decides anything.
          </Text>
          <Panel style={{ gap: S[2] }}>
            {members.map((m, i) => (
              <PlayerRow
                key={m.vaultId}
                name={m.name}
                accent={P[i % 4]}
                subtitle={COLOR_NAMES[i % 4]}
                tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
              />
            ))}
            <Text style={{ color: LR.muted, fontSize: t.sm }}>{members.length} seated · up to 4</Text>
            {members.length < 2 && (
              <Text style={{ color: LR.muted, fontSize: t.sm }}>Two players minimum — add a bot to start now.</Text>
            )}
          </Panel>
          {/* Stake. Free is first and the default: a table that quietly costs
              something is how a player loses coins they did not mean to put up.
              These are PLAY coins — the games server mints them and they buy
              nothing outside these tables. */}
          <Panel style={{ gap: S[2] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text accessibilityRole="header" style={{ flex: 1, color: LR.text, fontSize: t.md, fontWeight: '800' }}>Stake</Text>
              {/* The same gold dot the hub's CoinChip uses. This was the 🪙
                  emoji the hub replaced — one of the two call sites was missed,
                  so the identical balance rendered two different ways one tap
                  apart. */}
              {wallet.balance != null && (
                <View accessible accessibilityLabel={`Balance ${wallet.balance} play coins`} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Coin size={15} />
                  <Text style={{ color: SEAT[2].base, fontSize: t.sm, fontWeight: '800' }}>{wallet.balance}</Text>
                </View>
              )}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S[2] }}>
              {STAKES.map(v => (
                <Btn
                  key={v}
                  label={stakeLabel(v)}
                  compact
                  style={{ flexGrow: 1, flexBasis: Math.max(92, 72 * fontScale) }}
                  kind={stake === v ? 'gold' : 'secondary'}
                  selected={stake === v}
                  disabled={!host || (wallet.balance != null && v > wallet.balance)}
                  onPress={() => setStake(v)}
                  accessibilityLabel={v === 0 ? 'Play for free' : `Stake ${v} play coins`}
                />
              ))}
            </View>
            <Text style={{ color: LR.muted, fontSize: 11 }}>
              Play coins. They are not money and cannot be cashed out.
            </Text>
          </Panel>

          {/* The web offers these as distinct ways in rather than making
              everyone assemble a table by hand. Filling seats then starting is
              two taps that always go together. */}
          <Btn
            label="Quick game vs 1 bot"
            icon="bot"
            kind="gold"
            disabled={!host}
            onPress={() => { fillAndStart(1); }}
          />
          <Btn
            label="Play 3 bots"
            icon="bot"
            disabled={!host}
            onPress={() => { fillAndStart(3); }}
          />
          {/* A private room is worth nothing if its code is not on screen: the
              deep link covers people who have the app open, and this covers
              everyone who is being read the code out loud. */}
          {!!roomId && (
            <Text style={{ color: LR.muted, fontSize: t.sm }} selectable>
              Room code: <Text style={{ color: SEAT[2].base, fontWeight: '800' }}>{roomId}</Text>
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
          {/* The payload is written HERE, not left to the hook's default, so
              the wire message stays auditable at the call site — it must remain
              byte-identical to the `send({ t: 'addbot' })` this replaced. */}
          <Btn label="Add a bot" onPress={() => bot.addBot({ t: 'addbot' })} disabled={!host} />
          {/* The server can accept `addbot` and never seat one — seen on a
              device in a room with stale state. There is no error frame for it,
              so absence is the only evidence, and saying nothing leaves the
              player tapping a dead button. */}
          {bot.stalled && (
            <Text style={{ color: LR.bad, fontSize: t.sm, lineHeight: 18 }}>{ADD_BOT_STALLED}</Text>
          )}
          <Btn label="Invite a friend" icon="link" onPress={() => { void openInvite('ludo', roomId); }} disabled={!roomId} />
          <Btn label="Start now" kind="gold" onPress={() => send({ t: 'start', mode: 'classic', stake })} disabled={!host || members.length < 2} />
          {!!startBlockedReason(host, members.length) && (
            <Text style={{ color: LR.muted, fontSize: t.sm, lineHeight: 18, textAlign: 'center' }}>{startBlockedReason(host, members.length)}</Text>
          )}
        </ScrollView>
        <Toasts events={events} />
        <RulesSheet game="ludo" visible={rules.visible} onClose={rules.close} />
      </LudoRoom>
    );
  }

  // ── table ─────────────────────────────────────────────────────────
  const players: LPlayer[] = Array.isArray(G.players) ? G.players : [];
  const mySeat = players.find(p => pid(p) === state.you)?.seat ?? 0;
  // A tap while the socket is down goes nowhere: the intent is dropped and the
  // next snapshot puts every token back where the table has it.
  const connected = phase === 'connected';
  const reconnecting = !connected && !!G;
  const mine = G.turnPlayerId === state.you && connected;
  const movable: number[] = Array.isArray(G.movable) ? G.movable : [];
  const die: number | null = typeof G.pendingDie === 'number' ? G.pendingDie : null;

  const canRoll = mine && die == null && !finished;
  const canMove = mine && die != null && movable.length > 0;
  const turnName = players.find(p => pid(p) === G.turnPlayerId)?.name ?? 'Someone';

  /**
   * What a seat is doing right now, as a word.
   *
   * Derived from the SAME `turnPlayerId` and `phase` the board renders — this
   * reads state, it does not hold any. A seat card must never say "your turn"
   * one frame after the server moved on.
   */
  const seatStatus = (p: LPlayer): string => {
    if (finished) return pid(p) === G.winnerId ? 'Winner' : 'Finished';
    if (G.turnPlayerId !== pid(p)) return 'Waiting…';
    if (pid(p) !== state.you) return 'Playing…';
    // WHOSE turn it is comes from the server; whether we may ACT on it depends
    // on our socket. Conflating the two is what put "Tap a token" on the seat
    // card while the turn line said "<your own name> is playing" — the screen
    // telling the player to wait for themselves. Found on a device, mid-drop.
    if (!connected) return 'Your turn';
    return die != null ? (movable.length > 0 ? 'Tap a token' : 'No legal move') : 'Your turn';
  };

  /**
   * Whose turn the TABLE says it is — a server fact, independent of whether
   * this phone's socket happens to be up.
   *
   * `mine` is that AND `connected`, because it also gates interaction. The
   * wording below must use this one: a dropped socket does not hand your turn
   * to somebody else, and saying it does is worse than saying nothing.
   */
  const yourTurn = G.turnPlayerId === state.you;
  const board = (
        <View style={{ width: size, height: size, borderRadius: 20, backgroundColor: LR.bg,
          boxShadow: '0 16px 28px rgba(0,0,0,0.36), 0 2px 0 rgba(255,255,255,0.12)' }}>
          {/* Behind the board, and only as wide as the board. Every surface on
              the pane is translucent, so this is what they are lit BY. */}
          <StageLight size={size} />
          <BoardSvg size={size} />
          {players.map(p =>
            (p.tokens ?? []).map((step, i) => (
              <TokenView
                key={`${p.seat}:${i}`}
                seat={p.seat}
                index={i}
                step={step}
                cell={cell}
                movable={canMove && pid(p) === state.you && movable.includes(i)}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  send({ t: 'move', tokenIndex: i });
                }}
              />
            )),
          )}
        </View>
  );

  const controlsPanel = (<>
        {/* Seats, two to a row. Four stacked rows cost ~100dp of the board's
            height for two words of information each; the grid gives that back
            to the board, which is what the screen is for. Two players make one
            row and three make a row plus a full-width card — no empty slot is
            ever reserved. */}
        <View style={{ width: controlsWidth, gap: S[2] }}>
          {Array.from({ length: Math.ceil(players.length / controls.seatColumns) }, (_, rowIndex) => {
            const i = rowIndex * controls.seatColumns;
            const row = players.slice(i, i + controls.seatColumns);
            if (!row.length) return null;
            return (
              <View key={i} style={{ flexDirection: 'row', gap: S[2] }}>
                {row.map(p => (
                  <SeatCard
                    key={p.seat}
                    player={p}
                    you={pid(p) === state.you}
                    active={G.turnPlayerId === pid(p)}
                    status={seatStatus(p)}
                  />
                ))}
              </View>
            );
          })}
        </View>

        {!layout.wide && board}

        {reconnecting && <Reconnecting error={error} onRetry={retry} />}

        {finished ? (
          <View style={{ width: controlsWidth }}>
            <Banner
              text={G.winnerId === state.you ? 'You win!' : `${players.find(p => pid(p) === G.winnerId)?.name ?? 'Someone'} wins`}
              tone={G.winnerId === state.you ? 'win' : 'lose'}
            />
          </View>
        ) : (
          <View style={{ width: controlsWidth, flexDirection: controls.stacked ? 'column' : 'row', alignItems: 'stretch', gap: S[3] }}>
            <DiceTray wide={controls.stacked}>
              <Die value={die} tumbling={tumbling} armed={canRoll} seat={mySeat} size={controls.dieSize} />
              {/* Renders nothing when the snapshot carries no deadline, so the
                  tray simply centres the die instead of holding a gap. */}
              <TurnClock secs={secs} />
            </DiceTray>
            <Btn
              label={tumbling ? 'Rolling…' : canRoll ? 'Roll the Dice' : die != null ? `Rolled ${die}` : 'Waiting…'}
              kind="gold"
              icon="dice"
              style={{ flexGrow: 1, minWidth: 0, minHeight: 64 }}
              disabled={!canRoll || tumbling}
              onPress={() => {
                // Start the tumble first, then ask. The result is held back
                // until the animation has run its course.
                setTumbling(true);
                if (tumbleTimer.current) clearTimeout(tumbleTimer.current);
                tumbleTimer.current = setTimeout(() => setTumbling(false), 850);
                const cs = rollSeed();
                lastSeed.current = cs;
                send({ t: 'roll', clientSeed: cs });
              }}
            />
          </View>
        )}

        {!finished && (
          <View style={{ width: controlsWidth }}>
            <TurnIndicator
              // `yourTurn`, not `mine` — see above. While the socket is down it
              // is still your turn, and the Reconnecting banner directly above
              // already says why you cannot act on it.
              title={
                !yourTurn ? `${turnName} is playing`
                  : !connected ? 'Your turn'
                  : canMove ? 'Tap a token'
                  : die != null ? 'No legal move'
                  : 'Your turn'
              }
              sub={
                !yourTurn ? 'Waiting for their move'
                  : !connected ? 'Held until the table is back'
                  : canMove ? 'Any token with a glowing rim can move'
                  : die != null ? 'Passing to the next player'
                  : 'Roll the dice to move'
              }
              // Never `act` while disconnected: a tap would go nowhere, and the
              // gold "go" tone is a promise this screen could not keep.
              tone={!yourTurn || !connected ? 'wait' : canMove ? 'act' : die != null ? 'wait' : 'you'}
            />
          </View>
        )}

        {/* One action bar, four controls — the shape the design asks for.
            "Talk at the table" is a compact control that opens VoiceSheet
            rather than the full-width VoiceBar, which is the pattern Chess
            already uses: the bar's join/live/mute/leave row is three controls
            wide on its own and cannot share a line with anything.
            NO VOICE LOGIC LIVES HERE — the sheet drives the same `voice`
            object, so joining, muting and leaving behave exactly as before.
            The lobby keeps the full VoiceBar, where there is room for it. */}
        <View style={{ width: controlsWidth, flexDirection: 'row', flexWrap: 'wrap', gap: S[2] }}>
          <Btn
            label="Talk at the table"
            icon={voiceLive ? (voice.muted ? 'micOff' : 'mic') : 'mic'}
            compact
            style={{ flexGrow: 1, flexBasis: 150 }}
            disabled={voice.phase === 'unavailable'}
            onPress={() => setShowVoice(true)}
            accessibilityLabel={
              voice.phase === 'unavailable' ? 'Table voice unavailable'
                : voiceLive ? `Table voice, ${voice.muted ? 'muted' : 'live'}, ${voice.participants.length} in the channel`
                : 'Talk at the table'
            }
          />
          <Btn label="Emote" icon="emote" compact style={{ flexGrow: 1, flexBasis: 90 }} onPress={() => setShowEmotes(true)} />
          <Btn label="Invite" icon="link" compact style={{ flexGrow: 1, flexBasis: 90 }} onPress={() => { void openInvite('ludo', roomId); }} disabled={!roomId} />
          <Btn label="" icon="settings" compact onPress={() => setShowSettings(true)} accessibilityLabel="Settings" />
        </View>

        {/* Voice is LIVE and the bar is now a button, so the state that the
            full bar used to show has to be visible somewhere on the board. A
            dot and a count, not a second control. */}
        {voiceLive && (
          <View style={{ width: controlsWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2] }}>
            <View style={{
              width: 7, height: 7, borderRadius: 4,
              // Amber while nobody else has joined: you ARE in voice, you just
              // have no one to talk to yet. Same rule as VoiceBar's own dot.
              backgroundColor: voice.phase === 'waiting' ? SEAT[2].base : LR.ok,
            }} />
            <Text style={{ flexShrink: 1, color: LR.muted, fontSize: 11.5 }}>
              {voice.phase === 'waiting'
                ? 'In voice — waiting for others'
                : `${voice.muted ? 'Muted' : voice.canSpeak ? 'Voice on' : 'Listening'} · ${voice.participants.length}`}
            </Text>
          </View>
        )}

        {finished && (
          <View style={{ width: controlsWidth, flexDirection: controls.stacked ? 'column' : 'row', gap: S[2] }}>
            <RematchBtn rm={rematch} label="Play again" />
            <Btn label="Share" icon="share" onPress={() => { void shareResult('ludo', G.winnerId === state.you); }} />
          </View>
        )}

        {/* The dice are commit-reveal and have been from the start. Saying so
            where the player can check is the whole feature — an invisible
            guarantee reassures nobody. */}
        {/* Secondary by construction: quieter glass than every other control,
            no glow, no fill weight. It must not compete with Roll. */}
        <Pressable
          onPress={() => setShowFair(true)}
          accessibilityRole="button"
          accessibilityLabel="Are these dice fair?"
          style={{
            width: controlsWidth, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: S[3],
            paddingHorizontal: S[4], paddingVertical: S[2],
            borderRadius: R.pill, borderWidth: 1, borderColor: white(0.12),
            backgroundColor: white(LG.ctaQuiet),
          }}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={17} color={LR.muted} />
          <Text style={{ flex: 1, color: LR.muted, fontSize: t.sm, fontWeight: '600' }}>Are these dice fair?</Text>
          <Ionicons name="chevron-forward" size={16} color={LR.muted} />
        </Pressable>
  </>);

  return (
    <LudoRoom>
      <ScrollView onLayout={onBoardBox} contentContainerStyle={{ padding: S[4], gap: S[3], alignItems: 'center' }}>
        <View style={{ width: layout.contentWidth, flexDirection: layout.wide ? 'row' : 'column', alignItems: 'flex-start', gap: S[3] }}>
          {layout.wide && board}

          {layout.wide ? (
            <ScrollView nestedScrollEnabled style={{ width: controlsWidth, maxHeight: Math.max(120, height - S[4] * 2) }} contentContainerStyle={{ gap: S[3], paddingBottom: S[2] }}>
              {controlsPanel}
            </ScrollView>
          ) : <View style={{ width: controlsWidth, gap: S[3] }}>{controlsPanel}</View>}
        </View>
      </ScrollView>

      <Sheet visible={showFair} title="How the dice are rolled" onClose={() => setShowFair(false)}>
        <Text style={{ color: LR.muted, fontSize: t.sm, lineHeight: 20 }}>
          Neither side decides a roll on its own. Your phone sends a random seed, the
          table combines it with its own, and the number falls out of both. Change
          either half and you get a different number.
        </Text>
        <Text style={{ color: LR.muted, fontSize: t.sm, lineHeight: 20 }}>
          Your recent rolls are below, exactly as they were sent and published. Nothing
          here is recalculated on this phone: the table rolls, this only keeps the receipt.
          Where it says “not published”, the table did not reveal that half — so the roll
          cannot be checked independently, and we will not pretend otherwise.
        </Text>
        {receipts.length === 0 ? (
          <Text style={{ color: LR.muted, fontSize: t.sm }}>Roll the dice and your first receipt appears here.</Text>
        ) : receipts.map(r => (
          <View key={r.at} style={{ gap: 2, paddingVertical: S[2], borderTopWidth: 1, borderTopColor: white(0.12) }}>
            <Text style={{ color: LR.text, fontSize: t.sm, fontWeight: '800' }}>
              {r.value != null ? `Rolled ${r.value}` : 'Rolled'}
            </Text>
            <Text selectable style={{ color: LR.muted, fontSize: 11 }}>your seed  {r.clientSeed}</Text>
            <Text selectable style={{ color: LR.muted, fontSize: 11 }}>
              table commit  {r.commit ?? 'not published'}
            </Text>
            <Text selectable style={{ color: LR.muted, fontSize: 11 }}>
              table seed  {r.serverSeed ?? 'not published'}
            </Text>
          </View>
        ))}
      </Sheet>

      <Toasts events={events} />
      <Confetti show={!!finished && G.winnerId === state.you} />

      <Sheet visible={showEmotes} title="Say something" onClose={() => setShowEmotes(false)}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S[2] }}>
          {['👍', '😂', '😮', '😢', '🔥', '👏', '🎲', '😎', '💀', '🤝'].map(e => (
            <Pressable
              key={e}
              onPress={() => { send({ t: 'emote', emoji: e }); playSfx('tick'); setShowEmotes(false); }}
              accessibilityRole="button"
              accessibilityLabel={emoteLabel(e)}
              style={{
                width: 56, height: 56, borderRadius: R[2], alignItems: 'center', justifyContent: 'center',
                borderWidth: 1, borderColor: white(0.18), backgroundColor: white(0.08),
                boxShadow: `inset 0 1px 0 ${white(0.16)}`,
              }}
            >
              <Text style={{ fontSize: 26 }}>{e}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>

      {/* The full voice panel the action bar's control opens. Joining, leaving
          and muting here are the same calls the bar made — leaving voice never
          leaves the table. */}
      <VoiceSheet
        visible={showVoice}
        voice={voice}
        nameOf={id => players.find(p => pid(p) === id)?.name ?? id}
        onClose={() => setShowVoice(false)}
      />

      <Sheet visible={showSettings} title="Table" onClose={() => setShowSettings(false)}>
        <SettingRow
          label="Sound"
          value={sound ? 'On' : 'Off'}
          checked={sound}
          onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }}
        />
        {/* Rules were reachable only from the lobby, so a player who arrived by
            quick match never saw them. Same sheet, same copy. */}
        <SettingRow
          label="How to play"
          hint="The rules this table plays"
          value="Read"
          onPress={() => { setShowSettings(false); setShowRules(true); }}
        />
        <SettingRow
          label="Invite a friend"
          hint={roomId ? `Room code ${roomId}` : 'Share this table'}
          value="Share"
          onPress={() => { setShowSettings(false); void openInvite('ludo', roomId); }}
        />
      </Sheet>

      <RulesSheet game="ludo" visible={showRules} onClose={() => setShowRules(false)} />
    </LudoRoom>
  );
}
