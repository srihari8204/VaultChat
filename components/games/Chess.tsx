import { chessTttLayout } from '../../lib/games/chessTttLayout';
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
 *
 * The pieces of this screen live beside it in components/games/chess/: the
 * board's look (style.ts), a square (Square.tsx), the seats and status pill
 * (Seat.tsx), the sheets and promotion picker (Sheets.tsx) and the lobby
 * (Lobby.tsx). The read-outs (captured material, clocks, names) are pure and
 * tested in lib/games/chessView.ts; what a screen reader says is
 * lib/games/boardLabels.ts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, ScrollView, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useGameSocket, type AutoStart } from '../../lib/games/useGameSocket';
import {
  TableBackground, Btn, Panel, Reconnecting, RematchBtn, ActionDock, RoundBtn,
  useType, useBoardBox, useReduceMotion, useAnnounce,
} from './ui';
import { useRematch } from '../../lib/games/useRematch';
import LeaderboardSheet from './LeaderboardSheet';
import { S, R, white } from '../../lib/games/theme';
import { CR, CR_AMBIENT, CR_BOKEH, CR_VIGNETTE, g } from '../../lib/games/chessRoom';
import { playSfx, preloadSfx, soundEnabled, setSoundEnabled } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow, VoiceBar, VoiceSheet } from './feedback';
import { useTableVoice } from '../../lib/games/useTableVoice';
import { openInvite, shareResult } from '../../lib/games/invite';
import { chessSelectionAnnouncement } from '../../lib/games/boardLabels';
import {
  takenBy, clockFor, youName, opponentIsBot, roleOf, opponentName, pairUp, type Piece,
} from '../../lib/games/chessView';
import {
  THEMES, isThemeName, FILES, PIECE_STROKE, RIM, RAIL_RATIO, RAIL_MIN, RAIL_MAX, FELT, RAIL_INK,
  DRAW_OFFER_INK, type BoardTheme, type ThemeName, type Move,
} from './chess/style';
import { Square } from './chess/Square';
import { Seat, StatusPill } from './chess/Seat';
import { PlayersSheet, Swatches, PromoPicker } from './chess/Sheets';
import { Lobby, Connecting } from './chess/Lobby';

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
let boardPref: ThemeName = 'glass';
AsyncStorage.getItem(BOARD_KEY)
  .then(v => { if (isThemeName(v)) boardPref = v; })
  .catch(() => {});

