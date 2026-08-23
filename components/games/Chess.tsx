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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, withSequence,
  Easing, cancelAnimation, type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useGameSocket, isMyTurn, type GameState, type AutoStart } from '../../lib/games/useGameSocket';
import { Btn, Panel, Banner, PlayerRow, Chip, useType } from './ui';
import { C, S, R, D3, E, mix, goldLine } from '../../lib/games/theme';
import { playSfx, preloadSfx } from '../../lib/games/sfx';
import { Toasts, Confetti, Sheet, SettingRow } from './feedback';
import { inviteToTable, shareResult } from '../../lib/games/invite';
import { soundEnabled, setSoundEnabled } from '../../lib/games/sfx';

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

/** chess.com board themes, from games-web/chess.js BOARD_THEMES. */
const THEMES = {
  classic:    { light: '#ece6d3', dark: '#6f6253', hl: 'rgba(214,175,99,.50)', sel: 'rgba(214,175,99,.68)' },
  green:      { light: '#ebecd0', dark: '#739552', hl: 'rgba(155,199,0,.45)',  sel: 'rgba(155,199,0,.55)' },
  blue:       { light: '#dee3e6', dark: '#8ca2ad', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
  brown:      { light: '#f0d9b5', dark: '#b58863', hl: 'rgba(205,210,106,.45)', sel: 'rgba(205,210,106,.55)' },
  midnight:   { light: '#b7c6d8', dark: '#3a4b66', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
} as const;
type ThemeName = keyof typeof THEMES;

const FILES = 'abcdefgh';
const CHECK_TINT = 'rgba(225,90,90,.55)';
const DOT = 'rgba(40,35,28,.32)';

/** Material value per piece letter, for the captured-material readout. */
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** A full starting army, by letter. Used only to derive what has been taken. */
const ARMY: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

export default function Chess({ roomId, auto, autoBot }: { roomId: string } & AutoStart) {
  const { phase, error, state, events, send, retry } = useGameSocket('chess', roomId, { auto, autoBot });
  const [sel, setSel] = useState<number | null>(null);
  const [promo, setPromo] = useState<{ from: number; to: number; opts: Move[] } | null>(null);
  const [theme, setTheme] = useState<ThemeName>('classic');
  const [showSettings, setShowSettings] = useState(false);
  const [coords, setCoords] = useState(true);
  const [sound, setSound] = useState(soundEnabled());
  // A draw offer is a question that has to be answerable. The web shows a
  // banner with Accept; without it the offer arrives as a toast that scrolls
  // away and the player has no way to say yes.
  const [drawOffer, setDrawOffer] = useState(false);
  const [botLevel, setBotLevel] = useState(2);
  const t = useType();
  const { width } = useWindowDimensions();

  const G = state.game;
  // Chess seats by COLOUR, not seat index, and both `color` and `legal` ride at
  // the top level of the frame beside `game`.
  const myColor: 'w' | 'b' | null = state.raw?.color ?? null;
  const legal: Move[] = Array.isArray(state.raw?.legal) ? state.raw.legal : [];
  const board: Piece[] = Array.isArray(G?.board) ? G.board : [];
  const lastMove: Move | null = G?.lastMove ?? null;
  const mine = isMyTurn(state);

  const th = THEMES[theme];
  const size = Math.min(width - S[4] * 2, 460);
  const cell = size / 8;

  // Black plays from the far side, so the board is flipped for them.
  const flipped = myColor === 'b';
  const toDisplay = (idx: number) => (flipped ? 63 - idx : idx);
  const fromDisplay = (d: number) => (flipped ? 63 - d : d);

  const movesFromSel = useMemo(
    () => (sel == null ? [] : legal.filter(m => m.from === sel)),
    [sel, legal],
  );
  const targets = useMemo(() => new Set(movesFromSel.map(m => m.to)), [movesFromSel]);

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
    playSfx(G.result === 'draw' || !G.winner ? 'draw' : G.winner === state.you ? 'win' : 'lose');
  }, [G?.result, G?.winner, state.you]);

  const onSquare = (i: number) => {
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
  };

  if (phase !== 'connected') return <Connecting phase={phase} error={error} onRetry={retry} />;

  if (!G) {
    return (
      <Lobby
        state={state}
        events={events}
        botLevel={botLevel}
        onBotLevel={setBotLevel}
        onAddBot={() => send({ t: 'addbot', level: botLevel })}
        onStart={() => send({ t: 'start' })}
      />
    );
  }

  const captured = takenBy(board);
  const edge = Math.round(cell * 0.06);

  return (
    <View style={{ flex: 1, backgroundColor: '#121212' }}>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3], alignItems: 'center', paddingBottom: S[6] }}>

        <Seat
          name={opponentName(state)}
          glyph={myColor === 'w' ? '♚' : '♔'}
          clock={clockFor(state, myColor === 'w' ? 'b' : 'w')}
          taken={captured[myColor === 'w' ? 'w' : 'b']}
          edge={captured.edge * (myColor === 'w' ? -1 : 1)}
          active={!mine && G.result == null}
          width={size}
        />

        <View
          style={{
            width: size, height: size, borderRadius: R[1], overflow: 'hidden',
            boxShadow: '0 14px 44px rgba(0,0,0,.55)',
            borderWidth: 2, borderColor: '#2b2620',
          }}
        >
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
                bg={light ? th.light : th.dark}
                tint={isSel ? th.sel : isLast ? th.hl : null}
                check={inCheck}
                coordFile={coords && d >> 3 === 7 ? FILES[flipped ? 7 - c : c] : null}
                coordRank={coords && (d & 7) === 0 ? String(flipped ? r + 1 : 8 - r) : null}
                coordColor={light ? th.dark : th.light}
                piece={p}
                pieceSize={cell * 0.78}
                target={isTarget}
                capture={isTarget && !!p}
                slideFrom={
                  lastMove && lastMove.to === idx
                    ? { dx: ((toDisplay(lastMove.from) & 7) - (d & 7)) * cell,
                        dy: ((toDisplay(lastMove.from) >> 3) - (d >> 3)) * cell,
                        key: `${G.history?.length ?? 0}:${lastMove.from}:${lastMove.to}` }
                    : null
                }
                onPress={() => onSquare(idx)}
                edge={edge}
              />
            );
          })}
        </View>

        <Seat
          name="You"
          glyph={myColor === 'w' ? '♔' : '♚'}
          clock={clockFor(state, myColor ?? 'w')}
          taken={captured[myColor === 'w' ? 'b' : 'w']}
          edge={captured.edge * (myColor === 'w' ? 1 : -1)}
          active={mine && G.result == null}
          width={size}
        />

        <StatusLine game={G} mine={mine} spectator={state.spectator} width={size} />

        {drawOffer && !G.result && (
          <View style={{
            width: size, flexDirection: 'row', alignItems: 'center', gap: S[2],
            padding: S[3], borderRadius: R[2],
            borderWidth: 1, borderColor: 'rgba(245,196,81,.55)', backgroundColor: 'rgba(245,196,81,.12)',
          }}>
            <Text style={{ flex: 1, color: '#ffd97a', fontSize: t.sm, fontWeight: '700' }}>
              Your opponent offers a draw
            </Text>
            <Btn label="Accept" kind="gold" compact onPress={() => { send({ t: 'draw-accept' }); setDrawOffer(false); }} />
            <Btn label="No" compact onPress={() => setDrawOffer(false)} />
          </View>
        )}

        {G.result ? (
          <View style={{ flexDirection: 'row', gap: S[2], width: size }}>
            <Btn label="Rematch" kind="gold" icon="↻" style={{ flex: 1 }} onPress={() => send({ t: 'start' })} />
            <Btn label="Share" icon="📣" onPress={() => { void shareResult('chess', G.winner === state.you); }} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: S[2], width: size }}>
            <Btn label="Resign" kind="danger" compact style={{ flex: 1 }} onPress={() => send({ t: 'resign' })} />
            <Btn label="Offer draw" compact style={{ flex: 1 }} onPress={() => send({ t: 'draw-offer' })} />
            <Btn label="⚙" compact onPress={() => setShowSettings(true)} accessibilityLabel="Board settings" />
          </View>
        )}

        <Btn
          label="Invite a friend"
          icon="🔗"
          style={{ width: size }}
          onPress={() => { void inviteToTable('chess', roomId); }}
          disabled={!roomId}
        />

        <Swatches value={theme} onChange={setTheme} width={size} />

        {Array.isArray(G.history) && G.history.length > 0 && (
          <Panel style={{ width: size, maxHeight: 190 }}>
            <Text style={{ color: C.muted, fontSize: t.sm, fontWeight: '800', marginBottom: S[2] }}>Moves</Text>
            <ScrollView>
              <Text style={{ color: C.muted, fontSize: 12, lineHeight: 20, fontFamily: 'monospace' }}>
                {pairUp(G.history)}
              </Text>
            </ScrollView>
          </Panel>
        )}
      </ScrollView>

      <Toasts events={events} />
      <Confetti show={!!G.result && G.winner === state.you} />

      <Sheet visible={showSettings} title="Board" onClose={() => setShowSettings(false)}>
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
      </Sheet>

      {promo && (
        <PromoPicker
          opts={promo.opts}
          color={myColor ?? 'w'}
          onPick={(m) => { playSfx('promote'); send({ t: 'move', from: m.from, to: m.to, promo: m.promo }); setPromo(null); setSel(null); }}
          onCancel={() => setPromo(null)}
        />
      )}
    </View>
  );
}

