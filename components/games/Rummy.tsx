/**
 * Rummy — native, server-refereed, adaptive.
 *
 * The server holds the deck, deals, times the turns and validates every meld.
 * It sends the public table in `game`, THIS player's cards in a top-level
 * `hand`, the turn's `deadline` and, at the end, the `settlement`. Other
 * players are only ever a `handCount`, which is what keeps the game honest:
 * nobody's cards are ever on another device to be read out of a debugger.
 * See docs/GAMES_PROTOCOL.md.
 *
 * There is no meld validation here, no scoring, no shuffle, no wild-card
 * substitution and no timer of our own. `declare` sends the player's grouping
 * and the SERVER decides. The badges come from lib/games/meldHint.ts, which is
 * advisory and may never gate an action.
 *
 * Card: { id, suit: 'S'|'H'|'D'|'C'|'JOKER', rank } — id is unique per physical
 * card because two decks are in play and duplicates genuinely exist.
 *
 * LAYOUT: the felt IS the screen, and every size on it is resolved from the
 * real window and the real safe-area insets by lib/games/rummyTable.ts. That
 * module is checked against eight devices in both orientations, because a
 * Declare button under the gesture bar is a hand the player cannot finish and
 * no single screenshot would ever show it. Gameplay takes landscape and gives
 * it back on the way out; the lobby stays portrait, because a list of tables
 * reads better tall.
 *
 * WHAT THE SERVER DOES NOT OFFER, AND SO IS NOT HERE: pool (101/201) and deals
 * rummy. This server plays 13-card POINTS rummy and its wire protocol has no
 * concept of a pool score, an elimination or a deal count. Those are engine
 * features, and inventing them on the client would mean the client deciding
 * scores — exactly the thing the whole design refuses to do.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, Text, TextInput, View, useWindowDimensions, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, RadialGradient, Stop, Rect, Line, Ellipse, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, withRepeat,
  Easing, cancelAnimation, runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as ScreenOrientation from 'expo-screen-orientation';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import { TableBackground, Panel, Btn, Banner, PlayerRow, RematchBtn, useType } from './ui';
import { useCountdown } from '../../lib/games/useCountdown';
import { useRematch, type Rematch } from '../../lib/games/useRematch';
import { RulesSheet, useFirstTimeRules } from './rules';
import { Toasts, Confetti, Sheet, SettingRow, VoiceSheet } from './feedback';
import { useTableVoice, type TableVoice } from '../../lib/games/useTableVoice';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import {
  reconcile, groupUp, ungroup, sameGroups, moveCard, sortHand,
  isSortMode, SORT_MODES, SORT_LABEL, type Groups, type SortMode,
} from '../../lib/games/handGroups';
import { analyzeHand, type MeldType } from '../../lib/games/meldHint';
import { openInvite, shareResult, tableLink } from '../../lib/games/invite';
import {
  metrics, seatSpots, secondsLeft, ranked, activeCount, pid, allowsBots,
  newPrivateCode, normalizeCode,
  type RummyPlayer, type Settlement, type TableInfo,
} from '../../lib/games/rummyTable';
import { C, S, R, mix, goldLine } from '../../lib/games/theme';

type Card = { id: string; suit: string; rank: string };

const SUIT_GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣', JOKER: '★' };
const SUIT_NAME: Record<string, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs', JOKER: 'joker' };
const RED = new Set(['H', 'D']);

/** Thirteen-card Indian rummy: the hand a player holds between turns. */
const HAND_SIZE = 13;

/**
 * How long a table with enough players waits before the host's client deals.
 *
 * A minute is long enough for a third or fourth person to sit down and short
 * enough that two people are not left staring at a lobby — which is what
 * happened when dealing needed a tap that nobody made.
 */
const AUTO_DEAL_SECS = 60;

/**
 * The cloth.
 *
 * It was green — a straight port of rummy.css. Green is what a card table is,
 * but it was the ONLY green thing in the app: every other games surface is the
 * maroon room, so the table read as a component borrowed from somewhere else
 * rather than the centre of its own screen. The cloth is now a deep wine that
 * belongs to the same room, lit from above so the middle is where the eye goes
 * and the piles have somewhere to sit.
 *
 * Three stops, brightest first: the lit centre, the body of the cloth, and the
 * shadow at the rail.
 */
const FELT = ['#7A1E2B', '#4A1019', '#300A11'];
const CARD_FACE = '#fffdf6';
const CARD_EDGE = '#caa44a';
const CARD_RED = '#d8213f';
const CARD_INK = '#16181f';
const JOKER_PURPLE = '#7c3aed';
// Warm ink. It was '#e7f3ea', a GREEN-tinted white chosen for the old green
// cloth; on wine it read faintly cold and slightly dirty.
const INK_ON_FELT = '#FFF8F1';

/** Under this many seconds the clock turns red and ticks audibly. */
const CLOCK_URGENT = 10;

/**
 * How long to wait for the server to seat us before admitting it has not.
 *
 * A join that is never answered used to leave a spinner running forever, which
 * is the worst possible report: the player cannot tell a slow network from a
 * table that does not exist, so they wait instead of trying something else.
 */
const SEAT_TIMEOUT_MS = 8000;

function spoken(c: Card): string {
  if (c.suit === 'JOKER' || !c.rank) return 'joker';
  return `${c.rank} of ${SUIT_NAME[c.suit] ?? c.suit}`;
}

/* ── the remembered sort mode ───────────────────────────────────────── */
//
// Module-level and read back once, the same shape sfx.ts uses for the mute
// preference: it has to be readable synchronously during the first render, and
// a hand that re-sorts itself a beat after it appears looks broken. It lives
// here rather than in handGroups.ts because that module is exercised by a
// Node-run self-check and must stay free of native modules.

const SORT_KEY = 'vc_rummy_sort';
// SUIT, not 'smart'. Sorting in a rummy app means one cluster per suit, in rank
// order, so a player can see at a glance which sequences they are one card
// away from — that is the whole point of the button, and it is what every
// reference client does. 'smart' pulls completed melds to the front and leaves
// the rest in one mixed group, which reads as "it did something else". It is
// still available in Table settings for players who prefer it, along with
// by-rank and manual.
let sortModePref: SortMode = 'suit';
AsyncStorage.getItem(SORT_KEY)
  .then(v => { if (isSortMode(v)) sortModePref = v; })
  .catch(() => {});

/** Shared empty hand: a fresh [] each render would re-run every memo below it. */
const NO_CARDS: Card[] = [];

/** A measured drop target, in window coordinates. */
type Zone = { x: number; y: number; w: number; h: number };

