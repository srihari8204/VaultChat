// app/voice-speed.tsx
// Voice Message Speed Controller component
// Provides 1x, 1.5x, 2x playback for voice messages

import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState , useMemo} from 'react';
import {
  Animated, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

const SPEEDS = [0.5, 1, 1.25, 1.5, 2];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VoiceSpeedPlayer() {
  const { colors } = useTheme();
  const st = useS();
  const { uri, duration: durParam, senderName } = useLocalSearchParams<{
    uri: string; duration?: string; senderName?: string;
  }>();

  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(parseInt(durParam || '0') || 0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Waveform bars (simulated)
  const bars = useRef(Array.from({ length: 40 }, () => Math.random() * 0.7 + 0.3)).current;

  useEffect(() => {
    const onPlaybackUpdateInEffect = (status: any) => {
      if (!status.isLoaded) return;
      const pos = Math.floor((status.positionMillis || 0) / 1000);
      setPosition(pos);
      setIsPlaying(status.isPlaying);
      if (status.durationMillis) {
        const pct = status.positionMillis / status.durationMillis;
        progressAnim.setValue(pct);
      }
      if (status.didJustFinish) {
        setIsPlaying(false);
        setPosition(0);
        progressAnim.setValue(0);
      }
    };
    const loadAudio = async () => {
      try {
        const { sound, status } = await Audio.Sound.createAsync(
          { uri: uri as string },
          { shouldPlay: false, rate: speed, shouldCorrectPitch: true },
          onPlaybackUpdateInEffect
        );
        soundRef.current = sound;
        if (status.isLoaded && status.durationMillis) {
          setDuration(Math.floor(status.durationMillis / 1000));
        }
      } catch {}
    };
    loadAudio();
    return () => { soundRef.current?.unloadAsync(); };
  }, [uri, speed, progressAnim]);

  const togglePlay = async () => {
    if (!soundRef.current) return;
    if (isPlaying) {
      await soundRef.current.pauseAsync();
    } else {
      await soundRef.current.playAsync();
    }
  };

  const skip = async (secs: number) => {
    if (!soundRef.current) return;
    const status = await soundRef.current.getStatusAsync();
    if (status.isLoaded) {
      const newPos = Math.max(0, Math.min((status.positionMillis || 0) + secs * 1000, status.durationMillis || 0));
      await soundRef.current.setPositionAsync(newPos);
    }
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const progressWidth = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */ 
        title: 'Voice Message',
        headerStyle: { backgroundColor: colors.glassSoft },
        headerTintColor: '#1F2937',
      }} />
      <View style={st.screen}>
        <View style={st.card}>
          {/* Sender */}
          <Text style={st.sender}>{senderName || 'Voice Message'}</Text>

          {/* Waveform */}
          <View style={st.waveform}>
            {bars.map((h, i) => {
              const activeIdx = duration > 0 ? Math.floor((position / duration) * bars.length) : 0;
              return (
                <View
                  key={i}
                  style={[st.bar, {
                    height: h * 60,
                    backgroundColor: i <= activeIdx ? '#4A9FFF' : 'rgba(255,255,255,0.15)',
                  }]}
                />
              );
            })}
          </View>

          {/* Progress bar */}
          <View style={st.progressBg}>
            <Animated.View style={[st.progressFill, { width: progressWidth }]} />
          </View>

          {/* Time */}
          <View style={st.timeRow}>
            <Text style={st.time}>{fmt(position)}</Text>
            <Text style={st.time}>{fmt(duration)}</Text>
          </View>

          {/* Controls */}
          <View style={st.controls}>
            <TouchableOpacity onPress={() => skip(-10)} style={st.skipBtn}>
              <Text style={st.skipTxt}>-10s</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={togglePlay} style={st.playBtn}>
              <LinearGradient colors={['#4A9FFF', '#4A9FFF']} style={st.playGrad}>
                <Ionicons name={isPlaying ? 'pause' : 'play'} size={26} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => skip(10)} style={st.skipBtn}>
              <Text style={st.skipTxt}>+10s</Text>
            </TouchableOpacity>
          </View>

          {/* Speed selector */}
          <View style={st.speedRow}>
            {SPEEDS.map(s => (
              <TouchableOpacity
                key={s}
                style={[st.speedChip, speed === s && st.speedChipActive]}
                onPress={async () => {
                  setSpeed(s);
                  if (soundRef.current) await soundRef.current.setRateAsync(s, true);
                }}
              >
                <Text style={[st.speedTxt, speed === s && st.speedTxtActive]}>{s}x</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Info */}
        <View style={st.infoCard}>
          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>
            🔐 Voice messages are encrypted in transit — end-to-end coverage is rolling out
          </Text>
        </View>
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.glassSoft, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: 'rgba(10,22,40,0.9)', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: 'rgba(0,229,255,0.15)' },
  sender: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center', marginBottom: 20 },
  waveform: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 60, gap: 2, marginBottom: 16 },
  bar: { width: 4, borderRadius: 2 },
  progressBg: { height: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: 4, backgroundColor: '#4A9FFF', borderRadius: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  time: { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontFamily: 'monospace' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 20 },
  skipBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  skipTxt: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '700' },
  playBtn: { width: 70, height: 70, borderRadius: 35, overflow: 'hidden' },
  playGrad: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  playIcon: { fontSize: 28, color: c.text },
  speedRow: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  speedChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  speedChipActive: { backgroundColor: '#4A9FFF22', borderColor: '#4A9FFF' },
  speedTxt: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '700' },
  speedTxtActive: { color: '#4A9FFF' },
  infoCard: { marginTop: 16, alignItems: 'center' },
});