/** Stable empties, so an absent board does not churn every consumer. */
const NO_MOVES: Move[] = [];
const NO_BOARD: Piece[] = [];

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
  const reduceMotion = useReduceMotion();
  // 300, not 360. The chrome shrank with the redesign: the full-width status
  // banner became a pill, the swatch row and the move list moved into the
  // sheet, and the voice bar only appears once someone is in the channel. An
  // estimate that is too LARGE is not safe — it is a smaller board than the
  // screen can hold, on every device.
  const viewport = useBoardBox(300);
  const { wide, size, controlsWidth } = chessTttLayout(viewport.width, viewport.height, viewport.size);
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

  // Picking a piece up changes nothing a live region shows, so it is spoken
  // directly: which piece, and how many squares it can go to.
  useAnnounce(sel != null ? chessSelectionAnnouncement(sel, board[sel] ?? null, movesFromSel.length) : null, true);
  // The draw offer is a question; the banner carries a live region for Android.
  useAnnounce(drawOffer && !G?.result ? 'Your opponent offers a draw' : null);

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

  const boardView = (
    <>
        {/* The rim is a GRADIENT, so it has to be a view of its own wrapping the
            board — RN borderColor takes one colour. It adds RIM*2 to the width
            and nothing to `size`, so the cell geometry, the touch targets and
            every coordinate below are exactly what they were. */}
        <LinearGradient
          colors={[white(0.8), CR.gold, CR.goldDeep]}
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
                allowFontScaling={false}
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
                allowFontScaling={false}
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
                  pieceSize={cell * 0.94}
                  selected={isSel}
                  last={isLast}
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
                  dot={theme === 'glass' && !light ? 'rgba(240,248,242,.75)' : th.dot}
                  ring={theme === 'glass' && !light ? 'rgba(240,248,242,.85)' : th.ring}
                  onPress={onSquare}
                  stroke={stroke}
                  still={reduceMotion}
                  interactive={mine && !state.spectator}
                />
              );
            })}
            </View>
          </View>
        </LinearGradient>
    </>
  );

  return (
    // The chess room, not the shared maroon card table. See lib/games/chessRoom.
    <TableBackground bg={CR.bg} ambient={CR_AMBIENT} bokeh={CR_BOKEH} vignette={CR_VIGNETTE}>
      <View onLayout={viewport.onLayout} style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
      {wide && <ScrollView style={{ width: size + 32, flexGrow: 0 }} contentContainerStyle={{ padding: 16, alignItems: 'center' }}>{boardView}</ScrollView>}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: S[4], paddingTop: S[2], gap: S[3],
          alignItems: 'center',
          // GamesScreen already owns the live safe-area inset.
          paddingBottom: S[6],
        }}
      >
        {/* The strip the reference puts in the header. GameChrome above this
            board owns Back and the title (it used to say "the navigator header"
            owns them — it did not; the stack is headerShown:false and this
            screen had no way out at all), so duplicating either here would give
            the screen two ways back; these are the controls it does NOT already
            carry. Both open sheets built on data that was already on the
            screen — neither is a new request to the server. */}
        <View style={{ width: controlsWidth, flexDirection: 'row', alignItems: 'center', gap: S[2] }}>
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            numberOfLines={1}
            style={{ flex: 1, color: g(0.85), fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }}
          >
            PLAY  •  CONNECT  •  CHALLENGE
          </Text>
          <RoundBtn ion="stats-chart-outline" label="Standings" onPress={() => setStatsOpen(true)} />
          <RoundBtn ion="people-outline" label="Who is at this table" onPress={() => setPlayersOpen(true)} />
          <RoundBtn ion="settings-outline" label="Board settings" onPress={() => setShowSettings(true)} />
        </View>

        {reconnecting && (
          <View style={{ width: controlsWidth }}><Reconnecting error={error} onRetry={retry} /></View>
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
          width={controlsWidth}
        />

        {!wide && boardView}

        <Seat
          name={youName(state)}
          role={roleOf(state, G, true, mine)}
          bot={false}
          glyph={myColor === 'w' ? '♔' : '♚'}
          clock={clockFor(state, myColor ?? 'w')}
          taken={captured[myColor === 'w' ? 'b' : 'w']}
          edge={captured.edge * (myColor === 'w' ? 1 : -1)}
          active={mine && G.result == null}
          width={controlsWidth}
        />

        <StatusPill
          game={G}
          myColor={myColor}
          mine={mine}
          spectator={state.spectator}
          phase={phase}
          reconnecting={reconnecting}
          still={reduceMotion}
          width={controlsWidth}
        />

        {drawOffer && !G.result && (
          <View accessibilityLiveRegion="polite" style={{
            width: controlsWidth, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: S[2],
            padding: S[3], borderRadius: R[2],
            borderWidth: 1, borderColor: CR.lineSoft, backgroundColor: g(0.12),
          }}>
            <Text style={{ width: '100%', color: DRAW_OFFER_INK, fontSize: t.sm, fontWeight: '700' }}>
              Your opponent offers a draw
            </Text>
            <Btn label="Accept" accessibilityLabel="Accept the draw" kind="gold" compact onPress={() => { send({ t: 'draw-accept' }); setDrawOffer(false); }} />
            <Btn label="No" accessibilityLabel="Decline the draw" compact onPress={() => setDrawOffer(false)} />
          </View>
        )}

        {/* The rematch keeps a row of its own rather than a dock slot: it is the
            primary action once a game ends, and RematchBtn has four states — one
            of them reads "they did not come back, invite them" and needs the
            width to say so. */}
        {G.result ? (
          <View style={{ flexDirection: 'row', gap: S[2], width: controlsWidth }}>
            <RematchBtn rm={rematch} />
          </View>
        ) : null}

        {/* Every slot calls the handler that was already there. Nothing here is
            new behaviour and nothing that existed was dropped: resign, draw,
            voice, invite and the board settings are the same five sends. */}
        <ActionDock
          width={controlsWidth}
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
                  onPress: () => Alert.alert('Resign this game?', 'Your opponent wins. This cannot be undone.', [
                    { text: 'Keep playing', style: 'cancel' },
                    { text: 'Resign', style: 'destructive', onPress: () => send({ t: 'resign' }) },
                  ]) },
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
            width={controlsWidth}
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
          <Text style={{ color: g(0.85), fontSize: 10, fontWeight: '800', letterSpacing: 4 }}>CHESS</Text>
          <Text style={{ color: CR.muted, opacity: 0.85, fontSize: 9, fontWeight: '600', letterSpacing: 2 }}>
            MORE THAN A GAME
          </Text>
        </View>
      </ScrollView>
      </View>

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
          checked={coords}
          onPress={() => setCoords(v => !v)}
        />
        <SettingRow
          label="Sound"
          value={sound ? 'On' : 'Off'}
          checked={sound}
          onPress={() => { const n = !sound; setSound(n); void setSoundEnabled(n); }}
        />
        {/* NO SCROLLER OF ITS OWN. Sheet already wraps its children in one, and
            a ScrollView inside a ScrollView on the same axis is a gesture fight
            on Android — the inner one wins and the sheet stops scrolling. The
            sheet's own scroller carries this. */}
        {Array.isArray(G.history) && G.history.length > 0 && (
          <Panel style={{ marginTop: S[2] }}>
            <Text accessibilityRole="header" style={{ color: CR.muted, fontSize: t.sm, fontWeight: '800', marginBottom: S[2] }}>Moves</Text>
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
