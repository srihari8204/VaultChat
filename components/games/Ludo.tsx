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
 *
 * The board is one SVG because a 15x15 grid is 225 views otherwise, and the
 * glass surface needs gradients per cell. Tokens sit above it as animated views
 * so they can hop independently of a static board.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import Svg, {
  Defs, RadialGradient, LinearGradient as SvgLinear, Stop, Rect, G as SvgG, Polygon,
  Text as SvgText, Circle, Ellipse, Path,
} from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat, withSequence,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
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
import { S, R, D3, white } from '../../lib/games/theme';
import {
  LR, LR_AMBIENT, LR_STAGE, SEAT, P, PL, PD, COLOR_NAMES, SHAPE,
  LG, WELL, TRACK, TRAY, YARD, PAWN, PAWN_BODY, PAWN_BASE, w, seatA, ludoControls, ludoLayout,
} from '../../lib/games/ludoGlass';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar, VoiceSheet } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { openInvite, shareResult } from '../../lib/games/invite';
import { useWallet, STAKES, stakeLabel } from '../../lib/games/useWallet';
import { useAddBot, ADD_BOT_STALLED } from '../../lib/games/useAddBot';
import { initialOf } from '../../lib/format';

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

/**
 * The seat palette, the shape markers and the room now live in
 * lib/games/ludoGlass.ts.
 *
 * They were declared here, which meant a game's colour was written in this file
 * AND in app/games.tsx — the drift the ACCENT change exists to prevent. SEAT[2]
 * IS ACCENT.ludo now rather than a near-miss of it, and ludoGlass.selftest
 * asserts that they stay equal.
 */

/** Safe ring cells — starts and star squares. Decorative; the server enforces. */
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Yard origin [row,col] per corner, each 6x6 of the 15x15 grid. */
const YARD_RC: [number, number][] = [[0, 0], [0, 9], [9, 9], [9, 0]];

/**
 * Where a token sits, given its owner's corner and its step.
 *
 * Total by construction. Every lookup here is indexed by data that arrives off
 * the wire, and returning `undefined` for an unexpected seat or step crashes
 * the whole board at the destructure rather than misplacing one disc — which
 * is exactly what happened when `step` was accidentally undefined.
 */
function coord(corner: number, tokenIdx: number, step: number): [number, number] {
  const c = Number.isInteger(corner) && corner >= 0 && corner < 4 ? corner : 0;
  const i = Number.isInteger(tokenIdx) && tokenIdx >= 0 && tokenIdx < 4 ? tokenIdx : 0;
  const s = Number.isFinite(step) ? step : -1;
  if (s < 0) return BASE_SPOTS[c][i];
  if (s <= 50) return RING[(START_OFFSET[c] + s) % 52];
  if (s >= HOME_STEP) return CENTER_RC;
  return HOME_COORDS[c][Math.max(0, Math.min(s - 51, 4))];
}

/**
 * A token IS its step. The server sends `Tokens []int` and the web client reads
 * them straight through (`p.tokens.filter(s => s >= HOME_STEP)`); wrapping them
 * in `{step}` produced `undefined` everywhere and crashed the board the moment
 * a game started, because `coord()` then returned undefined and the caller
 * destructured it.
 */
type LPlayer = { id?: string; vaultId?: string; name: string; seat: number; tokens: number[]; isBot?: boolean };

const pid = (p: LPlayer) => p.id ?? p.vaultId ?? '';

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
        <Text style={{ fontSize: 46 }}>🎲</Text>
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
        <Text style={{ fontSize: 46 }}>🎲</Text>
        <Text style={{ color: LR.muted, fontSize: t.md }}>
          {phase === 'minting' ? 'Taking your seat…' : 'Joining the table…'}
        </Text>
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
          <Text style={{ color: LR.text, fontSize: t.xl, fontWeight: '800' }}>Ludo</Text>
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
              <Text style={{ flex: 1, color: LR.text, fontSize: t.md, fontWeight: '800' }}>Stake</Text>
              {/* The same gold dot the hub's CoinChip uses. This was the 🪙
                  emoji the hub replaced — one of the two call sites was missed,
                  so the identical balance rendered two different ways one tap
                  apart. */}
              {wallet.balance != null && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
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
              accessibilityLabel={`Send ${e}`}
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
          onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }}
        />
      </Sheet>
    </LudoRoom>
  );
}

