/**
 * TriviaView — wired to gameEngines triviaMove ({ answer }). Both players
 * answer each round; the engine advances when all have answered.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';

export function TriviaView({
  state, myId, myTurn, onMove,
}: {
  state: GameState; myId: string; myTurn: boolean; onMove: (m: any) => void;
}) {
  const d: any = state.data ?? {};
  const q: any = d.questions?.[d.currentQ];
  const opponent = state.players.find(p => p !== myId) ?? '';
  const answered = d.answers?.[myId] !== undefined;
  const options: string[] = q ? (q.options ?? q.answers ?? q.choices ?? []) : [];

  if (!q) return <View style={s.wrap}><Text style={s.q}>Quiz complete</Text></View>;

  return (
    <View style={s.wrap}>
      <View style={s.topRow}>
        <Text style={s.progress}>Q {d.currentQ + 1} / {d.questions.length}</Text>
        <Text style={s.score}>You {state.scores?.[myId] ?? 0} · Opp {state.scores?.[opponent] ?? 0}</Text>
      </View>
      <Text style={s.q}>{q.question ?? q.text ?? 'Question'}</Text>
      <View style={s.options}>
        {options.map((opt, i) => {
          const mine = d.answers?.[myId] === i;
          return (
            <TouchableOpacity
              key={i}
              disabled={!myTurn || answered}
              onPress={() => onMove({ answer: i })}
              style={[s.option, mine && s.optionMine, (!myTurn || answered) && !mine && s.optionDim]}
              activeOpacity={0.8}
            >
              <Text style={s.optionTxt}>{opt}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {answered && <Text style={s.waiting}>Waiting for opponent…</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', gap: 14 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progress: { color: Aurora.accent, fontSize: 12, fontWeight: '700' },
  score: { color: Aurora.textDim, fontSize: 12, fontWeight: '700' },
  q: { color: Aurora.text, fontSize: 18, fontWeight: '800', lineHeight: 24 },
  options: { gap: 10 },
  option: { backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, borderRadius: 14, padding: 16 },
  optionMine: { borderColor: Aurora.primary, backgroundColor: 'rgba(16,185,129,0.12)' },
  optionDim: { opacity: 0.5 },
  optionTxt: { color: Aurora.text, fontSize: 15, fontWeight: '600' },
  waiting: { color: Aurora.textDim, fontSize: 13, textAlign: 'center' },
});

export default TriviaView;
