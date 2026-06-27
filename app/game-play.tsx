// app/game-play.tsx
// Generic game play screen — handles Socket.io game state relay,
// turn management, coin awards, and renders game-specific components
// Each game type will have its own logic module in services/games/

import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useRef , useMemo} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '../lib/api';
import { SERVER_URL } from '../constants/server';
import { recordGameResult, ALL_GAMES, cryptoDiceRoll } from '../services/gameService';
import { initGame, makeGameMove, checkGameWinner, getBotMove, type GameState } from '../services/gameEngines';
import { GameBoard } from '../components/games/GameBoard';


function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function GamePlayScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { roomId, gameType, bet, opponentUid, opponentName, yourTurn: initialTurn, myUid } = useLocalSearchParams<{
    roomId: string; gameType: string; bet: string; opponentUid: string; opponentName: string; yourTurn: string; myUid: string;
  }>();

  const uid = myUid ?? '';
  const isBot = opponentUid === 'bot';
  const betAmount = parseInt(bet ?? '0', 10);
  const game = ALL_GAMES.find(g => g.id === gameType);

  const [myTurn, setMyTurn] = useState(initialTurn === 'true');
  const [gameState, setGameState] = useState<any>(() => {
    try { return initGame(gameType ?? 'vaultdice', [uid, opponentUid ?? 'bot']); }
    catch { return { moves: [], score: { me: 0, opp: 0 } }; }
  });
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  const [connected, setConnected] = useState(isBot);
  const [chatMsgs, setChatMsgs] = useState<{ from: string; text: string }[]>([]);

  // Some game engines (chess/ludo/rummy…) return a board-shaped state with no
  // score/moves. Default them so the generic screen never crashes on render.
  const score = gameState?.score ?? { me: 0, opp: 0 };
  const moves: any[] = Array.isArray(gameState?.moves) ? gameState.moves : [];
  // This generic screen only implements the dice game; other engines (chess,
  // ludo…) have no board UI yet, so don't offer a dice action that they reject.
  const isDiceGame = (gameType ?? 'vaultdice') === 'vaultdice';

  const socketRef = useRef<Socket | null>(null);

  // Socket connection for multiplayer
  useEffect(() => {
    if (isBot) return;
    let sock: Socket;
    (async () => {
      const token = await getAccessToken();
      sock = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = sock;
      // Re-join the game room (this is a fresh socket, not the lobby's).
      sock.emit('game_rejoin', { roomId });

      sock.on('connect', () => setConnected(true));
      sock.on('game_rejoined', () => setConnected(true));

      sock.on('game_move', ({ uid: moveUid, move }: any) => {
        if (moveUid !== uid) {
          setGameState((prev: any) => ({
            ...prev,
            moves: [...(prev.moves ?? []), { uid: moveUid, move, ts: Date.now() }],
          }));
          setMyTurn(true);
        }
      });

      sock.on('game_ended', ({ winnerId, totalPot, reason }: any) => {
        setGameOver(true);
        setWinner(winnerId);
        const result = winnerId === uid ? 'win' : 'loss';
        const coinsWon = winnerId === uid ? totalPot : -betAmount;
        recordGameResult(result, coinsWon);
      });

      sock.on('game_chat', ({ uid: fromUid, text }: any) => {
        setChatMsgs(prev => [...prev, { from: fromUid === uid ? 'You' : opponentName ?? 'Opponent', text }]);
      });
    })();

    return () => { sock?.disconnect(); };
  }, [isBot, roomId, uid]);

  // Which seat (if any) the bot should play next. Normally it's whoever's
  // state.turn isn't me. Durak is role-based (defender acts in the defend
  // phase), so it needs a special case. Returns null when it's MY move.
  const botActorFor = (st: GameState): string | null => {
    if (st.finished) return null;
    if (gameType === 'durak') {
      const defender = st.data?.defender;
      if (st.phase === 'defend' && defender && defender !== uid) return defender;
      if (st.phase === 'attack' && st.turn !== uid) return st.turn;
      return null;
    }
    return st.turn !== uid ? st.turn : null;
  };

  const makeMove = (move: any) => {
    if (gameOver) return;
    if (!myTurn && !isBot) return;

    const result = makeGameMove(gameType ?? 'vaultdice', gameState, move, uid);
    if (!result.valid) return; // invalid tap — ignore silently
    setGameState(result.state);

    const winCheck = checkGameWinner(gameType ?? 'vaultdice', result.state);
    if (winCheck.winner || winCheck.draw) {
      endGame(winCheck.draw ? uid : winCheck.winner!, winCheck.draw ? 'Draw' : 'Game over');
      return;
    }

    if (!isBot) {
      setMyTurn(result.state.turn === uid);
      socketRef.current?.emit('game_move', { roomId, uid, move });
      return;
    }
    const actor = botActorFor(result.state);
    setMyTurn(actor === null);
    if (actor) runBotTurn(result.state);
  };

  // Drive the bot through its full turn (possibly several engine moves, across
  // multiple seats / roles) until control returns to the player.
  const runBotTurn = (start: GameState) => {
    setTimeout(() => {
      let s = start;
      let guard = 0;
      let actor: string | null;
      while ((actor = botActorFor(s)) && guard++ < 80) {
        const botMove = getBotMove(gameType ?? 'vaultdice', s, 'easy');
        const r = makeGameMove(gameType ?? 'vaultdice', s, botMove, actor);
        if (!r.valid) break;
        s = r.state;
      }
      setGameState(s);
      const w = checkGameWinner(gameType ?? 'vaultdice', s);
      if (w.winner || w.draw) { endGame(w.draw ? uid : w.winner!, w.draw ? 'Draw' : 'Game over'); return; }
      setMyTurn(botActorFor(s) === null);
    }, 700 + Math.random() * 600);
  };

  // Dry-run a candidate move against the current state (engine clones state,
  // so this never mutates). Boards use it to highlight legal destinations.
  const dryRun = (move: any): boolean => {
    try { return makeGameMove(gameType ?? 'vaultdice', gameState, move, uid).valid; }
    catch { return false; }
  };

  const endGame = (winnerId: string, reason = 'Game over') => {
    setGameOver(true);
    setWinner(winnerId);

    if (isBot) {
      const result = winnerId === uid ? 'win' : 'loss';
      recordGameResult(result, winnerId === uid ? betAmount : -betAmount);
    } else {
      socketRef.current?.emit('game_end', { roomId, winnerId, reason });
    }
  };

  const resign = () => {
    Alert.alert('Resign?', 'You will lose this game.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Resign', style: 'destructive', onPress: () => endGame(isBot ? 'bot' : opponentUid ?? '', 'Resigned') },
    ]);
  };

  // Simple dice game as default (VaultDice / generic)
  const rollDice = () => {
    const { roll } = cryptoDiceRoll();
    makeMove({ type: 'dice', value: roll });

    if (isBot) {
      setTimeout(() => {
        const botRoll = cryptoDiceRoll();
        const myTotal = (gameState.score?.me ?? 0) + roll;
        const oppTotal = (gameState.score?.opp ?? 0) + botRoll.roll;

        setGameState((prev: any) => ({
          ...prev,
          score: { me: (prev.score?.me ?? 0) + roll, opp: (prev.score?.opp ?? 0) + botRoll.roll },
          moves: [...(prev.moves ?? []), { uid: 'bot', move: { type: 'dice', value: botRoll.roll }, ts: Date.now() }],
        }));

        // End game at 100 points
        if (myTotal + roll >= 100 || oppTotal + botRoll.roll >= 100) {
          const w = (myTotal + roll) >= 100 ? uid : 'bot';
          setTimeout(() => endGame(w, 'Reached 100 points'), 500);
        }
      }, 1000);
    }
  };

  if (!connected && !isBot) {
    return (
      <View style={[s.screen, s.center]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={colors.purple} />
        <Text style={{ color: colors.textDim, marginTop: 12 }}>Connecting to game...</Text>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={resign} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{game?.icon ?? '\uD83C\uDFAE'} {game?.name ?? gameType}</Text>
          <Text style={s.headerSub}>vs {opponentName ?? 'Opponent'} {betAmount > 0 ? `\u2022 ${betAmount} coins` : ''}</Text>
        </View>
        <View style={[s.turnBadge, myTurn ? s.turnBadgeActive : {}]}>
          <Text style={s.turnTxt}>{myTurn ? 'Your Turn' : 'Waiting...'}</Text>
        </View>
      </View>

      {/* Game area */}
      <View style={s.gameArea}>
        {/* Scores */}
        <View style={s.scoreRow}>
          <View style={[s.scoreCard, myTurn && s.scoreCardActive]}>
            <Text style={s.scoreName}>You</Text>
            <Text style={s.scoreVal}>{score.me}</Text>
          </View>
          <Text style={s.vsText}>VS</Text>
          <View style={[s.scoreCard, !myTurn && s.scoreCardActive]}>
            <Text style={s.scoreName}>{opponentName ?? 'Bot'}</Text>
            <Text style={s.scoreVal}>{score.opp}</Text>
          </View>
        </View>

        {/* Move history */}
        <View style={s.movesCard}>
          <Text style={s.movesTitle}>Moves ({moves.length})</Text>
          {moves.slice(-6).map((m: any, i: number) => (
            <View key={i} style={s.moveRow}>
              <Text style={s.moveFrom}>{m.uid === uid ? 'You' : opponentName ?? 'Bot'}</Text>
              <Text style={s.moveVal}>{m.move?.type === 'dice' ? `\uD83C\uDFB2 ${m.move.value}` : JSON.stringify(m.move)}</Text>
            </View>
          ))}
        </View>

        {/* Action button (dice roll) \u2014 only the dice game is playable here. */}
        {!gameOver && isDiceGame && (
          <TouchableOpacity style={[s.actionBtn, !myTurn && s.actionBtnDisabled]} onPress={rollDice} disabled={!myTurn} activeOpacity={0.8}>
            <Text style={s.actionBtnIcon}>{'\uD83C\uDFB2'}</Text>
            <Text style={s.actionBtnTxt}>{myTurn ? 'Roll Dice' : 'Waiting for opponent...'}</Text>
          </TouchableOpacity>
        )}

        {/* Board games render their engine-backed board. */}
        {!gameOver && !isDiceGame && (
          <View style={{ alignItems: 'center', marginVertical: 8 }}>
            <GameBoard state={gameState} myId={uid} myTurn={myTurn} onMove={makeMove} validate={dryRun} />
          </View>
        )}

        {/* Game over */}
        {gameOver && (
          <View style={s.gameOverCard}>
            <Text style={s.gameOverIcon}>{winner === uid ? '\uD83C\uDFC6' : '\uD83D\uDE1E'}</Text>
            <Text style={s.gameOverTitle}>{winner === uid ? 'You Won!' : 'You Lost'}</Text>
            {betAmount > 0 && <Text style={s.gameOverCoins}>{winner === uid ? `+${betAmount * 2}` : `-${betAmount}`} coins</Text>}
            <TouchableOpacity style={s.gameOverBtn} onPress={() => router.back()}>
              <Text style={s.gameOverBtnTxt}>Back to Lobby</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

// Bot moves now handled by services/gameEngines.ts getBotMove()

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  center: { justifyContent: 'center', alignItems: 'center' },

  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: c.text },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerSub: { fontSize: 12, color: c.textDim, marginTop: 1 },
  turnBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#2A2D3A' },
  turnBadgeActive: { backgroundColor: c.primary + '20' },
  turnTxt: { color: c.primary, fontSize: 11, fontWeight: '700' },

  gameArea: { flex: 1, padding: 16 },

  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 20 },
  scoreCard: { backgroundColor: c.card, borderRadius: 14, padding: 16, alignItems: 'center', width: 120, borderWidth: 1, borderColor: c.border },
  scoreCardActive: { borderColor: c.primary },
  scoreName: { color: c.textDim, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  scoreVal: { color: c.text, fontSize: 32, fontWeight: '800' },
  vsText: { color: c.textDim, fontSize: 16, fontWeight: '700' },

  movesCard: { backgroundColor: c.card, borderRadius: 14, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: c.border },
  movesTitle: { color: c.purple, fontSize: 12, fontWeight: '600', marginBottom: 8 },
  moveRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.border },
  moveFrom: { color: c.textDim, fontSize: 12 },
  moveVal: { color: c.text, fontSize: 13, fontWeight: '600' },

  actionBtn: { backgroundColor: c.purple, borderRadius: 16, paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 },
  actionBtnDisabled: { backgroundColor: '#2A2D3A', opacity: 0.5 },
  actionBtnIcon: { fontSize: 24 },
  actionBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },

  gameOverCard: { alignItems: 'center', backgroundColor: c.card, borderRadius: 20, padding: 28, borderWidth: 1, borderColor: c.accent + '40' },
  gameOverIcon: { fontSize: 56, marginBottom: 12 },
  gameOverTitle: { color: c.text, fontSize: 24, fontWeight: '800', marginBottom: 4 },
  gameOverCoins: { color: c.accent, fontSize: 18, fontWeight: '700', marginBottom: 20 },
  gameOverBtn: { backgroundColor: c.purple, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 36 },
  gameOverBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },
});
