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
  ScrollView, Text, TextInput, View, useWindowDimensions,
  type LayoutChangeEvent, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, RadialGradient, Stop, Rect, Ellipse, Text as SvgText } from 'react-native-svg';
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
import { analyzeHand, MAX_LOSS, type MeldType } from '../../lib/games/meldHint';
import { openInvite, shareResult, tableLink } from '../../lib/games/invite';
import { useRummyMatch, type RummyMatch } from '../../lib/games/useRummyMatch';
import { VARIANTS, variantLabel, standings, progressLabel } from '../../lib/games/match';
import {
  metrics, seatSpots, pileTop, seatAvatar, seatHasDetail, SEAT_NAME_LINE, SEAT_DETAIL_LINE,
  ranked, activeCount, pid, allowsBots,
  normalizeCode, filterBySeats, filterByKind, pickTable,
  type RummyPlayer, type Settlement, type TableInfo, type SeatFilter, type KindFilter, type SeatIntent,
} from '../../lib/games/rummyTable';
import { C, S, R, T, mix, alpha, goldLine, white } from '../../lib/games/theme';
import {
  FELT, RAIL, WOOD, CARD, CARD_SHADOW, STAT, CYAN,
  INK as INK_ON_FELT, INK_DIM, onFelt, ROOM, ROOM_GLOW,
} from '../../lib/games/rummyGlass';

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
 * The cloth, the card stock and the ink on both now live in ONE place —
 * lib/games/rummyGlass.ts. They used to live here, and the cost of that is on
 * the record: a documented green -> teal swap never reached the gradient that
 * actually paints the table, because the gradient repeated the hexes instead of
 * reading them. The history of why the felt is the colour it is moved with the
 * values.
 */

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

/**
 * Clearance between the top of the oval and the first seat capsule.
 *
 * Small, because the header is its own band now — the seats no longer have to
 * dodge it, they only have to stay off the brass.
 */
const OVAL_SEAT_TOP = 6;

/** Shared empty hand: a fresh [] each render would re-run every memo below it. */
const NO_CARDS: Card[] = [];

/** A measured drop target, in window coordinates. */
type Zone = { x: number; y: number; w: number; h: number };

