/**
 * components/games/Chess.tsx — VaultChess board.
 *
 * The server sends `legal: [{from,to,promo}]` — the complete legal-move list
 * for the player to move — every frame, so there is no move generation, no pin
 * detection, no special-case handling and no mate search in this file. Tapping
 * a piece filters `legal` by `from`; that is the entire move engine.
 *
 * Indices are NUMERIC, 0..63, index = row*8 + col with row 0 = rank 8 (black's
 * back rank) — the same convention `legal`, `lastMove` and `board` all use.
 * Algebraic squares never appear on the wire.
 *
 * The visual language is ported from games-web/chess.css: a board-first
 * near-black page rather than the maroon felt the other three games use,
 * classic cream/brown squares, and chess.com-style highlights.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Path, Ellipse, Defs, LinearGradient as SvgLinear, Stop } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat,
  Easing, cancelAnimation,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useGameSocket, type GameState, type AutoStart } from '../../lib/games/useGameSocket';
import {
  TableBackground, Btn, Panel, PlayerRow, Reconnecting, RematchBtn, ActionDock, RoundBtn,
  useType, useBoardBox, usePortraitLock, useReduceMotion,
} from './ui';
import { useRematch } from '../../lib/games/useRematch';
import { RulesSheet, useFirstTimeRules } from './rules';
import LeaderboardSheet from './LeaderboardSheet';
import { C, S, R, white, alpha, ACCENT } from '../../lib/games/theme';
import { CR, CR_AMBIENT, CR_BOKEH, CR_VIGNETTE, CR_LIT, g } from '../../lib/games/chessRoom';
import { useAddBot, ADD_BOT_STALLED } from '../../lib/games/useAddBot';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar, VoiceSheet } from './feedback';
import { useTableVoice, type TableVoice } from '../../lib/games/useTableVoice';
import { openInvite, shareResult } from '../../lib/games/invite';

type Piece = { t: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; c: 'w' | 'b' } | null;
type Move = { from: number; to: number; promo?: string };

/**
 * Filled glyphs for BOTH colours, tinted rather than outlined.
 *
 * The web uses the hollow set for white plus a -webkit-text-stroke outline;
 * RN has no text stroke, and a hollow glyph on a cream square is close to
 * invisible without one. Filled-and-tinted is what native chess apps do and it
 * reads correctly at phone sizes.
 */
const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/** Fill + fake-stroke per side. See OutlinedGlyph. */
type Ink = { w: { fill: string; line: string }; b: { fill: string; line: string } };

type BoardTheme = {
  light: string; dark: string; hl: string; sel: string;
  /** Board rim. Defaults to the dark wood edge every painted theme uses. */
  edge?: string;
  /** Legal-move dot. The default is INK — it is drawn for light squares. */
  dot?: string;
  /** Capture ring. Same reasoning as `dot`. */
  ring?: string;
  /** Piece ink. Defaults to black-on-cream; only `glass` needs its own. */
  ink?: Ink;
};

