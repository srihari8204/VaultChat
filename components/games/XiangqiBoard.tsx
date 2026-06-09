/**
 * XiangqiBoard — Chinese chess (10×9) wired to gameEngines xiangqiMove
 * ({ from:[r,c], to:[r,c] }). Pieces 'rX' (red, player[0], bottom) / 'bX'.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const GLYPH: Record<string, string> = {
  rK: '帥', rA: '仕', rE: '相', rR: '俥', rH: '傌', rC: '炮', rP: '兵',
  bK: '將', bA: '士', bE: '象', bR: '車', bH: '馬', bC: '砲', bP: '卒',
};

export function XiangqiBoard({
  state, myId, myTurn, onMove, validate,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void; validate?: (m: any) => boolean;
}) {
  const board: string[][] = state.board;
  const myColor = state.players[0] === myId ? 'r' : 'b';
  const { width } = useWindowDimensions();
  const bw = Math.min(width - 24, 324);
  const cell = bw / 9;
  const [sel, setSel] = useState<[number, number] | null>(null);

  const legal = useMemo(() => {
    const set = new Set<string>();
    if (!sel || !validate || !myTurn) return set;
    for (let r = 0; r < board.length; r++) for (let c = 0; c < 9; c++) {
      if (r === sel[0] && c === sel[1]) continue;
      if (validate({ from: sel, to: [r, c] })) set.add(`${r},${c}`);
    }
    return set;
  }, [sel, board, validate, myTurn]);

  const tap = (r: number, c: number) => {
    if (!myTurn) { setSel(null); return; }
    const p = board[r][c];
    if (sel) {
      if (sel[0] === r && sel[1] === c) { setSel(null); return; }
      if (p && p[0] === myColor) { setSel([r, c]); return; }
      onMove({ from: sel, to: [r, c] });
      setSel(null);
      return;
    }
    if (p && p[0] === myColor) setSel([r, c]);
  };

  return (
    <View style={[s.board, { width: bw }]}>
      {board.flatMap((row, r) => row.map((p, c) => {
        const selected = !!sel && sel[0] === r && sel[1] === c;
        return (
          <TouchableOpacity key={`${r}-${c}`} activeOpacity={0.7} onPress={() => tap(r, c)}
            style={[{ width: cell, height: cell }, s.cell, selected && s.sel]}>
            {p ? (
              <View style={[s.disc, { width: cell * 0.86, height: cell * 0.86 }]}>
                <Text style={[s.piece, { fontSize: cell * 0.5 }, p[0] === 'r' ? s.red : s.black]}>{GLYPH[p] ?? ''}</Text>
              </View>
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
  );
}

const s = StyleSheet.create({
  board: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#D8B783', borderRadius: 6, overflow: 'hidden', borderWidth: 2, borderColor: '#8A6D3B' },
  cell: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.3)' },
  sel: { backgroundColor: 'rgba(16,185,129,0.4)' },
  disc: { borderRadius: 999, backgroundColor: '#F3E2C0', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#8A6D3B' },
  piece: { fontWeight: '800' },
  red: { color: '#C0392B' },
  black: { color: '#1A1A1A' },
  dotMark: { position: 'absolute', backgroundColor: 'rgba(16,185,129,0.8)' },
  capMark: { position: 'absolute', borderColor: 'rgba(16,185,129,0.9)' },
});

export default XiangqiBoard;