export default function Rummy({ tableId = '', auto, autoBot, seat }: { tableId?: string; seat?: SeatIntent } & AutoStart) {
  /* ── connection ──────────────────────────────────────────────────── */

  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const onServerMessage = useCallback((m: any) => {
    // `tables` arrives once on connect, before any lobby exists, so it never
    // shows up in a `state` frame — this is the only way to see it.
    if (m?.t === 'tables' && Array.isArray(m.tables)) setTables(m.tables as TableInfo[]);
  }, []);

  /**
   * The player chose "Bots" from the table list.
   *
   * Not a second implementation of anything: it feeds the SAME `auto`/`autoBot`
   * the hub already passes when it opens rummy against a bot, so seating,
   * asking for the bot and dealing all stay in useGameSocket where the
   * once-only latches live. All this flag does is turn that path on for a table
   * the player picked themselves instead of one the hub picked for them.
   */
  const [wantBot, setWantBot] = useState(false);

  const { phase, error, state, events, send, join, subscribe, retry } =
    useGameSocket('rummy', tableId, {
      auto: auto || wantBot,
      autoBot: autoBot || wantBot,
      onMessage: onServerMessage,
    });

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
    setWantBot(false);
    setSeated('');
    setTables(null);
    setSeating(false);
    setSeatFailed(false);
    retry('');            // '' = join nothing, so we land back on the table list
  }, [retry]);

  const takeSeat = useCallback((id: string, withBot = false) => {
    const code = normalizeCode(id);
    if (!code) return;
    setWantBot(withBot);
    setSeated(code);
    setSeating(true);
    setSeatFailed(false);
    join(code);
  }, [join]);

  // Seated the moment a lobby comes back for us. Until then the timeout above
  // is what turns an unanswered join into something the player can act on.
  useEffect(() => { if (L) { setSeating(false); setSeatFailed(false); } }, [L]);

  /**
   * SEAT AT A TABLE THE SERVER ACTUALLY OWNS.
   *
   * This is the fix for "online and private rummy both do not connect".
   *
   * Rummy tables belong to the server. The other three games create a room from
   * whatever id you send; rummy only knows the tables it published in
   * `{t:'tables'}`, and it does NOT reject an id it does not know — it silently
   * seats you at one of its own. So both ways of playing a human were dead:
   * "Play online" handed rummy the MATCHMAKER's roomId (a /live/ws room, never a
   * table) and "Private room" handed it a freshly minted code. Two people
   * sharing either were substituted independently and each sat alone at
   * "1/6 seated".
   *
   * So the hub no longer invents an id for rummy — it asks for an INTENT, and
   * the table is chosen here from the list the server just sent. Proven on two
   * phones: joining a real table id seats both players together, "2/6 seated".
   *
   * Runs once: `asked` latches so a table filling up mid-connect cannot bounce
   * the player between tables.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (!seat || asked.current || seated || !tables) return;
    asked.current = true;
    const t = pickTable(tables, seat);
    // No open table is a real answer, not a failure: the list stays on screen
    // with its "no tables" message rather than joining something that is full.
    if (t) takeSeat(t.id);
  }, [seat, seated, tables, takeSeat]);

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
  // MEASURED CONTAINER (§3). The window and the container may be different
  // coordinate systems: if this View is laid out edge-to-edge it is display-
  // width, while useWindowDimensions() reports the usable window. Sizing
  // children from one and centring them in the other is what produces a
  // constant offset. Guarded so onLayout -> setState -> layout cannot loop.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onBoxLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox(prev => (Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5)
      ? prev
      : { w: width, h: height });
  }, []);

  const sideInset = Math.max(insets.left, insets.right);
  const boxInsets = useMemo(
    () => ({ top: insets.top, bottom: insets.bottom, left: sideInset, right: sideInset }),
    [insets.top, insets.bottom, sideInset],
  );
  /**
   * Geometry comes from the MEASURED CONTAINER, and the inset is applied ONCE.
   *
   * Measured at runtime on the Redmi in landscape:
   *   BOX 851x393   SCR 851   WIN 823   INS 28/0
   *
   * BOX === SCR, so this container is laid out edge-to-edge at display width,
   * while useWindowDimensions() reports the window — which has ALREADY had the
   * 28dp system bar removed (823 = 851 - 28). Feeding that window width into
   * metrics(), which subtracts the inset again on both sides, took the same
   * inset off twice: 823 - 56 = 767. A 768dp child centred in an 851dp
   * container then sits (851-768)/2 = 41.5dp from the edge instead of 28 —
   * the 114px offset, exactly.
   *
   * Using the container width keeps one coordinate system: the inset is
   * subtracted once, symmetrically, so the table clears the system bar AND
   * lands with equal space either side on any display.
   */
  const m = useMemo(
    () => metrics({ width: box.w || win.width, height: box.h || win.height }, boxInsets),
    [box.w, box.h, win.width, win.height, boxInsets],
  );
  const t = useType();

  const reduceMotion = useReduceMotion();

  /**
   * RUMMY IS LANDSCAPE. ALL OF IT.
   *
   * It used to be landscape only while a hand was in play and portrait for the
   * table list and the lobby, which meant the device physically rotated twice
   * per game — once when the host dealt and once when the round ended — and
   * again for every rematch. A rotation is a full relayout and, on the Redmi,
   * about a second of black screen; doing it at the exact moment the cards
   * arrive is the worst possible time for it.
   *
   * So the lock is asserted ONCE on mount and held for as long as Rummy is on
   * screen. The lobby and the table list are laid out as a centred column
   * (see LandscapeScroll) rather than being allowed to rotate.
   *
   * Restoring on unmount is the part that matters, and it is not belt-and-
   * braces: the app is portrait-locked everywhere else, and an OS orientation
   * lock OUTLIVES the component — a force-stop skips this cleanup entirely and
   * leaks landscape into the next launch. That is the documented root cause of
   * the three other boards measuring 38px off-centre, which is why they each
   * assert usePortraitLock() on mount rather than trusting this line.
   */
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
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

  // Pool (101/201) and Deals (best-of-2/6): a score ACROSS deals, which the
  // games server's single-deal engine cannot keep. Null — and completely inert —
  // when no match is running or the backend has not shipped it.
  const rmatch = useRummyMatch(seated, raw, state.you);

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
  /**
   * WHAT THE SERVER WOULD HAVE TO CHANGE for our move to have landed.
   *
   * The lock used to clear on `raw` — i.e. on EVERY frame. The server sends a
   * full snapshot for anything that happens at the table, so somebody else's
   * draw, an emote, or a player toggling their microphone released the lock
   * while our own frame was still in flight, and the second tap it was there to
   * absorb went through after all.
   *
   * Every action this lock guards (draw, discard, declare, drop) moves at least
   * one of these: the cards we hold, whose turn it is, or the phase of the hand
   * — a drop passes the turn on, so it lands here too. Nothing ANOTHER player does at our table moves any of
   * them while it is still our turn — which it is, or the buttons would not
   * have been tappable. The 6s timeout below is still the backstop, and it is
   * what covers the one case this cannot see: a move the server REFUSED, which
   * by definition changes nothing.
   */
  const ack = `${G?.turnPlayerId ?? ''}|${G?.phase ?? ''}|${hand.length}|${hand.map(c => c.id).join(',')}`;
  useEffect(() => { setPending(null); }, [ack]);
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

  // SELECTION IS BY CARD ID, AND AN ID CAN OUTLIVE THE CARD.
  //
  // A selection made in one deal survived into the next: nothing cleared it
  // when a new hand arrived (the deal effect below resets `groups` and
  // `dealtFor` and never touched this), so you finished a hand with a card
  // selected — the usual case, since you were about to discard it — and after
  // the re-deal DISCARD lit up on `picked.length === 1`, sent a cardId you no
  // longer held, and came back as a bare "⚠" while the turn clock ran.
  //
  // Clearing it on a new deal would fix that one path and leave the others: the
  // server auto-discards for a player who times out, and a reconnect can hand
  // back a different hand entirely — both leave an id behind that names no card.
  // So the selection is FILTERED BY THE HAND on the way out instead. An id that
  // is not in `byId` is not a card you can act on, wherever it came from, and
  // every read below — the buttons, their enablement, discard, declare — goes
  // through the filtered value.
  const [pickedRaw, setPicked] = useState<string[]>([]);
  const [groups, setGroups] = useState<Groups>([[]]);
  const [sortMode, setSortMode] = useState<SortMode>(sortModePref);
  const byId = useMemo(() => new Map(hand.map(c => [c.id, c])), [hand]);
  const picked = useMemo(() => pickedRaw.filter(id => byId.has(id)), [pickedRaw, byId]);

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
  // ...and take the sheet away when the moment it asks about has passed, rather
  // than leaving a live "Declare & win" button over a turn that is no longer
  // yours. `declare` refuses it anyway; this is so the player is not invited to
  // press it.
  useEffect(() => { if (!mustDiscard) setConfirmDeclare(false); }, [mustDiscard]);
  const [showSettings, setShowSettings] = useState(false);
  const [showRules, setShowRules] = useState(false);
  // Offered once, before the first hand a player ever sees.
  const firstRules = useFirstTimeRules('rummy');
  const [showResult, setShowResult] = useState(false);
  const [showStandings, setShowStandings] = useState(false);
  const [showEmotes, setShowEmotes] = useState(false);
  /** Dim the cards that already meld, so the ones that do not are all you see. */
  const [showDeadwood, setShowDeadwood] = useState(false);
  /** Which kind of table the header tabs will ask the list for on the way out. */
  const [listKind, setListKind] = useState<KindFilter>('all');
  /** The kind the player picked in the header, pending "leave this table?". */
  const [confirmLeave, setConfirmLeave] = useState<KindFilter | null>(null);
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
    // The same guard `discard` opens with, and for a sharper reason: the
    // confirm sheet stays open across state changes, so the turn can pass (or
    // the server can auto-discard for you) while "Declare?" is on screen. The
    // button's `disabled` prop was the ONLY gate, and a sheet that is already
    // open does not re-read it — this was the one path in the UI that could
    // emit an action out of turn.
    if (!mustDiscard) { notify('It is not your turn.'); playSfx('error'); return; }
    if (picked.length !== 1) return;
    const laid = groups.map(g => g.filter(id => id !== picked[0])).filter(g => g.length > 0);
    act('declare', { t: 'declare', discardId: picked[0], groups: laid });
    setPicked([]);
  }, [mustDiscard, picked, groups, act, notify]);

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
      <TableBackground style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <Text style={{ fontSize: 46 }}>🂡</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>Can’t reach the table</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text>
        {/* `onPress={retry}` handed the press event straight in as `roomId`,
            and left `seating`/`seatFailed` set — so a retry could land on the
            stale "No seat at X" panel instead of the table, having asked the
            socket to rejoin whatever a GestureResponderEvent stringifies to.
            Rejoin the table we were actually at; '' means the table list. */}
        <Btn
          label="Try again"
          kind="gold"
          onPress={() => { setSeating(!!seated); setSeatFailed(false); retry(seated); }}
        />
      </TableBackground>
    );
  }

  if (phase !== 'connected' && !G) {
    return (
      <TableBackground style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <Text style={{ fontSize: 46 }}>🂡</Text>
        <ActivityIndicator color={C.gold} />
        <Text style={{ color: C.muted, fontSize: t.md }}>
          {phase === 'minting' ? 'Taking your seat…' : 'Reaching the table…'}
        </Text>
      </TableBackground>
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
        kind={listKind}
        onKind={setListKind}
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
        rmatch={rmatch}
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
  // The seat ring rides the drawn OVAL, not the felt frame. With side panels the
  // two differ by a third of the width, and seating against the frame would put
  // the outer capsules underneath the table panel and the emote feed.
  const spots = seatSpots(others.length, m.ovalW, m.ovalH, OVAL_SEAT_TOP);
  // The pile stack, measured the same way the felt places it: label plate, the
  // card, and the caption under it.
  const stackH = 14 + 3 + Math.round(m.pileW * 1.4) + 2 + 13;
  const pilesY = pileTop(m.ovalW, m.ovalH, spots, m.pileRowW, stackH);
  const turnName = players.find(p => pid(p) === G.turnPlayerId)?.name ?? 'Someone';
  const nameOf = (id: string) =>
    players.find(p => pid(p) === id)?.name
    ?? (L.members ?? []).find(mem => mem.vaultId === id)?.name
    ?? id;

  // Which of the header tabs is the table you are actually sitting at. `bots`
  // is never "current" — it is not a kind of table, it is a way of joining one.
  const kindNow: KindFilter = allowsBots(table) ? 'practice' : 'stakes';

  const statusText = !mine
    ? `${turnName} is playing`
    : mustDraw
      ? 'Your turn — take a card'
      : hint.valid ? 'Pick a card and declare' : 'Group, then discard one';

  return (
    <View style={{ flex: 1 }}>
      {/* Full-bleed: the room reaches under the notch and the gesture bar,
          because a green screen with grey margins looks broken. Only the
          CONTROLS are inset — see the padded box below. */}
      <Baize />

      <View
        onLayout={onBoxLayout}
        style={{
          flex: 1, alignItems: 'center',
          paddingTop: boxInsets.top, paddingBottom: boxInsets.bottom,
        }}>

      {/* ── the header bar ─────────────────────────────────────────── */}
      <View style={{
        height: m.headerH, width: m.tableW, flexDirection: 'row',
        alignItems: 'center', gap: S[2], paddingHorizontal: S[1],
      }}>
        <Wordmark />
        <KindTabs
          current={kindNow}
          onPick={k => {
            // Changing the kind of game means changing TABLE, and you cannot do
            // that from a seat — so this asks rather than silently forfeiting
            // the hand. The chosen kind is carried into the list so the player
            // lands on what they asked for.
            if (k === kindNow) return;
            setListKind(k);
            setConfirmLeave(k);
          }}
        />
        <View style={{ flex: 1 }} />
        <VoicePill voice={voice} onPress={() => setVoiceOpen(true)} still={reduceMotion} />
        <IconBtn glyph="?" label="Game rules" onPress={() => setShowRules(true)} />
        <IconBtn glyph="⚙" label="Table settings" onPress={() => setShowSettings(true)} />
      </View>

      {/* ── the felt ───────────────────────────────────────────────── */}
      <View style={{ height: m.tableH, width: m.tableW }}>
        {/* The oval is narrower than the band when there are side gutters. */}
        <View style={{ position: 'absolute', left: m.ovalX, top: m.ovalY, width: m.ovalW, height: m.ovalH }}>
          <TableTop width={m.ovalW} height={m.ovalH} />

          {others.map((p, i) => (
            <Seat
              key={pid(p)}
              spot={spots[i]}
              name={p.name}
              count={p.handCount ?? 0}
              points={typeof p.points === 'number' ? p.points : null}
              status={p.status}
              bot={!!(L.members ?? []).find(mem => mem.vaultId === pid(p))?.isBot}
              host={L.hostId === pid(p)}
              turn={G.turnPlayerId === pid(p)}
              secs={G.turnPlayerId === pid(p) ? secs : null}
              talking={voice.speaking.has(pid(p))}
              still={reduceMotion}
            />
          ))}

          {/* piles, on the cloth */}
          {/* AN EXPLICIT WIDTH, not `left:0 right:0` with centred content.
              pileTop has to know where this row begins and ends to tell which
              seats are over it, and a row whose width is whatever its contents
              measured is a width only the renderer knows. Each column is
              pileColW so the three are even and the label plates have a home. */}
          <View style={{
            position: 'absolute', left: Math.round((m.ovalW - m.pileRowW) / 2),
            width: m.pileRowW, top: pilesY,
            flexDirection: 'row', gap: m.compact ? S[3] : S[4],
            // Centred INSIDE the fixed width, because the wild column is
            // conditional: with no wild card the row holds two columns, and
            // they belong in the middle of the table rather than flush left.
            // pileRowW stays the three-column width, so the range pileTop
            // clears is always at least the range that renders.
            justifyContent: 'center', alignItems: 'flex-start',
          }}>
            <View style={{ width: m.pileColW, alignItems: 'center', gap: 3 }}>
              <DeckLabel text={m.compact ? 'CLOSED' : 'CLOSED DECK'} />
              <Pile label={`${closedCount} left`} live={mustDraw && !pending} onPress={() => draw('closed')} back w={m.pileW} still={reduceMotion} />
            </View>
            <View style={{ width: m.pileColW, alignItems: 'center', gap: 3 }}>
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
              <View style={{ width: m.pileColW, alignItems: 'center', gap: 3 }}>
                <DeckLabel text="WILD" />
                <CardFace card={wild} w={m.pileW} wild />
                <Text style={{ color: C.gold2, fontSize: 10, fontWeight: '800' }}>
                  {wild.suit === 'JOKER' ? 'joker' : `${wild.rank} is wild`}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Whose turn it is, floating at the foot of the cloth. It used to own
              a 30dp band of its own; the score panel now carries the numbers it
              was repeating, so it costs nothing but the pixels it covers. */}
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 4, alignItems: 'center' }}>
            {reconnecting ? (
              <StatusPill tone="warn">
                <ActivityIndicator size="small" color={C.gold2} />
                <Text style={{ color: C.gold2, fontSize: 11, fontWeight: '800' }}>
                  Reconnecting — your hand is safe
                </Text>
              </StatusPill>
            ) : (
              <StatusPill tone={mine ? 'you' : 'plain'}>
                <Text numberOfLines={1} style={{ flexShrink: 1, color: mine ? C.gold2 : '#cfe8d8', fontSize: 11, fontWeight: '800' }}>
                  {statusText}
                </Text>
                {secs != null && (
                  <Text
                    accessibilityLabel={`${secs} seconds left on this turn`}
                    style={{ color: urgent ? C.bad : INK_ON_FELT, fontSize: 11, fontWeight: '800' }}
                  >
                    {`⏱ ${secs}s`}
                  </Text>
                )}
              </StatusPill>
            )}
          </View>
        </View>

        {/* The two gutter panels. They exist only where there is room for them —
            below SIDE_PANEL_MIN_W the oval takes the whole width and the table's
            identity falls back to the header. */}
        {m.sidePanels && (
          <TablePanel
            name={table?.name}
            stakes={table?.stakes}
            seated={players.length}
            max={L.maxPlayers ?? 6}
            width={m.ovalX - S[2]}
          />
        )}
        {m.sidePanels && (
          <EmoteFeed
            feed={feed}
            width={m.ovalX - S[2]}
            left={m.ovalX + m.ovalW + S[1]}
            onOpen={() => setShowEmotes(true)}
          />
        )}
      </View>

      {/* ── the hand, and the score beside it ──────────────────────── */}
      <View style={{ height: m.handH, width: m.tableW, flexDirection: 'row', gap: S[3] }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            gap: S[3], alignItems: 'stretch', paddingHorizontal: S[1],
            flexGrow: 1, justifyContent: 'center',
          }}
          style={{ width: m.scoreW ? m.trayW : m.tableW, flexGrow: 0 }}
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
              height={m.handH}
            >
              {g.map(id => {
                const c = byId.get(id);
                if (!c) return null;
                // SHOW DEADWOOD dims what already melds so what does NOT is the
                // only thing lit. Purely local, over the hint's own verdict —
                // no server call, and it never gates an action.
                const melded = hint.groups[gi]?.type === 'pure'
                  || hint.groups[gi]?.type === 'impure'
                  || hint.groups[gi]?.type === 'set';
                return (
                  <HandCard
                    key={id}
                    card={c}
                    w={m.cardW}
                    selected={picked.includes(id)}
                    wild={isJoker(c)}
                    dimmed={showDeadwood && melded}
                    onPress={toggle}
                    onDrop={dropAt}
                  />
                );
              })}
              {g.length === 0 && (
                <Text style={{ color: white(0.55), fontSize: T.xs, paddingHorizontal: S[2], paddingVertical: S[4] }}>
                  Drop here
                </Text>
              )}
            </GroupZone>
          ))}
        </ScrollView>

        {m.scoreW > 0 && (
          <ScorePanel
            width={m.scoreW}
            meld={hint.melded}
            deadwood={Math.min(MAX_LOSS, hint.deadwood)}
            score={typeof me?.points === 'number' ? me.points : 0}
            onPress={() => { void playSfx('select'); setShowStandings(true); }}
          />
        )}
      </View>

      {/* ── actions ────────────────────────────────────────────────── */}
      <View style={{ height: 46, width: m.tableW, flexDirection: 'row', gap: S[1], alignItems: 'center', paddingHorizontal: S[1] }}>
        <ActionBtn w={m.barBtnW} glyph="↕" label="SORT" accessibilityLabel="Sort your hand" onPress={() => sortNow(sortMode === 'manual' ? 'suit' : sortMode)} />
        <ActionBtn w={m.barBtnW} glyph="▣" label="GROUP" accessibilityLabel="Group the selected cards" disabled={picked.length < 2} onPress={() => { setGroups(g => groupUp(g, picked)); setPicked([]); playSfx('tick'); }} />
        <ActionBtn w={m.barBtnW} glyph="⊖" label="UNGROUP" accessibilityLabel="Ungroup the selected cards" disabled={picked.length === 0} onPress={() => { setGroups(g => ungroup(g, picked)); setPicked([]); playSfx('tick'); }} />

        <View style={{ flex: 1 }} />

        {/* The score trio only comes back to the bar when the panel could not
            fit in the band — otherwise this row would say it twice — AND when
            the bar can afford it. Sweeping the Honor at 666dp found the bar
            running 680dp of controls into a 666dp screen with DROP pushed off
            the edge; `barTrio`/`barStandings`/`barToggle` are that budget. */}
        {m.barTrio && (
          <Pressable
            onPress={() => { void playSfx('select'); setShowStandings(true); }}
            accessibilityRole="button"
            accessibilityLabel="Standings — see every player's points"
            hitSlop={6}
            style={{ flexDirection: 'row', marginRight: S[1] }}
          >
            <Stat glyph="★" value={hint.melded} label="MELD" tone={STAT.meld} />
            <Stat glyph="♠" value={Math.min(MAX_LOSS, hint.deadwood)} label="DEADWOOD" tone={STAT.deadwood} rule />
            {typeof me?.points === 'number' && (
              <Stat glyph="◎" value={me.points} label="SCORE" tone={STAT.score} rule />
            )}
          </Pressable>
        )}
        {m.barStandings && (
          <ActionBtn w={m.barBtnW} glyph="★" label="SCORE" accessibilityLabel="Standings — see every player's points" onPress={() => { void playSfx('select'); setShowStandings(true); }} />
        )}

        {m.barToggle && (
          <ActionBtn
            glyph="◉"
            label={showDeadwood ? 'ALL CARDS' : 'SHOW DEADWOOD'}
            wide
            active={showDeadwood}
            accessibilityLabel={showDeadwood ? 'Show every card normally' : 'Highlight the cards that do not meld'}
            onPress={() => { setShowDeadwood(v => !v); playSfx('tick'); }}
          />
        )}

        <View style={{ width: S[2] }} />
        <ActionBtn w={m.barBtnW} glyph="🗑" label="DISCARD" tone="blue" disabled={!mustDiscard || picked.length !== 1 || !!pending} onPress={() => discard(picked[0])} />
        <ActionBtn w={m.barBtnW} glyph="✓" label="DECLARE" tone="good" disabled={!mustDiscard || picked.length !== 1 || !!pending} onPress={() => setConfirmDeclare(true)} />
        <ActionBtn w={m.barBtnW} glyph="⏻" label="DROP" tone="danger" disabled={!mine || !!pending} onPress={() => act('drop', { t: 'drop' })} />
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

      <StandingsSheet
        visible={showStandings}
        players={players}
        you={state.you}
        turnPlayerId={G.turnPlayerId}
        closedCount={closedCount}
        wildRank={G.wildRank}
        rmatch={rmatch}
        onClose={() => setShowStandings(false)}
      />

      <Sheet visible={!!confirmLeave} title="Leave this table?" onClose={() => setConfirmLeave(null)}>
        <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>
          {`You are seated at a hand in progress. Leaving drops you from it, and the round is scored against you. The table list will show ${confirmLeave === 'bots' ? 'tables you can play a bot at' : confirmLeave === 'practice' ? 'practice tables' : 'tables played for coins'}.`}
        </Text>
        <Btn
          label="Leave and find another table"
          kind="danger"
          onPress={() => { setConfirmLeave(null); leaveTable(); }}
        />
        <Btn label="Stay at this table" onPress={() => setConfirmLeave(null)} />
      </Sheet>

      {/* `emote{emoji}` is in the protocol and Ludo already ships it, so this is
          the same real intent, not a second chat system. */}
      <Sheet visible={showEmotes} title="Say something" onClose={() => setShowEmotes(false)}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S[2] }}>
          {['👍', '😂', '😮', '😢', '🔥', '👏', '🍀', '😎', '💀', '🤝'].map(e => (
            <Pressable
              key={e}
              onPress={() => { send({ t: 'emote', emoji: e }); playSfx('tick'); setShowEmotes(false); }}
              accessibilityRole="button"
              accessibilityLabel={`Send ${e}`}
              style={{
                width: 52, height: 52, borderRadius: R[2], alignItems: 'center', justifyContent: 'center',
                borderWidth: 1, borderColor: white(0.18), backgroundColor: white(0.08),
              }}
            >
              <Text style={{ fontSize: 24 }}>{e}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>

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
        {/* ALWAYS REACHABLE. The bar shows the standings as a three-cell
            readout, or one button, or — on a bar too narrow for a seventh
            control — not at all. A readout must not be gated on how wide the
            action row happens to be, so the sheet carries it unconditionally. */}
        <SettingRow
          label="Standings"
          hint="Every player's points, this deal"
          value="Show"
          onPress={() => { setShowSettings(false); setShowStandings(true); }}
        />
        <SettingRow label="Sound" value={sound ? 'On' : 'Off'} onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }} />
        <SettingRow label="Game rules" hint="How this table scores" value="Read" onPress={() => { setShowSettings(false); setShowRules(true); }} />
        <SettingRow label="Invite a friend" hint={seated ? `Code ${seated}` : 'Share this table'} value="Share" onPress={() => { setShowSettings(false); void openInvite('rummy', seated); }} />
        {/* TWO DIFFERENT THINGS, and they were one row that did the wrong one.
            It was labelled "Leave table" / "Leave" and sent `{t:'drop'}`, which
            forfeits the hand and leaves you sitting at the table watching it
            finish — you pay the drop points and you do not get up. Dropping is
            a MOVE (it is already on the action bar, in danger red, next to
            Discard); leaving is a navigation, and `leaveTable` is what every
            other exit on this screen uses. */}
        <SettingRow
          label="Drop this hand"
          hint="Forfeits the deal and scores drop points against you. You stay at the table."
          value="Drop"
          onPress={() => { setShowSettings(false); act('drop', { t: 'drop' }); }}
        />
        <SettingRow
          label="Leave table"
          hint="Back to the table list"
          value="Leave"
          onPress={() => { setShowSettings(false); leaveTable(); }}
        />
      </Sheet>
    </View>
  );
}