/** chess.com board themes, from games-web/chess.js BOARD_THEMES — plus `glass`. */
const THEMES = {
  /**
   * The house board — a deep emerald table with warm ivory squares.
   *
   * THE KEY IS STILL `glass`, AND THAT IS DELIBERATE. It is the value written
   * into AsyncStorage under BOARD_KEY by every player who has ever kept the
   * default, and renaming it would silently invalidate their stored choice and
   * drop them back to whatever the default happened to be that week. The key is
   * storage; the colours are design. Only the colours moved.
   *
   * It used to be literally translucent — white at .16/.045 over the room —
   * which read as glass but gave chess the one thing a board must not have:
   * squares whose colour depends on what is behind them. The 2026-09-06
   * redesign makes the BOARD opaque and puts the glass in the panels around it,
   * which is both what the reference asks for and what every chess client does.
   *
   * Because the squares are opaque again, the BLACK pieces come back to black.
   * The previous version played the dark side in the ice accent, because black
   * on a dark translucent square is a silhouette on a shadow; on solid emerald
   * that problem is gone. What replaces the tint is a champagne rim — the same
   * trick the white pieces have always used, in the other direction — so an
   * obsidian piece on an emerald square still has an edge.
   */
  glass:      { light: CR.ivory, dark: CR.emerald,
                hl: 'rgba(233,196,106,.42)', sel: 'rgba(233,196,106,.62)',
                edge: CR.gold, dot: 'rgba(24,38,32,.34)',
                ring: 'rgba(24,38,32,.34)',
                ink: { w: { fill: '#FBF4E6', line: '#2B2620' },
                       b: { fill: '#14120F', line: '#E0B455' } } },
  classic:    { light: '#ece6d3', dark: '#6f6253', hl: 'rgba(214,175,99,.50)', sel: 'rgba(214,175,99,.68)' },
  green:      { light: '#ebecd0', dark: '#739552', hl: 'rgba(155,199,0,.45)',  sel: 'rgba(155,199,0,.55)' },
  blue:       { light: '#dee3e6', dark: '#8ca2ad', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
  brown:      { light: '#f0d9b5', dark: '#b58863', hl: 'rgba(205,210,106,.45)', sel: 'rgba(205,210,106,.55)' },
  midnight:   { light: '#b7c6d8', dark: '#3a4b66', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
  tournament: { light: '#e8e8e8', dark: '#7d8a99', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
} satisfies Record<string, BoardTheme>;
type ThemeName = keyof typeof THEMES;

/**
 * The board the player last chose, remembered.
 *
 * The reference client defaults to GREEN and persists the choice to
 * localStorage (chess.js: `if (!settings.board) settings.board = "green"`).
 * This port defaulted to `classic` — a theme the web does not even have — so
 * the board every crazzychat player saw was one no chess.com player would
 * recognise, and re-picking green every time the screen opened was the only
 * way to get it back. Same module-level read as the rummy sort preference, so
 * the first paint is already correct rather than flipping a frame later.
 *
 * THE DEFAULT IS NOW GLASS, by an explicit product decision (2026-09-04): the
 * four games share one look, and that outranks matching chess.com here. It was
 * green until then, and the swap was made deliberately rather than silently —
 * the test below moved with it.
 *
 * Green is still one swatch away and is still exactly what the reference client
 * uses, so nothing is lost for a player who wants it. And a player who has EVER
 * picked a board keeps theirs: the stored value is read before this default is
 * ever painted, so this changes nothing for anyone who already chose.
 */
const BOARD_KEY = 'vc_chess_board';
const isThemeName = (v: unknown): v is ThemeName =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(THEMES, v);
let boardPref: ThemeName = 'glass';
AsyncStorage.getItem(BOARD_KEY)
  .then(v => { if (isThemeName(v)) boardPref = v; })
  .catch(() => {});

/** Stable empties, so an absent board does not churn every consumer. */
const NO_MOVES: Move[] = [];
const NO_BOARD: Piece[] = [];

const FILES = 'abcdefgh';
// chess.css: `.sq.check { box-shadow: inset 0 0 0 60px rgba(225,90,90,.55) }`
// with a 1s pulse to .3. OPAQUE here because the pulse below animates opacity —
// a .55 colour at .55 opacity is .30 at rest, so the check marker was arriving
// at half strength and reading as a faint blush rather than an alarm.
const CHECK_RED = '#e15a5a';
const DOT = 'rgba(40,35,28,.32)';

/** Material value per piece letter, for the captured-material readout. */
/**
 * The pieces, as vector paths on a 100x100 grid.
 *
 * THEY WERE UNICODE GLYPHS, and that was a device risk rather than a look. A
 * glyph is drawn by whatever font the platform resolves it to; every Android
 * skin ships its own symbol fonts, and OutlinedGlyph's own comment used to warn
 * that whether the outline set renders hollow is a font-fallback question — on
 * a skin that answers it the other way, the white king comes out solid black
 * and you cannot tell your own pieces from your opponent's. That was a question
 * of which phone, not whether.
 *
 * A path renders as one shape everywhere, and it takes a REAL stroke, which is
 * what the four offset copies below it were faking.
 *
 * Drawn in Figma first per the standing rule (file BamgQ9YetsdRxW2CfWM7By,
 * frame "Chess v2 - piece set (draft)"), and kept to absolute M/L/C/Z: that is
 * the only path grammar Figma's parser accepts. react-native-svg takes far
 * more, but authoring to the smaller grammar is what lets the design file and
 * the code hold the same string.
 */
const BASE_WIDE = 'M 22 78 L 78 78 C 80.2 78 82 79.8 82 82 L 82 88 L 18 88 L 18 82 C 18 79.8 19.8 78 22 78 Z';
const COLLAR = 'M 32 66 L 68 66 C 70.2 66 72 67.8 72 70 L 72 74 L 28 74 L 28 70 C 28 67.8 29.8 66 32 66 Z';

const PIECE_PATH: Record<string, string> = {
  // A head, a NECK, and a flared skirt. Without the waist the head and the body
  // merge into one lump and it stops reading at board size, which is the only
  // size it is ever seen at.
  p: 'M 50 16 C 57.18 16 63 21.82 63 29 C 63 36.18 57.18 42 50 42 C 42.82 42 37 36.18 37 29 C 37 21.82 42.82 16 50 16 Z'
   + ' M 44 41.5 C 42.6 44.8 41.4 47.8 41 50.6 C 40.1 56.8 36.6 63.8 32.4 70 L 30 76 L 70 76 L 67.6 70 C 63.4 63.8 59.9 56.8 59 50.6 C 58.6 47.8 57.4 44.8 56 41.5 C 54.2 42.7 52.2 43.3 50 43.3 C 47.8 43.3 45.8 42.7 44 41.5 Z'
   + ' M 26 76 L 74 76 C 76.2 76 78 77.8 78 80 L 78 88 L 22 88 L 22 80 C 22 77.8 23.8 76 26 76 Z',
  r: 'M 27 15 L 38 15 L 38 24 L 46 24 L 46 15 L 54 15 L 54 24 L 62 24 L 62 15 L 73 15 L 73 35 L 66 41 L 66 63 L 73 73 L 73 78 L 27 78 L 27 73 L 34 63 L 34 41 L 27 35 Z ' + BASE_WIDE,
  b: 'M 50 11 C 53.31 11 56 13.69 56 17 C 56 20.31 53.31 23 50 23 C 46.69 23 44 20.31 44 17 C 44 13.69 46.69 11 50 11 Z'
   + ' M 50 21 C 60 27 67 36.5 67 45 C 67 52 63.4 58.2 57.9 61.8 L 61.5 67 L 38.5 67 L 42.1 61.8 C 36.6 58.2 33 52 33 45 C 33 36.5 40 27 50 21 Z'
   + ' M 36 67 L 64 67 C 66.2 67 68 68.8 68 71 L 68 74 L 32 74 L 32 71 C 32 68.8 33.8 67 36 67 Z ' + BASE_WIDE,
  n: 'M 38 78 L 38 74 C 38 65 41.4 58.4 48.2 53.4 C 52.6 50.2 55.2 47.5 56.5 44.2 L 48.1 47.4 L 44.5 41.2 L 51.1 36.6 C 52.5 34.6 53.3 32.2 53.5 29.4 L 46.9 32 L 44.5 25.4 L 53.5 20.8 C 56.1 16.8 60.1 14.2 65.1 13.4 L 67.7 20.8 L 74.1 24.4 C 78.1 26.6 80.5 30.6 80.5 35.6 L 80.5 78 Z ' + BASE_WIDE,
  q: 'M 50 10 C 53.04 10 55.5 12.46 55.5 15.5 C 55.5 18.54 53.04 21 50 21 C 46.96 21 44.5 18.54 44.5 15.5 C 44.5 12.46 46.96 10 50 10 Z'
   + ' M 28 25 C 30.76 25 33 27.24 33 30 C 33 32.76 30.76 35 28 35 C 25.24 35 23 32.76 23 30 C 23 27.24 25.24 25 28 25 Z'
   + ' M 72 25 C 74.76 25 77 27.24 77 30 C 77 32.76 74.76 35 72 35 C 69.24 35 67 32.76 67 30 C 67 27.24 69.24 25 72 25 Z'
   + ' M 50 20 L 58 38 L 71 27 L 68 50 L 65.5 66 L 34.5 66 L 32 50 L 29 27 L 42 38 Z ' + COLLAR + ' ' + BASE_WIDE,
  k: 'M 46.5 9 L 53.5 9 L 53.5 15 L 59.5 15 L 59.5 22 L 53.5 22 L 53.5 31 L 46.5 31 L 46.5 22 L 40.5 22 L 40.5 15 L 46.5 15 Z'
   + ' M 46.5 30 C 38 32.6 32 39.5 32 47.6 C 32 52.2 33.9 56.4 37 59.5 L 34 66 L 66 66 L 63 59.5 C 66.1 56.4 68 52.2 68 47.6 C 68 39.5 62 32.6 53.5 30 Z ' + COLLAR + ' ' + BASE_WIDE,
};

/**
 * The outline, in VIEWBOX UNITS rather than pixels.
 *
 * Was 1.2 — a px count copied from chess.css's -webkit-text-stroke and faked
 * with four offset glyph copies. A path takes a real stroke, and expressing it
 * in the 100-unit grid means it scales WITH the board instead of getting
 * proportionally heavier as the squares get smaller.
 */
const PIECE_STROKE = 2.2;

/**
 * Fill and stroke per side, straight from chess.css:
 *   .piece.w { color: #f4f0e6; -webkit-text-stroke: 1.2px #2b2620 }
 *   .piece.b { color: #1d1a16; -webkit-text-stroke: 1.2px #000 }
 *
 * Black's stroke is BLACK — it thickens the glyph rather than outlining it. An
 * earlier pass here gave black a light stroke, which is a different piece set:
 * it turns a solid black knight into an engraved one.
 */
const PIECE_INK = {
  w: { fill: '#f4f0e6', line: '#2b2620' },
  b: { fill: '#1d1a16', line: '#000000' },
} as const;

/** The bronze board frame, in dp. */
const RIM = 3;

/**
 * The felt rail between the frame and the grid, as a fraction of the board.
 *
 * THE COORDINATES LIVE ON IT, and that is the point. They used to be drawn
 * inside the first column and last row of squares, which is what chess.css
 * does — but it means eight squares carry a label a piece then stands on top
 * of, and on a phone the label and the piece fight for the same 40dp. A rail
 * is where a real board puts them.
 *
 * It is a RATIO rather than a constant because it has to hold its proportion
 * from a 320dp phone to a tablet; at 358dp it resolves to 19dp, which fits a
 * 10dp digit with air around it. Clamped so it can neither vanish on a small
 * screen nor eat the board on a large one.
 */
const RAIL_RATIO = 0.053;
const RAIL_MIN = 13;
const RAIL_MAX = 26;

/** The rail itself: the green felt a board's frame holds. */
const FELT = '#12483A';
const RAIL_INK = 'rgba(207,227,216,.85)';

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** A full starting army, by letter. Used only to derive what has been taken. */
const ARMY: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

export default function Chess({ roomId, auto, autoBot }: { roomId: string } & AutoStart) {
  const { phase, error, state, events, send, subscribe, retry } = useGameSocket('chess', roomId, { auto, autoBot });
  const [sel, setSel] = useState<number | null>(null);
  const [promo, setPromo] = useState<{ from: number; to: number; opts: Move[] } | null>(null);
  const [theme, setTheme] = useState<ThemeName>(boardPref);
  const [showSettings, setShowSettings] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [coords, setCoords] = useState(true);
  const [sound, setSound] = useState(soundEnabled());
  // A draw offer is a question that has to be answerable. The web shows a
  // banner with Accept; without it the offer arrives as a toast that scrolls
  // away and the player has no way to say yes.
  const [drawOffer, setDrawOffer] = useState(false);
  const [botLevel, setBotLevel] = useState(2);
  const voice = useTableVoice('chess', roomId, { you: state.you, send, subscribe });
  const t = useType();

  const G = state.game;
  // Chess seats by COLOUR, not seat index, and both `color` and `legal` ride at
  // the top level of the frame beside `game`.
  const myColor: 'w' | 'b' | null = state.raw?.color ?? null;
  // The FALLBACKS are module constants, not fresh literals.
  //
  // `state.raw.legal` and `G.board` are already the same array between renders —
  // they come straight off the last snapshot — but `: []` minted a new one every
  // time, so on any frame without a board (and on every frame once one existed,
  // through the memos below) the identity changed. That fed movesFromSel ->
  // targets -> onSquare -> all 64 squares, which is why a one-second clock tick
  // re-rendered the whole board.
  const legal: Move[] = Array.isArray(state.raw?.legal) ? state.raw.legal : NO_MOVES;
  const board: Piece[] = Array.isArray(G?.board) ? G.board : NO_BOARD;
  const lastMove: Move | null = G?.lastMove ?? null;

  /**
   * Chess seats by COLOUR, so the turn is 'w' or 'b' — not a seat index.
   *
   * The shared isMyTurn() only understands `turnPlayerId` or a numeric `turn`
   * against a numeric seat, so for chess it always returned false and NO SQUARE
   * WAS EVER TAPPABLE. The board rendered perfectly and could not be played.
   */
  const mine = !state.spectator && myColor != null && G?.turn === myColor
    // A tap while the socket is down goes nowhere: the intent is dropped and
    // the board keeps the piece where the last snapshot put it.
    && phase === 'connected';

  // The rematch is `start` on this same table — plus a wait that ends and an
  // invite for when the other seat is empty. See lib/games/useRematch.ts.
  const rematch = useRematch('chess', roomId, state, send);

  // Annotated: `satisfies` keeps the literal keys, so THEMES[theme] is a UNION
  // of the entry shapes and only `glass` carries ink/dot/ring/edge. Widening to
  // BoardTheme here is what makes those optional reads legal at the call site.
  const th: BoardTheme = THEMES[theme];
  // Seats above and below, the status line and two button rows.
  // Portrait only. See usePortraitLock — this also stops a force-stopped
  // rummy table from leaving the OS locked to landscape under this board.
  usePortraitLock();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  // 300, not 360. The chrome shrank with the redesign: the full-width status
  // banner became a pill, the swatch row and the move list moved into the
  // sheet, and the voice bar only appears once someone is in the channel. An
  // estimate that is too LARGE is not safe — it is a smaller board than the
  // screen can hold, on every device.
  const { size, onLayout: onBoardBox } = useBoardBox(300);
  // THE RIM IS PART OF THE BOARD'S BOX, NOT EXTRA.
  //
  // boardFit returns the largest square that fits inside a 16dp gutter, and the
  // ScrollView pads by exactly that 16. A 3dp frame drawn AROUND `size` is
  // therefore 6dp wider than the column it sits in, which on a phone is a
  // clipped right edge or a horizontally scrolling page — the two things a
  // board must never do. So the frame takes its width out of the board and the
  // eight cells divide what is left.
  const boardEdge = size - RIM * 2;
  // The rail is inside the frame and the grid is inside the rail, so the whole
  // assembly still measures exactly `size`. Everything below divides what is
  // actually left rather than assuming it.
  const rail = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(boardEdge * RAIL_RATIO)));
  const grid = boardEdge - rail * 2;
  const cell = grid / 8;

  // Black plays from the far side, so the board is flipped for them.
  const flipped = myColor === 'b';
  const toDisplay = (idx: number) => (flipped ? 63 - idx : idx);
  const fromDisplay = (d: number) => (flipped ? 63 - d : d);

  const movesFromSel = useMemo(
    () => (sel == null ? [] : legal.filter(m => m.from === sel)),
    [sel, legal],
  );
  const targets = useMemo(() => new Set(movesFromSel.map(m => m.to)), [movesFromSel]);

  const pickBoard = useCallback((n: ThemeName) => {
    setTheme(n);
    boardPref = n;
    void AsyncStorage.setItem(BOARD_KEY, n).catch(() => {});
  }, []);

  // Clear a stale selection whenever the position changes underneath it.
  useEffect(() => { setSel(null); }, [G?.history?.length, G?.turn]);

  useEffect(() => { void preloadSfx(['move', 'capture2', 'check', 'promote', 'select', 'win', 'lose', 'draw']); }, []);

  // Sound is driven off the SNAPSHOT, not off the tap, so a move the opponent
  // makes sounds the same as one of ours — and a move the server rejected makes
  // no sound at all, which is the correct feedback.
  const seen = useRef<string>('');
  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (!G) return;
    const count = board.reduce((n, p) => n + (p ? 1 : 0), 0);
    const key = `${G.history?.length ?? 0}:${lastMove?.from ?? -1}:${lastMove?.to ?? -1}`;
    if (lastMove && key !== seen.current) {
      seen.current = key;
      const took = prevCount.current != null && count < prevCount.current;
      playSfx(G.check ? 'check' : took ? 'capture2' : 'move');
    }
    prevCount.current = count;
  }, [G, board, lastMove]);

  useEffect(() => {
    const last = events[events.length - 1] ?? '';
    if (/draw/i.test(last) && /offer/i.test(last)) setDrawOffer(true);
  }, [events]);

  // Any move settles the question, so a stale banner cannot linger.
  useEffect(() => { setDrawOffer(false); }, [G?.history?.length]);

  const ended = useRef(false);
  useEffect(() => {
    if (!G?.result) { ended.current = false; return; }
    if (ended.current) return;
    ended.current = true;
    playSfx(G.result === 'draw' || !G.winner ? 'draw' : G.winner === myColor ? 'win' : 'lose');
  }, [G?.result, G?.winner, myColor]);

  // useCallback so a CLOCK TICK does not rebuild every square's handler. The
  // deps are the things a tap actually depends on, so this still rebuilds on a
  // real move — which is correct, the squares must re-render then.
  const onSquare = useCallback((i: number) => {
    if (!mine || state.spectator) return;
    if (sel != null && targets.has(i)) {
      const opts = movesFromSel.filter(m => m.to === i);
      // Several entries sharing a `to` with different `promo` values is a
      // promotion: ask rather than silently queening.
      if (opts.length > 1 && opts.some(o => o.promo)) { setPromo({ from: sel, to: i, opts }); return; }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      send({ t: 'move', from: sel, to: i, promo: opts[0]?.promo });
      setSel(null);
      return;
    }
    // Only squares the server says can move are selectable, so an illegal
    // selection is impossible rather than merely rejected.
    const can = legal.some(m => m.from === i);
    if (can) { Haptics.selectionAsync().catch(() => {}); playSfx('select'); }
    setSel(can ? i : null);
  }, [mine, state.spectator, sel, targets, movesFromSel, legal, send]);

  // Only take the screen back BEFORE there is a board. A mid-game drop keeps the
  // position up with a banner over it — see Reconnecting in ui.tsx.
  const reconnecting = phase !== 'connected' && !!G;
  if (phase !== 'connected' && !G) return <Connecting phase={phase} error={error} onRetry={retry} />;

  if (!G) {
    return (
      <Lobby
        state={state}
        events={events}
        botLevel={botLevel}
        onBotLevel={setBotLevel}
        onAddBot={() => send({ t: 'addbot', level: botLevel })}
        onStart={() => send({ t: 'start' })}
        voice={voice}
        code={roomId}
      />
    );
  }

  // Voice lives behind a button in the action row, not only in the bar under
  // the board: on a phone the bar is below the board, both seats and the status
  // line, so a player looking for "how do I talk to them" has to scroll past
  // the whole game to find out that they can. The label carries the live state
  // so the row itself says whether anyone is in the channel.
  // Count only - the microphone is now an icon on the button, not a character
  // glued to the front of its label.
  const voiceOn = voice.phase === 'live' || voice.phase === 'waiting';
  const voiceLabel = voiceOn ? `${voice.participants.length}` : '';
  const nameOfPlayer = (id: string) =>
    (state.lobby?.members ?? []).find(mem => mem.vaultId === id)?.name ?? id;

  const captured = takenBy(board);
  // chess.css puts a FLAT `-webkit-text-stroke: 1.2px` on every piece at every
  // board size. Scaling it off the cell (it was cell * 0.06) put a 3px stroke
  // on a phone board — thick enough to close up the gaps inside a knight.
  const stroke = PIECE_STROKE;

  return (
    // The chess room, not the shared maroon card table. See lib/games/chessRoom.
    <TableBackground bg={CR.bg} ambient={CR_AMBIENT} bokeh={CR_BOKEH} vignette={CR_VIGNETTE}>
      <ScrollView
        onLayout={onBoardBox}
        contentContainerStyle={{
          paddingHorizontal: S[4], paddingTop: S[2], gap: S[3],
          alignItems: 'center',
          // The gesture bar is not part of the board's box. Padding it here is
          // what keeps the action dock off the system UI on a gesture phone.
          paddingBottom: S[6] + insets.bottom,
        }}
      >
        {/* The strip the reference puts in the header. GameChrome above this
            board owns Back and the title (it used to say "the navigator header"
            owns them — it did not; the stack is headerShown:false and this
            screen had no way out at all), so duplicating either here would give
            the screen two ways back; these are the controls it does NOT already
            carry. Both open sheets built on data that was already on the
            screen — neither is a new request to the server. */}
        <View style={{ width: size, flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            numberOfLines={1}
            style={{ flex: 1, color: g(0.6), fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }}
          >
            PLAY  •  CONNECT  •  CHALLENGE
          </Text>
          <RoundBtn ion="stats-chart-outline" label="Standings" onPress={() => setStatsOpen(true)} />
          <RoundBtn ion="people-outline" label="Who is at this table" onPress={() => setPlayersOpen(true)} />
          <RoundBtn ion="settings-outline" label="Board settings" onPress={() => setShowSettings(true)} />
        </View>

        {reconnecting && (
          <View style={{ width: size }}><Reconnecting error={error} onRetry={retry} /></View>
        )}

        <Seat
          name={opponentName(state)}
          role={roleOf(state, G, false, mine)}
          bot={opponentIsBot(state)}
          glyph={myColor === 'w' ? '♚' : '♔'}
          clock={clockFor(state, myColor === 'w' ? 'b' : 'w')}
          taken={captured[myColor === 'w' ? 'w' : 'b']}
          edge={captured.edge * (myColor === 'w' ? -1 : 1)}
          active={!mine && G.result == null}
          width={size}
        />

        {/* The rim is a GRADIENT, so it has to be a view of its own wrapping the
            board — RN borderColor takes one colour. It adds RIM*2 to the width
            and nothing to `size`, so the cell geometry, the touch targets and
            every coordinate below are exactly what they were. */}
        <LinearGradient
          colors={[CR.gold2, CR.gold, CR.goldDeep]}
          locations={[0, 0.5, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            padding: RIM, borderRadius: R[2] + RIM,
            boxShadow: '0 16px 44px rgba(0,0,0,0.58), 0 4px 10px rgba(0,0,0,0.4)',
          }}
        >
          <View
            style={{
              width: boardEdge, height: boardEdge, borderRadius: R[2], overflow: 'hidden',
              backgroundColor: FELT,
            }}
          >
            {/* Coordinates on the RAIL, one rank column and one file row —
                the same two edges chess.css labels, moved off the squares.
                Absolutely placed rather than laid out with padding: Yoga and
                CSS disagree about whether an absolute child is offset by its
                parent's padding, and the grid below has to land on an exact
                pixel or every square is off by the rail. */}
            {coords ? Array.from({ length: 8 }, (_, i) => (
              <Text
                key={`rk${i}`}
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  position: 'absolute', left: 0, width: rail,
                  top: rail + i * cell + cell / 2 - 7,
                  textAlign: 'center', fontSize: 10, fontWeight: '700', color: RAIL_INK,
                }}
              >
                {String(flipped ? i + 1 : 8 - i)}
              </Text>
            )) : null}
            {coords ? Array.from({ length: 8 }, (_, i) => (
              <Text
                key={`fl${i}`}
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  position: 'absolute', bottom: 1, height: rail - 2,
                  left: rail + i * cell, width: cell,
                  textAlign: 'center', fontSize: 10, fontWeight: '700', color: RAIL_INK,
                }}
              >
                {FILES[flipped ? 7 - i : i]}
              </Text>
            )) : null}

            <View style={{
              position: 'absolute', left: rail, top: rail,
              width: grid, height: grid, borderRadius: 4, overflow: 'hidden',
              backgroundColor: th.dark,
              boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.42)',
            }}>
              {/* The house mark, dead centre and faint enough that a piece
                  standing on it still reads first. Behind every square's
                  content and untouchable. */}
              <Text
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  position: 'absolute', left: 3 * cell, top: 3.5 * cell,
                  width: cell * 2, textAlign: 'center',
                  fontSize: cell * 1.05, lineHeight: cell * 1.2,
                  color: 'rgba(138,106,30,.30)',
                }}
              >
                ♛
              </Text>
            {Array.from({ length: 64 }, (_, d) => {
              const idx = fromDisplay(d);
              const r = idx >> 3, c = idx & 7;
              const light = (r + c) % 2 === 0;
              const p = board[idx] ?? null;
              const isSel = sel === idx;
              const isLast = !!lastMove && (lastMove.from === idx || lastMove.to === idx);
              const inCheck = !!p && p.t === 'k' && p.c === G.turn && !!G.check;
              const isTarget = sel != null && targets.has(idx);

              return (
                <Square
                  key={d}
                  d={d}
                  cell={cell}
                  sq={idx}
                  bg={light ? th.light : th.dark}
                  tint={isSel ? th.sel : isLast ? th.hl : null}
                  check={inCheck}
                  piece={p}
                  pieceSize={cell * 0.95}
                  target={isTarget}
                  capture={isTarget && !!p}
                  slideFrom={
                    lastMove && lastMove.to === idx
                      ? { dx: ((toDisplay(lastMove.from) & 7) - (d & 7)) * cell,
                          dy: ((toDisplay(lastMove.from) >> 3) - (d >> 3)) * cell,
                          key: `${G.history?.length ?? 0}:${lastMove.from}:${lastMove.to}` }
                      : null
                  }
                  ink={th.ink}
                  dot={th.dot}
                  ring={th.ring}
                  onPress={() => onSquare(idx)}
                  stroke={stroke}
                  still={reduceMotion}
                />
              );
            })}
            </View>
          </View>
        </LinearGradient>

        <Seat
          name={youName(state)}
          role={roleOf(state, G, true, mine)}
          bot={false}
          glyph={myColor === 'w' ? '♔' : '♚'}
          clock={clockFor(state, myColor ?? 'w')}
          taken={captured[myColor === 'w' ? 'b' : 'w']}
          edge={captured.edge * (myColor === 'w' ? 1 : -1)}
          active={mine && G.result == null}
          width={size}
        />

        <StatusPill
          game={G}
          myColor={myColor}
          mine={mine}
          spectator={state.spectator}
          phase={phase}
          reconnecting={reconnecting}
          still={reduceMotion}
          width={size}
        />

        {drawOffer && !G.result && (
          <View style={{
            width: size, flexDirection: 'row', alignItems: 'center', gap: S[2],
            padding: S[3], borderRadius: R[2],
            borderWidth: 1, borderColor: CR.lineSoft, backgroundColor: g(0.12),
          }}>
            <Text style={{ flex: 1, color: '#ffd97a', fontSize: t.sm, fontWeight: '700' }}>
              Your opponent offers a draw
            </Text>
            <Btn label="Accept" kind="gold" compact onPress={() => { send({ t: 'draw-accept' }); setDrawOffer(false); }} />
            <Btn label="No" compact onPress={() => setDrawOffer(false)} />
          </View>
        )}

        {/* The rematch keeps a row of its own rather than a dock slot: it is the
            primary action once a game ends, and RematchBtn has four states — one
            of them reads "they did not come back, invite them" and needs the
            width to say so. */}
        {G.result ? (
          <View style={{ flexDirection: 'row', gap: S[2], width: size }}>
            <RematchBtn rm={rematch} />
          </View>
        ) : null}

        {/* Every slot calls the handler that was already there. Nothing here is
            new behaviour and nothing that existed was dropped: resign, draw,
            voice, invite and the board settings are the same five sends. */}
        <ActionDock
          width={size}
          accent={CR.line}
          actions={G.result
            ? [
                { key: 'share', ion: 'share-social-outline', label: 'Share',
                  onPress: () => { void shareResult('chess', G.winner === myColor); } },
                { key: 'talk', ion: voice.muted ? 'mic-off-outline' : 'mic-outline',
                  label: 'Talk at the table', badge: voiceLabel, tone: voiceOn ? 'accent' : 'glass',
                  onPress: () => setVoiceOpen(true) },
                { key: 'invite', ion: 'person-add-outline', label: 'Invite',
                  disabled: !roomId, onPress: () => { void openInvite('chess', roomId); } },
              ]
            : [
                { key: 'resign', ion: 'flag-outline', label: 'Resign', tone: 'danger',
                  onPress: () => send({ t: 'resign' }) },
                { key: 'draw', ion: 'hand-left-outline', label: 'Draw',
                  onPress: () => send({ t: 'draw-offer' }) },
                { key: 'talk', ion: voice.muted ? 'mic-off-outline' : 'mic-outline',
                  label: 'Talk at the table', badge: voiceLabel, tone: voiceOn ? 'accent' : 'glass',
                  onPress: () => setVoiceOpen(true) },
                { key: 'invite', ion: 'person-add-outline', label: 'Invite',
                  disabled: !roomId, onPress: () => { void openInvite('chess', roomId); } },
              ]}
        />

        {/* Only once somebody is actually in the channel. Idle, the dock's Talk
            button is the whole control; live, this is where mute lives. */}
        {voice.phase !== 'off' && (
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
        )}

        <VoiceSheet
          visible={voiceOpen}
          voice={voice}
          nameOf={nameOfPlayer}
          onClose={() => setVoiceOpen(false)}
        />

        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ alignItems: 'center', marginTop: S[2] }}
        >
          <Text style={{ color: g(0.55), fontSize: 10, fontWeight: '800', letterSpacing: 4 }}>CHESS</Text>
          <Text style={{ color: CR.muted, opacity: 0.5, fontSize: 7.5, fontWeight: '600', letterSpacing: 2 }}>
            MORE THAN A GAME
          </Text>
        </View>
      </ScrollView>

      <Toasts events={events} />
      <Confetti show={!!G.result && G.winner === myColor} />

      {/* "More" — the board settings, the swatches and the move list, which used
          to sit in a column below the dock where a phone never showed them. */}
      <Sheet visible={showSettings} title="Table" onClose={() => setShowSettings(false)}>
        <Swatches value={theme} onChange={pickBoard} />
        <SettingRow
          label="Coordinates"
          hint="Rank and file letters on the board edge"
          value={coords ? 'On' : 'Off'}
          onPress={() => setCoords(v => !v)}
        />
        <SettingRow
          label="Sound"
          value={sound ? 'On' : 'Off'}
          onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }}
        />
        {/* NO SCROLLER OF ITS OWN. Sheet already wraps its children in one, and
            a ScrollView inside a ScrollView on the same axis is a gesture fight
            on Android — the inner one wins and the sheet stops scrolling. The
            sheet's own scroller carries this. */}
        {Array.isArray(G.history) && G.history.length > 0 && (
          <Panel style={{ marginTop: S[2] }}>
            <Text style={{ color: CR.muted, fontSize: t.sm, fontWeight: '800', marginBottom: S[2] }}>Moves</Text>
            <Text style={{ color: CR.muted, fontSize: 12, lineHeight: 20, fontFamily: 'monospace' }}>
              {pairUp(G.history)}
            </Text>
          </Panel>
        )}
      </Sheet>

      {/* One sheet, shared with the hub — see components/games/LeaderboardSheet.
          It opens on the chess table because that is what a player standing at
          the chess board is asking about; every other tab is one tap away. */}
      <LeaderboardSheet
        visible={statsOpen}
        onClose={() => setStatsOpen(false)}
        initialScope="chess"
      />

      <PlayersSheet
        visible={playersOpen}
        onClose={() => setPlayersOpen(false)}
        state={state}
        myColor={myColor}
        roomId={roomId}
      />

      {promo && (
        <PromoPicker
          opts={promo.opts}
          color={myColor ?? 'w'}
          onPick={(m) => { playSfx('promote'); send({ t: 'move', from: m.from, to: m.to, promo: m.promo }); setPromo(null); setSel(null); }}
          onCancel={() => setPromo(null)}
          ink={th.ink}
        />
      )}
    </TableBackground>
  );
}