export default function Rummy({ tableId = '', auto, autoBot }: { tableId?: string } & AutoStart) {
  /* ── connection ──────────────────────────────────────────────────── */

  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const onServerMessage = useCallback((m: any) => {
    // `tables` arrives once on connect, before any lobby exists, so it never
    // shows up in a `state` frame — this is the only way to see it.
    if (m?.t === 'tables' && Array.isArray(m.tables)) setTables(m.tables as TableInfo[]);
  }, []);

  const { phase, error, state, events, send, join, subscribe, retry } =
    useGameSocket('rummy', tableId, { auto, autoBot, onMessage: onServerMessage });

  // Held in a ref so leaveTable, declared before the voice hook runs, can hang
  // up without either one having to move.
  const voiceLeaveRef = useRef<(() => void) | null>(null);

  const [seated, setSeated] = useState(tableId);
  const [seating, setSeating] = useState(!!tableId);
  const [seatFailed, setSeatFailed] = useState(false);

  const L = state.lobby;
  const G = state.game;
  const raw: any = state.raw;
  const hand: Card[] = Array.isArray(raw?.hand) ? raw.hand : NO_CARDS;
  const table = L?.table;

  /**
   * Get up from the table.
   *
   * The protocol has no `leave` intent — the reference client reloads the page
   * — so the honest equivalent is to rebuild the socket. `retry` disposes the
   * old one (which stops its reconnect loop), clears the state and reconnects,
   * and with no table id it comes back to the list. Merely blanking `seated`
   * would leave the stale lobby on screen and the player still seated on the
   * server, which is worse than not offering the button.
   */
  const leaveTable = useCallback(() => {
    voiceLeaveRef.current?.();
    setSeated('');
    setTables(null);
    setSeating(false);
    setSeatFailed(false);
    retry('');            // '' = join nothing, so we land back on the table list
  }, [retry]);

  const takeSeat = useCallback((id: string) => {
    const code = normalizeCode(id);
    if (!code) return;
    setSeated(code);
    setSeating(true);
    setSeatFailed(false);
    join(code);
  }, [join]);

  // Seated the moment a lobby comes back for us. Until then the timeout above
  // is what turns an unanswered join into something the player can act on.
  useEffect(() => { if (L) { setSeating(false); setSeatFailed(false); } }, [L]);

  /**
   * DID WE ACTUALLY GET THE TABLE WE ASKED FOR?
   *
   * The rummy server answers a join for a table it does not know by seating you
   * at its own default table and saying nothing about the substitution. Two
   * people who share a code therefore both land somewhere called "Practice",
   * each alone, each shown a lobby that looks like success — device-proven on
   * two phones with the same code, both reading "1/6 seated".
   *
   * The app cannot create a table the server will not create. What it can do is
   * stop reporting success: if we asked for a specific code and the lobby that
   * came back names one of the server's own public tables, say so, so the
   * player stops waiting for a friend who can never arrive.
   */
  const askedFor = seated;
  const servedName = (L?.table?.name ?? '').trim();
  // Compare what we ASKED FOR with what the table calls itself, rather than
  // against the public list: arriving by deep link or invite never loads that
  // list, which is exactly the path this notice exists for. If the server ever
  // does honour a code it will name the table after it, and the notice stops
  // appearing on its own.
  const substituted =
    !!askedFor && !!servedName && servedName.toLowerCase() !== askedFor.toLowerCase();
  useEffect(() => {
    if (!seating) return;
    const id = setTimeout(() => { setSeating(false); setSeatFailed(true); }, SEAT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [seating, seated]);

  /* ── notices ─────────────────────────────────────────────────────── */
  //
  // Server events and this screen's own refusals share one feed, so a local
  // "draw first" and a server "not your turn" cannot stack on top of each
  // other. Appending the server's into the same list (rather than rendering two
  // Toasts) is what keeps the newest one actually newest.

  const [feed, setFeed] = useState<string[]>([]);
  const seenEvents = useRef(0);
  useEffect(() => {
    if (events.length <= seenEvents.current) return;
    const fresh = events.slice(seenEvents.current);
    seenEvents.current = events.length;
    setFeed(prev => [...prev, ...fresh].slice(-20));
  }, [events]);
  const notify = useCallback((msg: string) => setFeed(prev => [...prev, msg].slice(-20)), []);

  /* ── screen ──────────────────────────────────────────────────────── */

  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Depends on the MEASUREMENTS, not on the objects carrying them: both hooks
  // hand back a fresh object every render, so depending on them would recompute
  // the whole layout on every keystroke and defeat the memo entirely.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  /**
   * SYMMETRIC side insets, so the table is centred on the SCREEN.
   *
   * In landscape — the orientation rummy plays in — the cutout sits on one side
   * only. Padding each edge by its own inset is correct for avoiding it, but it
   * makes the usable box asymmetric: measured on the Redmi at rotation 1, the
   * hand's scroller ran 76..2264, so a hand centred inside it still sat 38px
   * right of the middle of the screen. Padding both sides by the larger inset
   * costs a little width and buys a table that is actually centred.
   *
   * The same value feeds `metrics` and the padded box below. That is the point:
   * the last two bugs here were both a model describing a layout that did not
   * render, so there is exactly one number and both sides read it.
   */
  const sideInset = Math.max(insets.left, insets.right);
  const boxInsets = useMemo(
    () => ({ top: insets.top, bottom: insets.bottom, left: sideInset, right: sideInset }),
    [insets.top, insets.bottom, sideInset],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const m = useMemo(() => metrics(win, boxInsets), [win.width, win.height, boxInsets]);
  const t = useType();

  const reduceMotion = useReduceMotion();
  const playing = !!G;

  /**
   * Landscape for the table, portrait for everything else.
   *
   * Restoring is the part that matters: the app is portrait-locked, and leaving
   * it unlocked would let every other screen rotate. Rotating does NOT remount
   * anything — the hand, the turn and the arrangement live in state above this,
   * and the server owns the clock — so a rotation mid-hand costs a relayout and
   * nothing else.
   */
  useEffect(() => {
    void ScreenOrientation.lockAsync(
      playing ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => {});
  }, [playing]);
  useEffect(() => () => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  useEffect(() => { void preloadSfx(['deal', 'discard', 'select', 'tick', 'win', 'lose', 'error']); }, []);

  /* ── voice ───────────────────────────────────────────────────────── */

  // Voice signalling rides the GAME socket — the games server relays `voice-*`
  // frames to the named peer, and there is no SFU to connect to instead.
  const voice = useTableVoice('rummy', seated, { you: state.you, send, subscribe });
  const [voiceOpen, setVoiceOpen] = useState(false);
  voiceLeaveRef.current = voice.leave;

  // Changing tables must not leave the microphone live in the room you left.
  const lastVoiceRoom = useRef(seated);
  const leaveVoice = voice.leave;
  useEffect(() => {
    if (lastVoiceRoom.current === seated) return;
    lastVoiceRoom.current = seated;
    leaveVoice();
  }, [seated, leaveVoice]);

  /* ── the turn, and its clock ─────────────────────────────────────── */

  // A tap while the socket is down goes nowhere: the intent is dropped and the
  // next snapshot restores the table. Everything a player can DO hangs off this
  // one flag, so gating it here disables draw, discard, declare and drop at
  // once — and the reconnecting pill already explains why.
  const mine = !!G && G.turnPlayerId === state.you && phase === 'connected';
  // Dealing again is `start` on this same table. The hook adds the wait that
  // ends and the invite for a table everyone else has left — see useRematch.ts.
  const rematch = useRematch('rummy', seated, state, send);

  /**
   * A rummy turn is draw-then-discard, and the hand SIZE says which half you
   * are in: thirteen cards means you still owe a draw, fourteen means you owe a
   * discard. The server sends no explicit flag, but it does not need to — the
   * count is unambiguous and it is already authoritative.
   */
  const mustDraw = mine && hand.length > 0 && hand.length <= HAND_SIZE;
  const mustDiscard = mine && !mustDraw;

  const secs = useCountdown(raw?.deadline, !!G && G.phase !== 'finished');
  const urgent = secs != null && secs <= CLOCK_URGENT;

  // One tick per second inside the warning window, and only on your own turn:
  // a clock ticking for somebody else's decision is noise.
  const tickedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!mine || !urgent || secs == null) { tickedAt.current = null; return; }
    if (tickedAt.current === secs) return;
    tickedAt.current = secs;
    playSfx('tick');
  }, [mine, urgent, secs]);

  /**
   * One turn action at a time.
   *
   * The server refuses a duplicate, but a double-tapped Discard still sends two
   * frames and the second comes back as an error the player did nothing to
   * deserve. Cleared by the next snapshot — and by a timeout, so a dropped
   * frame cannot wedge the buttons for the rest of the hand.
   */
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => { setPending(null); }, [raw]);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setPending(null), 6000);
    return () => clearTimeout(id);
  }, [pending]);

  const act = useCallback((key: string, msg: Record<string, unknown>) => {
    if (pending) return;
    setPending(key);
    send(msg as any);
  }, [pending, send]);

  /* ── the player's arrangement ────────────────────────────────────── */

  const [picked, setPicked] = useState<string[]>([]);
  const [groups, setGroups] = useState<Groups>([[]]);
  const [sortMode, setSortMode] = useState<SortMode>(sortModePref);
  const byId = useMemo(() => new Map(hand.map(c => [c.id, c])), [hand]);

  const isJoker = useCallback(
    (c: { suit: string; rank: string }) => c.suit === 'JOKER' || (!!G?.wildRank && c.rank === G.wildRank),
    [G?.wildRank],
  );

  // A new deal arrives pre-arranged, the way every native rummy app does it —
  // unless the player asked for `manual`, in which case an auto-arrangement
  // would be undoing work they intend to do themselves.
  const dealtFor = useRef<string>('');
  useEffect(() => {
    if (hand.length === 0) return;
    const fingerprint = hand.map(c => c.id).sort().join('|');

    setGroups(prev => {
      const held = prev.flat();
      // A hand that shares nothing with the arrangement is a fresh deal.
      const fresh = held.length === 0 || !held.some(id => hand.some(c => c.id === id));
      if (fresh && dealtFor.current !== fingerprint) {
        dealtFor.current = fingerprint;
        return sortMode === 'manual'
          ? reconcile(prev, hand.map(c => c.id))
          : sortHand(sortMode, hand, isJoker, prev);
      }
      const next = reconcile(prev, hand.map(c => c.id));
      return sameGroups(prev, next) ? prev : next;
    });
  }, [hand, sortMode, isJoker]);

  // Arrangement is persisted per seat by the server, so a reconnecting player
  // gets their groups back rather than thirteen loose cards mid-hand.
  const sentGroups = useRef<Groups | null>(null);
  useEffect(() => {
    if (!G || groups.flat().length === 0) return;
    if (sentGroups.current && sameGroups(sentGroups.current, groups)) return;
    sentGroups.current = groups;
    send({ t: 'arrange', groups: groups.filter(g => g.length > 0) });
  }, [groups, G, send]);

  const prevHand = useRef<number | null>(null);
  useEffect(() => {
    const n = hand.length;
    if (prevHand.current != null && n !== prevHand.current) {
      playSfx(n > prevHand.current ? 'deal' : 'discard');
    }
    prevHand.current = n;
  }, [hand.length]);

  const ended = useRef(false);
  useEffect(() => {
    if (G?.phase !== 'finished') { ended.current = false; return; }
    if (ended.current) return;
    ended.current = true;
    playSfx(G.winnerId === state.you ? 'win' : 'lose');
  }, [G?.phase, G?.winnerId, state.you]);

  /** ADVISORY ONLY — the server judges the declaration. */
  const hint = useMemo(
    () => analyzeHand(groups, id => byId.get(id), G?.wildRank ?? null),
    [groups, byId, G?.wildRank],
  );

  /* ── drag and drop ───────────────────────────────────────────────── */
  //
  // Group rows and the discard pile publish their WINDOW rect on layout, so the
  // gesture's absoluteX/absoluteY can be compared directly with no parent
  // offset to keep in step as the layout shifts — which it does on every
  // rotation.

  const zones = useRef<Zone[]>([]);
  const discardZone = useRef<Zone | null>(null);
  const setZone = useCallback((i: number, z: Zone) => { zones.current[i] = z; }, []);

  const [confirmDeclare, setConfirmDeclare] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRules, setShowRules] = useState(false);
  // Offered once, before the first hand a player ever sees.
  const firstRules = useFirstTimeRules('rummy');
  const [showResult, setShowResult] = useState(false);
  const [sound, setSound] = useState(soundEnabled());

  const discard = useCallback((cardId: string) => {
    if (!mustDiscard) { notify('Take a card from a pile first.'); playSfx('error'); return; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    act('discard', { t: 'discard', cardId });
    setPicked([]);
  }, [mustDiscard, act, notify]);

  /**
   * Where a released card lands.
   *
   * The discard pile is checked first and is the only drop that leaves the
   * hand. It is gated on `mustDiscard`, so a card dragged there before drawing
   * springs back with a reason rather than being thrown away — the invalid drop
   * restores, it never commits.
   */
  const dropAt = useCallback((cardId: string, x: number, y: number) => {
    const inside = (z: Zone | null) => !!z && x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;

    if (inside(discardZone.current)) {
      if (mustDiscard) { discard(cardId); return; }
      notify('Take a card from a pile before discarding.');
      playSfx('error');
      return;
    }

    const hit = zones.current.findIndex(z => inside(z));
    setGroups(g => moveCard(g, cardId, hit));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    playSfx('tick');
  }, [mustDiscard, discard, notify]);

  const toggle = useCallback((id: string) => {
    Haptics.selectionAsync().catch(() => {});
    playSfx('select');
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  }, []);

  const draw = useCallback((source: 'open' | 'closed') => {
    if (!mustDraw) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    act(`draw:${source}`, { t: 'draw', source });
  }, [mustDraw, act]);

  const declare = useCallback(() => {
    if (picked.length !== 1) return;
    const laid = groups.map(g => g.filter(id => id !== picked[0])).filter(g => g.length > 0);
    act('declare', { t: 'declare', discardId: picked[0], groups: laid });
    setPicked([]);
  }, [picked, groups, act]);

  /** Lay the hand out now, without touching the remembered preference. */
  const sortNow = useCallback((mode: SortMode) => {
    if (mode === 'manual') return;
    setGroups(g => sortHand(mode, hand, isJoker, g));
    setPicked([]);
    playSfx('tick');
  }, [hand, isJoker]);

  /**
   * Change the remembered preference, and apply it.
   *
   * Separate from sortNow because the Sort BUTTON must not silently convert a
   * player who chose `manual` into a `smart` player for every future deal —
   * they asked once, not forever.
   */
  const applySort = useCallback((mode: SortMode) => {
    setSortMode(mode);
    sortModePref = mode;
    void AsyncStorage.setItem(SORT_KEY, mode).catch(() => {});
    sortNow(mode);
  }, [sortNow]);

  /* ── views ───────────────────────────────────────────────────────── */

  const finished = G?.phase === 'finished';
  // A finished board outranks `status === 'lobby'`: the result belongs on the
  // table, not behind a bounce back to the seat list.
  useEffect(() => { setShowResult(!!finished); }, [finished]);

  // Reconnecting mid-hand must NOT tear the board down. The socket rejoins the
  // same table on its own; replacing the felt with a spinner would read as the
  // hand having been lost when it has not.
  const reconnecting = phase !== 'connected' && !!G;

  if (error && phase !== 'connected' && !G) {
    return (
      <Center>
        <Text style={{ fontSize: 46 }}>🂡</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>Can’t reach the table</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
        <Btn label="Try again" kind="gold" onPress={retry} />
      </Center>
    );
  }

  if (phase !== 'connected' && !G) {
    return (
      <Center>
        <Text style={{ fontSize: 46 }}>🂡</Text>
        <ActivityIndicator color={C.gold} />
        <Text style={{ color: C.muted, fontSize: t.md }}>
          {phase === 'minting' ? 'Taking your seat…' : 'Reaching the table…'}
        </Text>
      </Center>
    );
  }

  // Connected but not seated: choose a table.
  if (!L) {
    return (
      <TableSelect
        tables={tables}
        seating={seating}
        failed={seatFailed}
        seatedId={seated}
        onJoin={takeSeat}
        onBack={() => { setSeatFailed(false); setSeated(''); send({ t: 'lobby' }); }}
        feed={feed}
      />
    );
  }

  if (!G || (L.status === 'lobby' && !finished)) {
    return (
      <Room
        lobby={L}
        table={table}
        you={state.you}
        code={seated}
        substituted={substituted}
        voice={voice}
        voiceOpen={voiceOpen}
        setVoiceOpen={setVoiceOpen}
        onSend={send}
        onLeave={leaveTable}
        feed={feed}
        notify={notify}
      />
    );
  }

  /* ── the table ───────────────────────────────────────────────────── */

  const players: RummyPlayer[] = Array.isArray(G.players) ? G.players : [];
  const others = players.filter(p => pid(p) !== state.you);
  const openTop: Card | null = G.openTop ?? null;
  const closedCount: number = typeof G.closedCount === 'number' ? G.closedCount : 0;
  const wild: Card | null = G.wildJokerCard ?? null;
  const me = players.find(p => pid(p) === state.you);
  const settlement: Settlement = (raw?.settlement ?? {}) as Settlement;
  const spots = seatSpots(others.length, m.tableW, m.tableH);
  // Seven controls at full width need roughly this much room.
  const tight = m.width < 560;
  const turnName = players.find(p => pid(p) === G.turnPlayerId)?.name ?? 'Someone';
  const nameOf = (id: string) =>
    players.find(p => pid(p) === id)?.name
    ?? (L.members ?? []).find(mem => mem.vaultId === id)?.name
    ?? id;

  return (
    <View style={{ flex: 1 }}>
      {/* Full-bleed: the cloth reaches under the notch and the gesture bar,
          because a green screen with grey margins looks broken. Only the
          CONTROLS are inset — see the padded box below. */}
      <Baize width={win.width} height={win.height} />

      <View style={{
        flex: 1,
        paddingTop: boxInsets.top, paddingBottom: boxInsets.bottom,
        paddingLeft: boxInsets.left, paddingRight: boxInsets.right,
      }}>
      {/* The felt — an oval with a gold rail, so the piles read as sitting ON
          something and the other players have somewhere to be. */}
      <View style={{ height: m.tableH, width: m.tableW }}>
        <TableTop width={m.tableW} height={m.tableH} />

        {others.map((p, i) => (
          <Seat
            key={pid(p)}
            spot={spots[i]}
            name={p.name}
            count={p.handCount ?? 0}
            points={typeof p.points === 'number' ? p.points : null}
            status={p.status}
            bot={!!(L.members ?? []).find(mem => mem.vaultId === pid(p))?.isBot}
            turn={G.turnPlayerId === pid(p)}
            talking={voice.speaking.has(pid(p))}
            still={reduceMotion}
          />
        ))}

        {/* Table chrome — never over a card, and inside the safe box. */}
        <View style={{ position: 'absolute', top: 0, right: 0, flexDirection: 'row', gap: S[1], alignItems: 'center' }}>
          <VoicePill voice={voice} onPress={() => setVoiceOpen(true)} still={reduceMotion} />
          <IconBtn glyph="?" label="Game rules" onPress={() => setShowRules(true)} />
          <IconBtn glyph="⚙" label="Table settings" onPress={() => setShowSettings(true)} />
        </View>

        {(table?.name || table?.stakes) && (
          <Text
            numberOfLines={1}
            style={{ position: 'absolute', top: 2, left: 0, maxWidth: m.tableW * 0.4, color: INK_ON_FELT, fontSize: 11, fontWeight: '700', opacity: 0.85 }}
          >
            {[table?.name, table?.stakes].filter(Boolean).join(' · ')}
          </Text>
        )}

        {/* piles, in the middle of the cloth */}
        <View style={{
          position: 'absolute', left: 0, right: 0, bottom: 2,
          flexDirection: 'row', gap: m.compact ? S[3] : S[5], justifyContent: 'center', alignItems: 'flex-end',
        }}>
          <View style={{ alignItems: 'center', gap: 3 }}>
            {/* Short form on a compact table rather than none: the plate is 12px
                tall, and a player who cannot tell the two stacks apart is the
                thing the label exists to prevent. */}
            <DeckLabel text={m.compact ? 'CLOSED' : 'CLOSED DECK'} />
            <Pile label={`${closedCount} left`} live={mustDraw && !pending} onPress={() => draw('closed')} back w={m.pileW} still={reduceMotion} />
          </View>
          <View style={{ alignItems: 'center', gap: 3 }}>
            <DeckLabel text={m.compact ? 'OPEN' : 'OPEN DECK'} />
          <DiscardPile
            card={openTop}
            live={mustDraw && !pending}
            armed={mustDiscard}
            w={m.pileW}
            onPress={() => draw('open')}
            onMeasure={z => { discardZone.current = z; }}
            still={reduceMotion}
          />
          </View>
          {wild ? (
            <View style={{ alignItems: 'center', gap: 3 }}>
              <CardFace card={wild} w={m.pileW} wild />
              <Text style={{ color: INK_ON_FELT, fontSize: 10, fontWeight: '700' }}>Wild</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* status strip — whose turn, the clock, and the hint's opinion */}
      <View style={{ height: 30, justifyContent: 'center', alignItems: 'center' }}>
        {reconnecting ? (
          <StatusPill tone="warn">
            <ActivityIndicator size="small" color="#ffdd72" />
            <Text style={{ color: '#ffdd72', fontSize: t.sm, fontWeight: '800' }}>
              Reconnecting — your hand is safe
            </Text>
          </StatusPill>
        ) : (
          <StatusPill tone={mine ? 'you' : 'plain'}>
            <Text numberOfLines={1} style={{ color: mine ? '#ffdd72' : '#cfe8d8', fontSize: t.sm, fontWeight: '800' }}>
              {!mine
                ? `${turnName} is playing`
                : mustDraw
                  ? 'Your turn — take a card'
                  : hint.valid ? 'Pick a card and declare' : 'Group, then discard one'}
            </Text>
            {secs != null && (
              <Text
                accessibilityLabel={`${secs} seconds left on this turn`}
                style={{ color: urgent ? '#ff8080' : INK_ON_FELT, fontSize: t.sm, fontWeight: '800' }}
              >
                {`⏱ ${secs}s`}
              </Text>
            )}
            <Text style={{ color: hint.valid ? '#5fe08c' : '#cfa0a0', fontSize: 11.5, fontWeight: '700' }}>
              {hint.valid ? '✓ valid'
                : !hint.hasPure ? 'no pure seq'
                : !hint.hasTwoSeq ? 'needs 2nd seq'
                : `${hint.fullCount} pts`}
            </Text>
          </StatusPill>
        )}
      </View>

      {/* the hand — each group is a drop target */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // CENTRED. flexGrow lets the content container fill the scroller even
        // when the hand is narrower than it, which is what justifyContent has
        // to push against — without it the hand pins to the left edge and sits
        // off-centre under a centred table. When the hand IS wider, flexGrow
        // changes nothing and it scrolls as before.
        contentContainerStyle={{
          gap: S[3], alignItems: 'flex-end', paddingHorizontal: S[1],
          flexGrow: 1, justifyContent: 'center',
        }}
        style={{ height: m.handH, flexGrow: 0 }}
      >
        {groups.map((g, gi) => (
          <GroupZone
            key={gi}
            index={gi}
            loose={gi === groups.length - 1}
            verdict={hint.groups[gi]}
            onMeasure={setZone}
            minW={m.cardW * 1.5}
            overlap={m.overlap}
          >
            {g.map(id => {
              const c = byId.get(id);
              return c ? (
                <HandCard
                  key={id}
                  card={c}
                  w={m.cardW}
                  selected={picked.includes(id)}
                  wild={isJoker(c)}
                  onPress={toggle}
                  onDrop={dropAt}
                />
              ) : null;
            })}
            {g.length === 0 && (
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, paddingHorizontal: S[2], paddingVertical: S[4] }}>
                Drop here
              </Text>
            )}
          </GroupZone>
        ))}
      </ScrollView>

      {/* actions — one row, comfortable targets, never over the cards.
          Below `TIGHT` the labels shorten rather than the row wrapping or the
          last button sliding off: Declare and Drop are the two that must always
          be reachable, so they are the two that never shrink. */}
      <View style={{ height: 46, flexDirection: 'row', gap: S[1], alignItems: 'center' }}>
        <Btn label={tight ? '⚡' : 'Sort'} icon={tight ? undefined : '⚡'} compact accessibilityLabel="Sort your hand" onPress={() => sortNow(sortMode === 'manual' ? 'suit' : sortMode)} />
        <Btn label={tight ? '⊞' : 'Group'} compact accessibilityLabel="Group the selected cards" onPress={() => { setGroups(g => groupUp(g, picked)); setPicked([]); playSfx('tick'); }} disabled={picked.length < 2} />
        <Btn label={tight ? '⊟' : 'Ungroup'} compact accessibilityLabel="Ungroup the selected cards" onPress={() => { setGroups(g => ungroup(g, picked)); setPicked([]); playSfx('tick'); }} disabled={picked.length === 0} />
        <View style={{ flex: 1 }} />
        {typeof me?.points === 'number' && !tight && (
          <Text style={{ color: INK_ON_FELT, fontSize: 12, fontWeight: '700', marginRight: S[1] }}>{`Score ${me.points}`}</Text>
        )}
        <Btn label="Discard" compact onPress={() => discard(picked[0])} disabled={!mustDiscard || picked.length !== 1 || !!pending} />
        <Btn label="✓ Declare" kind="good" compact onPress={() => setConfirmDeclare(true)} disabled={!mustDiscard || picked.length !== 1 || !!pending} />
        <Btn label="✕ Drop" kind="danger" compact onPress={() => act('drop', { t: 'drop' })} disabled={!mine || !!pending} />
      </View>

      <Toasts events={feed} />
      <Confetti show={!!finished && G.winnerId === state.you && !reduceMotion} />

      <ResultSheet
        visible={showResult}
        players={players}
        settlement={settlement}
        winnerId={G.winnerId}
        you={state.you}
        host={L.hostId === state.you}
        tableName={table?.name}
        onClose={() => setShowResult(false)}
        rematch={rematch}
        onShare={() => { void shareResult('rummy', G.winnerId === state.you); }}
        onLobby={() => { setShowResult(false); leaveTable(); }}
      />

      <VoiceSheet visible={voiceOpen} voice={voice} nameOf={nameOf} onClose={() => setVoiceOpen(false)} />
      <RulesSheet game="rummy" visible={showRules || firstRules.visible} onClose={() => { setShowRules(false); firstRules.close(); }} />

      <Sheet visible={confirmDeclare} title="Declare?" onClose={() => setConfirmDeclare(false)}>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>
          This ends the round. The table checks your hand — if the melds do not stand up, the round is scored against you.
        </Text>
        <Text style={{ color: hint.valid ? C.good : C.bad, fontSize: t.md, fontWeight: '800' }}>
          {hint.valid
            ? '✓ This looks like a winning hand.'
            : `✗ This does not look valid${hint.hasPure ? '' : ' — no pure sequence'}. Declaring now scores ${hint.fullCount} points against you.`}
        </Text>
        <Btn
          label={hint.valid ? 'Declare & win' : 'Declare anyway'}
          kind={hint.valid ? 'gold' : 'danger'}
          onPress={() => { setConfirmDeclare(false); declare(); }}
        />
      </Sheet>

      </View>

      <Sheet visible={showSettings} title="Table" onClose={() => setShowSettings(false)}>
        <SettingRow
          label="Sort"
          hint="How your hand is laid out"
          value={SORT_LABEL[sortMode]}
          onPress={() => {
            const next = SORT_MODES[(SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length];
            applySort(next);
          }}
        />
        <SettingRow label="Sound" value={sound ? 'On' : 'Off'} onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }} />
        <SettingRow label="Game rules" hint="How this table scores" value="Read" onPress={() => { setShowSettings(false); setShowRules(true); }} />
        <SettingRow label="Invite a friend" hint={seated ? `Code ${seated}` : 'Share this table'} value="Share" onPress={() => { setShowSettings(false); void openInvite('rummy', seated); }} />
        <SettingRow label="Leave table" hint="Drops you from this hand" value="Leave" onPress={() => { setShowSettings(false); act('drop', { t: 'drop' }); }} />
      </Sheet>
    </View>
  );
}