/* ── small hooks ────────────────────────────────────────────────────── */


/**
 * The lobby and the table list, laid out for the landscape screen they now
 * always sit on.
 *
 * Rummy locks landscape for its whole lifetime (see the lock on mount), so
 * these two scrollers no longer get a 390dp-wide portrait window — they get
 * 844, or 2264 on the Redmi. A list of table cards run edge to edge at that
 * width is a line of text a foot long, which is the reason the screens used to
 * rotate at all.
 *
 * So the content becomes a centred column with a real maximum measure. Nothing
 * about the layout inside it changes; it simply stops being as wide as the
 * device. The side padding takes the LARGER of the two insets on both edges —
 * in landscape the cutout is on one side only, and padding each edge by its own
 * inset centres the column 38px off the middle of the screen, which is the
 * defect this file already carries a long note about for the felt.
 */
const COLUMN_MAX = 680;

function useColumn() {
  const insets = useSafeAreaInsets();
  return useMemo(() => ({
    paddingHorizontal: Math.max(insets.left, insets.right, S[4]),
    paddingTop: insets.top + S[3],
    paddingBottom: insets.bottom + S[5],
    maxWidth: COLUMN_MAX,
    width: '100%' as const,
    alignSelf: 'center' as const,
  }), [insets.left, insets.right, insets.top, insets.bottom]);
}

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
 * The table-size filter.
 *
 * "Multi-player" is every table above two seats, NOT exactly six: the server
 * publishes a 2–6 range, so a filter pinned to 6 would hide 3-, 4- and 5-seat
 * tables and look like there were none open. The rule lives in
 * lib/games/rummyTable.ts; this is only its labelling.
 */
/**
 * The one rummy format this server plays.
 *
 * `docs/GAMES_PROTOCOL.md`: "There is no pool (101/201) and no deals variant on
 * this server: the wire protocol has no pool score, no elimination and no deal
 * count, and the engine only ever settles a single deal at a time." Pool and
 * Deals would be a crazzychat-side match layer over repeated deals — see
 * openspec/changes/rummy-variants. Until then, say which one this is.
 */
