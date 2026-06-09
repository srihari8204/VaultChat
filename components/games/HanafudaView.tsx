/**
 * HanafudaView — wired to gameEngines hanafudaMove ({ handCard, fieldCard? }).
 * 48 cards, month = floor(card/4). Tap a hand card to play it; if a field card
 * of the same month exists we auto-capture the first match (else it goes to
 * the field).
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const month = (c: number) => Math.floor(c / 4) + 1;
const LIGHTS = new Set([0, 8, 28, 40, 44]);
const RIBBONS = new Set([1, 5, 9, 13, 17, 21, 25, 29, 33, 37]);
const SEEDS = new Set([4, 12, 16, 20, 24, 32, 36, 41, 45]);
const typeOf = (c: number) => LIGHTS.has(c) ? 'light' : RIBBONS.has(c) ? 'ribbon' : SEEDS.has(c) ? 'seed' : 'chaff';
const GLYPH: Record<string, string> = { light: '🌟', ribbon: '🎀', seed: '🌱', chaff: '🍃' };
const TINT: Record<string, string> = { light: '#F39C12', ribbon: '#E74C3C', seed: '#27AE60', chaff: '#7F8C8D' };

function HCard({ c, onPress, highlight }: { c: number; onPress?: () => void; highlight?: boolean }) {
  const t = typeOf(c);
  return (
    <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress} style={[cs.card, highlight && cs.hl, { borderColor: TINT[t] }]}>
      <Text style={cs.month}>{month(c)}</Text>
      <Text style={cs.glyph}>{GLYPH[t]}</Text>
    </TouchableOpacity>
  );
}

export function HanafudaView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const field: number[] = (state.board as any) ?? [];
  const captured: number[] = state.data?.captured?.[myId] ?? [];
  const opp = state.players.find(p => p !== myId) ?? '';
  const deckCount = state.deck?.length ?? 0;

  const play = (handCard: number) => {
    if (!myTurn) return;
    const matches = field.filter(c => month(c) === month(handCard));
    onMove(matches.length ? { handCard, fieldCard: matches[0] } : { handCard });
  };

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.info}>Deck {deckCount}</Text>
        <Text style={s.info}>You {state.scores?.[myId] ?? 0} · Opp {state.scores?.[opp] ?? 0}</Text>
        <Text style={s.info}>Captured {captured.length}</Text>
      </View>

      <Text style={s.label}>Field</Text>
      <View style={s.field}>
        {field.length === 0 ? <Text style={s.empty}>—</Text> : field.map((c, i) => <HCard key={`${c}-${i}`} c={c} />)}
      </View>

      <Text style={s.label}>Your hand {myTurn ? '• tap to play' : ''}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hand}>
        {hand.map((c, i) => {
          const matches = field.some(f => month(f) === month(c));
          return <HCard key={`${c}-${i}`} c={c} highlight={myTurn && matches} onPress={myTurn ? () => play(c) : undefined} />;
        })}
      </ScrollView>
    </View>
  );
}

const cs = StyleSheet.create({
  card: { width: 40, height: 56, borderRadius: 8, backgroundColor: '#1E3A2E', alignItems: 'center', justifyContent: 'center', borderWidth: 2, gap: 2 },
  hl: { backgroundColor: '#2A5240' },
  month: { color: '#fff', fontSize: 13, fontWeight: '800' },
  glyph: { fontSize: 15 },
});
const s = StyleSheet.create({
  wrap: { width: '100%', gap: 10 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  info: { color: Aurora.textDim, fontSize: 11, fontWeight: '700' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  field: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, minHeight: 56 },
  empty: { color: Aurora.textFaint, fontSize: 13 },
  hand: { gap: 6, paddingVertical: 10 },
});

export default HanafudaView;