/* ── small hooks ────────────────────────────────────────────────────── */


/**
 * Honour the system's "reduce motion" setting.
 *
 * The spinning turn ring, the bobbing deck and the confetti are all decoration;
 * for a player who has asked the OS to stop animations they are a problem. The
 * game itself is unaffected.
 */
function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (alive) setOn(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', v => setOn(!!v));
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return on;
}

/* ── choosing a table ───────────────────────────────────────────────── */

/**
 * The seat list.
 *
 * Public tables come from the server (`{t:'lobby'}` → `{t:'tables'}`) with their
 * own names, stakes, seat counts and 2–6 player limits; nothing here invents a
 * table. Below them are the two ways to play someone specific: open a private
 * table with a fresh code, or type the code a friend sent.
 */
function TableSelect({
  tables, seating, failed, seatedId, onJoin, onBack, feed,
}: {
  tables: TableInfo[] | null;
  seating: boolean;
  failed: boolean;
  seatedId: string;
  onJoin: (id: string) => void;
  onBack: () => void;
  feed: string[];
}) {
  const t = useType();
  const [code, setCode] = useState('');
  const [record, setRecord] = useState<{ gamesPlayed: number; totalWon: number } | null>(null);

  // The only record the server exposes. There is no per-match history endpoint,
  // so this is played-and-won rather than a list of games — saying so beats an
  // empty "History" screen that never fills up.
  useEffect(() => {
    let alive = true;
    fetch('https://games.corefinite.com/api/me', { credentials: 'include' })
      .then(r => r.json())
      .then((d: any) => {
        if (!alive || !d?.ok) return;
        setRecord({ gamesPlayed: Number(d.gamesPlayed) || 0, totalWon: Number(d.totalWon) || 0 });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (seating) {
    return (
      <Center>
        <ActivityIndicator color={C.gold} />
        <Text style={{ color: C.muted, fontSize: t.md }}>Taking your seat at {seatedId}…</Text>
      </Center>
    );
  }

  if (failed) {
    return (
      <Center>
        <Text style={{ fontSize: 40 }}>🪑</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>No seat at “{seatedId}”</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center', lineHeight: 19 }}>
          The table did not answer. It may be full, finished, or the code may be wrong.
        </Text>
        <Btn label="Back to tables" kind="gold" onPress={onBack} />
      </Center>
    );
  }

  return (
    <TableBackground>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: S[4], gap: S[3], paddingBottom: S[6] }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>Rummy</Text>
          <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
            Thirteen cards, two decks, points scoring. The table deals, times every turn and judges every declaration — your cards are never sent to another player’s device.
          </Text>

          {record && (
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {`${record.gamesPlayed} deals played · ${record.totalWon} won`}
            </Text>
          )}

          <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800', marginTop: S[2] }}>Open tables</Text>
          {tables == null ? (
            <Panel style={{ alignItems: 'center', gap: S[2] }}>
              <ActivityIndicator color={C.gold} />
              <Text style={{ color: C.muted, fontSize: t.sm }}>Asking the server which tables are open…</Text>
            </Panel>
          ) : tables.length === 0 ? (
            <Panel>
              <Text style={{ color: C.muted, fontSize: t.sm }}>No public tables are open right now. Start a private one below.</Text>
            </Panel>
          ) : (
            tables.map(tb => <TableCard key={tb.id} table={tb} onJoin={() => onJoin(tb.id)} />)
          )}

          {/* Every surface that shows a stake says what it is staking. A number
              beside the word "stakes" reads as money unless it says otherwise. */}
          <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
            Stakes are in play coins. They are not money, cannot be bought, and cannot be cashed out.
          </Text>

          <Panel style={{ gap: S[3], marginTop: S[2] }}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Play your friends</Text>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 18 }}>
              Open a private table and send the code, or type one you were sent. Two to six players.
            </Text>
            <Btn label="Open a private table" icon="🔒" kind="gold" onPress={() => onJoin(newPrivateCode())} />
            <View style={{ flexDirection: 'row', gap: S[2] }}>
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder="Table code"
                placeholderTextColor={C.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Table code"
                onSubmitEditing={() => onJoin(code)}
                style={{
                  flex: 1, color: C.text, fontSize: t.md, paddingHorizontal: S[3], paddingVertical: S[3],
                  borderRadius: R[2], borderWidth: 1, borderColor: goldLine[18], backgroundColor: C.panel2,
                }}
              />
              <Btn label="Join" onPress={() => onJoin(code)} disabled={!normalizeCode(code)} />
            </View>
          </Panel>
        </ScrollView>
      </KeyboardAvoidingView>
      <Toasts events={feed} />
    </TableBackground>
  );
}

function TableCard({ table, onJoin }: { table: TableInfo; onJoin: () => void }) {
  const t = useType();
  const full = table.players >= table.maxPlayers;
  return (
    <Pressable
      onPress={full ? undefined : onJoin}
      disabled={full}
      accessibilityRole="button"
      accessibilityLabel={`${table.name}, ${table.stakes}, ${table.players} of ${table.maxPlayers} seated${full ? ', full' : ''}`}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3], padding: S[4],
        borderRadius: R[3], borderWidth: 1, borderColor: goldLine[22],
        backgroundColor: mix(C.panel, 92, '#ffffff'), opacity: full ? 0.55 : 1,
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>{table.name}</Text>
        <Text style={{ color: C.muted, fontSize: 12.5 }}>{table.stakes}</Text>
        <Text style={{ color: C.muted, fontSize: 12 }}>
          {`${table.players}/${table.maxPlayers} seated · ${table.status}`}
        </Text>
      </View>
      <Btn label={full ? 'Full' : 'Join'} kind={full ? 'secondary' : 'gold'} compact disabled={full} onPress={onJoin} />
    </Pressable>
  );
}

/* ── the waiting room ───────────────────────────────────────────────── */

/**
 * The lobby: who is here, and the controls only the host has.
 *
 * Bots are offered ONLY at a practice table. A staked table seating a bot would
 * be putting the house in the pot, which is why the server refuses it — and an
 * offer the server refuses reads to a player as a broken button.
 */
function Room({
  lobby, table, you, code, substituted, voice, voiceOpen, setVoiceOpen, onSend, onLeave, feed, notify,
}: {
  lobby: { status: string; hostId?: string; members: { vaultId: string; name: string; isBot?: boolean }[]; maxPlayers?: number };
  table?: { name?: string; stakes?: string; pointValue?: number };
  you: string;
  code: string;
  /** The server put us on one of ITS tables instead of the one we asked for. */
  substituted: boolean;
  voice: TableVoice;
  voiceOpen: boolean;
  setVoiceOpen: (v: boolean) => void;
  onSend: (m: any) => void;
  onLeave: () => void;
  feed: string[];
  notify: (m: string) => void;
}) {
  const t = useType();
  const insets = useSafeAreaInsets();
  const members = lobby.members ?? [];
  const host = lobby.hostId === you;
  const max = lobby.maxPlayers ?? 6;
  const full = members.length >= max;
  const empties = Math.max(0, max - members.length);
  const link = tableLink('rummy', code);

  /**
   * DEAL ON A FULL-ENOUGH TABLE, NOT A FULL ONE.
   *
   * A rummy table only ever dealt when the HOST tapped Deal. Two people could
   * sit at the same table indefinitely — which is exactly what "online rummy
   * does not work" looked like: both seated, neither able to start, because
   * seat one belonged to someone who had wandered off. Six players were never
   * required by the game; they were required by the button.
   *
   * So once there are two, the host's client deals itself after a minute, with
   * the count visible so nobody is surprised by it. Deal still works instantly
   * for anyone who does not want to wait, and the timer stands down the moment
   * the table drops back below two.
   */
  const canDeal = members.length >= 2;
  const [dealIn, setDealIn] = useState<number | null>(null);
  useEffect(() => {
    if (!host || !canDeal) { setDealIn(null); return; }
    setDealIn(AUTO_DEAL_SECS);
    const id = setInterval(() => {
      setDealIn(prev => {
        if (prev == null) return null;
        if (prev <= 1) { onSend({ t: 'start' }); return null; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [host, canDeal, members.length, onSend]);

  const copy = async () => {
    await Clipboard.setStringAsync(code).catch(() => {});
    notify('Table code copied.');
  };

  return (
    <TableBackground>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3], paddingBottom: insets.bottom + S[5] }}>
        <Text style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>{table?.name || 'Rummy table'}</Text>
        <Text style={{ color: C.muted, fontSize: t.sm }}>
          {[table?.stakes, `${members.length}/${max} seated`].filter(Boolean).join(' · ')}
        </Text>

        <Panel style={{ gap: S[2] }}>
          {members.map(mem => (
            <PlayerRow
              key={mem.vaultId}
              name={mem.name}
              tag={mem.vaultId === you ? 'you' : mem.isBot ? 'bot' : mem.vaultId === lobby.hostId ? 'host' : undefined}
            />
          ))}
          {Array.from({ length: empties }, (_, i) => (
            <Text key={`e${i}`} style={{ color: C.muted, fontSize: t.sm, opacity: 0.6, paddingVertical: S[2] }}>
              Empty seat
            </Text>
          ))}
          {full && <Text style={{ color: C.gold, fontSize: 12, fontWeight: '700' }}>Table full</Text>}
        </Panel>

        {/* A CODE NOBODY CAN JOIN IS WORSE THAN NO CODE.
            The server answers a join for a table it does not know by seating
            you at one of its own and saying nothing, so two people who share a
            code both end up alone on "Practice" — proven on two phones. When we
            can see that happened, say it, and do not offer a code to share. */}
        {substituted ? (
          <Panel style={{ gap: S[2] }}>
            <Text style={{ color: C.gold, fontSize: t.md, fontWeight: '800' }}>This is a public table</Text>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
              {`The table you asked for is not available on this server, so you are at ${table?.name || 'a public table'}. Anyone can join it from the table list — there is no private code to share for rummy.`}
            </Text>
            <Btn label="Back to tables" onPress={onLeave} />
          </Panel>
        ) : !!code && (
          <Panel style={{ gap: S[2] }}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Invite</Text>
            <Text selectable style={{ color: C.gold, fontSize: t.xl, fontWeight: '800', letterSpacing: 2 }}>{code}</Text>
            <View style={{ flexDirection: 'row', gap: S[2] }}>
              <Btn label="Copy code" icon="⧉" compact onPress={() => { void copy(); }} />
              <Btn label="Share link" icon="🔗" compact onPress={() => { void openInvite('rummy', code); }} disabled={!link} />
            </View>
          </Panel>
        )}

        <VoiceRow voice={voice} onExpand={() => setVoiceOpen(true)} />

        {host ? (
          <>
            {allowsBots(table) && (
              <Btn label="Add a bot" icon="🤖" onPress={() => onSend({ t: 'addbot' })} disabled={full} />
            )}
            <Btn
              label={dealIn != null ? `Deal now — starting in ${dealIn}s` : `Deal (${members.length})`}
              kind="gold"
              onPress={() => { setDealIn(null); onSend({ t: 'start' }); }}
              disabled={!canDeal}
            />
          </>
        ) : (
          <Text style={{ color: C.muted, fontSize: t.sm }}>Waiting for the host to deal…</Text>
        )}

        <Btn label="Leave table" onPress={onLeave} />
      </ScrollView>
      <Toasts events={feed} />
      <VoiceSheet
        visible={voiceOpen}
        voice={voice}
        nameOf={id => members.find(mem => mem.vaultId === id)?.name ?? id}
        onClose={() => setVoiceOpen(false)}
      />
    </TableBackground>
  );
}

/* ── the result ─────────────────────────────────────────────────────── */

/**
 * The round's standings and what it cost.
 *
 * Every number is the server's: `points` per player, and `settlement[id].delta`
 * for the coins. Ranking order is the server's winner first, then points
 * ascending, because points rummy scores DOWN.
 */
function ResultSheet({
  visible, players, settlement, winnerId, you, host, tableName, onClose, rematch, onShare, onLobby,
}: {
  visible: boolean;
  players: RummyPlayer[];
  settlement: Settlement;
  winnerId?: string | null;
  you: string;
  host: boolean;
  tableName?: string;
  onClose: () => void;
  rematch: Rematch;
  onShare: () => void;
  onLobby: () => void;
}) {
  const t = useType();
  const order = ranked(players, winnerId);
  const won = winnerId === you;
  const winner = players.find(p => pid(p) === winnerId);

  return (
    <Sheet visible={visible} title={tableName ? `${tableName} — result` : 'Result'} onClose={onClose}>
      <Banner
        text={won ? '🏆 You won this deal' : `${winner?.name ?? 'Someone'} won this deal`}
        tone={won ? 'win' : 'lose'}
      />

      <View style={{ gap: S[1] }}>
        <View style={{ flexDirection: 'row', paddingHorizontal: S[2] }}>
          <Text style={{ width: 26, color: C.muted, fontSize: 11, fontWeight: '700' }}>#</Text>
          <Text style={{ flex: 1, color: C.muted, fontSize: 11, fontWeight: '700' }}>Player</Text>
          <Text style={{ width: 54, textAlign: 'right', color: C.muted, fontSize: 11, fontWeight: '700' }}>Points</Text>
          <Text style={{ width: 66, textAlign: 'right', color: C.muted, fontSize: 11, fontWeight: '700' }}>Coins</Text>
        </View>
        {order.map((p, i) => {
          const isYou = pid(p) === you;
          const d = settlement[pid(p)]?.delta;
          return (
            <View
              key={pid(p)}
              accessibilityLabel={`${i + 1}. ${p.name}${isYou ? ', you' : ''}, ${p.points} points${d != null ? `, ${d} coins` : ''}`}
              style={{
                flexDirection: 'row', alignItems: 'center',
                paddingVertical: S[2], paddingHorizontal: S[2], borderRadius: R[2],
                backgroundColor: pid(p) === winnerId ? mix(C.gold, 16, C.panel2) : isYou ? C.panel2 : 'transparent',
                borderWidth: isYou ? 1 : 0, borderColor: goldLine[22],
              }}
            >
              <Text style={{ width: 26, color: C.text, fontSize: t.sm, fontWeight: '800' }}>{i + 1}</Text>
              <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: isYou ? '800' : '600' }}>
                {p.name}{isYou ? ' (you)' : ''}
              </Text>
              <Text style={{ width: 54, textAlign: 'right', color: C.text, fontSize: t.sm }}>{p.points ?? 0}</Text>
              <Text style={{ width: 66, textAlign: 'right', fontSize: t.sm, fontWeight: '700', color: d == null ? C.muted : d >= 0 ? C.good : C.bad }}>
                {d == null ? '—' : d >= 0 ? `+${d}` : `${d}`}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {`${activeCount(players)} of ${players.length} players were still in at the end. Coins are play coins — not money.`}
      </Text>

      <View style={{ flexDirection: 'row', gap: S[2] }}>
        {host
          ? <RematchBtn rm={rematch} label="Deal again" />
          : <Text style={{ flex: 1, color: C.muted, fontSize: t.sm, alignSelf: 'center' }}>Waiting for the host to deal again…</Text>}
        <Btn label="Share" icon="📣" compact onPress={onShare} />
      </View>
      <Btn label="Back to tables" onPress={onLobby} />
    </Sheet>
  );
}

/* ── rules ──────────────────────────────────────────────────────────── */

/* ── voice ──────────────────────────────────────────────────────────── */

const VOICE_LABEL: Record<string, string> = {
  off: 'Talk', asking: 'Mic…', connecting: 'Connecting…', live: 'Voice on',
  waiting: 'Waiting…', unavailable: 'No voice', error: 'Voice failed',
};

/**
 * The compact control that sits on the felt during play.
 *
 * Deliberately tiny and pinned to the table's chrome row, away from the cards
 * and the action bar: voice is a side channel and must never be something a
 * player hits while reaching for Discard. Everything else is one tap away in
 * the sheet.
 */
function VoicePill({ voice, onPress, still }: { voice: TableVoice; onPress: () => void; still: boolean }) {
  const live = voice.phase === 'live';
  const busy = voice.phase === 'connecting' || voice.phase === 'asking';
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (live && !voice.muted && !still) {
      pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 150 });
    }
    return () => cancelAnimation(pulse);
  }, [live, voice.muted, still, pulse]);

  const a = useAnimatedStyle(() => ({ opacity: 0.75 + pulse.value * 0.25 }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        live
          ? `Table voice, ${voice.participants.length} in the channel, ${voice.muted ? 'you are muted' : 'microphone live'}`
          : `Table voice, ${VOICE_LABEL[voice.phase] ?? voice.phase}`
      }
      hitSlop={6}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: S[2], paddingVertical: 5, borderRadius: R.pill,
        borderWidth: 1, borderColor: live ? goldLine[38] : 'rgba(255,255,255,0.22)',
        backgroundColor: 'rgba(4,26,14,0.6)',
      }}
    >
      {busy
        ? <ActivityIndicator size="small" color="#ffdd72" />
        : <Animated.Text style={[{ fontSize: 12 }, a]}>{live ? (voice.muted ? '🔇' : '🎙') : '🎤'}</Animated.Text>}
      <Text style={{ color: live ? '#5fe08c' : INK_ON_FELT, fontSize: 11, fontWeight: '800' }}>
        {live ? `${voice.participants.length}` : VOICE_LABEL[voice.phase] ?? ''}
      </Text>
    </Pressable>
  );
}

