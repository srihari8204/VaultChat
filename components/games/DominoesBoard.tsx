/**
 * DominoesBoard — double-6 dominoes wired to gameEngines dominoesMove
 * ({ action:'play', tileIndex, end } | 'draw' | 'pass'). hands[me] = tiles,
 * board = laid chain, data.leftEnd/rightEnd.
 */
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

function Tile({ t, onPress, active, disabled }: { t: number[]; onPress?: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <TouchableOpacity disabled={disabled || !onPress} onPress={onPress} activeOpacity={0.7}
      style={[s.tile, active && s.tileActive]}>
      <Text style={s.pip}>{t[0]}</Text>
      <View style={s.divider} />
      <Text style={s.pip}>{t[1]}</Text>
    </TouchableOpacity>
  );
}

export function DominoesBoard({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const hand: number[][] = (state.hands?.[myId] as any) ?? [];
  const chain: number[][] = (state.board as any) ?? [];
  const leftEnd: number = state.data?.leftEnd ?? -1;
  const rightEnd: number = state.data?.rightEnd ?? -1;
  const boneyard: number = state.data?.boneyard?.length ?? 0;

  const playTile = (i: number) => {
    if (!myTurn) return;
    const t = hand[i];
    if (chain.length === 0) return onMove({ action: 'play', tileIndex: i, end: 'right' });
    if (t.includes(rightEnd)) return onMove({ action: 'play', tileIndex: i, end: 'right' });
    if (t.includes(leftEnd)) return onMove({ action: 'play', tileIndex: i, end: 'left' });
    // no matching end — ignore
  };

  return (
    <View style={s.wrap}>
      <Text style={s.label}>Board {chain.length > 0 ? `(ends ${leftEnd} · ${rightEnd})` : ''}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chain} contentContainerStyle={s.chainContent}>
        {chain.length === 0
          ? <Text style={s.empty}>Play the first tile to start the chain</Text>
          : chain.map((t, i) => <Tile key={i} t={t} disabled />)}
      </ScrollView>

      <View style={s.actions}>
        <TouchableOpacity disabled={!myTurn || boneyard === 0} onPress={() => onMove({ action: 'draw' })}
          style={[s.actBtn, (!myTurn || boneyard === 0) && s.actOff]} activeOpacity={0.8}>
          <Text style={s.actTxt}>Draw ({boneyard})</Text>
        </TouchableOpacity>
        <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ action: 'pass' })}
          style={[s.actBtn, !myTurn && s.actOff]} activeOpacity={0.8}>
          <Text style={s.actTxt}>Pass</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.label}>Your tiles {myTurn ? '• your turn' : ''}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.handContent}>
        {hand.map((t, i) => {
          const playable = myTurn && (chain.length === 0 || t.includes(leftEnd) || t.includes(rightEnd));
          return <Tile key={i} t={t} onPress={() => playTile(i)} active={playable} />;
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 10 },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  chain: { maxHeight: 64 },
  chainContent: { gap: 4, alignItems: 'center', paddingVertical: 6 },
  empty: { color: Aurora.textFaint, fontSize: 13 },
  handContent: { gap: 8, paddingVertical: 6 },
  tile: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F2E8', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderWidth: 1, borderColor: '#C9C2A8' },
  tileActive: { borderColor: Aurora.primary, borderWidth: 2 },
  pip: { color: '#1A1A1A', fontSize: 18, fontWeight: '800', minWidth: 14, textAlign: 'center' },
  divider: { width: 1, height: 22, backgroundColor: '#1A1A1A' },
  actions: { flexDirection: 'row', gap: 10 },
  actBtn: { flex: 1, paddingVertical: 10, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center' },
  actOff: { opacity: 0.4 },
  actTxt: { color: Aurora.text, fontSize: 13, fontWeight: '700' },
});

export default DominoesBoard;