/* ── one square ─────────────────────────────────────────────────────── */

/**
 * MEMOISED, and it takes `onPress(sq)` rather than a closure.
 *
 * 64 of these mount, each owning a shared value and an effect, and every one
 * was rebuilt on every render of the screen — including the one-second clock
 * tick, which is what put the 250ms frames in this board's p90. The two things
 * that defeated memoisation were an `onPress={() => onSquare(idx)}` literal per
 * square and the unstable `legal`/`board` fallbacks feeding it; both are fixed,
 * so a tick now re-renders the clock and nothing else. A real move still
 * re-renders the squares, which is the point.
 *
 * Ludo's BoardSvg and Rummy's HandCard are both already memoised for the same
 * reason — chess was the board that missed it.
 */
const Square = React.memo(function Square({
  d, sq, cell, bg, tint, check, piece, pieceSize,
  target, capture, slideFrom, onPress, stroke, ink, dot, ring, still,
}: {
  /** Where it is DRAWN (0 = top-left of the board as this player sees it). */
  d: number;
  /** Which square it actually IS (0 = a8). These differ when the board is flipped. */
  sq: number;
  cell: number; bg: string; tint: string | null; check: boolean;
  piece: Piece; pieceSize: number; target: boolean; capture: boolean;
  slideFrom: { dx: number; dy: number; key: string } | null;
  onPress: (sq: number) => void; stroke: number;
  /** All three fall back to the painted-board defaults. See BoardTheme. */
  ink?: Ink; dot?: string; ring?: string;
  /** Reduced motion: the check marker holds instead of pulsing. */
  still?: boolean;
}) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (check && !still) {
      pulse.value = withRepeat(withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
    return () => cancelAnimation(pulse);
  }, [check, still, pulse]);
  const aCheck = useAnimatedStyle(() => ({ opacity: check ? 0.55 - pulse.value * 0.25 : 0 }));

  return (
    <Pressable
      onPress={() => onPress(sq)}
      accessibilityLabel={squareLabel(sq, piece, target, capture)}
      style={{
        position: 'absolute',
        left: (d & 7) * cell, top: (d >> 3) * cell,
        width: cell, height: cell,
        backgroundColor: bg,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {tint ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: tint }} /> : null}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', inset: 0, backgroundColor: CHECK_RED }, aCheck]} />

      {/* Capture ring sits behind the piece; the plain dot marks an empty target. */}
      {target && capture ? (
        <View pointerEvents="none" style={{
          position: 'absolute', width: cell * 0.78, height: cell * 0.78,
          borderRadius: cell * 0.39, borderWidth: 4, borderColor: ring ?? 'rgba(40,35,28,.3)',
        }} />
      ) : null}

      {piece ? <PieceGlyph piece={piece} size={pieceSize} slideFrom={slideFrom} stroke={stroke} ink={ink} still={still} /> : null}

      {target && !capture ? (
        <View pointerEvents="none" style={{
          position: 'absolute', width: cell * 0.3, height: cell * 0.3,
          borderRadius: cell * 0.15, backgroundColor: dot ?? DOT,
        }} />
      ) : null}
    </Pressable>
  );
});

