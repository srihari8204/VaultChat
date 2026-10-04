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
 * THE FILE IS SPLIT (2026-10 round 4). This is the board: the connection, the
 * turn, and the table's layout. Beside it in components/games/rummy/: the hand
 * and its actions (useHand.ts), the cards and piles (Cards.tsx), the felt and
 * the seats (Felt.tsx), the bar and pills (Controls.tsx), the table list
 * (TableSelect.tsx), the waiting room (Room.tsx) and the result and standings
 * sheets (Sheets.tsx).
 *
 * WHAT THE SERVER DOES NOT OFFER, AND SO IS NOT HERE: pool (101/201) and deals
 * rummy. This server plays 13-card POINTS rummy and its wire protocol has no
 * concept of a pool score, an elimination or a deal count. Those are engine
 * features, and inventing them on the client would mean the client deciding
 * scores — exactly the thing the whole design refuses to do.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable,
  ScrollView, Text, View, useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import { TableBackground, Btn, useType, useReduceMotion, useAnnounce } from './ui';
import { useCountdown } from '../../lib/games/useCountdown';
import { useRematch } from '../../lib/games/useRematch';
import { RulesSheet, useFirstTimeRules } from './rules';
import { Toasts, Confetti, Sheet, SettingRow, VoiceSheet } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { groupUp, ungroup, SORT_MODES, SORT_LABEL } from '../../lib/games/handGroups';
import { MAX_LOSS } from '../../lib/games/meldHint';
import { openInvite, shareResult } from '../../lib/games/invite';
import { useRummyMatch } from '../../lib/games/useRummyMatch';
import {
  metrics, seatSpots, pileTop, shiftDropTargets,
  pid, allowsBots, normalizeCode, pickTable,
  type RummyPlayer, type Settlement, type TableInfo, type KindFilter, type SeatIntent,
} from '../../lib/games/rummyTable';
import { C, S, R, T, white } from '../../lib/games/theme';
import { STAT, CYAN, INK as INK_ON_FELT, STATUS_INK, onFelt } from '../../lib/games/rummyGlass';
import type { Card } from './rummy/shared';
import { useHand } from './rummy/useHand';
import { emoteLabel } from '../../lib/games/boardLabels';
import { GroupZone, Pile, DiscardPile, CardFace, HandCard } from './rummy/Cards';
import { TableTop, Baize, DeckLabel, Wordmark, KindTabs, TablePanel, EmoteFeed, Seat } from './rummy/Felt';
import { VoicePill, ScorePanel, ActionBtn, Stat, StatusPill, IconBtn } from './rummy/Controls';
import { TableSelect } from './rummy/TableSelect';
import { Room } from './rummy/Room';
import { ResultSheet, StandingsSheet } from './rummy/Sheets';


/** Thirteen-card Indian rummy: the hand a player holds between turns. */
const HAND_SIZE = 13;

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

/**
 * Clearance between the top of the oval and the first seat capsule.
 *
 * Small, because the header is its own band now — the seats no longer have to
 * dodge it, they only have to stay off the brass.
 */
const OVAL_SEAT_TOP = 6;