/* ── one square ─────────────────────────────────────────────────────── */

function Square({
  d, cell, bg, tint, check, coordFile, coordRank, coordColor, piece, pieceSize,
  target, capture, slideFrom, onPress, edge,
}: {
  d: number; cell: number; bg: string; tint: string | null; check: boolean;
  coordFile: string | null; coordRank: string | null; coordColor: string;
  piece: Piece; pieceSize: number; target: boolean; capture: boolean;
  slideFrom: { dx: number; dy: number; key: string } | null;
  onPress: () => void; edge: number;
}) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (check) {
      pulse.value = withRepeat(withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
    return () => cancelAnimation(pulse);
  }, [check, pulse]);
  const aCheck = useAnimatedStyle(() => ({ opacity: check ? 0.55 - pulse.value * 0.25 : 0 }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={squareLabel(d, piece, target, capture)}
      style={{
        position: 'absolute',
        left: (d & 7) * cell, top: (d >> 3) * cell,
        width: cell, height: cell,
        backgroundColor: bg,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {tint ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: tint }} /> : null}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', inset: 0, backgroundColor: CHECK_TINT }, aCheck]} />

      {coordRank ? (
        <Text style={{ position: 'absolute', top: 2, left: 4, fontSize: 10, fontWeight: '700', color: coordColor, opacity: 0.7 }}>
          {coordRank}
        </Text>
      ) : null}
      {coordFile ? (
        <Text style={{ position: 'absolute', bottom: 2, right: 4, fontSize: 10, fontWeight: '700', color: coordColor, opacity: 0.7 }}>
          {coordFile}
        </Text>
      ) : null}

      {/* Capture ring sits behind the piece; the plain dot marks an empty target. */}
      {target && capture ? (
        <View pointerEvents="none" style={{
          position: 'absolute', width: cell * 0.78, height: cell * 0.78,
          borderRadius: cell * 0.39, borderWidth: 4, borderColor: 'rgba(40,35,28,.3)',
        }} />
      ) : null}

      {piece ? <PieceGlyph piece={piece} size={pieceSize} slideFrom={slideFrom} edge={edge} /> : null}

      {target && !capture ? (
        <View pointerEvents="none" style={{
          position: 'absolute', width: cell * 0.3, height: cell * 0.3,
          borderRadius: cell * 0.15, backgroundColor: DOT,
        }} />
      ) : null}
    </Pressable>
  );
}