/**
 * The piece, with the last-move slide.
 *
 * Ported from chess.js: the piece is placed at its ORIGIN offset with no
 * animation, then released to zero. Keying on history length as well as the
 * squares means a repeated shuffle still animates each time rather than once.
 */
function PieceGlyph({
  piece, size, slideFrom, stroke, ink, still,
}: {
  piece: NonNullable<Piece>; size: number;
  slideFrom: { dx: number; dy: number; key: string } | null; stroke: number; ink?: Ink;
  still?: boolean;
}) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const played = useRef<string | null>(null);

  useEffect(() => {
    if (!slideFrom || played.current === slideFrom.key) return;
    played.current = slideFrom.key;
    // Reduced motion: the piece is simply THERE. The move still happened and
    // the last-move highlight still marks it; only the travel is dropped.
    if (still) { x.value = 0; y.value = 0; return; }
    x.value = slideFrom.dx;
    y.value = slideFrom.dy;
    const spec = { duration: 200, easing: Easing.bezier(0.2, 0.8, 0.2, 1) };
    x.value = withTiming(0, spec);
    y.value = withTiming(0, spec);
  }, [slideFrom, still, x, y]);

  // Cast: a mixed [{translateX},{translateY}] tuple widens to a union RN's
  // transform type will not accept.
  const a = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={a} pointerEvents="none">
      <OutlinedGlyph t={piece.t} c={piece.c} size={size} stroke={stroke} ink={ink} />
    </Animated.View>
  );
}