/** The lobby's roomier version of the same thing. */
function VoiceRow({ voice, onExpand }: { voice: TableVoice; onExpand: () => void }) {
  const t = useType();
  if (voice.phase === 'unavailable') {
    return <Text style={{ color: C.muted, fontSize: 12 }}>{voice.error ?? 'Voice is not available at this table.'}</Text>;
  }
  if (voice.phase === 'live' || voice.phase === 'waiting') {
    return (
      <Panel style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: voice.phase === 'live' ? C.good : C.gold }} />
        <Text style={{ flex: 1, color: C.text, fontSize: t.sm, fontWeight: '700' }}>
          {voice.phase === 'live' ? `Voice on · ${voice.participants.length}` : 'In voice — waiting for others'}
        </Text>
        <Btn label="Open" compact onPress={onExpand} />
      </Panel>
    );
  }
  return <Btn label="Talk at the table" icon="🎤" onPress={voice.join} />;
}

/* ── the felt ───────────────────────────────────────────────────────── */

/**
 * The table.
 *
 * A real card-room table is not a green rectangle: it is cloth stretched INTO a
 * frame, so the eye reads a recess — brass cap, wood under it, a bevel where
 * the cloth drops away, and light falling from above the far seats. Everything
 * here serves that one impression, because depth is what makes the piles look
 * like objects lying ON something rather than stickers floating over a colour.
 *
 * Cheap by construction: one Svg, six shapes, no blur filters (React Native has
 * no cheap gaussian) — the bevel and the vignette are gradients, not shadows.
 */
