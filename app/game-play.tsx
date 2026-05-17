// app/game-play.tsx
// Generic game play screen — handles Socket.io game state relay,
// turn management, coin awards, and renders game-specific components
// Each game type will have its own logic module in services/games/

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { io, Socket } from 'socket.io-client';
import auth from '@react-native-firebase/auth';
import { SERVER_URL } from '../constants/server';
import { recordGameResult, ALL_GAMES, cryptoDiceRoll } from '../services/gameService';
import { initGame, makeGameMove, checkGameWinner, getBotMove } from '../services/gameEngines';

const DARK = '#0D0F14';
const CARD = '#1A1D27';
const PURPLE = '#6C63FF';
const BORDER = '#2A2D3A';
const TXT = '#E8E8E8';
const SUB = '#6B7280';
const GREEN = '#10B981';
const RED = '#EF4444';
const GOLD = '#F59E0B';

export default function GamePlayScreen() {
  const router = useRouter();
  const { roomId, gameType, bet, opponentUid, opponentName, yourTurn: initialTurn } = useLocalSearchParams<{
    roomId: string; gameType: string; bet: string; opponentUid: string; opponentName: string; yourTurn: string;
  }>();

  const uid = auth().currentUser?.uid ?? '';
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

  const socketRef = useRef<Socket | null>(null);

  // Socket connection for multiplayer
  useEffect(() => {
    if (isBot) return;
    let sock: Socket;
    (async () => {
      const token = await auth().currentUser?.getIdToken();
      sock = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = sock;
      sock.emit('join_chat', { chatId: roomId, uid }); // reuse chat room mechanism

      sock.on('connect', () => setConnected(true));

      sock.on('game_move', ({ uid: moveUid, move }: any) => {
        if (moveUid !== uid) {
          setGameState((prev: any) => ({
            ...prev,
            moves: [...prev.moves, { uid: moveUid, move, ts: Date.now() }],
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

  const makeMove = (move: any) => {
    if (!myTurn && !isBot) return;

    // Apply move through game engine
    const result = makeGameMove(gameType ?? 'vaultdice', gameState, move, uid);
    if (!result.valid) {
      Alert.alert('Invalid Move', result.message ?? 'That move is not allowed');
      return;
    }
    setGameState(result.state);

    // Check for winner
    const winCheck = checkGameWinner(gameType ?? 'vaultdice', result.state);
    if (winCheck.winner || winCheck.draw) {
      endGame(winCheck.draw ? uid : winCheck.winner!, winCheck.draw ? 'Draw' : 'Checkmate');
      return;
    }

    if (isBot) {
      setMyTurn(false);
      setTimeout(() => {
        const botMove = getBotMove(gameType ?? 'vaultdice', result.state, 'easy');
        const botResult = makeGameMove(gameType ?? 'vaultdice', result.state, botMove, opponentUid ?? 'bot');
        if (botResult.valid) {
          setGameState(botResult.state);
          const botWin = checkGameWinner(gameType ?? 'vaultdice', botResult.state);
          if (botWin.winner || botWin.draw) {
            endGame(botWin.draw ? uid : botWin.winner!, botWin.draw ? 'Draw' : 'Game over');
            return;
          }
        }
        setMyTurn(true);
      }, 800 + Math.random() * 1200);
    } else {
      socketRef.current?.emit('game_move', { roomId, uid, move });
      setMyTurn(false);
    }
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
        const myTotal = gameState.score.me + roll;
        const oppTotal = gameState.score.opp + botRoll.roll;

        setGameState((prev: any) => ({
          ...prev,
          score: { me: prev.score.me + roll, opp: prev.score.opp + botRoll.roll },
          moves: [...prev.moves, { uid: 'bot', move: { type: 'dice', value: botRoll.roll }, ts: Date.now() }],
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
        <ActivityIndicator size="large" color={PURPLE} />
        <Text style={{ color: SUB, marginTop: 12 }}>Connecting to game...</Text>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={resign} style={s.backBtn}>
          <Text style={s.backTxt}>{'\u2190'}</Text>
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
            <Text style={s.scoreVal}>{gameState.score.me}</Text>
          </View>
          <Text style={s.vsText}>VS</Text>
          <View style={[s.scoreCard, !myTurn && s.scoreCardActive]}>
            <Text style={s.scoreName}>{opponentName ?? 'Bot'}</Text>
            <Text style={s.scoreVal}>{gameState.score.opp}</Text>
          </View>
        </View>

        {/* Move history */}
        <View style={s.movesCard}>
          <Text style={s.movesTitle}>Moves ({gameState.moves.length})</Text>
          {gameState.moves.slice(-6).map((m: any, i: number) => (
            <View key={i} style={s.moveRow}>
              <Text style={s.moveFrom}>{m.uid === uid ? 'You' : opponentName ?? 'Bot'}</Text>
              <Text style={s.moveVal}>{m.move?.type === 'dice' ? `\uD83C\uDFB2 ${m.move.value}` : JSON.stringify(m.move)}</Text>
            </View>
          ))}
        </View>

        {/* Action button (dice roll for default game) */}
        {!gameOver && (
          <TouchableOpacity style={[s.actionBtn, !myTurn && s.actionBtnDisabled]} onPress={rollDice} disabled={!myTurn} activeOpacity={0.8}>
            <Text style={s.actionBtnIcon}>{'\uD83C\uDFB2'}</Text>
            <Text style={s.actionBtnTxt}>{myTurn ? 'Roll Dice' : 'Waiting for opponent...'}</Text>
          </TouchableOpacity>
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

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  center: { justifyContent: 'center', alignItems: 'center' },

  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: TXT },
  headerTitle: { fontSize: 16, fontWeight: '700', color: TXT },
  headerSub: { fontSize: 12, color: SUB, marginTop: 1 },
  turnBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: '#2A2D3A' },
  turnBadgeActive: { backgroundColor: GREEN + '20' },
  turnTxt: { color: GREEN, fontSize: 11, fontWeight: '700' },

  gameArea: { flex: 1, padding: 16 },

  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 20 },
  scoreCard: { backgroundColor: CARD, borderRadius: 14, padding: 16, alignItems: 'center', width: 120, borderWidth: 1, borderColor: BORDER },
  scoreCardActive: { borderColor: GREEN },
  scoreName: { color: SUB, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  scoreVal: { color: TXT, fontSize: 32, fontWeight: '800' },
  vsText: { color: SUB, fontSize: 16, fontWeight: '700' },

  movesCard: { backgroundColor: CARD, borderRadius: 14, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: BORDER },
  movesTitle: { color: PURPLE, fontSize: 12, fontWeight: '600', marginBottom: 8 },
  moveRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: BORDER },
  moveFrom: { color: SUB, fontSize: 12 },
  moveVal: { color: TXT, fontSize: 13, fontWeight: '600' },

  actionBtn: { backgroundColor: PURPLE, borderRadius: 16, paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 },
  actionBtnDisabled: { backgroundColor: '#2A2D3A', opacity: 0.5 },
  actionBtnIcon: { fontSize: 24 },
  actionBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },

  gameOverCard: { alignItems: 'center', backgroundColor: CARD, borderRadius: 20, padding: 28, borderWidth: 1, borderColor: GOLD + '40' },
  gameOverIcon: { fontSize: 56, marginBottom: 12 },
  gameOverTitle: { color: TXT, fontSize: 24, fontWeight: '800', marginBottom: 4 },
  gameOverCoins: { color: GOLD, fontSize: 18, fontWeight: '700', marginBottom: 20 },
  gameOverBtn: { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 36 },
  gameOverBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },
});