/**
 * A piece glyph with a REAL outline, not a glow.
 *
 * The reference client draws white with the hollow glyph set plus a CSS
 * -webkit-text-stroke; RN has neither, and the soft textShadow that stood in
 * for it read as a halo — on the green board a white piece blurred into the
 * light squares instead of sitting on them.
 *
 * Four offset copies of the SAME glyph behind the fill give a crisp edge.
 * Deliberately NOT the hollow set (♔ vs ♚): whether ♔ renders hollow is a
 * font-fallback question, and on a device that answers it the other way the
 * white king would come out solid black. A board where you cannot tell your own
 * pieces apart is a worse bug than a soft edge; one glyph set always renders as
 * one shape.
 *
 * Shared with the promotion picker, which shows the same four pieces at four
 * times the size — the place a mismatched piece style is most obvious.
 */
function OutlinedGlyph({
  t, c, size, stroke, ink,
}: { t: string; c: 'w' | 'b'; size: number; stroke: number; ink?: Ink }) {
  const { fill, line } = (ink ?? PIECE_INK)[c];
  // A letter with no path would draw NOTHING, and an empty square on a chess
  // board reads as a piece that has been captured. Falling back to the pawn is
  // wrong in a way somebody notices rather than wrong in a way nobody does.
  const d = PIECE_PATH[t] ?? PIECE_PATH.p;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          {/* Brass, lit from above: hot cap, body, dark underside. The same
              three tones the board rim uses, so the pieces and the frame read
              as one set of hardware rather than two golds. */}
          <SvgLinear id={`plinth${c}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={CR.gold2} />
            <Stop offset="0.55" stopColor={CR.gold} />
            <Stop offset="1" stopColor={CR.goldDeep} />
          </SvgLinear>
        </Defs>
        {/* CONTACT SHADOW. Without it a piece floats on the square instead of
            standing on it, and that is most of what made the old set read as
            flat glyphs rather than objects. */}
        <Ellipse cx="50" cy="91" rx="33" ry="5.2" fill="#000000" opacity={0.28} />
        {/* The gold ring the piece stands in. Drawn BEFORE the piece so its own
            base slab sits on top of it and only the rim shows. */}
        <Ellipse
          cx="50" cy="88.5" rx="31" ry="6.4"
          fill={`url(#plinth${c})`}
          stroke={CR.goldDeep} strokeWidth="1.1"
        />
        <Path d={d} fill={fill} stroke={line} strokeWidth={stroke} strokeLinejoin="round" />
      </Svg>
    </View>
  );
}

/* ── chrome ─────────────────────────────────────────────────────────── */

/**
 * A player card: who, what they are doing, and how long they have to do it.
 *
 * Every field is the LIVE one — `name` comes from the lobby roster, `clock`
 * from the server's clock frame through clockFor(), `role` from the same game
 * state the board renders, `bot` from the roster's own isBot flag. There is no
 * placeholder anywhere in here; an absent clock renders nothing rather than
 * a zero, exactly as TurnClock does in ui.tsx.
 *
 * The captured pieces and the material edge ride on the role line rather than
 * a line of their own, so the card is the same height all game.
 */
function Seat({
  name, role, bot, glyph, clock, taken, edge, active, width,
}: {
  name: string; role: string; bot: boolean; glyph: string; clock: string | null;
  taken: string[]; edge: number; active: boolean; width: number;
}) {
  const t = useType();
  const material = `${taken.join('')}${edge > 0 ? `  +${edge}` : ''}`;
  return (
    <View
      accessibilityLabel={
        `${name}${bot ? ', bot' : ''}. ${role}.` +
        (material ? ` Captured ${material}.` : '') +
        (clock ? ` ${clock} on the clock.` : '')
      }
      style={{
        width, flexDirection: 'row', alignItems: 'center', gap: S[3],
        paddingVertical: S[2], paddingHorizontal: S[3],
        borderRadius: R[4], borderWidth: 1,
        // An active seat is LIT and gold-edged. Gold is this screen's one
        // accent and the seat to move is where it earns its place.
        borderColor: active ? CR.lineSoft : white(0.16),
        backgroundColor: white(active ? 0.12 : 0.07),
        boxShadow: active
          ? `0 10px 26px rgba(0,0,0,0.44), inset 0 1px 0 ${white(0.26)}, inset 0 -1px 0 rgba(0,0,0,0.32)`
          : `0 6px 18px rgba(0,0,0,0.30), inset 0 1px 0 ${white(0.16)}, inset 0 -1px 0 rgba(0,0,0,0.30)`,
      }}
    >
      {/* The sheen that makes a pane look like glass rather than a tinted box.
          Gentle by necessity, not by taste: it brightens the surface exactly
          where the role line sits, and CR.muted carries a contrast note that
          had to be recomputed for it. */}
      <LinearGradient
        pointerEvents="none"
        colors={[white(0.10), white(0.02), 'transparent']}
        locations={[0, 0.5, 1]}
        start={{ x: 0.08, y: 0 }}
        end={{ x: 0.92, y: 1 }}
        style={[StyleSheet.absoluteFillObject, { borderRadius: R[4] }]}
      />
      <View>
        <View style={{
          width: 40, height: 40, borderRadius: 20,
          alignItems: 'center', justifyContent: 'center',
          borderWidth: 1, borderColor: g(active ? 0.55 : 0.28),
          backgroundColor: white(0.12),
        }}>
          <Text style={{ fontSize: 22, color: CR.gold2 }}>{glyph}</Text>
        </View>
        {/* THE AVATAR IS A GLYPH, NOT A PHOTO, and that is a protocol fact
            rather than a style choice: the lobby roster is
            {vaultId, name, isBot, wins} and carries no image anywhere, so a
            photograph would need a server change. The crown is the reference's
            seat mark and costs nothing. */}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ position: 'absolute', top: -5, right: -3, fontSize: 12, color: CR.gold2 }}
        >
          ♛
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: CR.text, fontSize: t.md, fontWeight: '800' }}>{name}</Text>
        <Text numberOfLines={1} style={{ color: CR.muted, fontSize: t.sm }}>
          {material ? `${role}  ·  ${material}` : role}
        </Text>
      </View>

      {clock ? (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: S[1] + 2,
          paddingHorizontal: S[3], paddingVertical: S[1] + 2, borderRadius: R.pill,
          borderWidth: 1, borderColor: g(active ? 0.60 : 0.35),
          backgroundColor: active ? g(0.16) : white(0.07),
        }}>
          <Ionicons name="time-outline" size={15} color={active ? '#FFDD9E' : CR.gold2} />
          <Text
            numberOfLines={1}
            style={{ color: active ? '#FFDD9E' : '#EFE3D0', fontSize: t.md, fontWeight: '800', fontFamily: 'monospace' }}
          >
            {clock}
          </Text>
        </View>
      ) : null}

      {/* AI PRO — the opponent's own mark, and only when the roster says bot. */}
      {bot ? (
        <View style={{
          width: 40, paddingVertical: S[1], borderRadius: R[2], alignItems: 'center',
          borderWidth: 1, borderColor: g(0.6), backgroundColor: g(0.14),
        }}>
          <Text style={{ color: CR.gold2, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 }}>AI</Text>
          <Text style={{ color: CR.line, fontSize: 7.5, fontWeight: '800', letterSpacing: 0.6 }}>PRO</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * What the table is doing, in one pill.
 *
 * REPLACES the full-width Banner. The banner was a slab as wide as the board
 * carrying two words, and on a phone it cost more vertical space than the seat
 * card above it. The information did not shrink with it — this says strictly
 * more than the banner did, because connecting and reconnecting are now states
 * it can express rather than a separate row somewhere else.
 *
 * The dot is never the only signal. Every state ships a word, so the pill is
 * readable with no colour vision at all, and `accessibilityLiveRegion` is
 * carried over from Banner so the change is announced rather than merely drawn.
 */
function StatusPill({
  game, myColor, mine, spectator, phase, reconnecting, still, width,
}: {
  game: any; myColor: 'w' | 'b' | null; mine: boolean; spectator: boolean;
  phase: string; reconnecting: boolean; still: boolean; width: number;
}) {
  const t = useType();
  const s = statusOf(game, myColor, mine, spectator, phase, reconnecting);
  const pulse = useSharedValue(0);

  // Only the seat to move breathes, and only when the player has not asked the
  // system for less motion.
  const live = s.beat && !still;
  useEffect(() => {
    if (live) {
      pulse.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
    return () => cancelAnimation(pulse);
  }, [live, pulse]);
  const aDot = useAnimatedStyle(() => ({ opacity: 1 - pulse.value * 0.55 }));

  return (
    <View style={{ width, alignItems: 'center', gap: S[2] }}>
      <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: S[3] }}>
        {/* The two rules the reference runs out to the edges. Decorative, and
            hidden from a screen reader for exactly that reason. */}
        <View accessibilityElementsHidden importantForAccessibility="no"
          style={{ flex: 1, height: 1, backgroundColor: g(0.26) }} />
        <View
          accessibilityLiveRegion="polite"
          accessibilityLabel={s.text}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: S[2],
            paddingVertical: S[2] + 2, paddingHorizontal: S[4],
            borderRadius: R.pill, borderWidth: 1, borderColor: s.tone,
            backgroundColor: alpha(s.tone, 0.14),
            boxShadow: `0 8px 22px rgba(0,0,0,0.36), inset 0 1px 0 ${white(0.18)}`,
          }}
        >
          <Animated.View
            style={[{ width: 9, height: 9, borderRadius: 5, backgroundColor: s.tone }, aDot]}
          />
          <Text numberOfLines={1} style={{ color: CR.text, fontSize: t.md, fontWeight: '800' }}>{s.text}</Text>
        </View>
        <View accessibilityElementsHidden importantForAccessibility="no"
          style={{ flex: 1, height: 1, backgroundColor: g(0.26) }} />
      </View>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ color: CR.muted, fontSize: 11.5, fontWeight: '500' }}
      >
        Good moves create great stories
      </Text>
    </View>
  );
}