/**
 * The piece, with the last-move slide.
 *
 * Ported from chess.js: the piece is placed at its ORIGIN offset with no
 * animation, then released to zero. Keying on history length as well as the
 * squares means a repeated shuffle still animates each time rather than once.
 */
function PieceGlyph({
  piece, size, slideFrom, edge,
}: { piece: NonNullable<Piece>; size: number; slideFrom: { dx: number; dy: number; key: string } | null; edge: number }) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const played = useRef<string | null>(null);

  useEffect(() => {
    if (!slideFrom || played.current === slideFrom.key) return;
    played.current = slideFrom.key;
    x.value = slideFrom.dx;
    y.value = slideFrom.dy;
    const spec = { duration: 200, easing: Easing.bezier(0.2, 0.8, 0.2, 1) };
    x.value = withTiming(0, spec);
    y.value = withTiming(0, spec);
  }, [slideFrom, x, y]);

  // Cast: a mixed [{translateX},{translateY}] tuple widens to a union RN's
  // transform type will not accept.
  const a = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }] as ViewStyle['transform'],
  }));

  return (
    <Animated.View style={a} pointerEvents="none">
      <Text
        style={{
          fontSize: size,
          lineHeight: size * 1.16,
          color: piece.c === 'w' ? '#f4f0e6' : '#1d1a16',
          textShadowColor: piece.c === 'w' ? 'rgba(43,38,32,0.95)' : 'rgba(255,255,255,0.35)',
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: Math.max(2, edge),
        }}
      >
        {GLYPH[piece.t]}
      </Text>
    </Animated.View>
  );
}