/* ── the room ───────────────────────────────────────────────────────── */

/**
 * The room this board plays in.
 *
 * Local rather than the shared TableBackground for the same reason ChessRoom
 * is: that surface is a maroon card table and other games sit on it. Ludo was
 * redesigned to a midnight room (2026-09-06) and changing the shared ground
 * would have taken Rummy and Tic-Tac-Toe with it.
 *
 * One SVG for all four glows, so the whole room costs a single view rather than
 * a stack of gradient wrappers. No dot grain: the shared table needs one because
 * a large expanse of flat maroon bands on cheap panels, and there is never an
 * area of flat colour that large on this screen.
 */
function LudoRoom({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flex: 1, backgroundColor: LR.bg }, style]}>
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          {LR_AMBIENT.map((g, i) => (
            <RadialGradient key={i} id={'lr' + i} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
              {/* Four stops, not two. A two-stop falloff left a visible hard
                  ring where the mid stop sat, and a gradient that ends abruptly
                  reads as a drawn circle rather than as light. */}
              <Stop offset="0"    stopColor={g.color} stopOpacity={g.opacity} />
              <Stop offset="0.35" stopColor={g.color} stopOpacity={g.opacity * 0.55} />
              <Stop offset="0.68" stopColor={g.color} stopOpacity={g.opacity * 0.18} />
              <Stop offset="1"    stopColor={g.color} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {LR_AMBIENT.map((_, i) => (
          <Rect key={i} x="0" y="0" width="100%" height="100%" fill={'url(#lr' + i + ')'} />
        ))}
      </Svg>
      {children}
    </View>
  );
}

/**
 * The light the board sits on.
 *
 * Not decoration, and the single highest-leverage thing in this restyle: every
 * surface ON the board is translucent white, so without a lit ground beneath
 * them the whole board composites toward the room's near-black and no amount of
 * tinting the cells recovers it. The first pass of this design was a grey smudge
 * for exactly this reason.
 *
 * Sized against the BOARD, not the screen. At screen scale it lit the chrome
 * instead and the room stopped being midnight.
 *
 * Memoised on `size` alone, like BoardSvg — it must not re-render per move.
 */
const StageLight = React.memo(function StageLight({ size }: { size: number }) {
  const d = size * LR_STAGE.scale;
  return (
    <Svg
      width={d} height={d} pointerEvents="none"
      style={{ position: 'absolute', left: (size - d) / 2, top: (size - d) / 2 }}
    >
      <Defs>
        <RadialGradient id="lstage" cx="50%" cy="50%" rx="50%" ry="50%">
          {LR_STAGE.stops.map(s => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </RadialGradient>
      </Defs>
      <Ellipse cx={d / 2} cy={d / 2} rx={d / 2} ry={d / 2} fill="url(#lstage)" />
    </Svg>
  );
});

/* ── the board ──────────────────────────────────────────────────────── */

/**
 * The whole static board in one SVG, drawn in grid units (0..15) so every
 * coordinate below reads as a cell reference rather than a pixel.
 *
 * MEMOISED, and it matters more than it looks: this is ~80 SVG nodes with
 * gradient fills, and `size` is the only thing it reads — a number fixed for
 * the life of the screen. Without the memo every dice roll, every token move
 * and every turn change rebuilt the entire board underneath the pieces, which
 * is the most expensive thing on the screen being redrawn to show exactly the
 * same picture.
 */
const BoardSvg = React.memo(function BoardSvg({ size }: { size: number }) {
  const homeCells = useMemo(() => {
    const out: { rc: [number, number]; seat: number }[] = [];
    for (let s = 0; s < 4; s++) for (let i = 0; i < 5; i++) out.push({ rc: HOME_COORDS[s][i], seat: s });
    return out;
  }, []);
  const stars = useMemo(() => [...SAFE].filter(i => !START_OFFSET.includes(i)), []);

  return (
    <Svg width={size} height={size} viewBox="0 0 15 15" style={{ position: 'absolute', borderRadius: 20 }}>
      <Defs>
        {/* Glass frame surrounds the familiar light track and colored homes. */}
        <RadialGradient id="lfelt" cx="50%" cy="50%" rx="65%" ry="65%">
          <Stop offset="0.42" stopColor="#ffffff" stopOpacity={LG.pane} />
          <Stop offset="1" stopColor="#ffffff" stopOpacity={LG.pane * 0.42} />
        </RadialGradient>
        <RadialGradient id="lsheen" cx="26%" cy="18%" rx="60%" ry="60%">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={LG.sheen} />
          <Stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </RadialGradient>
        {SEAT.map((s, i) => (
          <SvgLinear key={i} id={`lyard${i}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={s.light} stopOpacity={YARD.fillTop} />
            <Stop offset="0.55" stopColor={s.base} stopOpacity={YARD.fillMid} />
            <Stop offset="1" stopColor={s.deep} stopOpacity={YARD.fillBottom} />
          </SvgLinear>
        ))}
        {P.map((_, i) => (
          <SvgLinear
            key={i} id={`lhome${i}`}
            x1="0" y1="0"
            x2={i === 1 || i === 3 ? '0' : '1'}
            y2={i === 1 || i === 3 ? '1' : '0'}
          >
            <Stop offset="0" stopColor={PL[i]} />
            <Stop offset="0.55" stopColor={P[i]} />
            <Stop offset="1" stopColor={PD[i]} />
          </SvgLinear>
        ))}
      </Defs>

      <Rect x="0.025" y="0.025" width="14.95" height="14.95" rx="0.55" fill="url(#lfelt)" stroke={w(0.42)} strokeWidth="0.05" />
      <Rect x="0.1" y="0.1" width="14.8" height="14.8" rx="0.48" fill="url(#lsheen)" stroke={w(0.12)} strokeWidth="0.035" />

      {RING.map(([r, c], i) => (
        <SvgG key={`r${i}`}>
        <Rect
          x={c + 0.03} y={r + 0.03} width="0.94" height="0.94" rx="0.07"
          fill={SAFE.has(i) ? TRACK.safe : TRACK.cell}
          stroke={TRACK.edge} strokeWidth="0.035"
        />
        <Path d={`M ${c + 0.2} ${r + 0.13} H ${c + 0.8}`} stroke={w(0.3)} strokeWidth="0.035" strokeLinecap="round" />
        </SvgG>
      ))}

      {homeCells.map(({ rc: [r, c], seat }, i) => (
        <Rect key={`h${i}`} x={c + 0.03} y={r + 0.03} width="0.94" height="0.94" rx="0.07" fill={`url(#lhome${seat})`} stroke={w(0.55)} strokeWidth="0.045" />
      ))}

      {/* start squares — solid colour plus an arrow pointing into the track */}
      {START_OFFSET.map((off, seat) => {
        const [r, c] = RING[off];
        return (
          <SvgG key={`s${seat}`}>
            <Rect x={c + 0.03} y={r + 0.03} width="0.94" height="0.94" rx="0.07" fill={seatA(seat, 'base', 0.92)} stroke={w(0.7)} strokeWidth="0.045" />
            <Path d={`M ${c + 0.25} ${r + 0.5} H ${c + 0.73} M ${c + 0.53} ${r + 0.29} L ${c + 0.74} ${r + 0.5} L ${c + 0.53} ${r + 0.71}`}
              fill="none" stroke={TRACK.ink} strokeWidth="0.085" strokeLinecap="round" strokeLinejoin="round"
              transform={`rotate(${seat * 90} ${c + 0.5} ${r + 0.5})`} />
          </SvgG>
        );
      })}

      {stars.map(i => {
        const [r, c] = RING[i];
        return <Path key={`st${i}`} d="M .5 .17 L .6 .38 L .84 .41 L .66 .58 L .71 .82 L .5 .7 L .29 .82 L .34 .58 L .16 .41 L .4 .38 Z"
          transform={`translate(${c} ${r})`} fill="none" stroke={TRACK.ink} strokeWidth="0.065" strokeLinejoin="round" />;
      })}

      {/* centre — four triangles meeting in the middle, one per seat */}
      <Polygon points="6,6 9,6 7.5,7.5" fill="url(#lhome1)" stroke={w(0.35)} strokeWidth="0.035" />
      <Polygon points="9,6 9,9 7.5,7.5" fill="url(#lhome2)" stroke={w(0.35)} strokeWidth="0.035" />
      <Polygon points="9,9 6,9 7.5,7.5" fill="url(#lhome3)" stroke={w(0.35)} strokeWidth="0.035" />
      <Polygon points="6,9 6,6 7.5,7.5" fill="url(#lhome0)" stroke={w(0.35)} strokeWidth="0.035" />
      <Rect x="6" y="6" width="3" height="3" rx="0.14" fill="none" stroke={w(0.55)} strokeWidth="0.08" />
      <Circle cx="7.5" cy="7.5" r="0.64" fill={LR.bg} stroke={SEAT[2].light} strokeWidth="0.065" />
      <Circle cx="7.5" cy="7.5" r="0.5" fill={w(0.06)} stroke={w(0.3)} strokeWidth="0.025" />
      <SvgText x="7.5" y="7.72" fontSize="0.67" fill={SEAT[2].light} textAnchor="middle">★</SvgText>

      {/* the four yards */}
      {YARD_RC.map(([r, c], seat) => (
        <SvgG key={`y${seat}`}>
          <Rect
            x={c + 0.25} y={r + 0.25} width="5.5" height="5.5" rx="0.7"
            fill={`url(#lyard${seat})`}
            // The rim is the seat's LIGHT tone, not its base: on a quadrant now
            // filled with that same base, a base-coloured edge disappeared into
            // it and the yard lost its shape.
            stroke={seatA(seat, 'light', YARD.rim)} strokeWidth="0.07"
          />
          <Rect x={c + 0.48} y={r + 0.48} width="5.04" height="5.04" rx="0.52"
            fill={TRACK.cell} stroke={w(0.8)} strokeWidth="0.035" />
          <Path d={`M ${c + 0.85} ${r + 0.64} H ${c + 5.15}`}
            stroke={w(0.65)} strokeWidth="0.055" strokeLinecap="round" />
          <Circle cx={c + 3} cy={r + 3} r="0.68" fill={seatA(seat, 'deep', 0.55)} stroke={seatA(seat, 'light', 0.8)} strokeWidth="0.045" />
          <Circle cx={c + 3} cy={r + 3} r="0.54" fill="none" stroke={w(0.24)} strokeWidth="0.025" />
          <SvgText x={c + 3} y={r + 3.24} fontSize="0.7" fill={LR.text} textAnchor="middle">{SHAPE[seat]}</SvgText>
          {BASE_SPOTS[seat].map(([br, bc], i) => (
            // Inset sockets retain a visible seat-colored rim beneath each pawn.
            <SvgG key={i}>
              <Circle cx={bc + 0.5} cy={br + 0.54} r="0.64" fill={seatA(seat, 'deep', 0.6)} />
              <Circle cx={bc + 0.5} cy={br + 0.5} r="0.6" fill={WELL} stroke={PD[seat]} strokeWidth="0.055" />
              <Circle cx={bc + 0.5} cy={br + 0.5} r="0.46" fill={seatA(seat, 'base', 0.18)} stroke={seatA(seat, 'deep', 0.35)} strokeWidth="0.025" />
            </SvgG>
          ))}
        </SvgG>
      ))}
    </Svg>
  );
});

/* ── a token ────────────────────────────────────────────────────────── */

/**
 * A glass pawn on a rimmed medallion, with its seat's shape embossed on top.
 *
 * Position animates with a springy overshoot — the classic Ludo hop, and the
 * same curve ludo.css uses on left/top. Movable tokens breathe so the player
 * can see at a glance which ones this roll allows rather than trying each.
 */
function TokenView({
  seat, index, step, cell, movable, onPress,
}: { seat: number; index: number; step: number; cell: number; movable: boolean; onPress: () => void }) {
  const [r, c] = coord(seat, index, step);
  const d = cell * 0.78;
  // Tokens sharing a square are nudged apart so a stack is still countable.
  const nudge = step >= 0 && step < HOME_STEP ? (index - 1.5) * cell * 0.11 : 0;
  const tx = c * cell + (cell - d) / 2 + nudge;
  const ty = r * cell + (cell - d) / 2;

  const x = useSharedValue(tx);
  const y = useSharedValue(ty);
  const lift = useSharedValue(0);
  const pulse = useSharedValue(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; x.value = tx; y.value = ty; return; }
    x.value = withSpring(tx, { damping: 12, stiffness: 220, mass: 0.8 });
    y.value = withSpring(ty, { damping: 12, stiffness: 220, mass: 0.8 });
    // A brief rise on the way makes the move read as a hop, not a slide.
    lift.value = withSequence(
      withTiming(1, { duration: 90, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) }),
    );
  }, [tx, ty, x, y, lift]);

  useEffect(() => {
    if (movable) {
      pulse.value = withRepeat(withTiming(1, { duration: 620, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(pulse);
  }, [movable, pulse]);

  const a = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value - lift.value * cell * 0.35 },
      { scale: 1 + lift.value * 0.12 + pulse.value * 0.1 },
    ] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: d, height: d }, a]}>
      <Pressable
        onPress={movable ? onPress : undefined}
        disabled={!movable}
        // A ludo board is fifteen cells across, so on a phone a token is drawn
        // at about 19dp however big the board gets — measured on the Redmi at
        // 51px, which is 19dp, against a 44dp minimum target. The token cannot
        // grow without the board lying about where pieces sit, so the TOUCH
        // area grows instead: enough slop on each side to reach 44dp, and never
        // less than the 6 it always had.
        hitSlop={Math.max(6, Math.ceil((44 - d) / 2))}
        accessibilityRole="button"
        accessibilityState={{ disabled: !movable }}
        accessibilityLabel={`${COLOR_NAMES[seat]} token ${index + 1}${movable ? ', can move' : ''}`}
        style={{
          width: '100%', height: '100%',
          alignItems: 'center', justifyContent: 'center',
          // The glow is a shadow on the WRAPPER, not on the vector — a coloured
          // drop shadow around an SVG path is far more expensive than one
          // around a plain view, and at this size the halo is a soft disc
          // either way.
          boxShadow:
            `0 3px 6px rgba(0,0,0,0.5), `
            + `0 0 ${movable ? 10 : 5}px ${seatA(seat, 'base', movable ? PAWN.glowMovable : PAWN.glowRest)}`,
        }}
      >
        {/* A TOKEN, not a disc. Head, waist, flared skirt, plinth — the
            silhouette is what makes a piece readable at 18.5dp, which is the
            only size it is ever drawn at. Geometry lives in ludoGlass so it can
            be checked without a renderer. */}
        <Svg width={d} height={d} viewBox="0 0 100 100">
          <Defs>
            <SvgLinear id={`pw${seat}`} x1="0.15" y1="0" x2="0.85" y2="1">
              <Stop offset="0" stopColor={PL[seat]} />
              <Stop offset="0.45" stopColor={P[seat]} />
              <Stop offset="1" stopColor={PD[seat]} />
            </SvgLinear>
            <SvgLinear id={`pb${seat}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={P[seat]} />
              <Stop offset="1" stopColor={PD[seat]} />
            </SvgLinear>
            {/* Reads PAWN.specular rather than restating it. Hardcoding the
                stop here is how the token module and the pixels drift apart —
                ludoGlass.selftest §11 fails if any PAWN token goes unused. */}
            <RadialGradient id={`ps${seat}`} cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={PAWN.specular} />
              <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="50" cy="53" r="45" fill={seatA(seat, 'deep', 0.9)}
            stroke={movable ? LR.text : PL[seat]} strokeWidth={movable ? 5 : 3} />
          <Circle cx="50" cy="51" r="38" fill={`url(#pb${seat})`} stroke={w(0.4)} strokeWidth="1.8" />
          {/* plinth first — it sits under the body */}
          <Path d={PAWN_BASE} fill={`url(#pb${seat})`} stroke={seatA(seat, 'light', 0.6)} strokeWidth="2.8" />
          <Path
            d={PAWN_BODY}
            fill={`url(#pw${seat})`}
            // White only when the roll permits it, so "can move" is a change of
            // material rather than merely a thicker edge.
            stroke={movable ? white(PAWN.rimMovable) : seatA(seat, 'light', PAWN.rimRest)}
            strokeWidth={movable ? 5 : 3.4}
          />
          {/* one specular on the head. Two would read as plastic. */}
          <Ellipse cx="44" cy="22.5" rx="6.5" ry="4.5" fill={`url(#ps${seat})`} transform="rotate(28 44 22.5)" />
          {/* the colourblind marker rides the SKIRT, the widest part — in the
              head it would be ~3dp on a real phone and simply gone. */}
          <SvgText
            x="50" y="70" fontSize="26" fontWeight="bold"
            fill={PAWN.markerInk} textAnchor="middle"
          >{SHAPE[seat]}</SvgText>
        </Svg>
      </Pressable>
    </Animated.View>
  );
}

/* ── the die ────────────────────────────────────────────────────────── */

/** Pip positions per face, as indices into a 3x3 grid. */
const PIPS: Record<number, number[]> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

/**
 * The die.
 *
 * `armed` is "your turn, not yet rolled" — a slow breath, an invitation.
 * `tumbling` is the roll itself: the cube spins hard and the FACE CHANGES,
 * which is what reads as a roll. A die that only wobbles while keeping the same
 * pips looks like a stuck animation.
 *
 * The face shown while tumbling is deliberately random and means nothing; the
 * server's number replaces it the moment the animation ends. Rolling the real
 * result early would be showing an answer the player has not seen arrive.
 */
function Die({ value, tumbling, armed, seat, size }: { value: number | null; tumbling: boolean; armed: boolean; seat: number; size: number }) {
  const shake = useSharedValue(0);
  const spin = useSharedValue(0);
  const [flicker, setFlicker] = useState(6);

  useEffect(() => {
    if (tumbling) {
      spin.value = 0;
      spin.value = withTiming(1, { duration: 850, easing: Easing.out(Easing.cubic) });
      shake.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 70, easing: Easing.inOut(Easing.quad) }),
          withTiming(-1, { duration: 70, easing: Easing.inOut(Easing.quad) }),
        ), -1, true);
      // Cycle the face so the cube is visibly changing, not merely shaking.
      const id = setInterval(() => setFlicker(1 + Math.floor(Math.random() * 6)), 90);
      return () => { clearInterval(id); cancelAnimation(shake); cancelAnimation(spin); };
    }
    cancelAnimation(shake);
    shake.value = withSpring(0, { damping: 14, stiffness: 200 });
    if (armed) {
      // A slow breath while it is the player's turn to roll.
      shake.value = withRepeat(withTiming(0.22, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
    }
    spin.value = withTiming(0, { duration: 200 });
    return () => { cancelAnimation(shake); cancelAnimation(spin); };
  }, [tumbling, armed, shake, spin]);

  const a = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${shake.value * 12 + spin.value * 540}deg` },
      { translateY: -Math.abs(shake.value) * 6 },
      { scale: 1 + Math.abs(shake.value) * 0.06 },
    ] as ViewStyle['transform'],
  }));

  const face = tumbling ? flicker : (value ?? 6);
  const on = new Set(PIPS[face] ?? []);

  return (
    <Animated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={tumbling ? 'Rolling the dice' : value == null ? 'Dice, not rolled' : `Dice showing ${value}`}
      style={[{
        width: size, height: size, borderRadius: size * 0.24, padding: size * 0.15,
        // Frosted glass rather than cream ivory. The cream was mixed for the
        // maroon table; against the midnight room it read as a yellow tile.
        backgroundColor: LR.text,
        borderWidth: 1.5, borderColor: armed || tumbling ? SEAT[2].light : white(0.9),
        // CLIPPED, so the sheen below stays inside the cube. Shadows are drawn
        // outside a clipped view either way, so the halo survives.
        overflow: 'hidden',
        boxShadow:
          '0 7px 14px rgba(0,0,0,0.5), '
          // The gold halo is what makes it float over the tray rather than sit
          // on it. It is spent here and on the CTA, nowhere else on the board.
          + `0 0 16px ${seatA(2, 'base', armed || tumbling ? 0.4 : 0.16)}, `
          + 'inset 0 3px 1px rgba(255,255,255,1), inset 0 -5px 1px rgba(90,80,140,0.24)',
        opacity: value == null && !tumbling && !armed ? 0.78 : 1,
      }, a]}
    >
      {/* The corner sheen — one band of light across the top-left. It is what
          reads as a glass CUBE rather than a rounded square, and it is static,
          so it costs one SVG that never re-renders while the die spins. */}
      <Svg width={size} height={size} viewBox="0 0 62 62" pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinear id="dface" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" />
            <Stop offset="0.52" stopColor={LR.text} />
            <Stop offset="1" stopColor="#DCE5F0" />
          </SvgLinear>
          <RadialGradient id="dsheen" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
            <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="2" y="2" width="58" height="54" rx="12" fill="url(#dface)" stroke={w(0.85)} strokeWidth="0.8" />
        <Path d="M 10 5 H 43" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
        <Ellipse cx="20" cy="12" rx="26" ry="14" fill="url(#dsheen)" transform="rotate(18 20 12)" />
      </Svg>
      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: 9 }, (_, i) => (
          <View key={i} style={{ width: '33.33%', height: '33.33%', alignItems: 'center', justifyContent: 'center' }}>
            {on.has(i) && (
              <View style={{
                width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08,
                backgroundColor: tumbling || value == null ? '#77718D' : LR.bg,
                borderWidth: 0.8, borderColor: white(0.75),
                // A pip only glows once it is a real published result — while
                // the cube is tumbling the face means nothing and must not be
                // dressed up as an answer.
                boxShadow: !tumbling && value != null ? `0 0 4px ${seatA(seat, 'base', 0.55)}` : undefined,
              }} />
            )}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

/**
 * The tray the die is thrown into.
 *
 * A recessed well plus one warm pool of light under the cube. Purely a surface:
 * it holds the die and the server's clock and decides nothing.
 */
function DiceTray({ children, wide }: { children?: React.ReactNode; wide: boolean }) {
  return (
    <View style={{
      width: wide ? '100%' : 112, minHeight: 110, borderRadius: R[4],
      flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap',
      alignItems: 'center', justifyContent: 'center', gap: S[2], padding: S[3],
      backgroundColor: TRAY,
      borderWidth: 1, borderColor: seatA(2, 'light', 0.4),
      boxShadow: 'inset 0 3px 8px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,255,255,0.1)',
    }}>
      {/* The pool of warm light the cube sits in. Static and behind the die, so
          it costs one SVG that never re-renders — the die animating above it
          does not touch this. */}
      <Svg width={96} height={44} pointerEvents="none" style={{ position: 'absolute', top: '50%', left: '50%', marginLeft: -48, marginTop: -10 }}>
        <Defs>
          <RadialGradient id="ltray" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0"   stopColor={SEAT[2].base} stopOpacity="0.45" />
            <Stop offset="0.5" stopColor="#FF8A3D"      stopOpacity="0.18" />
            <Stop offset="1"   stopColor={SEAT[2].base} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx={48} cy={22} rx={48} ry={22} fill="url(#ltray)" />
      </Svg>
      <Text style={{ color: SEAT[2].light, fontSize: 10, fontWeight: '800', letterSpacing: 1.8 }}>DICE</Text>
      {children}
    </View>
  );
}

/* ── chrome ─────────────────────────────────────────────────────────── */

/**
 * A seat: who, what they are doing, and how close they are to finishing.
 *
 * Laid out two to a row rather than four stacked, because four full-width rows
 * cost about 100dp of the board's height to carry information that is two words
 * wide — and the board is the thing this screen is for.
 *
 * THE AVATAR IS A MONOGRAM, NOT A PHOTO, and that is a protocol fact rather
 * than a style choice: `GameLobby.members` is `{vaultId, name, isBot, wins}`
 * and `G.players` carries no image anywhere, so a photo would need a server
 * change. A lit ring in the seat's own colour identifies the player just as
 * well and costs nothing.
 *
 * Every field is live. `status` is derived from the same `turnPlayerId` the
 * board reads; `done` counts tokens at HOME_STEP. Nothing here is placeholder.
 */
function SeatCard({ player, you, active, status }: { player: LPlayer; you: boolean; active: boolean; status: string }) {
  const t = useType();
  const { fontScale } = useWindowDimensions();
  const avatarSize = Math.max(32, Math.ceil(14 * fontScale + 12));
  const tokens = player.tokens ?? [];
  const done = tokens.filter(s => s >= HOME_STEP).length;
  const total = tokens.length || 4;
  const pct = tokens.length
    ? Math.round((tokens.reduce((n, s) => n + Math.max(0, Math.min(s, HOME_STEP)), 0) / (tokens.length * HOME_STEP)) * 100)
    : 0;
  const seat = SEAT[player.seat] ?? SEAT[0];

  return (
    <View
      accessibilityLabel={`${player.name}${you ? ', you' : ''}${player.isBot ? ', bot' : ''}, ${COLOR_NAMES[player.seat] ?? ''}, ${status}, ${done} of ${total} home`}
      style={{
        flex: 1, minWidth: 0, gap: S[2],
        paddingVertical: S[2], paddingHorizontal: S[3],
        borderRadius: R[4], borderWidth: 1,
        borderColor: active ? seatA(player.seat, 'base', 0.85) : white(0.14),
        backgroundColor: white(active ? LG.cardActive : LG.card),
        boxShadow: active
          ? `0 0 16px ${seatA(player.seat, 'base', 0.45)}, inset 0 1px 0 ${white(0.22)}`
          : `${D3.lift1}, inset 0 1px 0 ${white(0.14)}`,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
      {/* avatar: monogram over a seat-tinted disc, ringed and lit when active */}
      <View style={{
        width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: seatA(player.seat, 'deep', 0.55),
        borderWidth: 1.5, borderColor: seatA(player.seat, 'light', active ? 0.95 : 0.6),
        boxShadow: active ? `0 0 10px ${seatA(player.seat, 'base', 0.7)}` : undefined,
      }}>
        {player.isBot
          ? <Ionicons name="hardware-chip-outline" size={16} color={LR.text} />
          : <Text style={{ color: LR.text, fontSize: 14, fontWeight: '800' }}>
              {initialOf(player.name)}
            </Text>}
        {/* The shape marker rides the avatar. The colourblind fallback has to be
            on the CARD as well as on the pawn, or a red/green pair is
            distinguishable on the board and not in the roster. */}
        <Text style={{
          position: 'absolute', right: -3, bottom: -4, fontSize: 9,
          color: seat.light, textShadowColor: LR.bg, textShadowRadius: 2,
        }}>{SHAPE[player.seat]}</Text>
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: LR.text, fontSize: t.sm, fontWeight: '700' }}>
          {player.name}{you ? ' (you)' : ''}
        </Text>
      </View>
      </View>

      {/* Home counter. The house keeps the number from being a bare figure, and
          the bar underneath is the same `pct` the old row showed. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: S[1] }}>
        <Text style={{ flexGrow: 1, flexShrink: 1, color: active ? LR.ok : LR.muted, fontSize: 11, fontWeight: active ? '700' : '400' }}>
          {status}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <Ionicons name="home" size={11} color={LR.muted} />
          <Text style={{ color: done > 0 ? seat.light : LR.text, fontSize: 12, fontWeight: '800' }}>
            {done}/{total}
          </Text>
        </View>
      </View>
        <View style={{ width: '100%', height: 3, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.34)', overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: seat.base }} />
        </View>
    </View>
  );
}

/**
 * The turn indicator.
 *
 * This is the status line that already lived under the die, given a surface. It
 * says exactly what `mine` / `canMove` / `die` already decide and never implies
 * a tap that is not allowed — `tone` only chooses the colour of a state the
 * caller has already worked out.
 */
function TurnIndicator({ title, sub, tone }: { title: string; sub?: string; tone: 'you' | 'wait' | 'act' }) {
  const t = useType();
  const edge = tone === 'you' ? LR.ok : tone === 'act' ? SEAT[2].base : white(0.14);
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={sub ? `${title}. ${sub}` : title}
      style={{
        alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: S[3],
        paddingVertical: S[2], paddingHorizontal: S[3],
        borderRadius: R[3], borderWidth: 1,
        borderColor: tone === 'wait' ? white(0.14) : edge,
        backgroundColor: white(0.08),
        boxShadow: tone === 'wait'
          ? `inset 0 1px 0 ${white(0.16)}`
          : `0 0 18px ${tone === 'you' ? 'rgba(62,232,155,0.22)' : seatA(2, 'base', 0.22)}, inset 0 1px 0 ${white(0.20)}`,
      }}
    >
      <View style={{
        width: 34, height: 34, borderRadius: R[2],
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: white(0.12), borderWidth: 1, borderColor: white(0.2),
      }}>
        <Ionicons name="dice-outline" size={19} color={tone === 'wait' ? LR.muted : LR.text} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: LR.text, fontSize: t.md, fontWeight: '800' }}>{title}</Text>
        {sub ? <Text style={{ color: LR.muted, fontSize: 11.5 }}>{sub}</Text> : null}
      </View>
    </View>
  );
}