/**
 * The whole status vocabulary, in one place.
 *
 * Nothing here is invented: every branch is a state the socket already puts on
 * screen somewhere. `result` and `winner` come off the game frame, `check` off
 * the same frame the board reads, `phase` off the shared socket hook, and
 * `spectator` off the seat the server gave this client.
 */
function statusOf(
  game: any, myColor: 'w' | 'b' | null, mine: boolean,
  spectator: boolean, phase: string, reconnecting: boolean,
): { text: string; tone: string; beat?: boolean } {
  if (game.result) {
    const won = game.winner && game.winner === myColor;
    return { text: resultText(game, myColor), tone: won ? CR.ok : game.winner ? CR.bad : CR.warn };
  }
  if (reconnecting) return { text: 'Reconnecting', tone: CR.warn, beat: true };
  if (phase !== 'connected') return { text: 'Connecting', tone: CR.warn, beat: true };
  if (spectator) return { text: 'Watching', tone: ACCENT.chess };
  if (game.check) return { text: mine ? 'Check — your move' : 'Check', tone: CR.bad, beat: mine };
  return mine
    ? { text: 'Your move', tone: CR.line, beat: true }
    : { text: 'Opponent’s move', tone: ACCENT.chess };
}

/**
 * Who is at this table.
 *
 * The seat cards above the board say who is playing and whose move it is; this
 * says what they have won, which side each is on, and how to get another person
 * here. It reads the SAME lobby roster the lobby screen renders — there is no
 * second player list to fall out of step with it.
 */