function TableTop({ width, height }: { width: number; height: number }) {
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(4, width / 2 - 2);
  const ry = Math.max(4, height / 2 - 2);
  // The rail is proportional, not a fixed 9px: on a small table a thick rail
  // eats the cloth, on a big one a thin one looks like a drawn line.
  const rail = Math.max(6, Math.min(18, Math.round(Math.min(rx, ry) * 0.055)));
  const irx = Math.max(2, rx - rail);
  const iry = Math.max(2, ry - rail);

  return (
    <Svg width={width} height={height} style={{ position: 'absolute' }} pointerEvents="none">
      <Defs>
        {/* Brass, lit from above: a hot cap at the top edge falling to a dark
            underside, which is what tells the eye the rail is round. */}
        <RadialGradient id="rtRail" cx="50%" cy="-10%" rx="75%" ry="110%">
          <Stop offset="0" stopColor="#FFE9A8" />
          <Stop offset="0.38" stopColor="#D9A93C" />
          <Stop offset="0.74" stopColor="#8A6416" />
          <Stop offset="1" stopColor="#4A330B" />
        </RadialGradient>
        {/* Walnut between brass and cloth — the part a player rests a hand on. */}
        <RadialGradient id="rtWood" cx="50%" cy="0%" rx="75%" ry="105%">
          <Stop offset="0" stopColor="#5C3A1E" />
          <Stop offset="1" stopColor="#2B1A0C" />
        </RadialGradient>
        {/* Cloth. The light sits high and slightly back, so the near edge —
            where the player's own hand is — falls into shadow and the middle of
            the table, where the piles are, is the brightest thing on screen. */}
        <RadialGradient id="rtCloth" cx="50%" cy="26%" rx="78%" ry="86%">
          <Stop offset="0" stopColor="#1E7A52" />
          <Stop offset="0.55" stopColor="#0C5236" />
          <Stop offset="1" stopColor="#052A1B" />
        </RadialGradient>
        {/* The drop where cloth meets frame: dark at the rim, gone by 12%. */}
        <RadialGradient id="rtBevel" cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0.86" stopColor="#000000" stopOpacity="0" />
          <Stop offset="1" stopColor="#000000" stopOpacity="0.55" />
        </RadialGradient>
      </Defs>

      <Ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#rtRail)" />
      <Ellipse cx={cx} cy={cy} rx={rx - rail * 0.42} ry={ry - rail * 0.42} fill="url(#rtWood)" />
      <Ellipse cx={cx} cy={cy} rx={irx} ry={iry} fill="url(#rtCloth)" />
      <Ellipse cx={cx} cy={cy} rx={irx} ry={iry} fill="url(#rtBevel)" />

      {/* A single bright hairline along the top of the cloth: the specular line
          every stretched surface has, and the cheapest way to say "taut". */}
      <Ellipse
        cx={cx} cy={cy} rx={irx} ry={iry}
        fill="none" stroke="#FFF8F1" strokeOpacity="0.16" strokeWidth="1.5"
      />

      {/* The house mark, printed into the cloth. Every real card-room table
          carries one and it is always nearly invisible — it sits UNDER the
          cards and must never compete with a rank pip. Low opacity and wide
          tracking do that; a logo you notice mid-hand is a logo in the way. */}
      <SvgText
        x={cx} y={cy - iry * 0.02}
        textAnchor="middle"
        fontSize={Math.max(14, Math.round(irx * 0.13))}
        fontWeight="800"
        fill="#FFF8F1"
        fillOpacity={0.075}
      >
        VAULTCHAT
      </SvgText>
      <SvgText
        x={cx} y={cy + Math.max(13, Math.round(irx * 0.105))}
        textAnchor="middle"
        fontSize={Math.max(9, Math.round(irx * 0.06))}
        fontWeight="700"
        fill="#D9A93C"
        fillOpacity={0.16}
      >
        RUMMY
      </SvgText>
    </Svg>
  );
}