const VARIANT = 'Points rummy';

const SEAT_FILTERS: { mode: SeatFilter; label: string; a11y: string }[] = [
  { mode: 'all',      label: 'All tables',  a11y: 'Show all tables' },
  { mode: 'heads-up', label: '2 players',   a11y: 'Show head-to-head tables only' },
  { mode: 'multi',    label: 'Multiplayer', a11y: 'Show tables for three or more players' },
];

/**
 * Practice · Free · Bots — what kind of game the player is after.
 *
 * "Free" is the staked tab under its honest name: this server's stakes are PLAY
 * COINS, which cannot be bought and cannot be cashed out (the table list says
 * so in as many words), so calling the other tab "Cash" would be the one piece
 * of wording on this screen that is not true.
 *
 * Bots lists the same tables as Practice, and that is not a duplicate: only a
 * practice table accepts `addbot`, so the SET cannot differ. What differs is
 * what joining does — from Bots the client seats you and asks for a bot in the
 * same breath, so it is one tap from the list to a game against the computer.
 */
const KIND_FILTERS: { mode: KindFilter; label: string; a11y: string }[] = [
  { mode: 'all',      label: 'All',      a11y: 'Show every kind of table' },
  { mode: 'practice', label: 'Practice', a11y: 'Show practice tables, which cost no coins' },
  { mode: 'stakes',   label: 'Free',     a11y: 'Show tables played for play coins' },
  { mode: 'bots',     label: 'Bots',     a11y: 'Show tables you can play against a bot, and seat a bot when you join' },
];

/**
 * One segment of a filter row.
 *
 * Extracted because there are now two rows of these, and the copy that existed
 * carried a bug worth not duplicating: the SELECTED chip asked for
 * `goldLine[40]` and `goldLine[12]`, and goldLine only defines 14/18/22/28/38/55.
 * Both resolved to `undefined`, so the selected chip rendered with no border
 * colour and no fill and the only thing marking the selection was the text
 * weight. `noImplicitAny: false` in tsconfig is why the compiler never said so —
 * an out-of-range index on a plain object is silently `any`.
 */
