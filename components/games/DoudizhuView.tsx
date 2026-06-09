/**
 * DoudizhuView — 3-player "Fight the Landlord" wired to gameEngines
 * doudizhuMove. Bid phase: { bid }. Play phase: { action:'play', cards } |
 * { action:'pass' }. hands include jokers (52 small, 53 big).
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';
import { Card } from './Card';

export function DoudizhuView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  useEffect(() => { if (!myTurn) setSel([]); }, [myTurn]);

  const hand: number[] = (state.hands?.[myId] as any) ?? [];
  const phase = state.phase;
  const landlord = state.data?.landlord;
  const lastPlay: number[] | null = state.data?.lastPlay ?? null;
  const lastPlayer = state.data?.lastPlayer;
  const opps = state.players.filter(p => p !== myId);

  const toggle = (c: number) => setSel(s => s.includes(c) ? s.filter(x => x !== c) : [...s, c]);
  const play = () => { if (sel.length) { onMove({ action: 'play', cards: sel }); setSel([]); } };
  const canPass = phase === 'play' && !!lastPlay && lastPlayer !== myId;

  return (
    <View style={s.wrap}>
      {/* Opponents */}
      <View style={s.oppRow}>
        {opps.map(p => (
          <View key={p} style={s.opp}>
            <Text style={s.oppName}>{landlord === p ? '👑 ' : ''}Bot {opps.indexOf(p) + 1}</Text>
            <Text style={s.oppCount}>{(state.hands?.[p] as any)?.length ?? 0} cards</Text>
          </View>
        ))}
      </View>

      {/* Centre: last play */}
      <View style={s.center}>
        {phase === 'bid' ? (
          <Text style={s.bidLabel}>Bidding for landlord…</Text>
        ) : lastPlay && lastPlay.length ? (
          <View style={s.lastRow}>{lastPlay.map((c, i) => <Card key={i} c={c} small />)}</View>
        ) : (
          <Text style={s.bidLabel}>{myTurn ? 'Your lead' : 'Waiting…'}</Text>
        )}
      </View>

      {/* My hand */}
      <Text style={s.label}>You {landlord === myId ? '👑 landlord' : ''} · {hand.length} cards</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.handRow}>
        {hand.map((c, i) => (
          <Card key={`${c}-${i}`} c={c} small raised={sel.includes(c)} onPress={phase === 'play' && myTurn ? () => toggle(c) : undefined} />
        ))}
      </ScrollView>

      {/* Actions */}
      {phase === 'bid' ? (
        <View style={s.actions}>
          <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ bid: false })} style={[s.btn, !myTurn && s.off]}><Text style={s.btnTxt}>Pass</Text></TouchableOpacity>
          <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ bid: true })} style={[s.btn, s.primary, !myTurn && s.off]}><Text style={s.btnTxt}>Bid 👑</Text></TouchableOpacity>
        </View>
      ) : (
        <View style={s.actions}>
          <TouchableOpacity disabled={!myTurn || !canPass} onPress={() => onMove({ action: 'pass' })} style={[s.btn, (!myTurn || !canPass) && s.off]}><Text style={s.btnTxt}>Pass</Text></TouchableOpacity>
          <TouchableOpacity disabled={!myTurn || sel.length === 0} onPress={play} style={[s.btn, s.primary, (!myTurn || sel.length === 0) && s.off]}><Text style={s.btnTxt}>Play {sel.length || ''}</Text></TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 12 },
  oppRow: { flexDirection: 'row', justifyContent: 'space-around' },
  opp: { alignItems: 'center', gap: 2 },
  oppName: { color: Aurora.text, fontSize: 13, fontWeight: '700' },
  oppCount: { color: Aurora.textDim, fontSize: 11 },
  center: { minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  bidLabel: { color: Aurora.textDim, fontSize: 13, fontWeight: '600' },
  lastRow: { flexDirection: 'row', gap: 4 },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  handRow: { gap: 4, paddingVertical: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center' },
  primary: { backgroundColor: Aurora.primary, borderColor: Aurora.primary },
  off: { opacity: 0.4 },
  btnTxt: { color: Aurora.text, fontSize: 14, fontWeight: '700' },
});

export default DoudizhuView;