/**
 * The surround behind the table.
 *
 * Deliberately NOT more felt: it is the dark of the room, so the lit table is
 * the only thing the eye lands on. A brass hairline at the very top keeps it
 * tied to the rail rather than reading as a separate black band.
 */
function Baize({ width, height }: { width: number; height: number }) {
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
      <Defs>
        {/* The room, matching C.bg — a near-black with maroon in it. The old
            surround was dark GREEN, which is why the table used to sit in a
            faintly different world from the rest of the games UI. */}
        <RadialGradient id="rbaize" cx="50%" cy="12%" rx="90%" ry="94%">
          <Stop offset="0" stopColor="#2A0C0E" />
          <Stop offset="0.55" stopColor="#1B0708" />
          <Stop offset="1" stopColor="#120405" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width={width} height={height} fill="url(#rbaize)" />
      {/* One gold hairline ties the surround to the rail. Kept thin and at low
          opacity: this is trim, not an accent, and the accent budget belongs to
          the primary action. */}
      <Rect x="0" y="0" width={width} height="1.5" fill={C.gold} opacity="0.4" />
    </Svg>
  );
}

/** Names a stack the way a table does — small caps on a dark plate. */
function DeckLabel({ text }: { text: string }) {
  return (
    <View style={{
      paddingHorizontal: S[2], paddingVertical: 2, borderRadius: R.pill,
      backgroundColor: 'rgba(18,4,5,0.75)', borderWidth: 1, borderColor: 'rgba(217,169,60,0.28)',
    }}>
      <Text style={{ color: '#FFF8F1', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 }}>{text}</Text>
    </View>
  );
}

