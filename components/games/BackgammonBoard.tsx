/**
 * BackgammonBoard — wired to gameEngines backgammonMove. board[24]: + = p1,
 * - = p2 (abs = checker count). Phase 'roll' → { action:'roll' }; 'move' →
 * { action:'move', from, dieValue }. Pick a die, then tap one of your points.
 */
import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

export function BackgammonBoard({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const board: number[] = state.board;
  const isP1 = state.players[0] === myId;
  const sign = isP1 ? 1 : -1;
  const dice: number[] = state.data?.dice ?? [];
  const bar: number = state.data?.bar?.[myId] ?? 0;
  const borneOff: number = state.data?.borneOff?.[myId] ?? 0;
  const phase = state.phase;
  const [activeDie, setActiveDie] = useState<number | null>(null);

  const pickDie = () => activeDie ?? dice[0] ?? null;
  const moveFrom = (from: number) => {
    const die = pickDie();
    if (die != null) onMove({ action: 'move', from, dieValue: die });
  };
  const enterFromBar = () => { const die = pickDie(); if (die != null) onMove({ action: 'move', from: -1, dieValue: die }); };

  const Point = ({ i }: { i: number }) => {
    const v = board[i];
    const count = Math.abs(v);
    const mine = v * sign > 0;
    return (
      <TouchableOpacity disabled={!myTurn || phase !== 'move' || !mine || bar > 0}
        onPress={() => moveFrom(i)} activeOpacity={0.7}
        style={[s.point, mine && phase === 'move' && bar === 0 && s.pointMine]}>
        <Text style={s.idx}>{i + 1}</Text>
        {count > 0 && (
          <View style={[s.checker, v > 0 ? s.p1 : s.p2]}><Text style={s.cc}>{count}</Text></View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.wrap}>
      <View style={s.statusRow}>
        <Text style={s.status}>Bar {bar}</Text>
        <Text style={s.status}>Borne off {borneOff}/15</Text>
      </View>

      <View style={s.grid}>
        <View style={s.row}>{Array.from({ length: 12 }, (_, i) => <Point key={i} i={i} />)}</View>
        <View style={s.row}>{Array.from({ length: 12 }, (_, i) => <Point key={12 + i} i={12 + i} />)}</View>
      </View>

      {phase === 'roll' ? (
        <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ action: 'roll' })} style={[s.rollBtn, !myTurn && s.off]} activeOpacity={0.85}>
          <Text style={s.rollTxt}>🎲  Roll dice</Text>
        </TouchableOpacity>
      ) : (
        <View style={s.diceArea}>
          <Text style={s.diceLabel}>Dice (tap to select):</Text>
          <View style={s.diceRow}>
            {dice.length === 0 ? <Text style={s.status}>—</Text> : dice.map((d, i) => (
              <TouchableOpacity key={i} onPress={() => setActiveDie(d)} style={[s.die, (activeDie ?? dice[0]) === d && s.dieActive]}>
                <Text style={s.dieTxt}>{d}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {bar > 0 && (
            <TouchableOpacity disabled={!myTurn} onPress={enterFromBar} style={[s.barBtn, !myTurn && s.off]}>
              <Text style={s.barTxt}>Enter from bar</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 12 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between' },
  status: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  grid: { backgroundColor: '#3A2616', borderRadius: 12, padding: 6, gap: 24, borderWidth: 1, borderColor: '#5A4028' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  point: { flex: 1, alignItems: 'center', minHeight: 44, gap: 3, paddingVertical: 2 },
  pointMine: { backgroundColor: 'rgba(16,185,129,0.15)', borderRadius: 4 },
  idx: { color: 'rgba(255,255,255,0.3)', fontSize: 8 },
  checker: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  p1: { backgroundColor: '#10B981' },
  p2: { backgroundColor: '#C0392B' },
  cc: { color: '#04130D', fontSize: 11, fontWeight: '800' },
  rollBtn: { backgroundColor: Aurora.primary, paddingVertical: 14, borderRadius: 16, alignItems: 'center' },
  off: { opacity: 0.4 },
  rollTxt: { color: '#04130D', fontSize: 16, fontWeight: '800' },
  diceArea: { gap: 8, alignItems: 'center' },
  diceLabel: { color: Aurora.textDim, fontSize: 12, fontWeight: '600' },
  diceRow: { flexDirection: 'row', gap: 10 },
  die: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#FAFAF7', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  dieActive: { borderColor: Aurora.primary },
  dieTxt: { color: '#1A1A1A', fontSize: 20, fontWeight: '800' },
  barBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  barTxt: { color: Aurora.text, fontSize: 13, fontWeight: '700' },
});

export default BackgammonBoard;
