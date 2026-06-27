/**
 * PokerView — heads-up Texas Hold'em wired to gameEngines pokerMove
 * ({ action:'fold'|'check'|'call'|'raise', amount? }). hands[me]=2 hole cards,
 * board=community, data.pot/currentBet/bets, scores=chips.
 */
import { brandAlpha } from '../../constants/theme';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';
import { Card } from './Card';

export function PokerView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hole: number[] = (state.hands?.[myId] as any) ?? [];
  const community: number[] = (state.board as any) ?? [];
  const opp = state.players.find(p => p !== myId) ?? '';
  const pot: number = state.data?.pot ?? 0;
  const currentBet: number = state.data?.currentBet ?? 0;
  const myBet: number = state.data?.bets?.[myId] ?? 0;
  const toCall = Math.max(0, currentBet - myBet);
  const bigBlind: number = state.data?.bigBlind ?? 20;
  const myChips = state.scores?.[myId] ?? 0;
  const oppChips = state.scores?.[opp] ?? 0;

  const act = (action: string, amount?: number) => { if (myTurn) onMove({ action, ...(amount ? { amount } : {}) }); };

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.chip}>Opp {oppChips}</Text>
        <Text style={s.phase}>{String(state.phase).toUpperCase()}</Text>
        <Text style={s.chip}>You {myChips}</Text>
      </View>

      <View style={s.potBox}><Text style={s.potTxt}>POT {pot}</Text></View>

      <Text style={s.label}>Community</Text>
      <View style={s.cardRow}>
        {[0, 1, 2, 3, 4].map(i => community[i] != null
          ? <Card key={i} c={community[i]} />
          : <View key={i} style={s.cardSlot} />)}
      </View>

      <Text style={s.label}>Your hand</Text>
      <View style={s.cardRow}>{hole.map((c, i) => <Card key={i} c={c} />)}</View>

      <View style={s.actions}>
        <TouchableOpacity disabled={!myTurn} onPress={() => act('fold')} style={[s.btn, s.fold, !myTurn && s.off]}>
          <Text style={s.btnTxt}>Fold</Text>
        </TouchableOpacity>
        {toCall === 0 ? (
          <TouchableOpacity disabled={!myTurn} onPress={() => act('check')} style={[s.btn, !myTurn && s.off]}>
            <Text style={s.btnTxt}>Check</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity disabled={!myTurn} onPress={() => act('call')} style={[s.btn, !myTurn && s.off]}>
            <Text style={s.btnTxt}>Call {toCall}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity disabled={!myTurn} onPress={() => act('raise', bigBlind)} style={[s.btn, s.raise, !myTurn && s.off]}>
          <Text style={s.btnTxt}>Raise {bigBlind}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 12, alignItems: 'center' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  chip: { color: Aurora.text, fontSize: 13, fontWeight: '700' },
  phase: { color: Aurora.accent, fontSize: 12, fontWeight: '800' },
  potBox: { backgroundColor: brandAlpha(0.12), borderColor: brandAlpha(0.3), borderWidth: 1, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 6 },
  potTxt: { color: Aurora.primary, fontSize: 14, fontWeight: '800' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700', alignSelf: 'flex-start' },
  cardRow: { flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 62 },
  cardSlot: { width: 44, height: 62, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: Aurora.border },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  fold: { borderColor: 'rgba(239,68,68,0.4)' },
  raise: { backgroundColor: Aurora.primary, borderColor: Aurora.primary },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
});

export default PokerView;
