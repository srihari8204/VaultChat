/**
 * RummyView — 13-card rummy wired to gameEngines rummyMove. Draw phase:
 * { action:'draw' | 'pickup' }. Discard phase: { action:'discard', card }.
 * Win: { action:'declare', melds } — we attempt a greedy auto-meld grouping.
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';
import { Card } from './Card';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const rank = (c: number) => c % 13;
const suit = (c: number) => Math.floor(c / 13);

// Greedy: pure same-suit runs (≥3) first, then same-rank sets (≥3).
function autoMelds(hand: number[], jokerRank: number): number[][] {
  const used = new Set<number>();
  const melds: number[][] = [];
  for (let su = 0; su < 4; su++) {
    const cards = hand.filter((c, i) => !used.has(i) && suit(c) === su && rank(c) !== jokerRank)
      .map((c) => ({ c, i: hand.indexOf(c) })).sort((a, b) => rank(a.c) - rank(b.c));
    let run: { c: number; i: number }[] = [];
    const flush = () => { if (run.length >= 3) { melds.push(run.map(x => x.c)); run.forEach(x => used.add(x.i)); } };
    for (let k = 0; k < cards.length; k++) {
      if (run.length === 0 || rank(cards[k].c) === rank(run[run.length - 1].c) + 1) run.push(cards[k]);
      else { flush(); run = [cards[k]]; }
    }
    flush();
  }
  for (let r = 0; r < 13; r++) {
    const idxs = hand.map((c, i) => ({ c, i })).filter(x => !used.has(x.i) && rank(x.c) === r);
    if (idxs.length >= 3) { const take = idxs.slice(0, 4); melds.push(take.map(x => x.c)); take.forEach(x => used.add(x.i)); }
  }
  return melds;
}

export function RummyView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const phase = state.phase;
  const discard: number[] = state.data?.discard ?? [];
  const top = discard.length ? discard[discard.length - 1] : null;
  const jokerRank: number = state.data?.jokerRank ?? -1;
  const deckCount = state.deck?.length ?? 0;
  const sorted = [...hand].sort((a, b) => (suit(a) - suit(b)) || (rank(a) - rank(b)));

  const declare = () => { const melds = autoMelds(hand, jokerRank); if (melds.length) onMove({ action: 'declare', melds }); };

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.info}>Deck {deckCount}</Text>
        <Text style={s.info}>Wild: {RANKS[jokerRank] ?? '—'}</Text>
      </View>

      {phase === 'draw' && (
        <View style={s.actions}>
          <TouchableOpacity disabled={!myTurn || deckCount === 0} onPress={() => onMove({ action: 'draw' })}
            style={[s.btn, (!myTurn || deckCount === 0) && s.off]}><Text style={s.btnTxt}>Draw deck</Text></TouchableOpacity>
          <TouchableOpacity disabled={!myTurn || top == null} onPress={() => onMove({ action: 'pickup' })}
            style={[s.btn, (!myTurn || top == null) && s.off]}>
            {top != null ? <Card c={top} small /> : <Text style={s.btnTxt}>—</Text>}
            <Text style={s.btnSub}>Pick discard</Text>
          </TouchableOpacity>
        </View>
      )}
      {phase === 'discard' && myTurn && <Text style={s.hint}>Tap a card to discard</Text>}

      <Text style={s.label}>Your hand ({hand.length})</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hand}>
        {sorted.map((c, i) => (
          <Card key={`${c}-${i}`} c={c} small onPress={phase === 'discard' && myTurn ? () => onMove({ action: 'discard', card: c }) : undefined} />
        ))}
      </ScrollView>

      <TouchableOpacity disabled={!myTurn} onPress={declare} style={[s.declareBtn, !myTurn && s.off]} activeOpacity={0.85}>
        <Text style={s.declareTxt}>Declare (auto-meld)</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 10 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  info: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center', gap: 4 },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
  btnSub: { color: Aurora.textDim, fontSize: 11, fontWeight: '600' },
  hint: { color: Aurora.accent, fontSize: 12, fontWeight: '600' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  hand: { gap: 4, paddingVertical: 12 },
  declareBtn: { backgroundColor: Aurora.primary, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  declareTxt: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});

export default RummyView;
