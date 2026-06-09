/**
 * CarromBoard — abstract carrom wired to gameEngines carromMove
 * ({ pocketed: string[] }). The engine tracks pocketed coins (no physics), so
 * tapping one of your coins pots it; "Strike & miss" pots nothing. First to 9.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

export function CarromBoard({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const pieces: any[] = state.board ?? [];
  const myColor = state.data?.targetColor?.[myId] ?? 'white';
  const oppColor = myColor === 'white' ? 'black' : 'white';
  const mine = pieces.filter(p => !p.pocketed && p.color === myColor);
  const opp = pieces.filter(p => !p.pocketed && p.color === oppColor);
  const queen = pieces.find(p => p.id === 'queen');
  const oppId = state.players.find(p => p !== myId) ?? '';

  const pot = (id: string) => { if (myTurn) onMove({ pocketed: [id] }); };

  return (
    <View style={s.wrap}>
      <View style={s.scoreRow}>
        <Text style={s.score}>You {state.scores?.[myId] ?? 0}/9</Text>
        <Text style={s.score}>Opp {state.scores?.[oppId] ?? 0}/9</Text>
      </View>

      <View style={s.board}>
        <View style={s.centerCircle} />
        <View style={s.coins}>
          {queen && !queen.pocketed && (
            <TouchableOpacity disabled={!myTurn} onPress={() => pot('queen')} style={[s.coin, s.queen, myTurn && s.tappable]} />
          )}
          {mine.map(p => (
            <TouchableOpacity key={p.id} disabled={!myTurn} onPress={() => pot(p.id)}
              style={[s.coin, myColor === 'white' ? s.white : s.black, myTurn && s.tappable]} />
          ))}
          {opp.map(p => (
            <View key={p.id} style={[s.coin, oppColor === 'white' ? s.white : s.black, s.dim]} />
          ))}
        </View>
      </View>

      <Text style={s.hint}>{myTurn ? 'Tap your coin to pot it' : 'Opponent striking…'}</Text>
      <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ pocketed: [] })} style={[s.miss, !myTurn && s.off]} activeOpacity={0.85}>
        <Text style={s.missTxt}>Strike &amp; miss</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 12, alignItems: 'center' },
  scoreRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  score: { color: Aurora.textDim, fontSize: 13, fontWeight: '700' },
  board: { width: 300, height: 300, backgroundColor: '#D8B783', borderRadius: 12, borderWidth: 6, borderColor: '#8A6D3B', alignItems: 'center', justifyContent: 'center', padding: 16 },
  centerCircle: { position: 'absolute', width: 90, height: 90, borderRadius: 45, borderWidth: 1, borderColor: '#8A6D3B' },
  coins: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'center' },
  coin: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5 },
  white: { backgroundColor: '#F5F2E8', borderColor: '#C9C2A8' },
  black: { backgroundColor: '#2A2A2A', borderColor: '#000' },
  queen: { backgroundColor: '#C0392B', borderColor: '#7A1F12' },
  tappable: { borderColor: Aurora.primary, borderWidth: 2 },
  dim: { opacity: 0.55 },
  hint: { color: Aurora.textDim, fontSize: 13 },
  miss: { paddingHorizontal: 24, paddingVertical: 11, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  off: { opacity: 0.4 },
  missTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
});

export default CarromBoard;