function StatusPill({ tone, children }: { tone: 'plain' | 'you' | 'warn'; children: React.ReactNode }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: S[2],
        paddingHorizontal: S[3], paddingVertical: 3, borderRadius: R.pill,
        backgroundColor: 'rgba(4,26,14,0.62)',
        borderWidth: 1,
        borderColor: tone === 'you' ? goldLine[38] : tone === 'warn' ? '#a9791b' : 'rgba(255,255,255,0.12)',
        maxWidth: '96%',
      }}
    >
      {children}
    </View>
  );
}

function IconBtn({ glyph, label, onPress }: { glyph: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // 28dp drawn, so 8dp of slop left the target at 44 only on the diagonal.
      // The table header is deliberately small — it must not compete with the
      // felt — so the touch area is what grows: 28 + 2x8 = 44 exactly.
      hitSlop={8}
      style={{
        width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', backgroundColor: 'rgba(4,26,14,0.6)',
      }}
    >
      <Text style={{ color: INK_ON_FELT, fontSize: 14, fontWeight: '800' }}>{glyph}</Text>
    </Pressable>
  );
}

/* ── a drop zone ────────────────────────────────────────────────────── */

function GroupZone({
  index, loose, verdict, onMeasure, minW, overlap, children,
}: {
  index: number;
  loose: boolean;
  verdict?: { type: MeldType; label: string };
  onMeasure: (i: number, z: Zone) => void;
  minW: number;
  overlap: number;
  children: React.ReactNode;
}) {
  const ref = useRef<View>(null);
  return (
    <View
      ref={ref}
      // measureInWindow rather than the layout event's own x/y: the row sits
      // inside a horizontal ScrollView, so its parent-relative position says
      // nothing about where a finger actually lands on the glass. Re-fires on
      // every relayout, which is what keeps drop targets correct after a
      // rotation.
      onLayout={() => {
        ref.current?.measureInWindow((x, y, w, h) => onMeasure(index, { x, y, w, h }));
      }}
      accessibilityLabel={loose ? 'Ungrouped cards' : `Group ${index + 1}${verdict?.label ? `, ${verdict.label}` : ''}`}
      style={{
        minWidth: minW,
        borderRadius: R[2],
        borderWidth: 1,
        borderStyle: loose ? 'dashed' : 'solid',
        // Light trays, not dark ones. Cards are cream; a dark holder behind
        // them muddies the edges and the group stops reading as a unit — which
        // is the whole job of the tray.
        borderColor: loose ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.55)',
        backgroundColor: loose ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.16)',
        paddingHorizontal: S[2], paddingTop: S[1], paddingBottom: 2,
        gap: 2,
      }}
    >
      {/* Cards overlap into a fan the way a held hand does — five groups of
          three at full width do not fit any phone.

          THE TUCK IS A NEGATIVE MARGIN, NOT A NEGATIVE GAP. `gap` is a Yoga
          gutter and, exactly as in CSS, may not be negative: the value is
          invalid and resolves to 0. So a negative gutter silently discarded the
          fan that fanFor() had computed and the hand laid out fully spread
          whatever the maths chose. Measured on the Redmi in landscape: cards
          stepped 149px against a 148px card — no overlap at all — where the
          model believed it had tucked 30px per card, and the thirteenth card
          sat outside the scroller. The model was right; the render threw it
          away. marginLeft is honoured, so the fan now actually happens. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', minHeight: 10 }}>
        {React.Children.map(children, (child, i) =>
          i === 0 ? child : <View style={{ marginLeft: -overlap }}>{child}</View>,
        )}
      </View>
      <View style={{ height: 14, justifyContent: 'center' }}>
        <MeldBadge verdict={verdict} loose={loose} />
      </View>
    </View>
  );
}

/** The group badge. Colour carries the same meaning as the label. */
function MeldBadge({ verdict, loose }: { verdict?: { type: MeldType; label: string }; loose?: boolean }) {
  if (loose) return <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700' }}>Ungrouped</Text>;
  if (!verdict || verdict.type === 'empty' || !verdict.label) return null;
  const good = verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set';
  const color = verdict.type === 'pure' ? '#5fe08c' : good ? '#ffdd72' : '#ff8080';
  return (
    <Text style={{ color, fontSize: 10, fontWeight: '800' }}>
      {good ? '✓' : '✗'} {verdict.label}
    </Text>
  );
}

/* ── piles ──────────────────────────────────────────────────────────── */

function Pile({
  label: text, live, onPress, card, back, w, still,
}: { label: string; live: boolean; onPress: () => void; card?: Card | null; back?: boolean; w: number; still: boolean }) {
  const bob = useSharedValue(0);
  useEffect(() => {
    if (live && !still) {
      bob.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(bob);
      bob.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(bob);
  }, [live, still, bob]);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: -bob.value * 3 }] }));

  return (
    <Pressable
      onPress={live ? onPress : undefined}
      disabled={!live}
      accessibilityRole="button"
      accessibilityLabel={back ? `Closed deck, ${text}` : card ? `${spoken(card)}, ${text}` : text}
      style={{ alignItems: 'center', gap: 2 }}
    >
      <Animated.View style={a}>
        {back ? <CardBack live={live} w={w} /> : card ? <CardFace card={card} w={w} glow={live} /> : <EmptySlot w={w} />}
      </Animated.View>
      <Text style={{ color: INK_ON_FELT, fontSize: 10, fontWeight: '700' }}>{text}</Text>
    </Pressable>
  );
}

/**
 * The open pile — draw source, and the one place a card may be dragged OUT of
 * the hand.
 *
 * It publishes its window rect so the drag can hit-test against it. `armed`
 * (you owe a discard) is what turns the outline gold; a card dropped here at
 * any other time springs back with a reason rather than being thrown away.
 */
function DiscardPile({
  card, live, armed, w, onPress, onMeasure, still,
}: {
  card: Card | null;
  live: boolean;
  armed: boolean;
  w: number;
  onPress: () => void;
  onMeasure: (z: Zone) => void;
  still: boolean;
}) {
  const ref = useRef<View>(null);
  return (
    <View
      ref={ref}
      onLayout={() => { ref.current?.measureInWindow((x, y, wd, h) => onMeasure({ x, y, w: wd, h })); }}
      style={{
        borderRadius: R[2], padding: 3,
        borderWidth: armed ? 2 : 1,
        borderStyle: armed ? 'dashed' : 'solid',
        borderColor: armed ? '#f3c245' : 'transparent',
      }}
    >
      <Pile
        label={armed ? 'Drop to discard' : 'Open'}
        live={live}
        onPress={onPress}
        card={card}
        w={w}
        still={still}
      />
    </View>
  );
}

