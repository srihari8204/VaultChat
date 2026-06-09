/**
 * TrucoView — Argentine Truco wired to gameEngines trucoMove. hands[me] = 3
 * cards (0-39: suit=floor(c/10), rank=c%10). Actions: { action:'play',
 * cardIndex } | 'truco' | 'retruco' | 'vale_cuatro' | 'fold'.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const RANK = ['1', '2', '3', '4', '5', '6', '7', '10', '11', '12'];
const SUIT = ['🗡️', '🪙', '🏆', '🌿']; // espadas, oros, copas, bastos

function SpanishCard({ c, onPress }: { c: number; onPress?: () => void }) {
  return (
    <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress} style={cs.card}>
      <Text style={cs.rank}>{RANK[c % 10]}</Text>
      <Text style={cs.suit}>{SUIT[Math.floor(c / 10)]}</Text>
    </TouchableOpacity>
  );
}

export function TrucoView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const table: { player: string; card: number }[] = state.data?.table ?? [];
  const stake: number = state.data?.stake ?? 1;
  const trucoCalled: boolean = state.data?.trucoCalled ?? false;
  const opp = state.players.find(p => p !== myId) ?? '';

  const call = (action: string) => { if (myTurn) onMove({ action }); };

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.score}>You {state.scores?.[myId] ?? 0}</Text>
        <Text style={s.stake}>Stake {stake}</Text>
        <Text style={s.score}>Opp {state.scores?.[opp] ?? 0}</Text>
      </View>

      <Text style={s.label}>Table</Text>
      <View style={s.table}>
        {table.length === 0 ? <Text style={s.empty}>No cards played</Text>
          : table.map((t, i) => <SpanishCard key={i} c={t.card} />)}
      </View>

      <Text style={s.label}>Your hand {myTurn ? '• your turn' : ''}</Text>
      <View style={s.hand}>
        {hand.map((c, i) => <SpanishCard key={`${c}-${i}`} c={c} onPress={myTurn ? () => onMove({ action: 'play', cardIndex: i }) : undefined} />)}
      </View>

      <View style={s.actions}>
        {!trucoCalled && <TouchableOpacity disabled={!myTurn} onPress={() => call('truco')} style={[s.btn, !myTurn && s.off]}><Text style={s.btnTxt}>Truco</Text></TouchableOpacity>}
        {stake === 2 && <TouchableOpacity disabled={!myTurn} onPress={() => call('retruco')} style={[s.btn, !myTurn && s.off]}><Text style={s.btnTxt}>Retruco</Text></TouchableOpacity>}
        {stake === 3 && <TouchableOpacity disabled={!myTurn} onPress={() => call('vale_cuatro')} style={[s.btn, !myTurn && s.off]}><Text style={s.btnTxt}>Vale 4</Text></TouchableOpacity>}
        <TouchableOpacity disabled={!myTurn} onPress={() => call('fold')} style={[s.btn, s.fold, !myTurn && s.off]}><Text style={s.btnTxt}>Fold</Text></TouchableOpacity>
      </View>
    </View>
  );
}

const cs = StyleSheet.create({
  card: { width: 48, height: 66, borderRadius: 8, backgroundColor: '#FAFAF7', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#C9A36A', gap: 2 },
  rank: { color: '#1A1A1A', fontSize: 20, fontWeight: '800' },
  suit: { fontSize: 16 },
});
const s = StyleSheet.create({
  wrap: { width: '100%', gap: 12 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  score: { color: Aurora.text, fontSize: 13, fontWeight: '700' },
  stake: { color: Aurora.accent, fontSize: 13, fontWeight: '800' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  table: { flexDirection: 'row', gap: 8, minHeight: 66, alignItems: 'center', justifyContent: 'center' },
  empty: { color: Aurora.textFaint, fontSize: 13 },
  hand: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 },
  btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  fold: { borderColor: 'rgba(239,68,68,0.4)' },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 13, fontWeight: '700' },
});

export default TrucoView;
