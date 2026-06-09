/**
 * DurakView — wired to gameEngines durakMove. 36-card deck (rank=c%9+6,
 * suit=floor(c/9)). Roles: attacker vs data.defender. Phase 'attack'/'defend'.
 * Actions: { action:'attack'|'defend'|'take'|'done', card?, targetIndex? }.
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const RANK = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT = ['♠', '♥', '♦', '♣'];
const rankOf = (c: number) => RANK[c % 9];
const suitOf = (c: number) => Math.floor(c / 9);

function Pip({ c, dim, trump, onPress }: { c: number; dim?: boolean; trump?: boolean; onPress?: () => void }) {
  const red = suitOf(c) === 1 || suitOf(c) === 2;
  return (
    <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress}
      style={[cs.card, dim && cs.dim, trump && cs.trump]}>
      <Text style={[cs.rank, red && cs.red]}>{rankOf(c)}</Text>
      <Text style={[cs.suit, red && cs.red]}>{SUIT[suitOf(c)]}</Text>
    </TouchableOpacity>
  );
}

export function DurakView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const trump: number = state.data?.trump ?? -1;
  const trumpCard: number = state.data?.trumpCard ?? -1;
  const table: { attack: number; defense?: number }[] = state.data?.table ?? [];
  const amDefender = state.data?.defender === myId;
  const deckCount = state.deck?.length ?? 0;
  const phase = state.phase;
  const hasAttacks = table.length > 0;
  const allDefended = hasAttacks && table.every(t => t.defense !== undefined);

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.info}>Trump {SUIT[trump] ?? '?'}{trumpCard >= 0 ? ` ${rankOf(trumpCard)}` : ''}</Text>
        <Text style={s.info}>Deck {deckCount}</Text>
        <Text style={s.role}>{amDefender ? 'Defending' : 'Attacking'}</Text>
      </View>

      <Text style={s.label}>Table</Text>
      <View style={s.table}>
        {!hasAttacks ? <Text style={s.empty}>No attacks yet</Text> : table.map((t, i) => (
          <View key={i} style={s.pair}>
            <Pip c={t.attack} trump={suitOf(t.attack) === trump} />
            {t.defense !== undefined
              ? <Pip c={t.defense} trump={suitOf(t.defense) === trump} dim />
              : <View style={cs.slot} />}
          </View>
        ))}
      </View>

      <Text style={s.label}>Your hand {myTurn ? '• your move' : ''}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hand}>
        {hand.map((c, i) => (
          <Pip key={`${c}-${i}`} c={c} trump={suitOf(c) === trump}
            onPress={myTurn ? () => onMove(amDefender ? { action: 'defend', card: c } : { action: 'attack', card: c }) : undefined} />
        ))}
      </ScrollView>

      <View style={s.actions}>
        {amDefender ? (
          <TouchableOpacity disabled={!myTurn || !hasAttacks} onPress={() => onMove({ action: 'take' })}
            style={[s.btn, (!myTurn || !hasAttacks) && s.off]}><Text style={s.btnTxt}>Take cards</Text></TouchableOpacity>
        ) : (
          <TouchableOpacity disabled={!myTurn || !allDefended} onPress={() => onMove({ action: 'done' })}
            style={[s.btn, (!myTurn || !allDefended) && s.off]}><Text style={s.btnTxt}>Done (beat)</Text></TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const cs = StyleSheet.create({
  card: { width: 40, height: 56, borderRadius: 7, backgroundColor: '#FAFAF7', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#C9C2A8' },
  slot: { width: 40, height: 56, borderRadius: 7, borderWidth: 1, borderStyle: 'dashed', borderColor: Aurora.border },
  dim: { opacity: 0.7, transform: [{ translateY: 6 }] },
  trump: { borderColor: Aurora.accent, borderWidth: 2 },
  rank: { color: '#1A1A1A', fontSize: 16, fontWeight: '800' },
  suit: { color: '#1A1A1A', fontSize: 14 },
  red: { color: '#C0392B' },
});
const s = StyleSheet.create({
  wrap: { width: '100%', gap: 10 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  info: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  role: { color: Aurora.accent, fontSize: 12, fontWeight: '800' },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  table: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, minHeight: 56, alignItems: 'center' },
  pair: { gap: 0 },
  empty: { color: Aurora.textFaint, fontSize: 13 },
  hand: { gap: 5, paddingVertical: 10 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center' },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
});

export default DurakView;
