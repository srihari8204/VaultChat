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
 * cream/gold surface needs gradients per cell. Tokens sit above it as animated
 * views so they can hop independently of a static board.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import Svg, {
  Defs, RadialGradient, LinearGradient as SvgLinear, Stop, Rect, G as SvgG, Polygon,
  Text as SvgText, Circle,
} from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat, withSequence,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import { TableBackground, Panel, Btn, Banner, PlayerRow, Reconnecting, RematchBtn, TurnClock, useType, useBoardSize } from './ui';
import { useRematch } from '../../lib/games/useRematch';
import { RulesSheet, useFirstTimeRules } from './rules';
import { rollSeed, receiptFrom, pushReceipt, type RollReceipt } from '../../lib/games/fairness';
import { useCountdown } from '../../lib/games/useCountdown';
import { C, S, R, D3, mix, goldLine } from '../../lib/games/theme';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { openInvite, shareResult } from '../../lib/games/invite';
import { useWallet, STAKES, stakeLabel } from '../../lib/games/useWallet';

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
 * Jewel tones from ludo.css — a light, a base and a dark per seat so surfaces
 * can be shaded rather than filled flat.
 */
const P  = ['#d8283f', '#12a054', '#eeb013', '#2168d6'];
const PD = ['#8d1226', '#076536', '#a96f06', '#103f8f'];
const PL = ['#ff6b78', '#58e08d', '#ffdb63', '#6fa9ff'];
const COLOR_NAMES = ['Red', 'Green', 'Yellow', 'Blue'];

/**
 * SHAPE MARKERS — accessibility, not decoration.
 *
 * Red and green are the classic deuteranopia pair, and identifying seats by
 * colour alone makes the game unplayable rather than merely harder for roughly
 * one man in twelve. Each seat carries a distinct shape as well.
 */
const SHAPE = ['▲', '●', '■', '◆'];

