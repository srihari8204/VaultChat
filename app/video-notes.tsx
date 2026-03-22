// app/video-notes.tsx
// Round video messages (like Telegram) — record circular video notes

import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState, useEffect } from 'react';
import {
  Animated, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';

const MAX_DURATION = 60; // 60 seconds max

export default function VideoNotesScreen() {
  const router = useRouter();
  const { chatId, peerUid, peerName } = useLocalSearchParams();
  const [permission, requestPermission] = useCameraPermissions();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recorded, setRecorded] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const timerRef = useRef<any>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const ringAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission?.granted, requestPermission]);

  useEffect(() => {
    if (recording) {
      // Pulse animation
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])).start();

      // Progress ring
      Animated.timing(ringAnim, { toValue: 1, duration: MAX_DURATION * 1000, useNativeDriver: false }).start();

      // Timer
      timerRef.current = setInterval(() => {
        setSeconds(s => {
          if (s >= MAX_DURATION - 1) { stopRecording(); return s; }
          return s + 1;
        });
      }, 1000);

      return () => {
        clearInterval(timerRef.current);
        pulseAnim.stopAnimation();
        ringAnim.stopAnimation();
      };
    }
  }, [recording, pulseAnim, ringAnim]);

  const startRecording = async () => {
    if (!cameraRef.current) return;
    setRecording(true);
    setSeconds(0);
    ringAnim.setValue(0);
    try {
      const video = await cameraRef.current.recordAsync?.({ maxDuration: MAX_DURATION });
      if (video?.uri) setRecorded(video.uri);
    } catch {}
  };

  const stopRecording = async () => {
    setRecording(false);
    clearInterval(timerRef.current);
    cameraRef.current?.stopRecording?.();
  };

  const sendNote = () => {
    if (recorded) {
      router.replace({
        pathname: '/chat' as any,
        params: { chatId, peerUid, peerName, capturedUri: recorded, capturedType: 'video-note' },
      });
    }
  };

  const retake = () => { setRecorded(null); setSeconds(0); ringAnim.setValue(0); };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const ringColor = ringAnim.interpolate({ inputRange: [0, 0.7, 1], outputRange: ['#00E5FF', '#F59E0B', '#EF4444'] });

  if (!permission?.granted) {
    return (
      <View style={[st.screen, { justifyContent: 'center', alignItems: 'center' }]}>
        <Stack.Screen options={{ title: 'Video Note', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
        <Text style={{ color: '#fff', fontSize: 16, marginBottom: 20 }}>Camera permission needed</Text>
        <TouchableOpacity onPress={requestPermission} style={st.permBtn}>
          <Text style={{ color: '#00E5FF', fontWeight: '800' }}>Grant Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Video Note', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={st.screen}>
        <Text style={st.title}>🎥 Video Note</Text>
        <Text style={st.subtitle}>Record a round video message (up to {MAX_DURATION}s)</Text>

        {/* Circular camera preview */}
        <View style={st.cameraWrap}>
          <Animated.View style={[st.ringOuter, {
            transform: [{ scale: recording ? pulseAnim : 1 }],
            borderColor: recording ? (ringColor as any) : '#00E5FF44',
          }]}>
            <View style={st.cameraCircle}>
              {!recorded ? (
                <CameraView
                  ref={cameraRef}
                  style={st.camera}
                  facing="front"
                  mode="video"
                />
              ) : (
                <View style={[st.camera, { backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' }]}>
                  <Text style={{ fontSize: 48 }}>✅</Text>
                  <Text style={{ color: '#00E5FF', fontSize: 14, fontWeight: '700', marginTop: 8 }}>Recorded!</Text>
                </View>
              )}
            </View>
          </Animated.View>

          {/* Timer */}
          {(recording || recorded) && (
            <View style={st.timerBadge}>
              <View style={[st.recDot, recording && { backgroundColor: '#EF4444' }]} />
              <Text style={st.timerTxt}>{fmt(seconds)}</Text>
            </View>
          )}
        </View>

        {/* Controls */}
        <View style={st.controls}>
          {!recorded ? (
            <>
              <TouchableOpacity onPress={() => router.back()} style={st.cancelBtn}>
                <Text style={{ color: '#888', fontSize: 14 }}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={recording ? stopRecording : startRecording}
                style={st.recordOuter}
              >
                <LinearGradient
                  colors={recording ? ['#EF4444', '#DC2626'] : ['#00E5FF', '#4A9FFF']}
                  style={st.recordInner}
                >
                  {recording ? (
                    <View style={st.stopSquare} />
                  ) : (
                    <Text style={{ color: '#000', fontSize: 20, fontWeight: '900' }}>REC</Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>

              <View style={{ width: 60 }} />
            </>
          ) : (
            <>
              <TouchableOpacity onPress={retake} style={st.actionBtn}>
                <Text style={{ color: '#F59E0B', fontSize: 14, fontWeight: '700' }}>🔄 Retake</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={sendNote}>
                <LinearGradient colors={['#00E5FF', '#4A9FFF']} style={st.sendBtn}>
                  <Text style={{ color: '#000', fontSize: 16, fontWeight: '900' }}>Send ➤</Text>
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => router.back()} style={st.actionBtn}>
                <Text style={{ color: '#888', fontSize: 14 }}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <Text style={st.hint}>
          {recording ? 'Tap stop when done' : recorded ? 'Send or retake' : 'Tap REC to start recording'}
        </Text>
      </View>
    </>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#020B18', alignItems: 'center', paddingTop: 20 },
  title: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4 },
  subtitle: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginBottom: 30 },
  cameraWrap: { alignItems: 'center', marginBottom: 40 },
  ringOuter: { width: 260, height: 260, borderRadius: 130, borderWidth: 4, justifyContent: 'center', alignItems: 'center' },
  cameraCircle: { width: 240, height: 240, borderRadius: 120, overflow: 'hidden' },
  camera: { width: 240, height: 240 },
  timerBadge: { position: 'absolute', bottom: -10, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#0C0C1A', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#333' },
  timerTxt: { color: '#fff', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 },
  cancelBtn: { width: 60, alignItems: 'center' },
  recordOuter: { width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  recordInner: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  stopSquare: { width: 24, height: 24, borderRadius: 4, backgroundColor: '#fff' },
  actionBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  sendBtn: { borderRadius: 24, paddingHorizontal: 28, paddingVertical: 14 },
  hint: { color: 'rgba(255,255,255,0.3)', fontSize: 13, marginTop: 20 },
  permBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: '#00E5FF44', backgroundColor: '#00E5FF12' },
});
