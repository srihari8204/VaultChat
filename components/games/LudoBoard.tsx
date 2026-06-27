/**
 * LudoBoard — wired to gameEngines ludoMove. Two-phase turn: 'roll' (tap Roll)
 * then 'move' (tap a movable token). board[player] = 4 token positions
 * (-1 yard, 0-51 track, 52-57 home stretch, 57 = home). Rolling a 6 repeats.
 */
import { brandAlpha } from '../../constants/theme';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

const label = (pos: number) =>
  pos === -1 ? 'Yard' : pos === 57 ? '🏁' : pos >= 52 ? `Home ${pos - 51}` : `Sq ${pos}`;

export function LudoBoard({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const tokens: number[] = (state.board?.[myId] as any) ?? [-1, -1, -1, -1];
  const phase = state.phase;
  const dice: number = state.data?.diceValue ?? 0;
  const opp = state.players.find(p => p !== myId) ?? '';
  const oppTokens: number[] = (state.board?.[opp] as any) ?? [];
  const oppHome = oppTokens.filter(t => t === 57).length;
  const myHome = tokens.filter(t => t === 57).length;

  const canMove = (pos: number) =>
    phase === 'move' && (pos === -1 ? dice === 6 : pos >= 52 ? pos + dice <= 57 : true);

  return (
    <View style={s.wrap}>
      <View style={s.scoreRow}>
        <Text style={s.score}>You home {myHome}/4</Text>
        <Text style={s.score}>Opp home {oppHome}/4</Text>
      </View>

      <View style={s.diceArea}>
        {phase === 'roll' ? (
          <TouchableOpacity disabled={!myTurn} onPress={() => onMove({ tokenIndex: 0 })}
            style={[s.rollBtn, !myTurn && s.off]} activeOpacity={0.85}>
            <Text style={s.rollTxt}>🎲  Roll dice</Text>
          </TouchableOpacity>
        ) : (
          <View style={s.diceShow}>
            <Text style={s.diceVal}>🎲 {dice}</Text>
            <Text style={s.diceHint}>Tap a token to move</Text>
          </View>
        )}
      </View>

      <Text style={s.label}>Your tokens {myTurn ? '• your turn' : ''}</Text>
      <View style={s.tokens}>
        {tokens.map((pos, i) => {
          const movable = myTurn && canMove(pos);
          return (
            <TouchableOpacity key={i} disabled={!movable} onPress={() => onMove({ tokenIndex: i })}
              style={[s.token, movable && s.tokenActive, pos === 57 && s.tokenDone]} activeOpacity={0.7}>
              <View style={s.tokenDot}><Text style={s.tokenNum}>{i + 1}</Text></View>
              <Text style={s.tokenPos}>{label(pos)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 14 },
  scoreRow: { flexDirection: 'row', justifyContent: 'space-between' },
  score: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  diceArea: { alignItems: 'center', minHeight: 64, justifyContent: 'center' },
  rollBtn: { backgroundColor: Aurora.primary, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 16 },
  off: { opacity: 0.4 },
  rollTxt: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  diceShow: { alignItems: 'center', gap: 4 },
  diceVal: { color: Aurora.text, fontSize: 30, fontWeight: '800' },
  diceHint: { color: Aurora.textDim, fontSize: 12 },
  label: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  tokens: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  token: { width: '47%', flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border },
  tokenActive: { borderColor: Aurora.primary, backgroundColor: brandAlpha(0.1) },
  tokenDone: { opacity: 0.6 },
  tokenDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: Aurora.purple, alignItems: 'center', justifyContent: 'center' },
  tokenNum: { color: '#fff', fontSize: 13, fontWeight: '800' },
  tokenPos: { color: Aurora.text, fontSize: 14, fontWeight: '600' },
});

export default LudoBoard;