const CREAM = '#f6efdd';
const CREAM_2 = '#e6dcc2';

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
  const { width } = useWindowDimensions();

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
  const [sound, setSound] = useState(soundEnabled());
  const [stake, setStake] = useState(0);
  const wallet = useWallet();
  const voice = useTableVoice('ludo', roomId, { you: state.you, send, subscribe });
  // The tumble is local and deliberate. The server answers in tens of
  // milliseconds, so without a held animation the number simply appears and the
  // player never sees a roll happen — which is the single thing that makes dice
  // feel fair. See rollFor() below.
  const [tumbling, setTumbling] = useState(false);
  const tumbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (tumbleTimer.current) clearTimeout(tumbleTimer.current); }, []);

  // Up to four seat cards above, plus the die row and two button rows.
  const size = useBoardSize(400, 460);
  const cell = size / 15;

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
      <Center>
        <Text style={{ fontSize: 46 }}>🎲</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>Can’t reach the table</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
        <Btn label="Try again" kind="gold" onPress={retry} />
      </Center>
    );
  }

  // Only take the screen back BEFORE there is a board.
  if ((phase !== 'connected' && !G) || !L) {
    return (
      <Center>
        <Text style={{ fontSize: 46 }}>🎲</Text>
        <Text style={{ color: C.muted, fontSize: t.md }}>
          {phase === 'minting' ? 'Taking your seat…' : 'Joining the table…'}
        </Text>
      </Center>
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
      <TableBackground>
        <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3] }}>
          <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>Ludo</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
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
            <Text style={{ color: C.muted, fontSize: t.sm }}>{members.length} seated · up to 4</Text>
            {members.length < 2 && (
              <Text style={{ color: C.muted, fontSize: t.sm }}>Two players minimum — add a bot to start now.</Text>
            )}
          </Panel>
          {/* Stake. Free is first and the default: a table that quietly costs
              something is how a player loses coins they did not mean to put up.
              These are PLAY coins — the games server mints them and they buy
              nothing outside these tables. */}
          <Panel style={{ gap: S[2] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, color: C.text, fontSize: t.md, fontWeight: '800' }}>Stake</Text>
              {wallet.balance != null && (
                <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>{`🪙 ${wallet.balance}`}</Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', gap: S[2] }}>
              {STAKES.map(v => (
                <Btn
                  key={v}
                  label={stakeLabel(v)}
                  compact
                  style={{ flex: 1 }}
                  kind={stake === v ? 'gold' : 'secondary'}
                  disabled={!host || (wallet.balance != null && v > wallet.balance)}
                  onPress={() => setStake(v)}
                  accessibilityLabel={v === 0 ? 'Play for free' : `Stake ${v} play coins`}
                />
              ))}
            </View>
            <Text style={{ color: C.muted, fontSize: 11 }}>
              Play coins. They are not money and cannot be cashed out.
            </Text>
          </Panel>

          {/* The web offers these as distinct ways in rather than making
              everyone assemble a table by hand. Filling seats then starting is
              two taps that always go together. */}
          <Btn
            label="Quick game vs 1 bot"
            icon="🤖"
            kind="gold"
            disabled={!host}
            onPress={() => { fillAndStart(1); }}
          />
          <Btn
            label="Play 3 bots"
            icon="🤖"
            disabled={!host}
            onPress={() => { fillAndStart(3); }}
          />
          {/* A private room is worth nothing if its code is not on screen: the
              deep link covers people who have the app open, and this covers
              everyone who is being read the code out loud. */}
          {!!roomId && (
            <Text style={{ color: C.muted, fontSize: t.sm }} selectable>
              Room code: <Text style={{ color: C.gold, fontWeight: '800' }}>{roomId}</Text>
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
          <Btn label="How to play" icon="📖" onPress={rules.open} />
          <Btn label="Add a bot" onPress={() => send({ t: 'addbot' })} disabled={!host} />
          <Btn label="Invite a friend" icon="🔗" onPress={() => { void openInvite('ludo', roomId); }} disabled={!roomId} />
          <Btn label="Start now" kind="gold" onPress={() => send({ t: 'start', mode: 'classic', stake })} disabled={!host || members.length < 2} />
        </ScrollView>
        <Toasts events={events} />
        <RulesSheet game="ludo" visible={rules.visible} onClose={rules.close} />
      </TableBackground>
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

  return (
    <TableBackground>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3], alignItems: 'center', paddingBottom: S[6] }}>

        <View style={{ width: size, gap: S[2] }}>
          {players.map(p => (
            <SeatCard key={p.seat} player={p} you={pid(p) === state.you} active={G.turnPlayerId === pid(p)} />
          ))}
        </View>

        <View style={{ width: size, height: size }}>
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

        {reconnecting && <Reconnecting error={error} onRetry={retry} />}

        <View style={{ width: size, flexDirection: 'row', alignItems: 'center', gap: S[3] }}>
          <Die value={die} tumbling={tumbling} armed={canRoll} seat={mySeat} />
          <TurnClock secs={secs} />
          <View style={{ flex: 1, gap: S[2] }}>
            {finished ? (
              <Banner
                text={G.winnerId === state.you ? 'You win!' : `${players.find(p => pid(p) === G.winnerId)?.name ?? 'Someone'} wins`}
                tone={G.winnerId === state.you ? 'win' : 'lose'}
              />
            ) : (
              <>
                <Btn
                  label={tumbling ? 'Rolling…' : canRoll ? 'Roll the dice' : die != null ? `Rolled ${die}` : 'Waiting…'}
                  kind="gold"
                  icon="🎲"
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
                <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>
                  {!mine ? `${turnName} is playing`
                    : canMove ? 'Tap a token to move'
                    : die != null ? 'No legal move — passing' : 'Your turn'}
                </Text>
              </>
            )}
          </View>
        </View>

        <VoiceBar
          width={size}
          phase={voice.phase}
          error={voice.error}
          canSpeak={voice.canSpeak}
          muted={voice.muted}
          participants={voice.participants}
          onJoin={voice.join}
          onLeave={voice.leave}
          onToggleMute={voice.toggleMute}
        />

        <View style={{ width: size, flexDirection: 'row', gap: S[2] }}>
          <Btn label="Emote" icon="💬" compact style={{ flex: 1 }} onPress={() => setShowEmotes(true)} />
          <Btn label="Invite" icon="🔗" compact style={{ flex: 1 }} onPress={() => { void openInvite('ludo', roomId); }} disabled={!roomId} />
          <Btn label="⚙" compact onPress={() => setShowSettings(true)} accessibilityLabel="Settings" />
        </View>

        {finished && (
          <View style={{ width: size, flexDirection: 'row', gap: S[2] }}>
            <RematchBtn rm={rematch} label="Play again" />
            <Btn label="Share" icon="📣" onPress={() => { void shareResult('ludo', G.winnerId === state.you); }} />
          </View>
        )}

        {/* The dice are commit-reveal and have been from the start. Saying so
            where the player can check is the whole feature — an invisible
            guarantee reassures nobody. */}
        <Btn label="Are these dice fair?" compact onPress={() => setShowFair(true)} />
      </ScrollView>

      <Sheet visible={showFair} title="How the dice are rolled" onClose={() => setShowFair(false)}>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>
          Neither side decides a roll on its own. Your phone sends a random seed, the
          table combines it with its own, and the number falls out of both. Change
          either half and you get a different number.
        </Text>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>
          Your recent rolls are below, exactly as they were sent and published. Nothing
          here is recalculated on this phone: the table rolls, this only keeps the receipt.
          Where it says “not published”, the table did not reveal that half — so the roll
          cannot be checked independently, and we will not pretend otherwise.
        </Text>
        {receipts.length === 0 ? (
          <Text style={{ color: C.muted, fontSize: t.sm }}>Roll the dice and your first receipt appears here.</Text>
        ) : receipts.map(r => (
          <View key={r.at} style={{ gap: 2, paddingVertical: S[2], borderTopWidth: 1, borderTopColor: goldLine[14] }}>
            <Text style={{ color: C.text, fontSize: t.sm, fontWeight: '800' }}>
              {r.value != null ? `Rolled ${r.value}` : 'Rolled'}
            </Text>
            <Text selectable style={{ color: C.muted, fontSize: 11 }}>your seed  {r.clientSeed}</Text>
            <Text selectable style={{ color: C.muted, fontSize: 11 }}>
              table commit  {r.commit ?? 'not published'}
            </Text>
            <Text selectable style={{ color: C.muted, fontSize: 11 }}>
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
                borderWidth: 1, borderColor: goldLine[22], backgroundColor: C.panel2,
              }}
            >
              <Text style={{ fontSize: 26 }}>{e}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>

      <Sheet visible={showSettings} title="Table" onClose={() => setShowSettings(false)}>
        <SettingRow
          label="Sound"
          value={sound ? 'On' : 'Off'}
          onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }}
        />
      </Sheet>
    </TableBackground>
  );
}

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
    <Svg width={size} height={size} viewBox="0 0 15 15" style={{ position: 'absolute', borderRadius: 14 }}>
      <Defs>
        <RadialGradient id="lfelt" cx="50%" cy="50%" rx="65%" ry="65%">
          <Stop offset="0.42" stopColor={CREAM} />
          <Stop offset="1" stopColor={CREAM_2} />
        </RadialGradient>
        <RadialGradient id="lsheen" cx="26%" cy="18%" rx="60%" ry="60%">
          <Stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <Stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="lyard" cx="50%" cy="28%" rx="60%" ry="60%">
          <Stop offset="0" stopColor="#ffffff" />
          <Stop offset="0.72" stopColor="#f2ecdc" />
          <Stop offset="1" stopColor="#e2d9c2" />
        </RadialGradient>
        <RadialGradient id="lsafe" cx="32%" cy="26%" rx="60%" ry="60%">
          <Stop offset="0" stopColor="#fffdf4" />
          <Stop offset="0.62" stopColor={CREAM} />
          <Stop offset="1" stopColor="#e2d6b8" />
        </RadialGradient>
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

      <Rect x="0" y="0" width="15" height="15" fill="url(#lfelt)" />
      <Rect x="0" y="0" width="15" height="15" fill="url(#lsheen)" />

      {RING.map(([r, c], i) => (
        <Rect
          key={`r${i}`} x={c} y={r} width="1" height="1"
          fill={SAFE.has(i) ? 'url(#lsafe)' : CREAM}
          stroke="rgba(0,0,0,0.09)" strokeWidth="0.03"
        />
      ))}

      {homeCells.map(({ rc: [r, c], seat }, i) => (
        <Rect key={`h${i}`} x={c} y={r} width="1" height="1" fill={`url(#lhome${seat})`} stroke="rgba(0,0,0,0.10)" strokeWidth="0.03" />
      ))}

      {/* start squares — solid colour plus an arrow pointing into the track */}
      {START_OFFSET.map((off, seat) => {
        const [r, c] = RING[off];
        return (
          <SvgG key={`s${seat}`}>
            <Rect x={c} y={r} width="1" height="1" fill={P[seat]} stroke="rgba(0,0,0,0.12)" strokeWidth="0.03" />
            <SvgText
              x={c + 0.5} y={r + 0.72} fontSize="0.62" fill="rgba(255,255,255,0.92)" textAnchor="middle"
              transform={`rotate(${seat * 90} ${c + 0.5} ${r + 0.5})`}
            >➜</SvgText>
          </SvgG>
        );
      })}

      {stars.map(i => {
        const [r, c] = RING[i];
        return <SvgText key={`st${i}`} x={c + 0.5} y={r + 0.78} fontSize="0.72" fill="#c2951f" textAnchor="middle">★</SvgText>;
      })}

      {/* centre — four triangles meeting in the middle, one per seat */}
      <Polygon points="6,6 9,6 7.5,7.5" fill={P[1]} />
      <Polygon points="9,6 9,9 7.5,7.5" fill={P[2]} />
      <Polygon points="9,9 6,9 7.5,7.5" fill={P[3]} />
      <Polygon points="6,9 6,6 7.5,7.5" fill={P[0]} />
      <Rect x="6" y="6" width="3" height="3" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="0.08" />
      <SvgText x="7.5" y="7.85" fontSize="0.9" fill="#ffdd72" textAnchor="middle">★</SvgText>

      {/* the four yards */}
      {YARD_RC.map(([r, c], seat) => (
        <SvgG key={`y${seat}`}>
          <Rect x={c + 0.2} y={r + 0.2} width="5.6" height="5.6" rx="0.8" fill="url(#lyard)" stroke={P[seat]} strokeWidth="0.3" />
          {BASE_SPOTS[seat].map(([br, bc], i) => (
            <Circle key={i} cx={bc + 0.5} cy={br + 0.5} r="0.62" fill="#ece4d0" stroke={P[seat]} strokeWidth="0.09" />
          ))}
        </SvgG>
      ))}
    </Svg>
  );
});

