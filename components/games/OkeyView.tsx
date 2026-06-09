/**
 * OkeyView — Turkish Okey wired to gameEngines okeyMove. tiles: color=
 * floor((t%52)/13), num=(t%13)+1; 104/105 + okeyTile are wild. Draw phase:
 * { action:'draw' | 'drawDiscard' }. Discard: { action:'discard', tile }.
 * Win: { action:'declare', groups } (greedy auto-grouping).
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const COLORS = ['#E74C3C', '#ECEDEE', '#3498DB', '#F39C12'];
const tColor = (t: number) => (t >= 104 ? -1 : Math.floor((t % 52) / 13));
const tNum = (t: number) => (t >= 104 ? 0 : (t % 13) + 1);

function autoGroups(hand: number[], okeyTile: number): number[][] {
  const used = new Set<number>();
  const groups: number[][] = [];
  const idx = (t: number) => hand.findIndex((x, i) => x === t && !used.has(i));
  for (let col = 0; col < 4; col++) {
    const cards = hand.map((t, i) => ({ t, i })).filter(x => !used.has(x.i) && tColor(x.t) === col && x.t !== okeyTile)
      .sort((a, b) => tNum(a.t) - tNum(b.t));
    let run: { t: number; i: number }[] = [];
    const flush = () => { if (run.length >= 3) { groups.push(run.map(x => x.t)); run.forEach(x => used.add(x.i)); } };
    for (const c of cards) { if (run.length === 0 || tNum(c.t) === tNum(run[run.length - 1].t) + 1) run.push(c); else { flush(); run = [c]; } }
    flush();
  }
  for (let num = 1; num <= 13; num++) {
    const seen = new Set<number>(); const pick: { t: number; i: number }[] = [];
    hand.forEach((t, i) => { if (!used.has(i) && tNum(t) === num && t !== okeyTile && !seen.has(tColor(t))) { seen.add(tColor(t)); pick.push({ t, i }); } });
    if (pick.length >= 3) { const take = pick.slice(0, 4); groups.push(take.map(x => x.t)); take.forEach(x => used.add(x.i)); }
  }
  return groups;
}

function Tile({ t, wild, onPress }: { t: number; wild?: boolean; onPress?: () => void }) {
  const joker = t >= 104;
  return (
    <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress} style={[ts.tile, wild && ts.wild]}>
      <Text style={[ts.num, { color: joker ? '#10B981' : COLORS[tColor(t)] }]}>{joker ? '★' : tNum(t)}</Text>
    </TouchableOpacity>
  );
}

export function OkeyView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const okeyTile: number = state.data?.okeyTile ?? -1;
  const phase = state.phase;
  const deckCount = state.deck?.length ?? 0;
  const sorted = [...hand].sort((a, b) => (tColor(a) - tColor(b)) || (tNum(a) - tNum(b)));

  const declare = () => { const g = autoGroups(hand, okeyTile); if (g.length) onMove({ action: 'declare', groups: g }); };

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.info}>Deck {deckCount}</Text>
        <View style={s.wildBox}><Text style={s.wildLbl}>Wild</Text><Tile t={okeyTile} wild /></View>
      </View>

      {phase === 'draw' && (
        <View style={s.actions}>
          <TouchableOpacity disabled={!myTurn || deckCount === 0} onPress={() => onMove({ action: 'draw' })} style={[s.btn, (!myTurn || deckCount === 0) && s.off]}><Text style={s.btnTxt}>Draw tile</Text></TouchableOpacity>
          <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ action: 'drawDiscard' })} style={[s.btn, !myTurn && s.off]}><Text style={s.btnTxt}>Take discard</Text></TouchableOpacity>
        </View>
      )}
      {phase === 'discard' && myTurn && <Text style={s.hint}>Tap a tile to discard</Text>}

      <Text style={s.label}>Your tiles ({hand.length})</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hand}>
        {sorted.map((t, i) => (
          <Tile key={`${t}-${i}`} t={t} wild={t === okeyTile || t >= 104}
            onPress={phase === 'discard' && myTurn ? () => onMove({ action: 'discard', tile: t }) : undefined} />
        ))}
      </ScrollView>

      <TouchableOpacity disabled={!myTurn} onPress={declare} style={[s.declare, !myTurn && s.off]} activeOpacity={0.85}>
        <Text style={s.declareTxt}>Declare Okey (auto)</Text>
      </TouchableOpacity>
    </View>
  );
}

const ts = StyleSheet.create({
  tile: { width: 34, height: 46, borderRadius: 6, backgroundColor: '#F5F2E8', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#C9C2A8' },
  wild: { borderColor: Aurora.primary, borderWidth: 2 },
  num: { fontSize: 18, fontWeight: '800' },
});
const s = StyleSheet.create({
  wrap: { width: '100%', gap: 10 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  info: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  wildBox: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wildLbl: { color: Aurora.textDim, fontSize: 11, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center' },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
  hint: { color: Aurora.accent, fontSize: 12, fontWeight: '600' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  hand: { gap: 4, paddingVertical: 10 },
  declare: { backgroundColor: Aurora.primary, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  declareTxt: { color: '#04130D', fontSize: 15, fontWeight: '800' },
});

export default OkeyView;
