/**
 * GameBoard — dispatches a GameState to the right board UI. Each board calls
 * onMove(move) which game-play.tsx feeds into makeGameMove + the bot loop.
 * Boards are added incrementally; unimplemented types show a placeholder.
 */
import { StyleSheet, Text, View } from 'react-native';
import type { GameState } from '../../services/gameEngines';
import { Aurora } from '../../constants/theme';
import { ChessBoard } from './ChessBoard';
import { MancalaBoard } from './MancalaBoard';
import { TriviaView } from './TriviaView';
import { GoBoard } from './GoBoard';
import { XiangqiBoard } from './XiangqiBoard';
import { DominoesBoard } from './DominoesBoard';
import { LudoBoard } from './LudoBoard';
import { PokerView } from './PokerView';
import { DoudizhuView } from './DoudizhuView';
import { ShogiBoard } from './ShogiBoard';
import { RummyView } from './RummyView';
import { BackgammonBoard } from './BackgammonBoard';
import { CarromBoard } from './CarromBoard';
import { TrucoView } from './TrucoView';
import { DurakView } from './DurakView';
import { OkeyView } from './OkeyView';
import { HanafudaView } from './HanafudaView';
import { MahjongView } from './MahjongView';

export function GameBoard({
  state, myId, myTurn, onMove, validate,
}: {
  state: GameState;
  myId: string;
  myTurn: boolean;
  onMove: (move: any) => void;
  validate?: (move: any) => boolean;
}) {
  const gt = state?.gameType;

  if (gt === 'chess') {
    const myColor = state.players[0] === myId ? 'w' : 'b';
    return <ChessBoard board={state.board} myColor={myColor} disabled={!myTurn} onMove={onMove} validate={validate} />;
  }
  if (gt === 'mancala') return <MancalaBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'trivia') return <TriviaView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'go') return <GoBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'xiangqi') return <XiangqiBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} validate={validate} />;
  if (gt === 'dominoes') return <DominoesBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'ludo') return <LudoBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'poker') return <PokerView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'doudizhu') return <DoudizhuView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'shogi') return <ShogiBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} validate={validate} />;
  if (gt === 'rummy') return <RummyView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'backgammon') return <BackgammonBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'carrom') return <CarromBoard state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'truco') return <TrucoView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'durak') return <DurakView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'okey') return <OkeyView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'hanafuda') return <HanafudaView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;
  if (gt === 'mahjong') return <MahjongView state={state} myId={myId} myTurn={myTurn} onMove={onMove} />;

  return (
    <View style={s.placeholder}>
      <Text style={s.icon}>🎲</Text>
      <Text style={s.title}>{gt} board coming soon</Text>
      <Text style={s.sub}>The engine is ready; the board UI is being built.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center', padding: 28, borderRadius: 16, backgroundColor: Aurora.surface },
  icon: { fontSize: 40, marginBottom: 8 },
  title: { color: Aurora.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sub: { color: Aurora.textDim, fontSize: 12, textAlign: 'center' },
});

export default GameBoard;
