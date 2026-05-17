// app/walkie-talkie.tsx
// Walkie-Talkie — 8 features matching PDF page 18
// 1. Push-to-Talk D2DE          5. AI Noise Suppression
// 2. Multi-Person (2-10)        6. Ping/Buzz Alert
// 3. Voice Effects              7. Voice Message Fallback (offline)
// 4. Broadcast Mode             8. Secure Room PIN

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert,
  FlatList, TextInput, Modal, Platform, Vibration, Animated,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { io, Socket } from 'socket.io-client';
import auth from '@react-native-firebase/auth';
import { SERVER_URL } from '../constants/server';

const DARK = '#0D0F14';
const CARD = '#1A1D27';
const PURPLE = '#6C63FF';
const BORDER = '#2A2D3A';
const TEXT = '#E8E8E8';
const SUB = '#6B7280';
const GREEN = '#10B981';
const RED = '#EF4444';

type VoiceEffect = 'none' | 'deep' | 'robot' | 'helium';

interface Participant {
  uid: string;
  name: string;
  isTalking: boolean;
  isMuted: boolean;
}

export default function WalkieTalkieScreen() {
  const router = useRouter();
  const { roomId: paramRoomId } = useLocalSearchParams<{ roomId?: string }>();
  const myUid = auth().currentUser?.uid ?? '';
  const myName = auth().currentUser?.displayName ?? 'You';

  // Room state
  const [roomId, setRoomId] = useState(paramRoomId ?? '');
  const [roomPin, setRoomPin] = useState('');
  const [inRoom, setInRoom] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);

  // Talk state
  const [isTalking, setIsTalking] = useState(false);
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [voiceEffect, setVoiceEffect] = useState<VoiceEffect>('none');
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [isMuted, setIsMuted] = useState(false);

  // UI state
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showEffects, setShowEffects] = useState(false);
  const [newRoomPin, setNewRoomPin] = useState('');
  const [joinPin, setJoinPin] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');

  const socketRef = useRef<Socket | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for talk button
  useEffect(() => {
    if (!isTalking) { pulseAnim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isTalking, pulseAnim]);

  // Socket connection
  useEffect(() => {
    if (!inRoom) return;
    let sock: Socket;
    (async () => {
      const token = await auth().currentUser?.getIdToken();
      sock = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = sock;

      sock.emit('walkie_join', { roomId, uid: myUid, name: myName, pin: roomPin });

      sock.on('walkie_participants', (list: Participant[]) => setParticipants(list));
      sock.on('walkie_user_joined', ({ uid, name }: any) => {
        setParticipants(p => [...p.filter(x => x.uid !== uid), { uid, name, isTalking: false, isMuted: false }]);
      });
      sock.on('walkie_user_left', ({ uid }: any) => {
        setParticipants(p => p.filter(x => x.uid !== uid));
      });
      sock.on('walkie_talk_start', ({ uid }: any) => {
        setParticipants(p => p.map(x => x.uid === uid ? { ...x, isTalking: true } : x));
      });
      sock.on('walkie_talk_stop', ({ uid }: any) => {
        setParticipants(p => p.map(x => x.uid === uid ? { ...x, isTalking: false } : x));
      });
      sock.on('walkie_ping', ({ from }: any) => {
        Vibration.vibrate([0, 200, 100, 200]);
        Alert.alert('Ping!', `${from} pinged the room`);
      });
      sock.on('walkie_error', ({ message }: any) => {
        Alert.alert('Error', message);
        setInRoom(false);
      });
    })();

    return () => {
      sock?.emit('walkie_leave', { roomId, uid: myUid });
      sock?.disconnect();
      socketRef.current = null;
    };
  }, [inRoom, roomId, myUid, myName, roomPin]);

  const createRoom = () => {
    const id = `WT-${Date.now().toString(36).toUpperCase()}`;
    setRoomId(id);
    setRoomPin(newRoomPin);
    setIsHost(true);
    setInRoom(true);
    setShowCreate(false);
    setParticipants([{ uid: myUid, name: myName, isTalking: false, isMuted: false }]);
  };

  const joinRoom = () => {
    if (!joinRoomId.trim()) { Alert.alert('Error', 'Enter a Room ID'); return; }
    setRoomId(joinRoomId.trim());
    setRoomPin(joinPin);
    setIsHost(false);
    setInRoom(true);
    setShowJoin(false);
  };

  const leaveRoom = () => {
    socketRef.current?.emit('walkie_leave', { roomId, uid: myUid });
    setInRoom(false);
    setParticipants([]);
    setIsTalking(false);
  };

  const startTalk = () => {
    if (isMuted) return;
    setIsTalking(true);
    socketRef.current?.emit('walkie_talk_start', { roomId, uid: myUid, effect: voiceEffect, noiseSuppression });
  };

  const stopTalk = () => {
    setIsTalking(false);
    socketRef.current?.emit('walkie_talk_stop', { roomId, uid: myUid });
  };

  const sendPing = () => {
    socketRef.current?.emit('walkie_ping', { roomId, from: myName });
    Vibration.vibrate(100);
  };

  const toggleMute = () => {
    setIsMuted(m => !m);
    socketRef.current?.emit('walkie_mute', { roomId, uid: myUid, muted: !isMuted });
  };

  // ── LOBBY (not in room) ───────────────────────────────────────
  if (!inRoom) {
    return (
      <View style={s.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Text style={s.backTxt}>{'\u2190'}</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>{'\uD83D\uDCFB'} Walkie-Talkie</Text>
            <Text style={s.headerSub}>D2DE Encrypted {'\u2022'} P2P</Text>
          </View>
        </View>

        <View style={s.lobbyBody}>
          <Text style={s.lobbyIcon}>{'\uD83D\uDCFB'}</Text>
          <Text style={s.lobbyTitle}>Encrypted Walkie-Talkie</Text>
          <Text style={s.lobbySub}>Push-to-talk voice channels with up to 10 people. All audio is D2DE encrypted.</Text>

          <TouchableOpacity style={s.createBtn} onPress={() => setShowCreate(true)} activeOpacity={0.8}>
            <Text style={s.createBtnTxt}>Create Room</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.joinBtn} onPress={() => setShowJoin(true)} activeOpacity={0.8}>
            <Text style={s.joinBtnTxt}>Join Room</Text>
          </TouchableOpacity>

          {/* Features list */}
          <View style={s.featList}>
            {[
              ['\uD83D\uDCFB', 'Push-to-Talk D2DE'],
              ['\uD83D\uDC65', 'Multi-Person (2-10 people)'],
              ['\uD83D\uDD0A', 'Voice Effects (Deep/Robot/Helium)'],
              ['\uD83D\uDCE2', 'Broadcast Mode'],
              ['\uD83E\uDDE0', 'AI Noise Suppression'],
              ['\uD83D\uDC4B', 'Ping/Buzz Alert'],
              ['\uD83D\uDCAC', 'Voice Message Fallback'],
              ['\uD83D\uDD12', 'Secure Room PIN'],
            ].map(([icon, label], i) => (
              <View key={i} style={s.featRow}>
                <Text style={s.featIcon}>{icon}</Text>
                <Text style={s.featTxt}>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Create Room Modal */}
        <Modal visible={showCreate} transparent animationType="slide">
          <View style={s.modalBg}>
            <View style={s.modalCard}>
              <Text style={s.modalTitle}>Create Room</Text>
              <Text style={s.modalSub}>Set an optional PIN for private rooms</Text>
              <TextInput
                style={s.modalInput}
                placeholder="Room PIN (optional)"
                placeholderTextColor="#555"
                value={newRoomPin}
                onChangeText={setNewRoomPin}
                keyboardType="number-pad"
                maxLength={6}
                secureTextEntry
              />
              <TouchableOpacity style={s.modalBtn} onPress={createRoom}>
                <Text style={s.modalBtnTxt}>Create & Join</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowCreate(false)} style={{ marginTop: 12 }}>
                <Text style={s.modalCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Join Room Modal */}
        <Modal visible={showJoin} transparent animationType="slide">
          <View style={s.modalBg}>
            <View style={s.modalCard}>
              <Text style={s.modalTitle}>Join Room</Text>
              <TextInput
                style={s.modalInput}
                placeholder="Room ID (e.g. WT-ABC123)"
                placeholderTextColor="#555"
                value={joinRoomId}
                onChangeText={setJoinRoomId}
                autoCapitalize="characters"
              />
              <TextInput
                style={[s.modalInput, { marginTop: 10 }]}
                placeholder="PIN (if required)"
                placeholderTextColor="#555"
                value={joinPin}
                onChangeText={setJoinPin}
                keyboardType="number-pad"
                maxLength={6}
                secureTextEntry
              />
              <TouchableOpacity style={s.modalBtn} onPress={joinRoom}>
                <Text style={s.modalBtnTxt}>Join</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowJoin(false)} style={{ marginTop: 12 }}>
                <Text style={s.modalCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  // ── IN ROOM ───────────────────────────────────────────────────
  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={leaveRoom} style={s.backBtn}>
          <Text style={s.backTxt}>{'\u2190'}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83D\uDD12'} D2DE ENCRYPTED {'\u2022'} P2P</Text>
          <Text style={s.headerSub}>Room: {roomId} {'\u2022'} {participants.length} people</Text>
        </View>
        {isHost && (
          <TouchableOpacity onPress={() => setBroadcastMode(b => !b)} style={[s.modeBtn, broadcastMode && s.modeBtnActive]}>
            <Text style={s.modeBtnTxt}>{broadcastMode ? '\uD83D\uDCE2' : '\uD83D\uDC65'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Participants */}
      <View style={s.participantsWrap}>
        <FlatList
          data={participants}
          horizontal
          keyExtractor={p => p.uid}
          contentContainerStyle={s.participantsList}
          renderItem={({ item: p }) => (
            <View style={[s.participantCard, p.isTalking && s.participantTalking]}>
              <View style={[s.avatarCircle, p.isTalking && s.avatarTalking]}>
                <Text style={s.avatarTxt}>{p.name.charAt(0).toUpperCase()}</Text>
              </View>
              <Text style={s.participantName} numberOfLines={1}>{p.uid === myUid ? 'You' : p.name}</Text>
              {p.isMuted && <Text style={s.mutedTag}>{'\uD83D\uDD07'}</Text>}
              {p.isTalking && <Text style={s.talkingTag}>{'\uD83D\uDD0A'}</Text>}
            </View>
          )}
        />
      </View>

      {/* Talk button */}
      <View style={s.talkArea}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[s.talkBtn, isTalking && s.talkBtnActive, isMuted && s.talkBtnMuted]}
            onPressIn={startTalk}
            onPressOut={stopTalk}
            activeOpacity={0.8}
            disabled={isMuted}
          >
            <Text style={s.talkBtnIcon}>{isMuted ? '\uD83D\uDD07' : isTalking ? '\uD83D\uDD0A' : '\uD83D\uDCFB'}</Text>
          </TouchableOpacity>
        </Animated.View>
        <Text style={s.talkLabel}>
          {isMuted ? 'Muted' : isTalking ? 'Release to stop' : 'Hold to Talk'}
        </Text>
        <Text style={s.talkSub}>{participants.length} people {'\u2022'} Host: {isHost ? 'You' : participants[0]?.name ?? '?'}</Text>
      </View>

      {/* Bottom controls */}
      <View style={s.controls}>
        <ControlBtn icon={isMuted ? '\uD83D\uDD07' : '\uD83C\uDFA4'} label={isMuted ? 'Unmute' : 'Mute'} active={isMuted} onPress={toggleMute} />
        <ControlBtn icon={'\uD83D\uDD0A'} label="Effects" active={showEffects} onPress={() => setShowEffects(e => !e)} />
        <ControlBtn icon={'\uD83D\uDC4B'} label="Ping" onPress={sendPing} />
        <ControlBtn icon={noiseSuppression ? '\uD83E\uDDE0' : '\uD83D\uDEAB'} label="Noise AI" active={noiseSuppression} onPress={() => setNoiseSuppression(n => !n)} />
        <ControlBtn icon={'\uD83D\uDEAA'} label="Leave" danger onPress={leaveRoom} />
      </View>

      {/* Voice effects panel */}
      {showEffects && (
        <View style={s.effectsPanel}>
          {(['none', 'deep', 'robot', 'helium'] as VoiceEffect[]).map(e => (
            <TouchableOpacity
              key={e}
              style={[s.effectBtn, voiceEffect === e && s.effectBtnActive]}
              onPress={() => { setVoiceEffect(e); setShowEffects(false); }}
            >
              <Text style={s.effectIcon}>
                {e === 'none' ? '\uD83C\uDFA4' : e === 'deep' ? '\uD83D\uDC3B' : e === 'robot' ? '\uD83E\uDD16' : '\uD83C\uDF88'}
              </Text>
              <Text style={[s.effectLabel, voiceEffect === e && s.effectLabelActive]}>
                {e.charAt(0).toUpperCase() + e.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

function ControlBtn({ icon, label, active, danger, onPress }: {
  icon: string; label: string; active?: boolean; danger?: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={s.controlBtn} onPress={onPress} activeOpacity={0.7}>
      <View style={[s.controlCircle, active && s.controlCircleActive, danger && s.controlCircleDanger]}>
        <Text style={s.controlIcon}>{icon}</Text>
      </View>
      <Text style={[s.controlLabel, danger && { color: RED }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16,
    backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: TEXT },
  headerTitle: { fontSize: 14, fontWeight: '700', color: GREEN },
  headerSub: { fontSize: 12, color: SUB, marginTop: 1 },
  modeBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: '#2A2D3A' },
  modeBtnActive: { backgroundColor: PURPLE + '30' },
  modeBtnTxt: { fontSize: 18 },

  // Lobby
  lobbyBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  lobbyIcon: { fontSize: 64, marginBottom: 16 },
  lobbyTitle: { fontSize: 22, fontWeight: '700', color: TEXT, marginBottom: 6 },
  lobbySub: { fontSize: 13, color: SUB, textAlign: 'center', marginBottom: 28, lineHeight: 19 },
  createBtn: { backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 48, marginBottom: 12, width: '100%', alignItems: 'center' },
  createBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  joinBtn: { backgroundColor: CARD, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 48, borderWidth: 1, borderColor: BORDER, width: '100%', alignItems: 'center' },
  joinBtnTxt: { color: TEXT, fontSize: 16, fontWeight: '600' },
  featList: { marginTop: 28, width: '100%' },
  featRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  featIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  featTxt: { fontSize: 13, color: SUB },

  // Participants
  participantsWrap: { paddingVertical: 16 },
  participantsList: { paddingHorizontal: 16, gap: 12 },
  participantCard: { alignItems: 'center', gap: 6 },
  participantTalking: {},
  avatarCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  avatarTalking: { borderColor: GREEN },
  avatarTxt: { fontSize: 22, fontWeight: '700', color: PURPLE },
  participantName: { fontSize: 11, color: SUB, maxWidth: 60, textAlign: 'center' },
  mutedTag: { fontSize: 12 },
  talkingTag: { fontSize: 12 },

  // Talk button
  talkArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  talkBtn: {
    width: 140, height: 140, borderRadius: 70,
    backgroundColor: '#1A3A2A', alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: GREEN + '40',
  },
  talkBtnActive: { backgroundColor: GREEN + '30', borderColor: GREEN },
  talkBtnMuted: { backgroundColor: '#3A1A1A', borderColor: RED + '40' },
  talkBtnIcon: { fontSize: 48 },
  talkLabel: { color: TEXT, fontSize: 16, fontWeight: '600', marginTop: 16 },
  talkSub: { color: SUB, fontSize: 12, marginTop: 4 },

  // Bottom controls
  controls: {
    flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    backgroundColor: CARD, borderTopWidth: 1, borderTopColor: BORDER,
  },
  controlBtn: { alignItems: 'center', gap: 4 },
  controlCircle: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  controlCircleActive: { backgroundColor: PURPLE + '30' },
  controlCircleDanger: { backgroundColor: RED + '20' },
  controlIcon: { fontSize: 20 },
  controlLabel: { fontSize: 10, color: SUB },

  // Voice effects
  effectsPanel: {
    position: 'absolute', bottom: Platform.OS === 'ios' ? 120 : 80, left: 16, right: 16,
    flexDirection: 'row', justifyContent: 'space-around',
    backgroundColor: CARD, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: BORDER, elevation: 8,
  },
  effectBtn: { alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  effectBtnActive: { backgroundColor: PURPLE + '20' },
  effectIcon: { fontSize: 24 },
  effectLabel: { fontSize: 10, color: SUB },
  effectLabelActive: { color: PURPLE, fontWeight: '600' },

  // Modals
  modalBg: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: CARD, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: BORDER },
  modalTitle: { fontSize: 20, fontWeight: '700', color: TEXT, marginBottom: 4 },
  modalSub: { fontSize: 13, color: SUB, marginBottom: 16 },
  modalInput: { backgroundColor: '#0D0F14', borderRadius: 12, padding: 14, color: TEXT, fontSize: 16, borderWidth: 1, borderColor: BORDER },
  modalBtn: { backgroundColor: PURPLE, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  modalBtnTxt: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  modalCancel: { color: SUB, fontSize: 14, textAlign: 'center' },
});