function PlayersSheet({
  visible, onClose, state, myColor, roomId,
}: {
  visible: boolean; onClose: () => void; state: GameState;
  myColor: 'w' | 'b' | null; roomId: string;
}) {
  const t = useType();
  const members = state.lobby?.members ?? [];

  // A SIDE IS ONLY CLAIMED WHEN IT IS ACTUALLY DERIVABLE. The frame carries
  // `color` for THIS client and nobody else, so the other seat's colour is an
  // inference that holds for exactly two seated players and breaks the moment
  // there are three. A roster that guesses is worse than one that says nothing.
  const canSay = members.length === 2 && myColor != null;
  const sideOf = (id: string): string | null => {
    if (!canSay) return null;
    const mineSide = myColor === 'w' ? 'White' : 'Black';
    const theirs = myColor === 'w' ? 'Black' : 'White';
    return id === state.you ? mineSide : theirs;
  };

  return (
    <Sheet visible={visible} title="At this table" onClose={onClose}>
      {members.length === 0 ? (
        <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 19 }}>
          The table has not sent its seats yet.
        </Text>
      ) : members.map(m => (
        <PlayerRow
          key={m.vaultId}
          name={m.name}
          tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
          subtitle={
            [sideOf(m.vaultId), typeof m.wins === 'number' ? `${m.wins} wins` : null]
              .filter(Boolean).join('  ·  ') || undefined
          }
        />
      ))}

      {state.spectator ? (
        <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 19 }}>
          You are watching this game, not playing it.
        </Text>
      ) : null}

      {!!roomId && (
        <Text style={{ color: CR.muted, fontSize: t.sm }} selectable>
          Room code: <Text style={{ color: CR.gold2, fontWeight: '800' }}>{roomId}</Text>
        </Text>
      )}

      <Btn
        label="Invite a friend"
        icon="link"
        onPress={() => { void openInvite('chess', roomId); }}
        disabled={!roomId}
      />
    </Sheet>
  );
}

function Swatches({ value, onChange }: { value: ThemeName; onChange: (n: ThemeName) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: S[2], justifyContent: 'center', paddingVertical: S[2] }}>
      {(Object.keys(THEMES) as ThemeName[]).map(n => (
        <Pressable
          key={n}
          onPress={() => onChange(n)}
          accessibilityRole="button"
          accessibilityLabel={`${n} board`}
          accessibilityState={{ selected: value === n }}
          // 34dp is 10dp short of the 44dp floor this file uses elsewhere
          // (Ludo.tsx's tokens). The row's own gap is 8dp, so a symmetric
          // hitSlop of 5 would overlap the neighbour by 2dp either side —
          // asymmetric instead: 5 top/bottom reaches 44 vertically, 4
          // left/right reaches 42 horizontally with the gap untouched.
          hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
          style={{
            width: 34, height: 34, borderRadius: R[1], overflow: 'hidden', flexDirection: 'row',
            borderWidth: 2, borderColor: value === n ? CR.line : white(0.16),
            // Every board theme is opaque now, so this backdrop is covered in
            // all seven cases — it is kept because a translucent theme added
            // later would otherwise preview against nothing. CR_LIT is the room
            // as it actually composites, not CR.bg, which is the ground before
            // the ambient wash and a colour no real pixel is.
            backgroundColor: CR_LIT,
          }}
        >
          <View style={{ flex: 1, backgroundColor: THEMES[n].light }} />
          <View style={{ flex: 1, backgroundColor: THEMES[n].dark }} />
        </Pressable>
      ))}
    </View>
  );
}