/* ── chrome ─────────────────────────────────────────────────────────── */

function Seat({
  name, glyph, clock, taken, edge, active, width,
}: { name: string; glyph: string; clock: string | null; taken: string[]; edge: number; active: boolean; width: number }) {
  const t = useType();
  return (
    <View style={{
      width, flexDirection: 'row', alignItems: 'center', gap: S[2],
      paddingVertical: S[2], paddingHorizontal: S[3],
      borderRadius: R[2], borderWidth: 1,
      borderColor: active ? 'rgba(245,196,81,.55)' : 'rgba(255,255,255,.09)',
      backgroundColor: 'rgba(255,255,255,.045)',
    }}>
      <Text style={{ fontSize: t.lg, color: '#e9eefb' }}>{glyph}</Text>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: '#e9eefb', fontSize: t.md, fontWeight: '800' }}>{name}</Text>
        {taken.length > 0 || edge !== 0 ? (
          <Text numberOfLines={1} style={{ color: '#8b95ad', fontSize: 12 }}>
            {taken.join('')}{edge > 0 ? `  +${edge}` : ''}
          </Text>
        ) : null}
      </View>
      {clock ? (
        <View style={{
          paddingHorizontal: S[2], paddingVertical: S[1], borderRadius: R[1],
          backgroundColor: active ? 'rgba(245,196,81,.14)' : 'rgba(255,255,255,.07)',
        }}>
          <Text style={{ color: active ? '#ffd97a' : '#8b95ad', fontSize: t.md, fontWeight: '800', fontFamily: 'monospace' }}>
            {clock}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function StatusLine({ game, mine, spectator, width }: { game: any; mine: boolean; spectator: boolean; width: number }) {
  if (game.result) {
    const won = game.winner && game.winner === game.you;
    return <View style={{ width }}><Banner text={resultText(game)} tone={won ? 'win' : game.winner ? 'lose' : 'info'} /></View>;
  }
  const text = spectator ? 'Watching' : mine ? (game.check ? 'Your move — you are in check' : 'Your move') : 'Waiting for your opponent';
  return <View style={{ width }}><Banner text={text} tone={mine ? 'turn' : 'info'} /></View>;
}

function Swatches({ value, onChange, width }: { value: ThemeName; onChange: (n: ThemeName) => void; width: number }) {
  return (
    <View style={{ width, flexDirection: 'row', gap: S[2], justifyContent: 'center' }}>
      {(Object.keys(THEMES) as ThemeName[]).map(n => (
        <Pressable
          key={n}
          onPress={() => onChange(n)}
          accessibilityRole="button"
          accessibilityLabel={`${n} board`}
          accessibilityState={{ selected: value === n }}
          style={{
            width: 34, height: 34, borderRadius: R[1], overflow: 'hidden', flexDirection: 'row',
            borderWidth: 2, borderColor: value === n ? '#3b82f6' : 'rgba(255,255,255,.16)',
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
  opts, color, onPick, onCancel,
}: { opts: Move[]; color: 'w' | 'b'; onPick: (m: Move) => void; onCancel: () => void }) {
  const seen = new Set<string>();
  const choices = opts.filter(o => o.promo && !seen.has(o.promo) && seen.add(o.promo));
  return (
    <Pressable
      onPress={onCancel}
      style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(3,6,14,.72)', alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{
        flexDirection: 'row', gap: S[3], padding: S[4], borderRadius: R[3],
        backgroundColor: '#0b1020', borderWidth: 1, borderColor: 'rgba(255,255,255,.16)',
      }}>
        {choices.map(m => (
          <Pressable key={m.promo} onPress={() => onPick(m)} accessibilityRole="button" accessibilityLabel={`Promote to ${m.promo}`}>
            <Text style={{ fontSize: 46, color: color === 'w' ? '#f4f0e6' : '#1d1a16',
              textShadowColor: color === 'w' ? 'rgba(43,38,32,.9)' : 'rgba(255,255,255,.35)',
              textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 3 }}>
              {GLYPH[m.promo as string]}
            </Text>
          </Pressable>
        ))}
      </View>
    </Pressable>
  );
}

function Lobby({
  state, events, onAddBot, onStart, botLevel, onBotLevel,
}: {
  state: GameState; events: string[]; onAddBot: () => void; onStart: () => void;
  botLevel: number; onBotLevel: (n: number) => void;
}) {
  const t = useType();
  const members = state.lobby?.members ?? [];
  const host = state.lobby?.hostId === state.you;
  return (
    <View style={{ flex: 1, backgroundColor: '#121212' }}>
      <ScrollView contentContainerStyle={{ padding: S[4], gap: S[3] }}>
        <Text style={{ color: '#e9eefb', fontSize: t.xl, fontWeight: '800' }}>Chess</Text>
        <Text style={{ color: '#8b95ad', fontSize: t.sm, lineHeight: 19 }}>
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
          <Text style={{ flex: 1, color: '#8b95ad', fontSize: t.sm }}>Bot strength</Text>
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
        <Btn label="Add a bot" icon="🤖" onPress={onAddBot} />
        <Btn label="Start game" kind="gold" onPress={onStart} disabled={!host || members.length < 2} />
      </ScrollView>
      <Toasts events={events} />
    </View>
  );
}

function Connecting({ phase, error, onRetry }: { phase: string; error: string | null; onRetry: () => void }) {
  const t = useType();
  return (
    <View style={{ flex: 1, backgroundColor: '#121212', alignItems: 'center', justifyContent: 'center', padding: S[5], gap: S[3] }}>
      <Text style={{ fontSize: 46 }}>♚</Text>
      <Text style={{ color: '#e9eefb', fontSize: t.lg, fontWeight: '800' }}>
        {error ? 'Could not reach the table' : 'Connecting…'}
      </Text>
      {error ? <Text style={{ color: '#8b95ad', fontSize: t.sm, textAlign: 'center' }}>{error}</Text> : null}
      {error ? <Btn label="Try again" kind="gold" onPress={onRetry} /> : null}
    </View>
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

function opponentName(state: GameState): string {
  const them = (state.lobby?.members ?? []).find(m => m.vaultId !== state.you);
  return them?.name ?? 'Opponent';
}

function resultText(game: any): string {
  if (game.result === 'draw') return 'Draw';
  if (game.winner) return `${game.winner === game.you ? 'You win' : 'You lose'}`;
  return String(game.result ?? 'Game over');
}

function pairUp(history: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    out.push(`${i / 2 + 1}. ${history[i] ?? ''} ${history[i + 1] ?? ''}`.trimEnd());
  }
  return out.join('   ');
}

function squareLabel(d: number, piece: Piece, target: boolean, capture: boolean): string {
  const name = `${FILES[d & 7]}${8 - (d >> 3)}`;
  const what = piece ? `${piece.c === 'w' ? 'white' : 'black'} ${piece.t}` : 'empty';
  const hint = capture ? ', can capture' : target ? ', can move here' : '';
  return `${name}, ${what}${hint}`;
}
