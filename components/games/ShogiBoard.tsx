/**
 * ShogiBoard — 9×9 Shogi wired to gameEngines shogiMove ({ from, to, promote }
 * | { drop, to }). Pieces 's'+type (Sente, player[0], bottom) / 'g'+type;
 * promoted pieces prefixed '+'. Captured pieces ("in hand") can be dropped.
 */
import { brandAlpha } from '../../constants/theme';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const GLYPH: Record<string, string> = { K: '王', R: '飛', B: '角', G: '金', S: '銀', N: '桂', L: '香', P: '歩' };
const PROMOTABLE = new Set(['P', 'L', 'N', 'S', 'R', 'B']);

type Sel = { kind: 'sq'; r: number; c: number } | { kind: 'drop'; piece: string } | null;

export function ShogiBoard({
  state, myId, myTurn, onMove, validate,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void; validate?: (m: any) => boolean;
}) {
  const board: string[][] = state.board;
  const myColor = state.players[0] === myId ? 's' : 'g';
  const captured: string[] = state.data?.captured?.[myId] ?? [];
  const { width } = useWindowDimensions();
  const bw = Math.min(width - 24, 324);
  const cell = bw / 9;
  const [sel, setSel] = useState<Sel>(null);

  const legal = useMemo(() => {
    const set = new Set<string>();
    if (!sel || !validate || !myTurn) return set;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      if (sel.kind === 'sq') {
        if (sel.r === r && sel.c === c) continue;
        if (validate({ from: [sel.r, sel.c], to: [r, c] })) set.add(`${r},${c}`);
      } else if (validate({ drop: sel.piece, to: [r, c] })) set.add(`${r},${c}`);
    }
    return set;
  }, [sel, board, validate, myTurn]);

  const inPromoZone = (r: number) => (myColor === 's' ? r <= 2 : r >= 6);

  const tapSquare = (r: number, c: number) => {
    if (!myTurn) { setSel(null); return; }
    const p = board[r][c];
    if (sel?.kind === 'drop') {
      if (!p) onMove({ drop: sel.piece, to: [r, c] });
      setSel(null);
      return;
    }
    if (sel?.kind === 'sq') {
      if (sel.r === r && sel.c === c) { setSel(null); return; }
      if (p && p[0] === myColor) { setSel({ kind: 'sq', r, c }); return; }
      const moving = board[sel.r][sel.c];
      const base = moving.replace('+', '').substring(1);
      const promote = PROMOTABLE.has(base) && (inPromoZone(r) || inPromoZone(sel.r));
      onMove({ from: [sel.r, sel.c], to: [r, c], ...(promote ? { promote: true } : {}) });
      setSel(null);
      return;
    }
    if (p && p[0] === myColor) setSel({ kind: 'sq', r, c });
  };

  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      <View style={[s.board, { width: bw }]}>
        {board.flatMap((row, r) => row.map((p, c) => {
          const selected = sel?.kind === 'sq' && sel.r === r && sel.c === c;
          const promoted = p.includes('+');
          const base = p.replace('+', '').substring(1);
          return (
            <TouchableOpacity key={`${r}-${c}`} activeOpacity={0.7} onPress={() => tapSquare(r, c)}
              style={[{ width: cell, height: cell }, s.cell, selected && s.sel]}>
              {p ? (
                <Text style={[s.piece, { fontSize: cell * 0.46 }, p[0] === myColor ? s.mine : s.theirs, p[0] !== 's' && s.flip]}>
                  {(promoted ? '+' : '') + (GLYPH[base] ?? base)}
                </Text>
              ) : null}
              {legal.has(`${r},${c}`) && (
                p
                  ? <View pointerEvents="none" style={[s.capMark, { width: cell * 0.92, height: cell * 0.92, borderRadius: cell * 0.46, borderWidth: Math.max(2, cell * 0.06) }]} />
                  : <View pointerEvents="none" style={[s.dotMark, { width: cell * 0.3, height: cell * 0.3, borderRadius: cell * 0.15 }]} />
              )}
            </TouchableOpacity>
          );
        }))}
      </View>

      <Text style={s.handLabel}>In hand</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hand}>
        {captured.length === 0 ? <Text style={s.empty}>—</Text> : captured.map((piece, i) => (
          <TouchableOpacity key={`${piece}-${i}`} disabled={!myTurn} onPress={() => setSel({ kind: 'drop', piece })}
            style={[s.handPiece, sel?.kind === 'drop' && sel.piece === piece && s.handSel]}>
            <Text style={s.handGlyph}>{GLYPH[piece] ?? piece}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  board: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#E8C98A', borderRadius: 4, overflow: 'hidden', borderWidth: 2, borderColor: '#8A6D3B' },
  cell: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.35)' },
  sel: { backgroundColor: brandAlpha(0.45) },
  piece: { fontWeight: '800' },
  mine: { color: '#1A1A1A' },
  theirs: { color: '#7A1F12' },
  flip: { transform: [{ rotate: '180deg' }] },
  handLabel: { color: Aurora.textDim, fontSize: 11, fontWeight: '700' },
  hand: { gap: 6, minHeight: 36, alignItems: 'center', paddingHorizontal: 8 },
  empty: { color: Aurora.textFaint, fontSize: 13 },
  handPiece: { width: 32, height: 34, borderRadius: 6, backgroundColor: '#E8C98A', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#8A6D3B' },
  handSel: { borderColor: Aurora.primary, borderWidth: 2 },
  handGlyph: { color: '#1A1A1A', fontSize: 18, fontWeight: '800' },
  dotMark: { position: 'absolute', backgroundColor: brandAlpha(0.8) },
  capMark: { position: 'absolute', borderColor: brandAlpha(0.9) },
});

export default ShogiBoard;