/* ── a token ────────────────────────────────────────────────────────── */

/**
 * One glossy disc.
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
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${COLOR_NAMES[seat]} token ${index + 1}${movable ? ', can move' : ''}`}
        style={{
          width: '100%', height: '100%', borderRadius: d / 2,
          backgroundColor: P[seat],
          borderWidth: movable ? 2 : 1,
          borderColor: movable ? '#ffffff' : 'rgba(0,0,0,0.45)',
          alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 5px 10px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.42), inset 0 -3px 6px rgba(0,0,0,0.4), inset 0 2px 3px rgba(255,255,255,0.55)',
        }}
      >
        <Text style={{ fontSize: d * 0.5, lineHeight: d * 0.62, color: 'rgba(0,0,0,0.66)', fontWeight: '700' }}>
          {SHAPE[seat]}
        </Text>
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
function Die({ value, tumbling, armed, seat }: { value: number | null; tumbling: boolean; armed: boolean; seat: number }) {
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
      accessibilityLabel={tumbling ? 'Rolling the dice' : value == null ? 'Dice, not rolled' : `Dice showing ${value}`}
      style={[{
        width: 62, height: 62, borderRadius: 12, padding: 7,
        backgroundColor: '#fdf8ec',
        borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)',
        boxShadow: '0 8px 18px rgba(0,0,0,0.45), inset 0 2px 3px rgba(255,255,255,0.9), inset 0 -3px 6px rgba(120,90,40,0.28)',
        opacity: value == null && !tumbling && !armed ? 0.55 : 1,
      }, a]}
    >
      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: 9 }, (_, i) => (
          <View key={i} style={{ width: '33.33%', height: '33.33%', alignItems: 'center', justifyContent: 'center' }}>
            {on.has(i) && (
              <View style={{
                width: 9, height: 9, borderRadius: 5,
                backgroundColor: tumbling ? '#8d7f66' : value == null ? '#b0a48c' : P[seat],
              }} />
            )}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

/* ── chrome ─────────────────────────────────────────────────────────── */

