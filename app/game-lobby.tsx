// app/game-lobby.tsx
// D2DE Gaming Platform — Full lobby with matchmaking, coins, game selection
// PDF page 22-23: 12 platform features + 19 world games across 6 continents

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Alert,
  ScrollView, Modal, Platform, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL } from '../constants/server';
import { getAccessToken } from '../lib/api';
import { getCurrentUserAsync } from './(constants)/authService';
import { getGameProfile } from '../lib/chatService';
import {
  ALL_GAMES, GAME_REGIONS, getGameStats, GameStats, GameType, ACHIEVEMENTS, setCoins,
} from '../services/gameService';

const DARK = '#0D0F14';
const CARD = '#1A1D27';
const PURPLE = '#6C63FF';
const BORDER = '#2A2D3A';
const TXT = '#E8E8E8';
const SUB = '#6B7280';
const GREEN = '#10B981';
const GOLD = '#F59E0B';
const RED = '#EF4444';

const BET_OPTIONS = [0, 10, 25, 50, 100, 250, 500];

type PlayMode = 'friends' | 'online' | 'bot';

export default function GameLobbyScreen() {
  const router = useRouter();
  const [uid, setUid] = useState('');
  const [myName, setMyName] = useState('Player');

  const [coins, setCoinsState] = useState(1000);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<GameType | null>(null);
  const [playMode, setPlayMode] = useState<PlayMode>('online');
  const [bet, setBet] = useState(0);
  const [searching, setSearching] = useState(false);
  const [showAchievements, setShowAchievements] = useState(false);

  const socketRef = useRef<Socket | null>(null);

  // Load coin balance (backend-authoritative) + local stats
  useEffect(() => {
    getGameProfile().then(p => setCoinsState(p.coins)).catch(() => {});
    getGameStats().then(setStats);
  }, []);

  // Identity + socket connection for matchmaking. Auth uses our JWT (not a
  // Firebase token); the server identifies the player from it.
  useEffect(() => {
    let sock: Socket | null = null;
    let cancelled = false;
    (async () => {
      const me = await getCurrentUserAsync();
      const myId = me?.id ?? '';
      const myNm = me?.name ?? 'Player';
      if (cancelled) return;
      setUid(myId);
      setMyName(myNm);

      const token = await getAccessToken();
      if (cancelled) return;
      sock = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = sock;

      sock.emit('game_join_lobby', { name: myNm });

      sock.on('game_coins', ({ coins: c }: any) => {
        setCoinsState(c);
        setCoins(c);
      });

      sock.on('game_matched', ({ roomId, gameType, bet: b, opponent, yourTurn }: any) => {
        setSearching(false);
        Alert.alert('Match Found!', `Playing ${gameType} vs ${opponent.name} for ${b} coins`, [
          { text: 'Play', onPress: () => router.push({ pathname: `/game-play` as any, params: { roomId, gameType, bet: String(b), opponentUid: opponent.uid, opponentName: opponent.name, yourTurn: String(yourTurn), myUid: myId } }) },
        ]);
      });

      sock.on('game_waiting', () => { /* still searching */ });
      sock.on('game_match_cancelled', () => setSearching(false));
      sock.on('game_error', ({ message }: any) => {
        setSearching(false);
        Alert.alert('Error', message);
      });
    })();

    return () => { cancelled = true; sock?.disconnect(); };
  }, []);

  const startQuickMatch = () => {
    if (!selectedGame) { Alert.alert('Select a game first'); return; }
    if (coins < bet) { Alert.alert('Not enough coins', `You need ${bet} coins. You have ${coins}.`); return; }
    setSearching(true);
    socketRef.current?.emit('game_quick_match', { uid, gameType: selectedGame.id, bet });
  };

  const cancelMatch = () => {
    if (selectedGame) socketRef.current?.emit('game_cancel_match', { uid, gameType: selectedGame.id, bet });
    setSearching(false);
  };

  const startBotGame = () => {
    if (!selectedGame) { Alert.alert('Select a game first'); return; }
    router.push({ pathname: `/game-play` as any, params: { roomId: `BOT-${Date.now()}`, gameType: selectedGame.id, bet: '0', opponentUid: 'bot', opponentName: 'Bot (Easy)', yourTurn: 'true', myUid: uid } });
  };

  const filteredGames = activeRegion ? ALL_GAMES.filter(g => g.region === activeRegion) : ALL_GAMES;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>{'\u2190'}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83C\uDFAE'} Game Lobby</Text>
          <Text style={s.headerSub}>D2DE Encrypted {'\u2022'} P2P Fair Play</Text>
        </View>
        <TouchableOpacity onPress={() => setShowAchievements(true)}>
          <Text style={{ fontSize: 22 }}>{'\uD83C\uDFC6'}</Text>
        </TouchableOpacity>
      </View>

      {/* Stats bar */}
      <View style={s.statsBar}>
        <View style={s.statItem}>
          <Text style={s.statIcon}>{'\uD83E\uDE99'}</Text>
          <Text style={s.statVal}>{coins.toLocaleString()}</Text>
        </View>
        <View style={s.statItem}>
          <Text style={s.statIcon}>{'\uD83C\uDFC6'}</Text>
          <Text style={s.statVal}>{stats?.wins ?? 0} Wins</Text>
        </View>
        <View style={s.statItem}>
          <Text style={s.statIcon}>{'\uD83C\uDFC5'}</Text>
          <Text style={s.statVal}>{stats?.achievements.length ?? 0}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        {/* Region filter */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regionRow}>
          <TouchableOpacity style={[s.regionChip, !activeRegion && s.regionChipActive]} onPress={() => setActiveRegion(null)}>
            <Text style={[s.regionTxt, !activeRegion && s.regionTxtActive]}>All</Text>
          </TouchableOpacity>
          {GAME_REGIONS.map(r => (
            <TouchableOpacity key={r} style={[s.regionChip, activeRegion === r && s.regionChipActive]} onPress={() => setActiveRegion(activeRegion === r ? null : r)}>
              <Text style={[s.regionTxt, activeRegion === r && s.regionTxtActive]}>
                {r === 'India' ? '\uD83C\uDDEE\uD83C\uDDF3' : r === 'China' ? '\uD83C\uDDE8\uD83C\uDDF3' : r === 'Japan' ? '\uD83C\uDDEF\uD83C\uDDF5' : '\uD83C\uDF0D'} {r}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Games grid */}
        <View style={s.gamesGrid}>
          {filteredGames.map(g => (
            <TouchableOpacity
              key={g.id}
              style={[s.gameCard, selectedGame?.id === g.id && s.gameCardSelected]}
              onPress={() => setSelectedGame(selectedGame?.id === g.id ? null : g)}
              activeOpacity={0.7}
            >
              <Text style={s.gameIcon}>{g.icon}</Text>
              <Text style={s.gameName}>{g.name}</Text>
              <Text style={s.gameRegion}>{g.region}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Play options (visible when game selected) */}
        {selectedGame && (
          <View style={s.playCard}>
            <Text style={s.playTitle}>{selectedGame.icon} {selectedGame.name}</Text>
            <Text style={s.playDesc}>{selectedGame.description}</Text>
            <Text style={s.playPlayers}>{selectedGame.minPlayers}-{selectedGame.maxPlayers} players</Text>

            {/* Play mode */}
            <View style={s.modeRow}>
              {([['friends', '\uD83D\uDC65', 'Friends'], ['online', '\uD83C\uDF10', 'Online'], ['bot', '\uD83E\uDD16', 'vs Bot']] as [PlayMode, string, string][]).map(([mode, icon, label]) => (
                <TouchableOpacity key={mode} style={[s.modeBtn, playMode === mode && s.modeBtnActive]} onPress={() => setPlayMode(mode)}>
                  <Text style={s.modeIcon}>{icon}</Text>
                  <Text style={[s.modeTxt, playMode === mode && s.modeTxtActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Bet selector (not for bot mode) */}
            {playMode !== 'bot' && (
              <View style={s.betSection}>
                <Text style={s.betLabel}>Bet Amount</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.betRow}>
                  {BET_OPTIONS.map(b => (
                    <TouchableOpacity key={b} style={[s.betChip, bet === b && s.betChipActive]} onPress={() => setBet(b)}>
                      <Text style={[s.betTxt, bet === b && s.betTxtActive]}>{b === 0 ? 'Free' : `${b} \uD83E\uDE99`}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Play button */}
            {searching ? (
              <View style={s.searchingWrap}>
                <ActivityIndicator color={PURPLE} size="small" />
                <Text style={s.searchingTxt}>Searching for opponent...</Text>
                <TouchableOpacity style={s.cancelBtn} onPress={cancelMatch}>
                  <Text style={s.cancelBtnTxt}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={s.playBtn} onPress={playMode === 'bot' ? startBotGame : startQuickMatch} activeOpacity={0.8}>
                <Text style={s.playBtnTxt}>
                  {playMode === 'bot' ? '\uD83E\uDD16 Play vs Bot' : playMode === 'friends' ? '\uD83D\uDC65 Invite Friend' : `\uD83C\uDF10 Quick Match${bet > 0 ? ` (${bet} coins)` : ''}`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Platform features */}
        <View style={s.featCard}>
          <Text style={s.featTitle}>12 Platform Features</Text>
          {[
            ['\uD83C\uDFAE', 'D2DE Game Engine'],
            ['\uD83C\uDCCF', 'Mental Poker Protocol (Fair Deal)'],
            ['\uD83C\uDFB2', 'Cryptographic Dice (Commitment)'],
            ['\uD83D\uDC65', 'Play with Friends Mode'],
            ['\uD83C\uDF10', 'Online Ranked Matchmaking'],
            ['\uD83E\uDD16', 'Bot Mode (Easy to Expert)'],
            ['\uD83E\uDE99', '1,000 Demo Coins (Every User)'],
            ['\uD83C\uDFA4', 'In-Game Voice Chat (D2DE)'],
            ['\uD83D\uDD07', 'Host Mute / Player Mute'],
            ['\uD83D\uDC41', 'Spectator Mode'],
            ['\uD83C\uDFC6', 'Tournaments (Bracket Style)'],
            ['\uD83C\uDFC5', 'Achievements & Badges'],
          ].map(([icon, text], i) => (
            <View key={i} style={s.featRow}>
              <Text style={s.featIcon}>{icon}</Text>
              <Text style={s.featTxt}>{text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Achievements Modal */}
      <Modal visible={showAchievements} transparent animationType="slide">
        <View style={s.achieveModal}>
          <View style={s.achieveCard}>
            <Text style={s.achieveTitle}>{'\uD83C\uDFC5'} Achievements</Text>
            {ACHIEVEMENTS.map(a => {
              const unlocked = stats?.achievements.includes(a.id);
              return (
                <View key={a.id} style={[s.achieveRow, !unlocked && { opacity: 0.3 }]}>
                  <Text style={s.achieveIcon}>{a.icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.achieveName}>{a.name}</Text>
                    <Text style={s.achieveDesc}>{a.desc}</Text>
                  </View>
                  {unlocked && <Text style={{ color: GREEN, fontSize: 12, fontWeight: '700' }}>{'\u2713'}</Text>}
                </View>
              );
            })}
            <TouchableOpacity onPress={() => setShowAchievements(false)} style={{ marginTop: 16 }}>
              <Text style={{ color: SUB, textAlign: 'center', fontSize: 14 }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: TXT },
  headerTitle: { fontSize: 16, fontWeight: '700', color: TXT },
  headerSub: { fontSize: 11, color: GREEN, marginTop: 1, fontWeight: '600' },

  statsBar: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statIcon: { fontSize: 18 },
  statVal: { color: TXT, fontSize: 14, fontWeight: '700' },

  body: { padding: 16, paddingBottom: 40 },

  regionRow: { gap: 8, marginBottom: 16 },
  regionChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: CARD, borderWidth: 1, borderColor: BORDER },
  regionChipActive: { backgroundColor: PURPLE + '20', borderColor: PURPLE },
  regionTxt: { color: SUB, fontSize: 13, fontWeight: '500' },
  regionTxtActive: { color: PURPLE },

  gamesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gameCard: { width: '30%', backgroundColor: CARD, borderRadius: 14, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: BORDER },
  gameCardSelected: { backgroundColor: PURPLE + '15', borderColor: PURPLE },
  gameIcon: { fontSize: 28, marginBottom: 6 },
  gameName: { color: TXT, fontSize: 11, fontWeight: '600', textAlign: 'center' },
  gameRegion: { color: SUB, fontSize: 9, marginTop: 2 },

  playCard: { backgroundColor: CARD, borderRadius: 16, padding: 18, marginTop: 16, borderWidth: 1, borderColor: PURPLE + '40' },
  playTitle: { color: TXT, fontSize: 18, fontWeight: '700', marginBottom: 4 },
  playDesc: { color: SUB, fontSize: 13, marginBottom: 4 },
  playPlayers: { color: PURPLE, fontSize: 12, fontWeight: '600', marginBottom: 12 },

  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  modeBtn: { flex: 1, backgroundColor: '#2A2D3A', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  modeBtnActive: { backgroundColor: PURPLE + '15', borderColor: PURPLE },
  modeIcon: { fontSize: 20, marginBottom: 2 },
  modeTxt: { color: SUB, fontSize: 11, fontWeight: '500' },
  modeTxtActive: { color: PURPLE },

  betSection: { marginBottom: 14 },
  betLabel: { color: SUB, fontSize: 12, fontWeight: '600', marginBottom: 8 },
  betRow: { gap: 8 },
  betChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#2A2D3A' },
  betChipActive: { backgroundColor: GOLD + '20', borderWidth: 1, borderColor: GOLD },
  betTxt: { color: SUB, fontSize: 13, fontWeight: '600' },
  betTxtActive: { color: GOLD },

  searchingWrap: { alignItems: 'center', gap: 8, paddingVertical: 12 },
  searchingTxt: { color: SUB, fontSize: 13 },
  cancelBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, backgroundColor: RED + '20' },
  cancelBtnTxt: { color: RED, fontSize: 13, fontWeight: '600' },

  playBtn: { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  playBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },

  featCard: { backgroundColor: CARD, borderRadius: 16, padding: 16, marginTop: 20, borderWidth: 1, borderColor: BORDER },
  featTitle: { color: PURPLE, fontSize: 13, fontWeight: '600', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  featRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  featIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  featTxt: { color: SUB, fontSize: 13 },

  achieveModal: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 24 },
  achieveCard: { backgroundColor: CARD, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: BORDER },
  achieveTitle: { color: TXT, fontSize: 20, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  achieveRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BORDER },
  achieveIcon: { fontSize: 24 },
  achieveName: { color: TXT, fontSize: 14, fontWeight: '600' },
  achieveDesc: { color: SUB, fontSize: 12, marginTop: 1 },
});
