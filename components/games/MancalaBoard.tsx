/**
 * MancalaBoard — wired to gameEngines mancalaMove ({ pit }). board is a
 * 14-int array: p1 pits 0-5, p1 store 6, p2 pits 7-12, p2 store 13.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

export function MancalaBoard({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const board: number[] = state.board;
  const isP1 = state.players[0] === myId;
  const myPits = isP1 ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12];
  const oppPits = isP1 ? [12, 11, 10, 9, 8, 7] : [5, 4, 3, 2, 1, 0];
  const myStore = isP1 ? 6 : 13;
  const oppStore = isP1 ? 13 : 6;

  const Pit = ({ idx, mine }: { idx: number; mine: boolean }) => {
    const playable = mine && myTurn && board[idx] > 0;
    return (
      <TouchableOpacity disabled={!playable} onPress={() => onMove({ pit: idx })} activeOpacity={0.7}
        style={[s.pit, playable && s.pitActive]}>
        <Text style={s.seeds}>{board[idx]}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.wrap}>
      <Text style={s.label}>Opponent</Text>
      <View style={s.row}>{oppPits.map(i => <Pit key={i} idx={i} mine={false} />)}</View>
      <View style={s.storesRow}>
        <View style={s.store}><Text style={s.storeLbl}>OPP</Text><Text style={s.storeVal}>{board[oppStore]}</Text></View>
        <View style={s.store}><Text style={s.storeLbl}>YOU</Text><Text style={s.storeVal}>{board[myStore]}</Text></View>
      </View>
      <View style={s.row}>{myPits.map(i => <Pit key={i} idx={i} mine />)}</View>
      <Text style={s.label}>You {myTurn ? '• your turn' : ''}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: '#2A1A0E', borderRadius: 18, padding: 14, gap: 10, borderWidth: 1, borderColor: '#4A3420' },
  label: { color: Aurora.textDim, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  pit: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#3A2616', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#5A4028' },
  pitActive: { borderColor: Aurora.primary, backgroundColor: '#4A3018' },
  seeds: { color: '#F5D9A8', fontSize: 16, fontWeight: '800' },
  storesRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20 },
  store: { width: 60, height: 56, borderRadius: 14, backgroundColor: '#3A2616', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#5A4028' },
  storeLbl: { color: Aurora.textFaint, fontSize: 9, fontWeight: '700' },
  storeVal: { color: '#F5D9A8', fontSize: 20, fontWeight: '800' },
});

export default MancalaBoard;