function FilterChip({
  label, a11y, selected, onPress,
}: { label: string; a11y: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => { void playSfx('select'); onPress(); }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={a11y}
      hitSlop={8}
      style={{
        paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
        borderWidth: 1,
        borderColor: selected ? goldLine[38] : white(0.16),
        backgroundColor: selected ? alpha(C.gold, 0.12) : white(0.06),
      }}
    >
      <Text style={{
        color: selected ? C.gold : C.muted,
        fontSize: 12.5, fontWeight: selected ? '800' : '600',
      }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Pool and Deals: the score across deals.
 *
 * The games server plays one deal and knows nothing about a match around it, so
 * this panel is crazzychat's half — the running scoreboard, and the way to start
 * a match in the first place. It renders NOTHING at all when there is no match
 * and the table cannot host one, which is also exactly what happens while the
 * backend for it is undeployed.
 *
 * PRACTICE TABLES ONLY, and the reason is money, not preference: a staked table
 * settles coins on EVERY deal, but a pool's stake moves once at the end — so a
 * pool over a staked table charges a player per deal by the games server and
 * again per match. `allowsBots` already tests the same `pointValue === 0`
 * condition for a closely related reason.
 */
function MatchPanel({
  rmatch, table, you, host,
}: {
  rmatch: RummyMatch;
  table?: { name?: string; stakes?: string; pointValue?: number };
  you: string;
  host: boolean;
}) {
  const t = useType();
  const [picking, setPicking] = useState(false);
  const m = rmatch.match;
  const practice = allowsBots(table);

  // Nothing to show and nothing to offer.
  if (!m && (!practice || !host)) return null;

  if (!m) {
    return (
      <Panel style={{ gap: S[2] }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Pool & Deals</Text>
        {picking ? (
          <>
            {VARIANTS.map(v => (
              <Btn
                key={v.id}
                label={v.label}
                onPress={() => { void playSfx('select'); setPicking(false); rmatch.open(v.id, practice); }}
              />
            ))}
            <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
              {VARIANTS.map(v => `${v.label}: ${v.blurb}`).join('\n')}
            </Text>
            <Btn label="Not now" compact onPress={() => setPicking(false)} />
          </>
        ) : (
          <>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
              Play several deals as one match — knocked out at 101 or 201, or the
              best of 2 or 6 deals.
            </Text>
            <Btn label="Start a match" icon="bot" kind="gold" onPress={() => setPicking(true)} />
          </>
        )}
      </Panel>
    );
  }

  const rows = standings(m);
  const done = m.status === 'finished';
  const leader = rows[0];

  return (
    <Panel style={{ gap: S[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
        <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800', flex: 1 }}>
          {variantLabel(m.variant)}
        </Text>
        <Text style={{ color: C.muted, fontSize: 12 }}>{progressLabel(m)}</Text>
      </View>

      {rows.map(r => {
        const out = r.status === 'out';
        // A pool shows the total against the limit it is racing; a deals match
        // shows chips, which can be negative. Showing one as the other is how a
        // scoreboard reads as nonsense.
        const value = m.poolLimit > 0 ? `${r.points} / ${m.poolLimit}` : `${r.chips >= 0 ? '+' : ''}${r.chips}`;
        return (
          <View
            key={r.vaultId}
            accessibilityLabel={`${r.name}, ${value}${out ? ', out' : ''}`}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: S[2],
              paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
              backgroundColor: r.vaultId === you ? C.panel2 : 'transparent',
              opacity: out ? 0.5 : 1,
            }}
          >
            <Text style={{ color: C.text, fontSize: t.sm, fontWeight: '700', flex: 1 }} numberOfLines={1}>
              {r.name}{r.vaultId === you ? ' (you)' : ''}
            </Text>
            {out && (
              <Text style={{ color: C.muted, fontSize: 11, fontWeight: '800' }}>OUT</Text>
            )}
            <Text style={{ color: out ? C.muted : C.gold, fontSize: t.sm, fontWeight: '800' }}>
              {value}
            </Text>
          </View>
        );
      })}

      {done ? (
        <Text style={{ color: C.gold, fontSize: t.sm, fontWeight: '800' }}>
          {leader ? `${leader.name} wins the match.` : 'Match over.'}
        </Text>
      ) : (
        <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
          {m.poolLimit > 0
            ? `Deal again to play the next round. Out at ${m.poolLimit}.`
            : 'Deal again to play the next round.'}
        </Text>
      )}
    </Panel>
  );
}

/**
 * The seat list.
 *
 * Public tables come from the server (`{t:'lobby'}` → `{t:'tables'}`) with their
 * own names, stakes, seat counts and 2–6 player limits; nothing here invents a
 * table. Below them are the two ways to play someone specific: open a private
 * table with a fresh code, or type the code a friend sent.
 */
function TableSelect({
  tables, seating, failed, seatedId, onJoin, onBack, feed, kind, onKind,
}: {
  tables: TableInfo[] | null;
  seating: boolean;
  failed: boolean;
  seatedId: string;
  onJoin: (id: string, withBot?: boolean) => void;
  onBack: () => void;
  feed: string[];
  /** Lifted, so the table header's Practice/Free/Bots tabs can pre-set it. */
  kind: KindFilter;
  onKind: (k: KindFilter) => void;
}) {
  const t = useType();
  const column = useColumn();
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [seats, setSeats] = useState<SeatFilter>('all');
  const setKind = onKind;
  // Both filters compose; neither is allowed to be the only one that applies.
  const shown = useMemo(
    () => filterBySeats(filterByKind(tables ?? [], kind), seats),
    [tables, kind, seats],
  );
  /**
   * Join by a typed code — CHECKED AGAINST THE SERVER'S OWN LIST FIRST.
   *
   * The server does not refuse an id it does not know; it seats you at Practice
   * and says nothing. So a typo, a stale invite, or a code from one of the
   * other three games used to look like it worked, right up until you noticed
   * you were somewhere else on your own. The table list is already on screen —
   * matching against it costs nothing and turns a silent wrong seat into a
   * sentence. Matched on name as well as id, because the invite text and the
   * table card both say "Casual" while the id is lower-case.
   */
  const tryCode = useCallback(() => {
    const want = normalizeCode(code);
    if (!want) return;
    const hit = (tables ?? []).find(tb =>
      tb.id.toLowerCase() === want.toLowerCase() || tb.name.toLowerCase() === want.toLowerCase());
    if (!hit) {
      setCodeErr(`There is no rummy table called "${want}". Rummy has ${(tables ?? []).map(tb => tb.name).join(', ') || 'no open tables right now'}.`);
      return;
    }
    if (hit.players >= hit.maxPlayers) { setCodeErr(`${hit.name} is full (${hit.players}/${hit.maxPlayers}).`); return; }
    setCodeErr('');
    onJoin(hit.id);
  }, [code, tables, onJoin]);

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
      <TableBackground style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <ActivityIndicator color={C.gold} />
        <Text style={{ color: C.muted, fontSize: t.md }}>Taking your seat at {seatedId}…</Text>
      </TableBackground>
    );
  }

  if (failed) {
    return (
      <TableBackground style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
        <Text style={{ fontSize: 40 }}>🪑</Text>
        <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>No seat at “{seatedId}”</Text>
        <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center', lineHeight: 19 }}>
          {/* NOT "the code may be wrong" any more. A typed code is now checked
              against the server's own table list before we ever try to sit
              down, so by the time we are waiting, the table is real. Naming a
              cause that cannot apply sends the player off to re-read an invite
              that was fine. What is left is the table, or the connection. */}
          The table did not answer. It may be full or finished, or the connection may have dropped.
        </Text>
        <Btn label="Back to tables" kind="gold" onPress={onBack} />
      </TableBackground>
    );
  }

  return (
    <TableBackground>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[column, { gap: S[3] }]}
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

          {/* HEAD-TO-HEAD OR A FULL TABLE IS A CHOICE, NOT A SEARCH.
              The server has always sent maxPlayers per table and the list has
              always rendered it as text — so wanting a 2-player game meant
              reading every card looking for one. */}
          {!!tables?.length && (
            <View style={{ gap: S[2] }}>
              {/* WHAT KIND OF GAME, then HOW MANY SEATS. Two rows rather than
                  one: they are independent questions and a single row of seven
                  chips reads as one list where picking two looks contradictory. */}
              <View style={{ flexDirection: 'row', gap: S[2], flexWrap: 'wrap' }}>
                {KIND_FILTERS.map(f => (
                  <FilterChip
                    key={f.mode}
                    label={f.label}
                    a11y={f.a11y}
                    selected={kind === f.mode}
                    onPress={() => setKind(f.mode)}
                  />
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: S[2], flexWrap: 'wrap' }}>
                {SEAT_FILTERS.map(f => (
                  <FilterChip
                    key={f.mode}
                    label={f.label}
                    a11y={f.a11y}
                    selected={seats === f.mode}
                    onPress={() => setSeats(f.mode)}
                  />
                ))}
              </View>
            </View>
          )}

          {tables == null ? (
            <Panel style={{ alignItems: 'center', gap: S[2] }}>
              <ActivityIndicator color={C.gold} />
              <Text style={{ color: C.muted, fontSize: t.sm }}>Asking the server which tables are open…</Text>
            </Panel>
          ) : tables.length === 0 ? (
            <Panel>
              <Text style={{ color: C.muted, fontSize: t.sm }}>No public tables are open right now. Start a private one below.</Text>
            </Panel>
          ) : shown.length === 0 ? (
            /* A FILTER THAT EMPTIES THE LIST MUST SAY SO. Rendering nothing here
               is indistinguishable from "the server has no tables", and the way
               out — clearing the filter — would be invisible. */
            <Panel style={{ gap: S[2] }}>
              <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 19 }}>
                {/* Name the filter that emptied the list. Saying "no
                    head-to-head tables" while the KIND filter is what hid them
                    sends the player to fix the wrong control. */}
                {kind !== 'all'
                  ? kind === 'bots'
                    ? 'No table that accepts a bot is open right now.'
                    : kind === 'practice'
                      ? 'No practice tables are open right now.'
                      : 'No coin tables are open right now.'
                  : seats === 'heads-up'
                    ? 'No head-to-head tables are open right now.'
                    : 'No multi-player tables are open right now.'}
              </Text>
              <Btn label="Show every table" compact onPress={() => { setKind('all'); setSeats('all'); }} />
            </Panel>
          ) : (
            shown.map(tb => (
              <TableCard
                key={tb.id}
                table={tb}
                // From the Bots tab, joining seats you AND asks for a bot — the
                // whole point of the tab, since the table set is the same.
                onJoin={() => onJoin(tb.id, kind === 'bots')}
              />
            ))
          )}

          {/* Every surface that shows a stake says what it is staking. A number
              beside the word "stakes" reads as money unless it says otherwise. */}
          <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
            Stakes are in play coins. They are not money, cannot be bought, and cannot be cashed out.
          </Text>

          {/* PLAYING A FRIEND, described as it actually works.
              ────────────────────────────────────────────────────────────────
              This used to offer "Open a private table", which minted a code
              like 2YR7QG and joined it. There is no such thing on this server
              and there never was. Probed live: rummy publishes exactly three
              GLOBAL tables — Practice, Casual, Pro — and a join carrying any
              other id is not refused, it is silently answered with a seat at
              Practice. Two friends who shared a minted code were each put at
              Practice on their own, both reading "1/6 seated", which is exactly
              the "private rummy does not connect" report. Extra fields on the
              join (private, password, maxPlayers, name) are ignored, and every
              invented verb — create, createTable, private, invite, host, room,
              new — is dropped without an answer. It is a server feature that
              does not exist, so the button was a promise the app could not keep
              and the table screen had to apologise for afterwards.
              The three tables seat six, so a friend CAN join you — you simply
              cannot keep strangers out. That is what this now says. */}
          <Panel style={{ gap: S[3], marginTop: S[2] }}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>Play your friends</Text>
            <Text style={{ color: C.muted, fontSize: t.sm, lineHeight: 18 }}>
              Rummy tables are shared — take a seat at one above, then send your friends the
              invite from the table menu and they will land at the same table. Six seats each,
              first come first served.
            </Text>
            <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
              There are no private rummy tables on this server. Chess, Ludo and Tic-tac-toe do
              have them.
            </Text>
            <View style={{ flexDirection: 'row', gap: S[2] }}>
              <TextInput
                value={code}
                onChangeText={txt => { setCode(txt); setCodeErr(''); }}
                placeholder="Table name or code"
                placeholderTextColor={C.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Table name or code from an invite"
                onSubmitEditing={() => tryCode()}
                style={{
                  flex: 1, color: C.text, fontSize: t.md, paddingHorizontal: S[3], paddingVertical: S[3],
                  borderRadius: R[2], borderWidth: 1,
                  borderColor: codeErr ? C.bad : goldLine[18], backgroundColor: C.panel2,
                }}
              />
              <Btn label="Join" onPress={() => tryCode()} disabled={!normalizeCode(code)} />
            </View>
            {!!codeErr && (
              <Text style={{ color: C.bad, fontSize: t.sm, lineHeight: 18 }}>{codeErr}</Text>
            )}
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
        borderRadius: R[3], borderWidth: 1, borderColor: white(0.16),
        // The table list sits on the ROOM, so this is light glass — the same
        // card the games hub uses. Only the pills that live on the felt go dark.
        backgroundColor: white(0.075), opacity: full ? 0.55 : 1,
        boxShadow: `inset 0 1px 0 ${white(0.18)}`,
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>{table.name}</Text>
        <Text style={{ color: C.muted, fontSize: T.sm }}>{table.stakes}</Text>
        {/* NAME THE VARIANT, even though there is only one.
            Rummy has three well-known formats (Points, Pool 101/201, Deals),
            and this server plays only Points — the wire protocol carries no
            pool score, no elimination and no deal count. A player arriving from
            another rummy app assumes a format unless told, and finding out from
            the scoreboard reads as the app getting the rules wrong. */}
        <Text style={{ color: C.muted, fontSize: 12 }}>
          {`${VARIANT} · ${table.players}/${table.maxPlayers} seated · ${table.status}`}
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
  lobby, table, you, code, substituted, voice, voiceOpen, setVoiceOpen, onSend, onLeave, feed, notify, rmatch,
}: {
  rmatch: RummyMatch;
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
  const column = useColumn();
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
      // TICK, AND NOTHING ELSE. The `start` used to be sent from inside this
      // updater, which is two bugs in one line: React may invoke an updater
      // twice for the same tick (it does in StrictMode), so a dev build dealt
      // the table twice; and a state updater that talks to a socket runs
      // wherever React decides to run it, which is not somewhere a network send
      // belongs. The updater now only counts, and the effect below reacts to it
      // reaching zero.
      setDealIn(prev => (prev == null ? null : prev - 1));
    }, 1000);
    return () => clearInterval(id);
    // members.length is DELIBERATELY not a dependency. It was, and it meant the
    // countdown restarted at sixty every time anyone joined or left — a table
    // that people drift in and out of never reached zero and never dealt, which
    // is the failure this timer exists to prevent. `canDeal` is the part that
    // actually matters (did we cross two players), and it is here.
  }, [host, canDeal]);

  // Zero is the deal. Separate from the tick so the send happens in an effect,
  // once, after the state that triggered it has actually committed.
  useEffect(() => {
    if (dealIn !== 0) return;
    setDealIn(null);
    onSend({ t: 'start' });
  }, [dealIn, onSend]);

  /**
   * ONE LOBBY ACTION AT A TIME — the same lock the action bar already puts on a
   * turn (`act`/`pending` on the board), which these two buttons never had.
   *
   * `start` and `addbot` are both answered by a new snapshot rather than an ack,
   * so a double-tap sent two frames and the server replied to the second with an
   * error the player did nothing to earn: two bots seated from one tap, or
   * "already started". Cleared by the snapshot that arrives — and by a timeout,
   * so a dropped frame cannot wedge the buttons the way it could wedge the bar.
   */
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [members.length, lobby.status]);
  useEffect(() => {
    if (!busy) return;
    const id = setTimeout(() => setBusy(false), 6000);
    return () => clearTimeout(id);
  }, [busy]);
  const addBot = useCallback(() => { setBusy(true); onSend({ t: 'addbot' }); }, [onSend]);
  const dealNow = useCallback(() => { setBusy(true); setDealIn(null); onSend({ t: 'start' }); }, [onSend]);

  const copy = async () => {
    await Clipboard.setStringAsync(code).catch(() => {});
    notify('Table code copied.');
  };

  return (
    <TableBackground>
      <ScrollView contentContainerStyle={[column, { gap: S[3] }]}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: t.xl, fontWeight: '800' }}>{table?.name || 'Rummy table'}</Text>
        <Text style={{ color: C.muted, fontSize: t.sm }}>
          {[VARIANT, table?.stakes, `${members.length}/${max} seated`].filter(Boolean).join(' · ')}
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
              <Btn label="Copy code" icon="copy" compact onPress={() => { void copy(); }} />
              <Btn label="Share link" icon="link" compact onPress={() => { void openInvite('rummy', code); }} disabled={!link} />
            </View>
          </Panel>
        )}

        <MatchPanel rmatch={rmatch} table={table} you={you} host={host} />

        <VoiceRow voice={voice} onExpand={() => setVoiceOpen(true)} />

        {host ? (
          <>
            {allowsBots(table) && (
              <Btn label="Add a bot" icon="bot" onPress={addBot} disabled={full || busy} />
            )}
            <Btn
              label={dealIn != null ? `Deal now — starting in ${dealIn}s` : `Deal (${members.length})`}
              kind="gold"
              onPress={dealNow}
              disabled={!canDeal || busy}
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
          <Text style={{ width: 26, color: C.muted, fontSize: T.xs, fontWeight: '700' }}>#</Text>
          <Text style={{ flex: 1, color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Player</Text>
          <Text style={{ width: 54, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Points</Text>
          <Text style={{ width: 66, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Coins</Text>
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
              {/* A zero delta says nothing happened, not that something GOOD
                  happened - `>= 0` put it in the same green "+0" branch as a
                  real win. Ties to the history list's own detailOf fix. */}
              <Text style={{ width: 66, textAlign: 'right', fontSize: t.sm, fontWeight: '700', color: d == null || d === 0 ? C.muted : d > 0 ? C.good : C.bad }}>
                {d == null ? '—' : d === 0 ? '0' : d > 0 ? `+${d}` : `${d}`}
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
        <Btn label="Share" icon="share" compact onPress={onShare} />
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
      hitSlop={9}
      style={[
        // Teal glass when the channel is live, navy when it is not — the same
        // two-family rule as every other surface on the felt, from
        // lib/games/rummyGlass.ts rather than written out here. This pill used
        // to carry its own rgba(4,26,14): a green-black mixed for a felt the
        // table stopped using two restyles ago, which is exactly the drift one
        // source of colour exists to stop.
        onFelt(live ? 'teal' : 'navy', { radius: R.pill, active: live }),
        {
          flexDirection: 'row', alignItems: 'center', gap: 4,
          paddingHorizontal: S[2], paddingVertical: 4,
        },
      ]}
    >
      {busy
        ? <ActivityIndicator size="small" color={C.gold2} />
        : <Animated.View style={a}>
            {/* Was three emoji in one expression. `mic-off` / `mic` / `mic-outline`
                say the same three states in the family every other control uses,
                and unlike an emoji they take the pill's own colour. */}
            <Ionicons
              name={live ? (voice.muted ? 'mic-off' : 'mic') : 'mic-outline'}
              size={13}
              color={live ? (voice.muted ? C.bad : C.good) : C.gold2}
            />
          </Animated.View>}
      <Text style={{ color: live ? CYAN : INK_ON_FELT, fontSize: T.xs, fontWeight: '800' }}>
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
  return <Btn label="Talk at the table" icon="mic" onPress={voice.join} />;
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
          <Stop offset="0" stopColor={RAIL[0]} />
          <Stop offset="0.38" stopColor={RAIL[1]} />
          <Stop offset="0.74" stopColor={RAIL[2]} />
          <Stop offset="1" stopColor={RAIL[3]} />
        </RadialGradient>
        {/* Walnut between brass and cloth — the part a player rests a hand on. */}
        <RadialGradient id="rtWood" cx="50%" cy="0%" rx="75%" ry="105%">
          <Stop offset="0" stopColor={WOOD[0]} />
          <Stop offset="1" stopColor={WOOD[1]} />
        </RadialGradient>
        {/* Cloth. The light sits high and slightly back, so the near edge —
            where the player's own hand is — falls into shadow and the middle of
            the table, where the piles are, is the brightest thing on screen.
            Reads FELT (above) rather than repeating its three hexes here — this
            was still the old GREEN, the documented "TEAL rather than wine" swap
            had never actually reached the gradient that paints the table. */}
        <RadialGradient id="rtCloth" cx="50%" cy="26%" rx="78%" ry="86%">
          <Stop offset="0" stopColor={FELT[0]} />
          <Stop offset="0.55" stopColor={FELT[1]} />
          <Stop offset="1" stopColor={FELT[2]} />
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
        fill="none" stroke={CYAN} strokeOpacity="0.22" strokeWidth="1.5"
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
        CRAZZYCHAT
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
/**
 * AUTO-FIT, not window-sized.
 *
 * This took `win.width`/`win.height` and painted itself at WINDOW size while
 * everything else on the table measures its own container. Those two are not
 * the same number — this file's own notes record a container of 851 against a
 * window of 823 — so the cloth fell short of the box it is meant to fill and
 * left an unpainted strip at one edge, which on a full-bleed surface reads as
 * the table being broken.
 *
 * `absoluteFill` plus percentage rects means it is sized BY its parent instead
 * of guessing at it: no window read, no orientation special case, and it stays
 * correct through a rotation without recomputing anything. Same pattern
 * TableBackground already uses in ui.tsx.
 */
function Baize() {
  return (
    <Svg style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
      <Defs>
        {/* The room. Warm, and lit from two sides — see ROOM/ROOM_GLOW. It was a
            flat maroon near-black, which left the cloth as the only lit thing on
            screen and the brass rail with nothing to catch. */}
        <RadialGradient id="rbaize" cx="50%" cy="18%" rx="95%" ry="100%">
          <Stop offset="0" stopColor={ROOM[0]} />
          <Stop offset="0.5" stopColor={ROOM[1]} />
          <Stop offset="1" stopColor={ROOM[2]} />
        </RadialGradient>
        {ROOM_GLOW.map((g, i) => (
          <RadialGradient key={i} id={`rglow${i}`} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
            <Stop offset="0" stopColor={g.color} stopOpacity={g.opacity} />
            <Stop offset="1" stopColor={g.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#rbaize)" />
      {ROOM_GLOW.map((_, i) => (
        <Rect key={i} x="0" y="0" width="100%" height="100%" fill={`url(#rglow${i})`} />
      ))}
      {/* One gold hairline ties the surround to the rail. Kept thin and at low
          opacity: this is trim, not an accent, and the accent budget belongs to
          the primary action. */}
      <Rect x="0" y="0" width="100%" height="1.5" fill={C.gold} opacity="0.4" />
    </Svg>
  );
}

/** Names a stack the way a table does — small caps on a dark plate. */
function DeckLabel({ text }: { text: string }) {
  return (
    <View style={[onFelt('navy', { radius: R.pill, lift: 0 }), { paddingHorizontal: S[2], paddingVertical: 2 }]}>
      <Text style={{ color: INK_ON_FELT, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 }}>{text}</Text>
    </View>
  );
}

/**
 * SCORE — the standings, mid-hand.
 *
 * Every number here is the server's and is already on the wire every frame:
 * `players[].points`, `.handCount`, `.status`, plus `closedCount` and the
 * round's wild rank. Nothing is computed, nothing is remembered between frames.
 *
 * It exists because the table could only ever be read at the END of a round.
 * `ResultSheet` shows the settlement once the hand is over and `MatchPanel`
 * lives in the lobby, so a player halfway through a deal had no way to answer
 * "who is winning" — the one question the whole game is about. In points rummy
 * that matters more than in most: the score runs DOWN, and whether to drop is a
 * decision you make against everyone else's totals.
 *
 * Ordered by `ranked`, the same function the result sheet uses, so the standing
 * a player watches during the hand is the standing they see at the end of it.
 */
function StandingsSheet({
  visible, players, you, turnPlayerId, closedCount, wildRank, rmatch, onClose,
}: {
  visible: boolean;
  players: RummyPlayer[];
  you: string;
  turnPlayerId?: string | null;
  closedCount: number;
  wildRank?: string | null;
  rmatch: RummyMatch;
  onClose: () => void;
}) {
  const ty = useType();
  const order = ranked(players, null);
  const match = rmatch.match;
  const rows = match ? standings(match) : [];

  return (
    <Sheet visible={visible} title="Standings" onClose={onClose}>
      <View style={{ flexDirection: 'row', paddingHorizontal: S[2] }}>
        <Text style={{ flex: 1, color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Player</Text>
        <Text style={{ width: 58, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Cards</Text>
        <Text style={{ width: 58, textAlign: 'right', color: C.muted, fontSize: T.xs, fontWeight: '700' }}>Points</Text>
      </View>

      {order.map(p => {
        const isYou = pid(p) === you;
        const out = p.status !== 'active' && p.status !== 'won';
        return (
          <View
            key={pid(p)}
            accessibilityLabel={`${p.name}${isYou ? ', you' : ''}, ${p.handCount ?? 0} cards, ${p.points ?? 0} points${out ? `, ${p.status}` : ''}`}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: S[2],
              paddingVertical: S[2], paddingHorizontal: S[2], borderRadius: R[2],
              backgroundColor: isYou ? C.panel2 : 'transparent',
              borderWidth: isYou ? 1 : 0, borderColor: goldLine[22],
              opacity: out ? 0.55 : 1,
            }}
          >
            <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: ty.sm, fontWeight: isYou ? '800' : '600' }}>
              {p.name}{isYou ? ' (you)' : ''}
              {pid(p) === turnPlayerId ? ' ·' : ''}
            </Text>
            {out
              ? <Text style={{ width: 58, textAlign: 'right', color: C.muted, fontSize: 11, fontWeight: '800' }}>{p.status}</Text>
              : <Text style={{ width: 58, textAlign: 'right', color: C.text, fontSize: ty.sm }}>{p.handCount ?? 0}</Text>}
            <Text style={{ width: 58, textAlign: 'right', color: C.gold, fontSize: ty.sm, fontWeight: '800' }}>{p.points ?? 0}</Text>
          </View>
        );
      })}

      <Text style={{ color: C.muted, fontSize: 11.5, lineHeight: 17 }}>
        {`Points rummy scores down — the winner takes 0 and everyone else carries their deadwood. ${closedCount} cards left in the deck${wildRank ? ` · ${wildRank} is wild` : ''}.`}
      </Text>

      {/* The match across deals, when one is running. Same rows the lobby's
          panel shows — a pool score is not visible anywhere else mid-hand. */}
      {match && rows.length > 0 && (
        <>
          <Text style={{ color: C.text, fontSize: ty.md, fontWeight: '800', marginTop: S[2] }}>
            {variantLabel(match.variant)}
          </Text>
          {rows.map(r => (
            <View
              key={r.vaultId}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: S[2],
                paddingVertical: S[2], paddingHorizontal: S[3], borderRadius: R[2],
                backgroundColor: r.vaultId === you ? C.panel2 : 'transparent',
                opacity: r.status === 'out' ? 0.5 : 1,
              }}
            >
              <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: ty.sm, fontWeight: '700' }}>
                {r.name}{r.vaultId === you ? ' (you)' : ''}
              </Text>
              {r.status === 'out' && <Text style={{ color: C.muted, fontSize: 11, fontWeight: '800' }}>OUT</Text>}
              <Text style={{ color: C.gold, fontSize: ty.sm, fontWeight: '800' }}>
                {match.poolLimit > 0 ? `${r.points} / ${match.poolLimit}` : `${r.chips >= 0 ? '+' : ''}${r.chips}`}
              </Text>
            </View>
          ))}
          <Text style={{ color: C.muted, fontSize: 11.5 }}>{progressLabel(match)}</Text>
        </>
      )}
    </Sheet>
  );
}

/** The house mark. Small, and the only branding on the screen. */
function Wordmark() {
  return (
    <View style={[onFelt('navy', { radius: 9 }), { paddingHorizontal: S[2], paddingVertical: 2, alignItems: 'center' }]}>
      <Text style={{ color: C.gold2, fontSize: 8, lineHeight: 9 }}>♛</Text>
      <Text style={{ color: INK_ON_FELT, fontSize: 10, fontWeight: '800', letterSpacing: 1 }}>RUMMY</Text>
      <Text style={{ color: C.gold, opacity: 0.8, fontSize: 5.5, fontWeight: '800', letterSpacing: 0.9 }}>PLAY SMART</Text>
    </View>
  );
}

/**
 * Practice · Free · Bots, at the table.
 *
 * These CANNOT switch table by themselves — you are sitting at a hand, and the
 * protocol has no way to move a seated player. So the tab that is not current
 * asks to leave, and carries the choice into the table list. A tab that
 * silently forfeited the round would be worse than no tab at all.
 */
function KindTabs({ current, onPick }: { current: KindFilter; onPick: (k: KindFilter) => void }) {
  const tabs: { k: KindFilter; label: string }[] = [
    { k: 'practice', label: 'Practice' },
    { k: 'stakes', label: 'Free' },
    { k: 'bots', label: 'Bots' },
  ];
  return (
    <View style={[onFelt('navy', { radius: R.pill, lift: 0 }), { flexDirection: 'row', padding: 2 }]}>
      {tabs.map(t => {
        const on = t.k === current;
        return (
          <Pressable
            key={t.k}
            onPress={() => { void playSfx('select'); onPick(t.k); }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={on ? `${t.label} table — you are here` : `Leave and find a ${t.label} table`}
            hitSlop={6}
            style={{
              paddingHorizontal: S[3], paddingVertical: 3, borderRadius: R.pill,
              borderWidth: 1, borderColor: on ? goldLine[38] : 'transparent',
              backgroundColor: on ? alpha(C.gold, 0.14) : 'transparent',
            }}
          >
            <Text style={{ color: on ? C.gold2 : INK_DIM, fontSize: 10.5, fontWeight: on ? '800' : '600' }}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The table, in the three facts a player actually asks for.
 *
 * Every one is the server's: the table's own name and stakes string, and the
 * seat count from `players`. Nothing here is computed or guessed.
 */
function TablePanel({
  name, stakes, seated, max, width,
}: { name?: string; stakes?: string; seated: number; max: number; width: number }) {
  const rows: [string, string][] = [
    ['Table:', name || 'Rummy'],
    ['Players:', `${seated} / ${max}`],
    ['Stakes:', stakes || '—'],
  ];
  return (
    <View style={[
      onFelt('navy', { radius: 14, lift: 2 }),
      { position: 'absolute', left: S[1], top: '28%', width: Math.max(88, width), padding: S[2], gap: 5 },
    ]}>
      {rows.map(([k, v]) => (
        <View key={k}>
          <Text style={{ color: INK_DIM, fontSize: 7.5, fontWeight: '800', letterSpacing: 0.4 }}>{k}</Text>
          <Text numberOfLines={1} style={{ color: INK_ON_FELT, fontSize: 11, fontWeight: '800' }}>{v}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The last thing anyone said, and the way to say something back.
 *
 * The bubbles are the tail of the SAME feed the toasts render — server events
 * and this screen's own refusals — so nothing is stored twice and nothing is
 * invented. The button opens the emote sheet, which sends `emote{emoji}`.
 */
function EmoteFeed({
  feed, width, left, onOpen,
}: { feed: string[]; width: number; left: number; onOpen: () => void }) {
  const last = feed.slice(-2);
  return (
    <View style={[
      onFelt('navy', { radius: 14, lift: 2 }),
      { position: 'absolute', left, top: '34%', width: Math.max(88, width), padding: S[2], gap: 4 },
    ]}>
      {last.length === 0 ? (
        <Text style={{ color: INK_DIM, fontSize: 9.5 }}>Say hello</Text>
      ) : last.map((msg, i) => (
        <View key={i} style={{ borderRadius: 10, paddingHorizontal: S[2], paddingVertical: 3, backgroundColor: white(0.10) }}>
          <Text numberOfLines={2} style={{ color: INK_ON_FELT, fontSize: 9 }}>{msg}</Text>
        </View>
      ))}
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="Say something"
        hitSlop={8}
        style={{ alignSelf: 'flex-end', paddingHorizontal: S[2], paddingVertical: 2, borderRadius: R.pill, backgroundColor: white(0.12) }}
      >
        <Text style={{ color: INK_ON_FELT, fontSize: 9, fontWeight: '800' }}>•••</Text>
      </Pressable>
    </View>
  );
}

/**
 * MELD · DEADWOOD · SCORE, at full size beside the hand.
 *
 * This is what let the turn/status strip give up its 30dp band: the numbers it
 * used to repeat are permanently on screen here instead. Pressing it opens the
 * standings, so the readout and the control are the same object.
 */
function ScorePanel({
  width, meld, deadwood, score, onPress,
}: { width: number; meld: number; deadwood: number; score: number; onPress: () => void }) {
  const cells: [string, number, string, string][] = [
    ['★', meld, 'MELD POINTS', STAT.meld],
    ['♠', deadwood, 'DEADWOOD', STAT.deadwood],
    ['◎', score, 'SCORE', STAT.score],
  ];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Standings. Meld ${meld}, deadwood ${deadwood}, score ${score}`}
      // A COLUMN of three rows, not a row of three columns — see SCORE_MIN_W.
      style={[
        onFelt('navy', { radius: 13 }),
        { width, flexDirection: 'column' },
      ]}
    >
      {cells.map(([glyph, value, label, tone], i) => (
        <View key={label} style={{
          flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: S[2], gap: S[1],
          borderTopWidth: i ? 1 : 0, borderTopColor: white(0.10),
        }}>
          <Text style={{ color: tone, fontSize: 12 }}>{glyph}</Text>
          <Text style={{ color: tone, fontSize: 17, fontWeight: '800' }}>{value}</Text>
          <View style={{ flex: 1 }} />
          <Text numberOfLines={1} style={{ color: tone, opacity: 0.8, fontSize: 6.5, fontWeight: '800', letterSpacing: 0.4 }}>{label}</Text>
        </View>
      ))}
    </Pressable>
  );
}

/**
 * One action: a glyph over its name.
 *
 * The three decisions are coloured and the utilities are not, because Declare
 * and Drop sit inches apart and one wins the hand while the other forfeits it.
 */
function ActionBtn({
  glyph, label, onPress, disabled, tone, wide, active, w, accessibilityLabel,
}: {
  glyph: string;
  label: string;
  /** Mandatory controls take a computed width so the row can never overflow. */
  w?: number;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'blue' | 'good' | 'danger';
  wide?: boolean;
  active?: boolean;
  accessibilityLabel?: string;
}) {
  const ink = tone === 'good' ? '#F2FFF7' : tone === 'danger' ? '#FFF1F2' : tone === 'blue' ? '#F0F8FF' : INK_ON_FELT;
  const surface = tone === 'good' ? onFelt('emerald', { radius: 11, active: true })
    : tone === 'danger' ? onFelt('danger', { radius: 11, active: true })
    : tone === 'blue' ? onFelt('blue', { radius: 11, active: true })
    : onFelt('navy', { radius: 11, active: !!active });
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[surface, {
        height: 36, width: wide ? undefined : w, minWidth: wide ? 118 : (w ?? 62),
        paddingHorizontal: w && w < 56 ? 2 : S[2],
        alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1,
      }]}
    >
      <Text style={{ color: ink, fontSize: 11 }}>{glyph}</Text>
      <Text numberOfLines={1} style={{ color: ink, fontSize: 7.5, fontWeight: '800', letterSpacing: 0.5 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * One cell of the score readout.
 *
 * Colour carries the meaning before the label does — gold is what you have
 * built, red is what it will cost you, cyan is the server's score — so the
 * three are never interchangeable and the values live in rummyGlass.STAT
 * rather than being written at each call site.
 */
function Stat({
  glyph, value, label, tone, rule,
}: { glyph: string; value: number; label: string; tone: string; rule?: boolean }) {
  return (
    <View
      accessibilityLabel={`${label.toLowerCase()} ${value}`}
      style={{
        paddingHorizontal: S[2], alignItems: 'center', justifyContent: 'center',
        borderLeftWidth: rule ? 1 : 0, borderLeftColor: white(0.14),
      }}
    >
      <Text style={{ color: tone, fontSize: 12.5, fontWeight: '800' }}>{`${glyph} ${value}`}</Text>
      <Text style={{ color: tone, opacity: 0.7, fontSize: 6.5, fontWeight: '800', letterSpacing: 0.5 }}>{label}</Text>
    </View>
  );
}

function StatusPill({ tone, children }: { tone: 'plain' | 'you' | 'warn'; children: React.ReactNode }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        // Gold glass when it is YOUR turn, plain navy when it is not: the pill
        // is the one place the table says whether it is waiting on you, so the
        // surface itself carries that rather than only the words on it.
        onFelt(tone === 'plain' ? 'navy' : 'gold', { radius: R.pill, lift: 2, active: tone !== 'plain' }),
        {
          flexDirection: 'row', alignItems: 'center', gap: S[2],
          paddingHorizontal: S[3], paddingVertical: 3, maxWidth: '96%',
        },
      ]}
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
      // 26dp drawn, so 9dp of slop left the target at 44 only on the diagonal.
      // The table header is deliberately small — it must not compete with the
      // felt — so the touch area is what grows: 26 + 2x9 = 44 exactly.
      hitSlop={9}
      style={[
        onFelt('navy', { radius: 13 }),
        { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
      ]}
    >
      <Text style={{ color: INK_ON_FELT, fontSize: 13, fontWeight: '800' }}>{glyph}</Text>
    </Pressable>
  );
}

/* ── a drop zone ────────────────────────────────────────────────────── */

function GroupZone({
  index, loose, verdict, onMeasure, minW, overlap, height, children,
}: {
  index: number;
  loose: boolean;
  verdict?: { type: MeldType; label: string };
  onMeasure: (i: number, z: Zone) => void;
  minW: number;
  overlap: number;
  /** The band's full height, so every tray is the same height as its siblings. */
  height: number;
  children: React.ReactNode;
}) {
  // NAME ON TOP. The verdict used to be a badge under the cards and nothing
  // else, so reading the hand meant decoding thirteen ranks — the one thing a
  // glance should not have to do. "SEQUENCE" over the cards is what a player
  // actually scans for; the points underneath are the consequence.
  const good = verdict && (verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set');
  const tone = loose ? white(0.75) : verdict?.type === 'pure' ? C.good : good ? C.gold2 : C.bad;
  const title = loose ? 'UNGROUPED'
    : verdict?.type === 'pure' ? 'SEQUENCE'
    : verdict?.type === 'impure' ? 'SEQUENCE'
    : verdict?.type === 'set' ? 'SET'
    : verdict?.type === 'invalid' ? 'GROUP' : '';
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
        height,
        justifyContent: 'space-between',
        borderRadius: R[2],
        borderWidth: 1,
        borderStyle: loose ? 'dashed' : 'solid',
        // LIGHT trays, not dark ones, and this is the one place on the felt
        // that breaks the dark-glass rule on purpose: cards are cream, and a
        // dark holder behind cream muddies their edges until the group stops
        // reading as a unit — which is the whole job of the tray. A valid meld
        // takes a green edge, so the badge under it is a confirmation rather
        // than the only signal.
        borderColor: loose ? white(0.35)
          : verdict && (verdict.type === 'pure' || verdict.type === 'impure' || verdict.type === 'set')
            ? 'rgba(99,230,160,0.55)'
            : white(0.55),
        backgroundColor: loose ? white(0.06) : white(0.16),
        boxShadow: `inset 0 1px 0 ${white(0.22)}`,
        paddingHorizontal: S[2], paddingTop: S[1], paddingBottom: 2,
        gap: 2,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: tone, fontSize: 7.5, fontWeight: '800', letterSpacing: 1, textAlign: 'center' }}
      >{title}</Text>

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
  const color = verdict.type === 'pure' ? '#5fe08c' : good ? C.gold2 : '#ff8080';
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
        borderColor: armed ? C.gold : 'transparent',
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
      borderWidth: 1, borderColor: CARD.edge,
      boxShadow: live
        ? `0 0 0 2px ${C.gold}, 0 0 16px rgba(232,194,95,0.55), 0 4px 10px rgba(0,0,0,0.5)`
        : '0 3px 9px rgba(0,0,0,0.55)',
    }}>
      <Svg width={w} height={h}>
        <Defs>
          <RadialGradient id="cardback" cx="50%" cy="30%" rx="80%" ry="80%">
            <Stop offset="0" stopColor={CARD.back[0]} />
            <Stop offset="1" stopColor={CARD.back[1]} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={w} height={h} fill="url(#cardback)" />
        {/* A crown, not eighteen diagonal lines. The stripes were a texture at
            any size; the mark reads at pile size AND at the 8dp the seat
            capsules draw a held hand at, which is where most backs appear. */}
        <SvgText
          x={w / 2} y={h / 2 + w * 0.16}
          textAnchor="middle" fontSize={Math.round(w * 0.42)} fill={CARD.edge} fillOpacity={0.9}
        >
          ♛
        </SvgText>
        <Rect x="3" y="3" width={Math.max(1, w - 6)} height={Math.max(1, h - 6)} rx="4" fill="none" stroke={CARD.backLine} strokeWidth="1.5" />
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
  const color = joker ? CARD.joker : RED.has(card.suit) ? CARD.red : CARD.ink;
  const idx = Math.round(w * 0.3);

  return (
    <View style={{
      width: w, height: h, borderRadius: 6,
      // Warm ivory, not white. A pure-white card on lit emerald reads as a
      // cut-out; card stock is warm and slightly absorbent, and that difference
      // is most of what makes a hand look like objects rather than rectangles.
      backgroundColor: joker ? CARD.jokerFace : CARD.face,
      borderWidth: 1, borderColor: wild ? C.gold : CARD.edge,
      boxShadow: (glow || wild) ? CARD_SHADOW.wild(C.gold)
        : glow ? CARD_SHADOW.raised : CARD_SHADOW.rest,
      overflow: 'hidden',
    }}>
      {/* The shaded lower half of the paper — one flat overlay rather than a
          gradient library. It is what stops a card reading as a plain swatch,
          and it costs one View. */}
      <View pointerEvents="none" style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: h * 0.55,
        backgroundColor: CARD.faceLow, opacity: 0.55,
      }} />
      <Text style={{ position: 'absolute', top: 1, left: 3, fontSize: idx, lineHeight: idx * 1.1, fontWeight: '800', color }}>
        {joker ? '★' : card.rank}
      </Text>
      {/* The suit UNDER the rank, the way a real index reads. Without it a
          glance at a fanned hand shows a column of ranks and no suits at all —
          the tuck hides the centre pip, which is the only other place the suit
          appears. */}
      {!joker && w >= 40 && (
        <Text style={{
          position: 'absolute', top: idx * 1.05, left: 3,
          fontSize: Math.round(w * 0.2), lineHeight: Math.round(w * 0.22), color,
        }}>
          {SUIT_GLYPH[card.suit]}
        </Text>
      )}
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
  card, w, selected, wild, dimmed, onPress, onDrop,
}: {
  card: Card;
  w: number;
  selected: boolean;
  /** A printed joker, or a card of this round's wild rank. */
  wild: boolean;
  /** SHOW DEADWOOD is on and this card already melds, so it steps back. */
  dimmed?: boolean;
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
        style={[a, selected ? { borderRadius: 8, borderWidth: 2, borderColor: C.gold } : null,
          dimmed ? { opacity: 0.34 } : null]}
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
  spot, name, count, points, status, bot, host, turn, talking, still, secs,
}: {
  spot?: { x: number; y: number; w: number; h: number };
  name: string;
  count: number;
  points?: number | null;
  status: string;
  bot: boolean;
  /** Whoever deals. The server sends no dealer, so this is the lobby's host. */
  host: boolean;
  turn: boolean;
  talking: boolean;
  still: boolean;
  /** Seconds left on THIS player's turn. Only ever passed to the one playing. */
  secs: number | null;
}) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (turn && !still) {
      pulse.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 160 });
    }
    return () => cancelAnimation(pulse);
  }, [turn, still, pulse]);
  // The whole capsule breathes rather than a ring spinning around the avatar.
  // A 3.4s rotation on five seats was five continuously-animating views on a
  // screen that also animates thirteen cards; opacity on one border is one
  // interpolation and reads as "live" just as clearly.
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));

  if (!spot) return null;
  const out = status !== 'active' && status !== 'won';

  // THE AVATAR IS THE LEFTOVERS, and that is the whole trick. rummyTable owns
  // the budget (SEAT_CHROME_H) and hands back what is left after the padding,
  // the two line boxes and the gaps between them have been paid for. The old
  // seat guessed at this — `Math.min(28, h - 20)` for chrome that cost 30 —
  // and every capsule overflowed its own border by 12 to 18dp, painting the
  // card-back row onto bare felt outside the gold turn ring.
  const av = seatAvatar(spot.h);
  const initials = name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();

  // The line under the name. The card count is NOT here — it is the badge on
  // the avatar — so this is free to carry the number that actually decides the
  // hand. On a staked table that is points, and the old row-based seat
  // ellipsised them away at every phone width.
  const detail =
    status === 'won' ? 'WON'
    : status === 'dropped' ? 'DROPPED'
    : status === 'lost' ? `${points ?? 0} pts`
    : points != null ? `${points} pts`
    : `${count} cards`;

  const showCount = count > 0 && !out;

  return (
    <Animated.View
      accessibilityLabel={`${name}, ${detail}${showCount ? `, ${count} cards` : ''}${turn ? `, playing now${secs != null ? `, ${secs} seconds left` : ''}` : ''}${talking ? ', talking' : ''}${host ? ', host' : ''}`}
      style={[
        onFelt(turn ? 'gold' : 'navy', { radius: 14, active: turn }),
        {
          position: 'absolute', left: spot.x, top: spot.y, width: spot.w, height: spot.h,
          paddingHorizontal: 6, paddingVertical: 5,
          alignItems: 'center', opacity: out ? 0.5 : 1,
        },
      ]}
    >
      {turn && (
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', inset: -1, borderRadius: 15, borderWidth: 1.5, borderColor: C.gold }, ring]}
        />
      )}

      {/* the player */}
      <View style={{ width: av, height: av }}>
        <View style={{
          width: av, height: av, borderRadius: av / 2, alignItems: 'center', justifyContent: 'center',
          backgroundColor: bot ? '#6F9BFF' : C.gold,
          // One ring, three meanings, in priority order: talking beats host,
          // because who is speaking changes second by second and who deals does
          // not. A seat with neither has no ring at all — five glowing avatars
          // is the same as none.
          borderWidth: (talking || host) ? 2 : 0,
          borderColor: talking ? C.good : C.gold2,
        }}>
          {bot
            ? <Ionicons name="hardware-chip" size={Math.round(av * 0.44)} color={C.onGold} />
            : <Text style={{ color: C.onGold, fontWeight: '800', fontSize: Math.round(av * 0.38) }}>{initials}</Text>}
        </View>

        {/* HOW MANY CARDS THEY HOLD, as a badge rather than a row.
            It used to be up to five little card backs on a third row, which is
            what pushed the capsule past its own height — and five drawn backs
            cannot show the difference between six cards and thirteen anyway,
            because they capped at five. A number is smaller AND says more. */}
        {showCount && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', right: -5, bottom: -3,
              minWidth: 15, height: 14, borderRadius: 7, paddingHorizontal: 3,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(8,14,26,0.92)',
              borderWidth: 1, borderColor: alpha(CARD.edge, 0.55),
            }}>
            <Text style={{ color: INK_DIM, fontSize: 9, fontWeight: '800' }}>{count}</Text>
          </View>
        )}

        {/* Still in the hand, out of it, or the winner. Opposite the count so
            the two badges never sit on each other. */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute', right: -1, top: -1,
            width: 8, height: 8, borderRadius: 4,
            borderWidth: 1, borderColor: 'rgba(0,0,0,0.45)',
            backgroundColor: out ? '#9A8F8F' : status === 'won' ? C.gold : C.good,
          }}
        />
      </View>

      {/* their name — the FULL width of the capsule, which is the point of
          standing the seat up. It was 22dp on a 732dp table before. */}
      <Text
        numberOfLines={1}
        style={{
          width: '100%', marginTop: 3, textAlign: 'center',
          color: '#fff', fontWeight: '800', fontSize: 11.5, lineHeight: SEAT_NAME_LINE,
        }}
      >{name}</Text>

      {/* the clock while they are playing, otherwise the server's line.
          DROPPED ENTIRELY on a felt too short to hold it — see seatHasDetail.
          Rendering it anyway is what the old seat did with its third row, and
          the row ended up painted on the cloth below the capsule's border. */}
      {seatHasDetail(spot.h) && (
        <Text
          numberOfLines={1}
          style={{
            width: '100%', marginTop: 2, textAlign: 'center',
            fontSize: 9.5, lineHeight: SEAT_DETAIL_LINE, fontWeight: turn ? '800' : '600',
            color: turn && secs != null ? C.gold2 : INK_DIM,
          }}
        >{turn && secs != null ? `${secs}s left` : detail}</Text>
      )}
    </Animated.View>
  );
}
