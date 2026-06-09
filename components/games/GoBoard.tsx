/**
 * GoBoard — 9×9 Go wired to gameEngines goMove ({ action:'place', row, col }
 * | { action:'pass' }). board: 0 empty, 1 black (player[0]), 2 white.
 */
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

export function GoBoard({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const board: number[][] = state.board;
  const size = state.data?.size ?? 9;
  const { width } = useWindowDimensions();
  const bs = Math.min(width - 24, 330);
  const cell = bs / size;

  const place = (r: number, c: number) => {
    if (!myTurn || board[r][c] !== 0) return;
    onMove({ action: 'place', row: r, col: c });
  };

  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      <View style={[s.board, { width: bs, height: bs }]}>
        {board.flatMap((row, r) => row.map((v, c) => (
          <TouchableOpacity key={`${r}-${c}`} activeOpacity={0.6} onPress={() => place(r, c)}
            style={[{ width: cell, height: cell }, s.cell]}>
            {v !== 0 && <View style={[s.stone, { width: cell * 0.82, height: cell * 0.82 }, v === 1 ? s.black : s.white]} />}
          </TouchableOpacity>
        )))}
      </View>
      <TouchableOpacity style={[s.pass, !myTurn && { opacity: 0.4 }]} disabled={!myTurn} onPress={() => onMove({ action: 'pass' })} activeOpacity={0.8}>
        <Text style={s.passTxt}>Pass</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  board: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#C9A36A', borderRadius: 6, overflow: 'hidden' },
  cell: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.45)' },
  stone: { borderRadius: 999 },
  black: { backgroundColor: '#0B0B0F' },
  white: { backgroundColor: '#F5F5F5' },
  pass: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  passTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
});

export default GoBoard;