function SeatCard({ player, you, active }: { player: LPlayer; you: boolean; active: boolean }) {
  const t = useType();
  const tokens = player.tokens ?? [];
  const done = tokens.filter(s => s >= HOME_STEP).length;
  const pct = tokens.length
    ? Math.round((tokens.reduce((n, s) => n + Math.max(0, Math.min(s, HOME_STEP)), 0) / (tokens.length * HOME_STEP)) * 100)
    : 0;

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: S[2],
      paddingVertical: S[2], paddingHorizontal: S[3],
      borderRadius: R[2], borderWidth: 1,
      borderColor: active ? P[player.seat] : goldLine[14],
      backgroundColor: mix(C.panel2, 86, '#ffffff'),
      boxShadow: active ? '0 6px 18px rgba(0,0,0,0.35)' : D3.lift1,
    }}>
      <Text style={{ fontSize: 14, color: P[player.seat] }}>{SHAPE[player.seat]}</Text>
      <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }}>
        {player.name}{you ? ' (you)' : ''}{player.isBot ? ' 🤖' : ''}
      </Text>
      <Text style={{ color: C.muted, fontSize: 11 }}>{done}/{tokens.length || 4} home</Text>
      <View style={{ width: 54, height: 5, borderRadius: 3, backgroundColor: C.panel2, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: '100%', backgroundColor: P[player.seat] }} />
      </View>
    </View>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <TableBackground>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        {children}
      </View>
    </TableBackground>
  );
}