/** Shared empty hand: a fresh [] each render would re-run every memo below it. */
const NO_CARDS: Card[] = [];

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

  // GamesScreen owns all safe-area edges. The measured box is already safe;
  // subtract device insets only for the first frame before it is measured.
  const m = useMemo(
    () => metrics({
      width: box.w || win.width - insets.left - insets.right,
      height: box.h || win.height - insets.top - insets.bottom,
    }, { top: 0, bottom: 0, left: 0, right: 0 }),
    [box.w, box.h, win.width, win.height, insets.left, insets.right, insets.top, insets.bottom],
  );
  const t = useType();

  const reduceMotion = useReduceMotion();

  useEffect(() => { void preloadSfx(['deal', 'discard', 'select', 'tick', 'win', 'lose', 'error']); }, []);

  /* ── voice ───────────────────────────────────────────────────────── */

  // Voice goes through crazzychat's SFU, not the games socket — see
  // lib/games/useTableVoice.ts for what that costs (no end-to-end encryption).
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
  // Dropping forfeits the hand, and DROP sits beside Discard on the bar, so it
  // asks first — the same way Declare does.
  const confirmDrop = useCallback(() => Alert.alert(
    'Drop this hand?',
    'You forfeit this deal and drop points are scored against you. You stay at the table.',
    [{ text: 'Keep playing', style: 'cancel' }, { text: 'Drop', style: 'destructive', onPress: () => act('drop', { t: 'drop' }) }],
  ), [act]);


  /* ── the player's arrangement, and the actions on it ─────────────── */
  //
  // See rummy/useHand.ts. SELECTION IS BY CARD ID, AND AN ID CAN OUTLIVE THE
  // CARD: the selection is filtered by the hand on the way out, so a card that
  // left (a re-deal, an auto-discard, a reconnect) can never be acted on.
  const {
    picked, setPicked, groups, setGroups, sortMode, byId, isJoker, hint,
    zones, discardZone, tableScrollY, handScrollX, mountTableScroll, setZone,
    discard, dropAt, toggle, draw, declare, sortNow, applySort,
  } = useHand({ hand, wildRank: G?.wildRank, live: !!G, send, mustDraw, mustDiscard, act, notify });

  // The clock is a number on the pill; a screen-reader player hears the
  // warning once when their own turn enters the last CLOCK_URGENT seconds.
  useAnnounce(mine && urgent ? `${CLOCK_URGENT} seconds left on your turn` : null, true);

  const ended = useRef(false);
  useEffect(() => {
    if (G?.phase !== 'finished') { ended.current = false; return; }
    if (ended.current) return;
    ended.current = true;
    playSfx(G.winnerId === state.you ? 'win' : 'lose');
  }, [G?.phase, G?.winnerId, state.you]);

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
      {/* The route owns safe-area padding; this is the available play viewport. */}
      <Baize />

      <ScrollView
        ref={mountTableScroll}
        onLayout={onBoxLayout}
        style={{ flex: 1 }}
        nestedScrollEnabled
        scrollEventThrottle={16}
        onScroll={event => {
          // Drop targets are window coordinates. Scrolling does not trigger
          // onLayout, so carry them with the content instead of using stale y.
          const y = event.nativeEvent.contentOffset.y;
          const delta = tableScrollY.current - y;
          tableScrollY.current = y;
          shiftDropTargets(zones.current, 0, delta);
          if (discardZone.current) discardZone.current.y += delta;
        }}
        contentContainerStyle={{
          alignItems: 'center',
        }}>

      {/* ── the header bar ─────────────────────────────────────────── */}
      <ScrollView horizontal style={{ width: m.tableW, flexGrow: 0 }} contentContainerStyle={{
        minHeight: m.headerH, minWidth: m.tableW, flexDirection: 'row',
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
      </ScrollView>

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
                <View
                  accessible
                  accessibilityLabel={wild.suit === 'JOKER' ? 'Wild card: joker' : `Wild card, ${wild.rank} is wild this round`}
                  style={{ alignItems: 'center', gap: 3 }}
                >
                  <CardFace card={wild} w={m.pileW} wild />
                  {/* On a navy plate: bare on the lit cloth this gold measured
                      2.7:1, under WCAG AA. 11:1 on the plate. */}
                  <View style={[onFelt('navy', { radius: R.pill, lift: 0 }), { paddingHorizontal: S[1] + 2 }]}>
                    <Text style={{ color: C.gold2, fontSize: 10, fontWeight: '800' }}>
                      {wild.suit === 'JOKER' ? 'joker' : `${wild.rank} is wild`}
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}
          </View>

          {/* Whose turn it is, floating at the foot of the cloth. It used to own
              a 30dp band of its own; the score panel now carries the numbers it
              was repeating, so it costs nothing but the pixels it covers. */}
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 4, alignItems: 'center' }}>
            {reconnecting ? (
              <StatusPill tone="warn" announce="Reconnecting. Your hand is safe.">
                <ActivityIndicator size="small" color={C.gold2} />
                <Text style={{ color: C.gold2, fontSize: 11, fontWeight: '800' }}>
                  Reconnecting — your hand is safe
                </Text>
              </StatusPill>
            ) : (
              <StatusPill tone={mine ? 'you' : 'plain'} announce={statusText}>
                <Ionicons name="person-circle-outline" size={18} color={mine ? C.gold2 : CYAN} />
                <Text numberOfLines={1} style={{ flexShrink: 1, color: mine ? C.gold2 : STATUS_INK, fontSize: 11, fontWeight: '800' }}>
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
          scrollEventThrottle={16}
          onScroll={event => {
            // Only the hand groups move horizontally; the discard pile stays put.
            const x = event.nativeEvent.contentOffset.x;
            shiftDropTargets(zones.current, handScrollX.current - x, 0);
            handScrollX.current = x;
          }}
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
                    group={gi === groups.length - 1
                      ? 'ungrouped'
                      : `group ${gi + 1}${hint.groups[gi]?.label ? `, ${hint.groups[gi].label}` : ''}`}
                    onPress={toggle}
                    onDrop={dropAt}
                    onDiscard={discard}
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
      <ScrollView horizontal style={{ width: m.tableW, flexGrow: 0 }} contentContainerStyle={{ minHeight: 46, minWidth: m.tableW, flexDirection: 'row', gap: S[1], alignItems: 'center', paddingHorizontal: S[1], paddingVertical: 5 }}>
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
        <ActionBtn w={m.barBtnW} glyph="⏻" label="DROP" tone="danger" disabled={!mine || !!pending} onPress={confirmDrop} />
      </ScrollView>
      </ScrollView>

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
          {`You are seated at a hand in progress. It keeps running on the server without you, and turns you miss can time out and count against you. To give the hand up now, use Drop instead. The table list will show ${confirmLeave === 'bots' ? 'tables you can play a bot at' : confirmLeave === 'practice' ? 'practice tables' : 'tables played for coins'}.`}
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
              accessibilityLabel={emoteLabel(e)}
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
        <SettingRow label="Sound" value={sound ? 'On' : 'Off'} checked={sound} onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }} />
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
          onPress={() => { setShowSettings(false); confirmDrop(); }}
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
