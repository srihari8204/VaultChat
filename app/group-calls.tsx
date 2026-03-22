// app/group-calls.tsx
// Group Voice & Video Call — multi-participant calling

import auth from '@react-native-firebase/auth';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  FlatList, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';

type CallMode = 'voice' | 'video';
type CallState = 'lobby' | 'ringing' | 'connected' | 'ended';

interface Participant {
  uid: string;
  name: string;
  isMuted: boolean;
  isSpeaking: boolean;
  isVideoOn: boolean;
  joinedAt: number;
}

export default function GroupCallsScreen() {
  const router = useRouter();
  const { groupName, mode: modeParam } = useLocalSearchParams<{
    chatId: string; groupName: string; mode?: string;
  }>();
  const myUid = auth().currentUser?.uid || '';
  const myName = auth().currentUser?.displayName || 'You';

  const [mode, setMode] = useState<CallMode>((modeParam as CallMode) || 'voice');
  const [state, setState] = useState<CallState>('lobby');
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(mode === 'video');
  const [speaker, setSpeaker] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<any>(null);

  const [participants, setParticipants] = useState<Participant[]>([
    { uid: myUid, name: myName + ' (You)', isMuted: false, isSpeaking: false, isVideoOn: mode === 'video', joinedAt: Date.now() },
  ]);

  const startCall = () => {
    setState('ringing');
    // Simulate participants joining
    setTimeout(() => {
      setState('connected');
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
      // Simulate others joining
      const others = ['Arjun M', 'Priya S', 'Vikram T'];
      others.forEach((name, i) => {
        setTimeout(() => {
          setParticipants(prev => [...prev, {
            uid: `sim_${i}`,
            name,
            isMuted: Math.random() > 0.7,
            isSpeaking: false,
            isVideoOn: mode === 'video' && Math.random() > 0.3,
            joinedAt: Date.now(),
          }]);
        }, (i + 1) * 2000);
      });
    }, 3000);
  };

  const endCall = () => {
    clearInterval(timerRef.current);
    setState('ended');
    setTimeout(() => router.back(), 1000);
  };

  useEffect(() => () => clearInterval(timerRef.current), []);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    return `${m}:${(s % 60).toString().padStart(2, '0')}`;
  };

  const toggleMute = () => {
    setMuted(m => !m);
    setParticipants(prev => prev.map(p => p.uid === myUid ? { ...p, isMuted: !muted } : p));
  };

  // ── Lobby ──
  if (state === 'lobby') {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={st.screen}>
          <LinearGradient colors={['#020B18', '#0A1628']} style={StyleSheet.absoluteFill} />
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
            <Text style={{ fontSize: 60 }}>{mode === 'video' ? '📹' : '📞'}</Text>
            <Text style={st.title}>{groupName}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, marginBottom: 40 }}>
              {mode === 'video' ? 'Group Video Call' : 'Group Voice Call'}
            </Text>

            {/* Mode toggle */}
            <View style={st.modeRow}>
              <TouchableOpacity
                style={[st.modeBtn, mode === 'voice' && st.modeBtnActive]}
                onPress={() => { setMode('voice'); setVideoOn(false); }}
              >
                <Text style={{ fontSize: 18 }}>🎤</Text>
                <Text style={[st.modeTxt, mode === 'voice' && { color: '#00E5FF' }]}>Voice</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[st.modeBtn, mode === 'video' && st.modeBtnActive]}
                onPress={() => { setMode('video'); setVideoOn(true); }}
              >
                <Text style={{ fontSize: 18 }}>📹</Text>
                <Text style={[st.modeTxt, mode === 'video' && { color: '#00E5FF' }]}>Video</Text>
              </TouchableOpacity>
            </View>

            {/* Pre-call toggles */}
            <View style={st.preControls}>
              <TouchableOpacity style={[st.preBtn, muted && st.preBtnOff]} onPress={() => setMuted(!muted)}>
                <Text style={{ fontSize: 22 }}>{muted ? '🔇' : '🎤'}</Text>
                <Text style={st.preLbl}>{muted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>
              {mode === 'video' && (
                <TouchableOpacity style={[st.preBtn, !videoOn && st.preBtnOff]} onPress={() => setVideoOn(!videoOn)}>
                  <Text style={{ fontSize: 22 }}>{videoOn ? '📹' : '📹'}</Text>
                  <Text style={st.preLbl}>{videoOn ? 'Cam On' : 'Cam Off'}</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity onPress={startCall} style={{ marginTop: 20 }}>
              <LinearGradient colors={['#10B981', '#059669']} style={st.startBtn}>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>Start Call</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
              <Text style={{ color: '#888', fontSize: 14 }}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {/* D2DE badge */}
          <View style={st.d2de}>
            <Text style={{ color: '#00D4AA', fontSize: 10, fontWeight: '700' }}>🛡️ D2DE · E2E Encrypted Call</Text>
          </View>
        </View>
      </>
    );
  }

  // ── Connected / Ringing ──
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={st.screen}>
        <LinearGradient colors={['#020B18', '#0A1628']} style={StyleSheet.absoluteFill} />

        {/* Header */}
        <View style={st.header}>
          <View>
            <Text style={st.title}>{groupName}</Text>
            <Text style={{ color: state === 'connected' ? '#00E5FF' : '#F59E0B', fontSize: 13, fontWeight: '600' }}>
              {state === 'ringing' ? 'Calling...' : `${fmt(seconds)} · ${participants.length} participants`}
            </Text>
          </View>
        </View>

        {/* Participants grid */}
        <FlatList
          data={participants}
          keyExtractor={p => p.uid}
          numColumns={mode === 'video' ? 2 : 1}
          contentContainerStyle={{ padding: 12, paddingBottom: 160 }}
          renderItem={({ item }) => (
            <View style={[st.participantCard, mode === 'video' && { flex: 1, margin: 4, height: 200 }]}>
              <LinearGradient
                colors={item.uid === myUid ? ['#1D4ED8', '#7C3AED'] : ['#0F3460', '#16213E']}
                style={st.participantGrad}
              >
                <Text style={{ fontSize: mode === 'video' ? 40 : 28 }}>
                  {item.isVideoOn ? '📹' : item.name[0]?.toUpperCase()}
                </Text>
                <Text style={st.pName}>{item.name}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                  {item.isMuted && <Text style={{ fontSize: 12 }}>🔇</Text>}
                  {item.isSpeaking && <Text style={{ fontSize: 12 }}>🔊</Text>}
                </View>
              </LinearGradient>
            </View>
          )}
        />

        {/* Controls */}
        <View style={st.controls}>
          <TouchableOpacity style={[st.ctrlBtn, muted && st.ctrlBtnActive]} onPress={toggleMute}>
            <Text style={{ fontSize: 22 }}>{muted ? '🔇' : '🎤'}</Text>
          </TouchableOpacity>

          {mode === 'video' && (
            <TouchableOpacity style={[st.ctrlBtn, !videoOn && st.ctrlBtnActive]} onPress={() => setVideoOn(!videoOn)}>
              <Text style={{ fontSize: 22 }}>📹</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={[st.ctrlBtn, speaker && st.ctrlBtnActive]} onPress={() => setSpeaker(!speaker)}>
            <Text style={{ fontSize: 22 }}>{speaker ? '🔊' : '🔈'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={st.endBtn} onPress={endCall}>
            <Text style={{ fontSize: 24 }}>📵</Text>
          </TouchableOpacity>
        </View>

        <View style={st.d2de}>
          <Text style={{ color: '#00D4AA', fontSize: 10, fontWeight: '700' }}>🛡️ D2DE · E2E Encrypted</Text>
        </View>
      </View>
    </>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#020B18' },
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12 },
  title: { color: '#fff', fontSize: 22, fontWeight: '900' },
  modeRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  modeBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  modeBtnActive: { borderColor: '#00E5FF', backgroundColor: '#00E5FF12' },
  modeTxt: { color: '#888', fontSize: 14, fontWeight: '700' },
  preControls: { flexDirection: 'row', gap: 16 },
  preBtn: { alignItems: 'center', gap: 6, padding: 16, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', width: 80 },
  preBtnOff: { backgroundColor: 'rgba(239,68,68,0.15)', borderColor: 'rgba(239,68,68,0.3)' },
  preLbl: { color: '#888', fontSize: 10, fontWeight: '600' },
  startBtn: { borderRadius: 20, paddingHorizontal: 48, paddingVertical: 18 },
  participantCard: { marginBottom: 8 },
  participantGrad: { borderRadius: 16, padding: 16, alignItems: 'center', justifyContent: 'center', flex: 1 },
  pName: { color: '#fff', fontSize: 14, fontWeight: '700', marginTop: 8 },
  controls: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 16, paddingBottom: 20 },
  ctrlBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#1A2235', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#1E293B' },
  ctrlBtnActive: { backgroundColor: '#003328', borderColor: '#00D4AA' },
  endBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#EF4444', justifyContent: 'center', alignItems: 'center' },
  d2de: { position: 'absolute', top: 52, right: 16, backgroundColor: '#003328', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 0.5, borderColor: '#00D4AA' },
});
