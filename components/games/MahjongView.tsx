/**
 * MahjongView — wired to gameEngines mahjongMove ({ action:'draw'|'discard'|
 * 'win', tile? }). Tiles 0-33 (1-9 bamboo/char/dot + winds + dragons). Draw a
 * tile (auto-tsumo if it completes the hand), then discard one; or claim the
 * last discard with Win.
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const WINDS = ['東', '南', '西', '北'];
const DRAGONS = ['中', '發', '白'];
function tileLabel(t: number): { txt: string; tint: string } {
  if (t < 9) return { txt: `${t + 1}`, tint: '#27AE60' };   // bamboo
  if (t < 18) return { txt: `${t - 8}`, tint: '#C0392B' };  // characters
  if (t < 27) return { txt: `${t - 17}`, tint: '#2980B9' }; // dots
  if (t < 31) return { txt: WINDS[t - 27], tint: '#34495E' };
  return { txt: DRAGONS[t - 31], tint: '#8E44AD' };
}
const suitMark = (t: number) => t < 9 ? '🎍' : t < 18 ? '萬' : t < 27 ? '●' : '';

function MTile({ t, onPress }: { t: number; onPress?: () => void }) {
  const { txt, tint } = tileLabel(t);
  return (
    <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress} style={ms.tile}>
      <Text style={[ms.txt, { color: tint }]}>{txt}</Text>
      <Text style={ms.mark}>{suitMark(t)}</Text>
    </TouchableOpacity>
  );
}

export function MahjongView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const phase = state.phase;
  const wall = state.deck?.length ?? 0;
  const discardPile: number[] = state.data?.discardPile ?? [];
  const lastDiscard: number | null = state.data?.lastDiscard ?? null;
  const sorted = [...hand].sort((a, b) => a - b);

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.info}>Wall {wall}</Text>
        <Text style={s.info}>Score {state.scores?.[myId] ?? 0}</Text>
      </View>

      <Text style={s.label}>Discards</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.disc}>
        {discardPile.length === 0 ? <Text style={s.empty}>—</Text>
          : discardPile.slice(-12).map((t, i) => <MTile key={i} t={t} />)}
      </ScrollView>

      {phase === 'draw' && (
        <View style={s.actions}>
          <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ action: 'draw' })} style={[s.btn, s.primary, !myTurn && s.off]}><Text style={s.btnTxt}>Draw tile</Text></TouchableOpacity>
          <TouchableOpacity disabled={!myTurn || lastDiscard == null} onPress={() => onMove({ action: 'win' })} style={[s.btn, (!myTurn || lastDiscard == null) && s.off]}><Text style={s.btnTxt}>Win (Ron)</Text></TouchableOpacity>
        </View>
      )}
      {phase === 'discard' && myTurn && <Text style={s.hint}>Tap a tile to discard</Text>}

      <Text style={s.label}>Your hand ({hand.length})</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hand}>
        {sorted.map((t, i) => (
          <MTile key={`${t}-${i}`} t={t} onPress={phase === 'discard' && myTurn ? () => onMove({ action: 'discard', tile: t }) : undefined} />
        ))}
      </ScrollView>
    </View>
  );
}

const ms = StyleSheet.create({
  tile: { width: 32, height: 44, borderRadius: 6, backgroundColor: '#FAF8F0', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#C9C2A8' },
  txt: { fontSize: 17, fontWeight: '800' },
  mark: { fontSize: 9, color: '#666' },
});
const s = StyleSheet.create({
  wrap: { width: '100%', gap: 10 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  info: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  disc: { gap: 4, minHeight: 44, alignItems: 'center' },
  empty: { color: Aurora.textFaint, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center' },
  primary: { backgroundColor: Aurora.primary, borderColor: Aurora.primary },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
  hint: { color: Aurora.accent, fontSize: 12, fontWeight: '600' },
  hand: { gap: 4, paddingVertical: 10 },
});

export default MahjongView;