function CardBack({ live, w }: { live: boolean; w: number }) {
  const h = Math.round(w * 1.4);
  return (
    <View style={{
      width: w, height: h, borderRadius: 6, overflow: 'hidden',
      borderWidth: 1, borderColor: CARD_EDGE,
      boxShadow: live
        ? '0 0 0 2px #f3c245, 0 0 16px rgba(232,194,95,0.55), 0 4px 10px rgba(0,0,0,0.5)'
        : '0 3px 9px rgba(0,0,0,0.55)',
    }}>
      <Svg width={w} height={h}>
        <Rect x="0" y="0" width={w} height={h} fill="#a3163f" />
        {Array.from({ length: 18 }, (_, i) => (
          <Line key={i} x1={-h + i * 10} y1={h} x2={-h + i * 10 + h} y2={0} stroke="#86112f" strokeWidth="5" />
        ))}
        <Rect x="3" y="3" width={Math.max(1, w - 6)} height={Math.max(1, h - 6)} rx="4" fill="none" stroke="rgba(247,244,234,0.14)" strokeWidth="3" />
      </Svg>
    </View>
  );
}

function EmptySlot({ w }: { w: number }) {
  return (
    <View style={{
      width: w, height: Math.round(w * 1.4), borderRadius: 6,
      borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.35)',
    }} />
  );
}

function CardFace({ card, w, glow, wild }: { card: Card; w: number; glow?: boolean; wild?: boolean }) {
  const h = Math.round(w * 1.4);
  const joker = card.suit === 'JOKER';
  const color = joker ? JOKER_PURPLE : RED.has(card.suit) ? CARD_RED : CARD_INK;
  const idx = Math.round(w * 0.3);

  return (
    <View style={{
      width: w, height: h, borderRadius: 6,
      backgroundColor: joker ? '#f6efff' : CARD_FACE,
      borderWidth: 1, borderColor: wild ? '#f3c245' : CARD_EDGE,
      boxShadow: glow || wild
        ? '0 0 0 2px #f3c245, 0 3px 8px rgba(0,0,0,0.4)'
        : '0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.8)',
      overflow: 'hidden',
    }}>
      <Text style={{ position: 'absolute', top: 1, left: 3, fontSize: idx, lineHeight: idx * 1.1, fontWeight: '800', color }}>
        {joker ? '★' : card.rank}
      </Text>
      <Text style={{
        position: 'absolute', left: 0, right: 0, top: h / 2 - w * 0.3,
        textAlign: 'center', fontSize: w * 0.46, lineHeight: w * 0.6, color, opacity: 0.9,
      }}>
        {joker ? '★' : SUIT_GLYPH[card.suit]}
      </Text>
    </View>
  );
}

/* ── a draggable card ───────────────────────────────────────────────── */

/**
 * Tap to select, DRAG to re-group or to discard.
 *
 * Both gestures live on one card, which is why the pan needs a few pixels of
 * movement before it activates — without that threshold every tap becomes a
 * one-pixel drag and selection stops working entirely.
 *
 * The card springs home on release NO MATTER WHAT: its real position comes from
 * the new arrangement, so leaving it under the finger would double the move —
 * and it means an interrupted drag (a rotation, a backgrounded app) can never
 * strand a card off-screen.
 */
/**
 * MEMOISED. Each card owns four shared values, a Pan/Tap gesture pair and an
 * animated style, and rebuilding those is what re-rendering one of these costs
 * — thirteen times over, twice a second, because the turn clock sits at the top
 * of this screen and every tick re-rendered the whole hand to change one digit.
 *
 * `onPress` takes the card id rather than closing over it, which is the whole
 * reason the memo holds: `() => toggle(id)` would be a new function on every
 * render and defeat it. `toggle` and `dropAt` are already stable callbacks, and
 * `card` keeps its identity between server frames via the `byId` map.
 */
const HandCard = React.memo(function HandCard({
  card, w, selected, wild, onPress, onDrop,
}: {
  card: Card;
  w: number;
  selected: boolean;
  /** A printed joker, or a card of this round's wild rank. */
  wild: boolean;
  onPress: (cardId: string) => void;
  onDrop: (cardId: string, x: number, y: number) => void;
}) {
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const lift = useSharedValue(selected ? 1 : 0);
  const dragging = useSharedValue(0);

  useEffect(() => {
    lift.value = withSpring(selected ? 1 : 0, { damping: 15, stiffness: 260 });
  }, [selected, lift]);

  const pan = Gesture.Pan()
    .minDistance(8)
    .onStart(() => { dragging.value = 1; })
    .onUpdate(e => { dx.value = e.translationX; dy.value = e.translationY; })
    .onEnd(e => {
      runOnJS(onDrop)(card.id, e.absoluteX, e.absoluteY);
      dx.value = withSpring(0, { damping: 18, stiffness: 260 });
      dy.value = withSpring(0, { damping: 18, stiffness: 260 });
    })
    .onFinalize(() => {
      dragging.value = 0;
      // Belt and braces: a gesture cancelled by a rotation or a system dialog
      // never reaches onEnd, and without this the card would stay where the
      // finger left it.
      dx.value = withSpring(0, { damping: 18, stiffness: 260 });
      dy.value = withSpring(0, { damping: 18, stiffness: 260 });
    });

  const tap = Gesture.Tap().onEnd((_e, ok) => { if (ok) runOnJS(onPress)(card.id); });
  const composed = Gesture.Exclusive(pan, tap);

  const a = useAnimatedStyle(() => ({
    transform: [
      { translateX: dx.value },
      { translateY: dy.value - lift.value * 10 - dragging.value * 8 },
      { scale: 1 + dragging.value * 0.08 },
    ] as ViewStyle['transform'],
    zIndex: dragging.value ? 50 : 1,
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${spoken(card)}${wild ? ', joker' : ''}${selected ? ', selected' : ''}. Drag to move between groups, or onto the open pile to discard.`}
        style={[a, selected ? { borderRadius: 8, borderWidth: 2, borderColor: '#f3c245' } : null]}
      >
        {/* A joker is marked ON THE CARD, not only beside the deck. The wild
            indicator by the closed pile says which RANK is wild this round; it
            does not tell you which of your own thirteen cards are the wild
            ones, and a player who cannot see that discards one. Every
            reference client highlights them in the hand. */}
        <CardFace card={card} w={w} glow={selected} wild={wild} />
      </Animated.View>
    </GestureDetector>
  );
});

/* ── seats ──────────────────────────────────────────────────────────── */

/**
 * One opponent, placed by rummyTable.seatSpots.
 *
 * `status` is the server's — 'active' | 'won' | 'dropped' | 'lost' — and it is
 * what says whether this player is still in the hand. Reading a `dropped` flag
 * that the server does not send (as this screen used to) means a player who
 * dropped goes on looking like they are still holding cards.
 */
function Seat({
  spot, name, count, points, status, bot, turn, talking, still,
}: {
  spot?: { x: number; y: number; w: number };
  name: string;
  count: number;
  points?: number | null;
  status: string;
  bot: boolean;
  turn: boolean;
  talking: boolean;
  still: boolean;
}) {
  const spin = useSharedValue(0);
  useEffect(() => {
    if (turn && !still) {
      spin.value = withRepeat(withTiming(1, { duration: 3400, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(spin);
      spin.value = 0;
    }
    return () => cancelAnimation(spin);
  }, [turn, still, spin]);
  const a = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

  if (!spot) return null;
  const out = status !== 'active' && status !== 'won';
  const av = Math.max(26, Math.min(40, Math.round(spot.w * 0.5)));
  const initials = name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();

  const detail =
    status === 'won' ? 'WON'
    : status === 'dropped' ? 'dropped'
    : status === 'lost' ? `${points ?? 0} pts`
    : `${count} cards${points != null ? ` · ${points}` : ''}`;

  return (
    <View
      style={{ position: 'absolute', left: spot.x, top: spot.y, width: spot.w, alignItems: 'center', opacity: out ? 0.5 : 1 }}
      accessibilityLabel={`${name}, ${detail}${turn ? ', playing now' : ''}${talking ? ', talking' : ''}`}
    >
      <View style={{ width: av, height: av, borderRadius: av / 2, padding: 3, backgroundColor: '#0a1710', justifyContent: 'center' }}>
        {turn && (
          <Animated.View style={[{
            position: 'absolute', inset: 0, borderRadius: av / 2,
            borderWidth: 3, borderColor: '#f3c245', borderTopColor: '#ffdd72', borderBottomColor: '#a9791b',
          }, a]} />
        )}
        {talking && (
          <View style={{ position: 'absolute', inset: -3, borderRadius: av / 2 + 3, borderWidth: 2, borderColor: '#5fe08c' }} />
        )}
        <View style={{
          flex: 1, borderRadius: av / 2 - 3, alignItems: 'center', justifyContent: 'center',
          backgroundColor: bot ? '#6f9bff' : '#f3c245',
        }}>
          <Text style={{ color: '#2a1c00', fontWeight: '800', fontSize: Math.round(av * 0.36) }}>{bot ? '🤖' : initials}</Text>
        </View>
      </View>
      {/* Names were 10.5px on a felt seen at arm's length — smaller than the
          card pips and the first thing a player actually needs to read. */}
      <Text numberOfLines={1} style={{ color: '#fff', fontWeight: '800', fontSize: 14, marginTop: 2, maxWidth: spot.w }}>{name}</Text>
      <Text numberOfLines={1} style={{ color: INK_ON_FELT, fontSize: 12, maxWidth: spot.w }}>{detail}</Text>
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