function PromoPicker({
  opts, color, onPick, onCancel, ink,
}: {
  opts: Move[]; color: 'w' | 'b'; onPick: (m: Move) => void; onCancel: () => void;
  /** The board's ink. Without it the picker offers a BLACK queen while every
   *  piece on the glass board behind it is ice — the exact mismatch
   *  OutlinedGlyph's own comment warns is most obvious here. */
  ink?: Ink;
}) {
  const seen = new Set<string>();
  const choices = opts.filter(o => o.promo && !seen.has(o.promo) && seen.add(o.promo));
  return (
    // `accessible={false}`: the default would make this backdrop swallow its
    // whole subtree into one unlabelled node, same defect as Sheet — the four
    // "Promote to Q/R/B/N" buttons below would announce as nothing. Tapping
    // the backdrop to cancel is a sighted-only convenience either way, so an
    // explicit Cancel button carries that action for accessibility instead.
    <Pressable
      onPress={onCancel}
      accessible={false}
      style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(3,12,9,.76)', alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3], padding: S[4], borderRadius: R[3],
        backgroundColor: white(0.10), borderWidth: 1, borderColor: CR.lineSoft,
        boxShadow: `0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 ${white(0.18)}`,
      }}>
        {choices.map(m => (
          <Pressable key={m.promo} onPress={() => onPick(m)} accessibilityRole="button" accessibilityLabel={`Promote to ${m.promo}`}>
            <OutlinedGlyph t={m.promo as string} c={color} size={46} stroke={PIECE_STROKE} ink={ink} />
          </Pressable>
        ))}
        {/* A bare Text in a Pressable is a ~16dp-tall target, and it is the only
            AT-reachable way out of this picker — the backdrop tap is
            sighted-only by design (see the comment above). */}
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: S[2], alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function Lobby({
  state, events, onAddBot, onStart, botLevel, onBotLevel, voice, code,
}: {
  state: GameState; events: string[]; onAddBot: () => void; onStart: () => void;
  botLevel: number; onBotLevel: (n: number) => void; voice: TableVoice; code: string;
}) {
  const t = useType();
  const members = state.lobby?.members ?? [];
  const host = state.lobby?.hostId === state.you;
  // Offered once, in the lobby — before a move is ever required.
  const rules = useFirstTimeRules('chess');
  // The server can accept `addbot` and never seat one. The payload stays the
  // caller's (chess sends a level); this only watches whether a seat appeared.
  const bot = useAddBot(() => onAddBot(), members.length);
  return (
    <TableBackground bg={CR.bg} ambient={CR_AMBIENT} bokeh={CR_BOKEH} vignette={CR_VIGNETTE}>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3] }}>
        <Text style={{ color: CR.gold2, fontSize: t.xl, fontWeight: '800', letterSpacing: 0.4 }}>Chess</Text>
        <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 19 }}>
          Every move is validated by the table, and your legal moves arrive from it — so the board you see is exactly the board your opponent sees.
        </Text>
        <Panel style={{ gap: S[2] }}>
          {members.map(m => (
            <PlayerRow
              key={m.vaultId}
              name={m.name}
              tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
              subtitle={typeof m.wins === 'number' ? `${m.wins} wins` : undefined}
            />
          ))}
          {members.length < 2 && (
            <Text style={{ color: C.muted, fontSize: t.sm }}>Two players minimum — add a bot to start now.</Text>
          )}
        </Panel>
        <View style={{ flexDirection: 'row', gap: S[2], alignItems: 'center' }}>
          <Text style={{ flex: 1, color: C.muted, fontSize: t.sm }}>Bot strength</Text>
          {[1, 2, 3].map(n => (
            <Btn
              key={n}
              label={['Easy', 'Even', 'Hard'][n - 1]}
              compact
              kind={botLevel === n ? 'gold' : 'secondary'}
              onPress={() => onBotLevel(n)}
            />
          ))}
        </View>
        {!!code && (
          <Text style={{ color: C.muted, fontSize: t.sm }} selectable>
            Room code: <Text style={{ color: CR.gold2, fontWeight: '800' }}>{code}</Text>
          </Text>
        )}
        {/* Voice while you WAIT, not only once the game is running. A private
            room is two people arriving at the same table; that is the moment
            they want to talk. */}
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
        {/* Inviting belongs HERE, not only on the board. Chess had its invite
            behind the first move — you could only ask someone to join a game
            that had already started, which is the wrong moment and the reason
            an empty chess lobby had no way out except a bot. */}
        <Btn label="Invite a friend" icon="link" onPress={() => { void openInvite('chess', code); }} disabled={!code} />
        <Btn label="Add a bot" icon="bot" onPress={() => bot.addBot()} />
        {/* Seen on a device: the tap lands, no error comes back, and no bot
            ever arrives — so "Start game" stays disabled forever and the
            button is simply dead. There is no ack for `addbot`, so absence is
            the only evidence we have; saying nothing is the real bug. */}
        {bot.stalled && (
          <Text style={{ color: CR.bad, fontSize: t.sm, lineHeight: 18 }}>{ADD_BOT_STALLED}</Text>
        )}
        <Btn label="Start game" kind="gold" onPress={onStart} disabled={!host || members.length < 2} />
      </ScrollView>
      <Toasts events={events} />
      <RulesSheet game="chess" visible={rules.visible} onClose={rules.close} />
    </TableBackground>
  );
}

function Connecting({ phase, error, onRetry }: { phase: string; error: string | null; onRetry: () => void }) {
  const t = useType();
  return (
    <TableBackground bg={CR.bg} ambient={CR_AMBIENT} bokeh={CR_BOKEH} vignette={CR_VIGNETTE} style={{ alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
      <Text style={{ fontSize: 46 }}>♚</Text>
      <Text style={{ color: C.text, fontSize: t.lg, fontWeight: '800' }}>
        {error ? 'Could not reach the table' : 'Connecting…'}
      </Text>
      {error ? <Text style={{ color: C.muted, fontSize: t.sm, textAlign: 'center' }}>{error}</Text> : null}
      {error ? <Btn label="Try again" kind="gold" onPress={onRetry} /> : null}
    </TableBackground>
  );
}

/* ── helpers ────────────────────────────────────────────────────────── */

/** What each side has lost, plus the material edge. Presentation only. */
function takenBy(board: Piece[]): { w: string[]; b: string[]; edge: number } {
  const alive: Record<'w' | 'b', Record<string, number>> = { w: {}, b: {} };
  for (const p of board) if (p) alive[p.c][p.t] = (alive[p.c][p.t] ?? 0) + 1;
  const out = { w: [] as string[], b: [] as string[], edge: 0 };
  for (const side of ['w', 'b'] as const) {
    for (const letter of Object.keys(ARMY)) {
      const gone = ARMY[letter] - (alive[side][letter] ?? 0);
      for (let i = 0; i < gone; i++) out[side].push(GLYPH[letter]);
      out.edge += (side === 'b' ? 1 : -1) * gone * VALUE[letter];
    }
  }
  return out;
}

function clockFor(state: GameState, color: 'w' | 'b'): string | null {
  const c = state.raw?.clock;
  const ms = c && typeof c === 'object' ? c[color] : null;
  if (typeof ms !== 'number' || !isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The name this client plays under. Falls back to a label, never to an id. */
function youName(state: GameState): string {
  const me = (state.lobby?.members ?? []).find(m => m.vaultId === state.you);
  return me?.name ?? 'You';
}

/** Whether the other seat is a bot, from the roster the server sent. */
function opponentIsBot(state: GameState): boolean {
  const them = (state.lobby?.members ?? []).find(m => m.vaultId !== state.you);
  return !!them?.isBot;
}

/**
 * What a seat is doing, for the card's second line.
 *
 * Derived from the same frame the board renders — there is no separate seat
 * state to fall out of step with it.
 */
function roleOf(state: GameState, game: any, isYou: boolean, mine: boolean): string {
  if (game?.result) return 'Game over';
  if (isYou) {
    if (state.spectator) return 'Watching';
    return mine ? (game?.check ? 'You are in check' : 'Play your move') : 'Waiting';
  }
  const bot = opponentIsBot(state);
  if (!mine) return bot ? 'Thinking…' : 'To move';
  return bot ? 'AI Challenger' : 'Waiting';
}

function opponentName(state: GameState): string {
  const them = (state.lobby?.members ?? []).find(m => m.vaultId !== state.you);
  return them?.name ?? 'Opponent';
}

function resultText(game: any, myColor: 'w' | 'b' | null): string {
  if (game.result === 'draw') return 'Draw';
  if (game.winner) return `${game.winner === myColor ? 'You win' : 'You lose'}`;
  return String(game.result ?? 'Game over');
}

function pairUp(history: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    out.push(`${i / 2 + 1}. ${history[i] ?? ''} ${history[i + 1] ?? ''}`.trimEnd());
  }
  return out.join('   ');
}

/**
 * What a screen reader says about a square.
 *
 * TAKES THE REAL SQUARE, NOT THE DRAWN POSITION. It used to take the display
 * index, so on a flipped board — every game the player has black — each square
 * was announced with its mirrored name: the pawn on e4 read as "d5", and a
 * player using a screen reader was told a position that does not exist. The
 * VISIBLE coordinates were always right (they undo the flip explicitly), which
 * is why this survived: it is invisible to anyone looking at the board.
 */
function squareLabel(sq: number, piece: Piece, target: boolean, capture: boolean): string {
  const name = `${FILES[sq & 7]}${8 - (sq >> 3)}`;
  const what = piece ? `${piece.c === 'w' ? 'white' : 'black'} ${piece.t}` : 'empty';
  const hint = capture ? ', can capture' : target ? ', can move here' : '';
  return `${name}, ${what}${hint}`;
}
