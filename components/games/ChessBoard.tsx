/**
 * ChessBoard — tap-to-move board wired to services/gameEngines chessMove.
 * board is an 8×8 array of '' | 'wP'..'bK'. Player[0] is white (bottom).
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Aurora } from '../../constants/theme';

const GLYPH: Record<string, string> = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

export function ChessBoard({
  board, myColor, disabled, onMove, validate,
}: {
  board: string[][];
  myColor: 'w' | 'b';
  disabled: boolean;
  onMove: (m: { from: number[]; to: number[]; promotion?: string }) => void;
  validate?: (m: any) => boolean;
}) {
  const { width } = useWindowDimensions();
  const boardSize = Math.min(width - 24, 360);
  const cell = boardSize / 8;
  const [sel, setSel] = useState<[number, number] | null>(null);

  // Legal destinations for the selected piece — computed by dry-running every
  // target through the engine, so highlighting is always rules-accurate.
  const legal = useMemo(() => {
    const set = new Set<string>();
    if (!sel || !validate || disabled) return set;
    const moving = board[sel[0]][sel[1]];
    const isPawn = !!moving && moving[1] === 'P';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (r === sel[0] && c === sel[1]) continue;
      const promotion = isPawn && (r === 0 || r === 7) ? 'Q' : undefined;
      if (validate({ from: sel, to: [r, c], ...(promotion ? { promotion } : {}) })) set.add(`${r},${c}`);
    }
    return set;
  }, [sel, board, validate, disabled]);

  const tap = (r: number, c: number) => {
    if (disabled) { setSel(null); return; }
    const piece = board[r][c];
    if (sel) {
      if (sel[0] === r && sel[1] === c) { setSel(null); return; }
      if (piece && piece[0] === myColor) { setSel([r, c]); return; } // reselect own
      const moving = board[sel[0]][sel[1]];
      const isPawn = !!moving && moving[1] === 'P';
      const lastRank = r === 0 || r === 7;
      onMove({ from: sel, to: [r, c], ...(isPawn && lastRank ? { promotion: 'Q' } : {}) });
      setSel(null);
      return;
    }
    if (piece && piece[0] === myColor) setSel([r, c]);
  };

  return (
    <View style={[s.board, { width: boardSize, height: boardSize }]}>
      {board.flatMap((row, r) => row.map((p, c) => {
        const dark = (r + c) % 2 === 1;
        const selected = !!sel && sel[0] === r && sel[1] === c;
        return (
          <TouchableOpacity
            key={`${r}-${c}`}
            activeOpacity={0.7}
            onPress={() => tap(r, c)}
            style={[{ width: cell, height: cell }, s.cell, dark ? s.dark : s.light, selected && s.sel]}
          >
            <Text style={[s.piece, { fontSize: cell * 0.66 }, p && p[0] === 'w' ? s.white : s.black]}>
              {GLYPH[p] ?? ''}
            </Text>
            {legal.has(`${r},${c}`) && (
              p
                ? <View pointerEvents="none" style={[s.capture, { width: cell * 0.86, height: cell * 0.86, borderRadius: cell * 0.43, borderWidth: Math.max(2, cell * 0.06) }]} />
                : <View pointerEvents="none" style={[s.dot, { width: cell * 0.3, height: cell * 0.3, borderRadius: cell * 0.15 }]} />
            )}
          </TouchableOpacity>
        );
      }))}
    </View>
  );
}

const s = StyleSheet.create({
  board: { flexDirection: 'row', flexWrap: 'wrap', borderRadius: 10, overflow: 'hidden', borderWidth: 2, borderColor: Aurora.border },
  cell: { alignItems: 'center', justifyContent: 'center' },
  light: { backgroundColor: '#3A3D4A' },
  dark: { backgroundColor: '#22242E' },
  sel: { backgroundColor: Aurora.primary },
  piece: { fontWeight: '700' },
  white: { color: '#FFFFFF', textShadowColor: '#000', textShadowRadius: 2 },
  black: { color: '#0B0B0F', textShadowColor: 'rgba(255,255,255,0.4)', textShadowRadius: 2 },
  dot: { position: 'absolute', backgroundColor: 'rgba(16,185,129,0.75)' },
  capture: { position: 'absolute', borderColor: 'rgba(16,185,129,0.85)' },
});

export default ChessBoard;
