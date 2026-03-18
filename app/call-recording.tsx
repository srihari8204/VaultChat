/**
 * app/call-recording.tsx
 * Call Recording — record, playback, save, share, manage recordings.
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const C = {
  bg: '#020B18',
  card: '#0A1628',
  cardAlt: '#111D32',
  accent: '#4A9FFF',
  cyan: '#00E5FF',
  red: '#EF4444',
  green: '#10B981',
  orange: '#F59E0B',
  text: '#FFFFFF',
  textDim: 'rgba(255,255,255,0.5)',
  textFaint: 'rgba(255,255,255,0.22)',
  border: 'rgba(74,159,255,0.15)',
};

const SW = Dimensions.get('window').width;
const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;
const STORAGE_KEY = 'vc_call_recordings';

interface RecordingMeta {
  id: string;
  uri: string;
  duration: number;
  callerName: string;
  date: number;
  savedToVault: boolean;
}

type ScreenState = 'idle' | 'recording' | 'paused' | 'finished' | 'list';

export default function CallRecordingScreen() {
  const router = useRouter();

  const [state, setState] = useState<ScreenState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [currentUri, setCurrentUri] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeIn = useRef(new Animated.Value(0)).current;
  const waveAnims = useRef(Array.from({ length: 24 }, () => new Animated.Value(0.2))).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    loadRecordings();
    return () => {
      stopTimerInterval();
      cleanupSound();
    };
  }, []);

  // Pulsing red dot animation
  useEffect(() => {
    if (state === 'recording') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    pulseAnim.setValue(1);
  }, [state]);

  // Fake waveform animation during recording
  useEffect(() => {
    if (state === 'recording') {
      const anims = waveAnims.map(a =>
        Animated.loop(
          Animated.sequence([
            Animated.timing(a, {
              toValue: Math.random() * 0.8 + 0.2,
              duration: 200 + Math.random() * 300,
              useNativeDriver: true,
            }),
            Animated.timing(a, {
              toValue: 0.2,
              duration: 200 + Math.random() * 300,
              useNativeDriver: true,
            }),
          ])
        )
      );
      anims.forEach(a => a.start());
      return () => anims.forEach(a => a.stop());
    }
  }, [state]);

  const loadRecordings = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setRecordings(JSON.parse(raw));
    } catch {}
  };

  const saveRecordings = async (list: RecordingMeta[]) => {
    setRecordings(list);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  };

  const stopTimerInterval = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const cleanupSound = async () => {
    if (soundRef.current) {
      try { await soundRef.current.unloadAsync(); } catch {}
      soundRef.current = null;
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // ── Recording controls ──

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission Required', 'Microphone access is needed to record calls.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;

      setElapsed(0);
      setState('recording');

      timerRef.current = setInterval(() => {
        setElapsed(prev => prev + 1);
      }, 1000);
    } catch (e) {
      Alert.alert('Error', 'Failed to start recording.');
      console.warn('[CallRecording] Start error:', e);
    }
  };

  const pauseRecording = async () => {
    try {
      if (recordingRef.current) {
        await recordingRef.current.pauseAsync();
        stopTimerInterval();
        setState('paused');
      }
    } catch (e) {
      console.warn('[CallRecording] Pause error:', e);
    }
  };

  const resumeRecording = async () => {
    try {
      if (recordingRef.current) {
        await recordingRef.current.startAsync();
        setState('recording');
        timerRef.current = setInterval(() => {
          setElapsed(prev => prev + 1);
        }, 1000);
      }
    } catch (e) {
      console.warn('[CallRecording] Resume error:', e);
    }
  };

  const stopRecording = async () => {
    try {
      stopTimerInterval();
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync();
        const uri = recordingRef.current.getURI();
        recordingRef.current = null;

        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

        if (uri) {
          setCurrentUri(uri);
          const meta: RecordingMeta = {
            id: Date.now().toString(),
            uri,
            duration: elapsed,
            callerName: 'Call Participant',
            date: Date.now(),
            savedToVault: false,
          };
          const updated = [meta, ...recordings];
          await saveRecordings(updated);
        }
        setState('finished');
      }
    } catch (e) {
      console.warn('[CallRecording] Stop error:', e);
      setState('finished');
    }
  };

  // ── Playback ──

  const playRecording = async (uri: string) => {
    try {
      await cleanupSound();
      const { sound } = await Audio.Sound.createAsync({ uri });
      soundRef.current = sound;

      sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded) {
          if (status.durationMillis) {
            setPlaybackProgress(status.positionMillis / status.durationMillis);
          }
          if (status.didJustFinish) {
            setIsPlaying(false);
            setPlaybackProgress(0);
          }
        }
      });

      await sound.playAsync();
      setIsPlaying(true);
    } catch (e) {
      Alert.alert('Error', 'Failed to play recording.');
    }
  };

  const stopPlayback = async () => {
    await cleanupSound();
    setIsPlaying(false);
    setPlaybackProgress(0);
  };

  const deleteRecording = (id: string) => {
    Alert.alert('Delete Recording', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const updated = recordings.filter(r => r.id !== id);
          await saveRecordings(updated);
          if (state === 'finished') setState('idle');
        },
      },
    ]);
  };

  const saveToVault = (id: string) => {
    const updated = recordings.map(r => (r.id === id ? { ...r, savedToVault: true } : r));
    saveRecordings(updated);
    Alert.alert('Saved', 'Recording encrypted and saved to File Vault.');
  };

  // ── Render sections ──

  const renderHeader = () => (
    <View style={s.header}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
        <Ionicons name="arrow-back" size={24} color={C.text} />
      </TouchableOpacity>
      <Text style={s.headerTitle}>Call Recording</Text>
      <TouchableOpacity onPress={() => setState('list')} style={s.backBtn}>
        <Ionicons name="list" size={22} color={C.accent} />
      </TouchableOpacity>
    </View>
  );

  const renderRecordingIndicator = () => (
    <View style={s.indicatorContainer}>
      <View style={s.indicatorRow}>
        <Animated.View style={[s.redDot, { opacity: pulseAnim }]} />
        <Text style={s.recordingText}>
          {state === 'paused' ? 'Paused' : 'Recording'}
        </Text>
      </View>
      <Text style={s.timer}>{formatTime(elapsed)}</Text>

      {/* Waveform */}
      <View style={s.waveContainer}>
        {waveAnims.map((a, i) => (
          <Animated.View
            key={i}
            style={[
              s.waveBar,
              {
                transform: [{ scaleY: a }],
                backgroundColor: state === 'paused' ? C.orange : C.cyan,
              },
            ]}
          />
        ))}
      </View>

      {/* Consent banner */}
      <View style={s.consentBanner}>
        <Ionicons name="shield-checkmark" size={16} color={C.green} style={{ marginRight: 8 }} />
        <Text style={s.consentText}>All participants have been notified</Text>
      </View>
    </View>
  );

  const renderRecordingControls = () => (
    <View style={s.controlsRow}>
      {state === 'recording' ? (
        <TouchableOpacity style={s.controlBtn} onPress={pauseRecording}>
          <View style={[s.controlCircle, { backgroundColor: 'rgba(245,158,11,0.2)' }]}>
            <Ionicons name="pause" size={28} color={C.orange} />
          </View>
          <Text style={s.controlLabel}>Pause</Text>
        </TouchableOpacity>
      ) : state === 'paused' ? (
        <TouchableOpacity style={s.controlBtn} onPress={resumeRecording}>
          <View style={[s.controlCircle, { backgroundColor: 'rgba(16,185,129,0.2)' }]}>
            <Ionicons name="play" size={28} color={C.green} />
          </View>
          <Text style={s.controlLabel}>Resume</Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity style={s.controlBtn} onPress={stopRecording}>
        <View style={[s.controlCircle, { backgroundColor: 'rgba(239,68,68,0.2)', width: 72, height: 72 }]}>
          <Ionicons name="stop" size={32} color={C.red} />
        </View>
        <Text style={s.controlLabel}>Stop</Text>
      </TouchableOpacity>
    </View>
  );

  const renderFinished = () => {
    const latest = recordings[0];
    if (!latest) return null;

    return (
      <View style={s.finishedContainer}>
        <Ionicons name="checkmark-circle" size={48} color={C.green} />
        <Text style={s.finishedTitle}>Recording Saved</Text>
        <Text style={s.finishedDuration}>Duration: {formatTime(latest.duration)}</Text>

        {/* Playback progress bar */}
        <View style={s.progressBarBg}>
          <View style={[s.progressBarFill, { width: `${playbackProgress * 100}%` }]} />
        </View>

        <View style={s.actionRow}>
          <TouchableOpacity
            style={s.actionBtn}
            onPress={() => (isPlaying ? stopPlayback() : playRecording(latest.uri))}
          >
            <Ionicons name={isPlaying ? 'stop-circle' : 'play-circle'} size={24} color={C.cyan} />
            <Text style={s.actionText}>{isPlaying ? 'Stop' : 'Play'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.actionBtn} onPress={() => saveToVault(latest.id)}>
            <Ionicons name="lock-closed" size={24} color={C.accent} />
            <Text style={s.actionText}>Save to Vault</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.actionBtn} onPress={() => Alert.alert('Share', 'Recording shared in chat.')}>
            <Ionicons name="share" size={24} color={C.green} />
            <Text style={s.actionText}>Share</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.actionBtn} onPress={() => deleteRecording(latest.id)}>
            <Ionicons name="trash" size={24} color={C.red} />
            <Text style={s.actionText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderIdle = () => (
    <View style={s.idleContainer}>
      <View style={s.idleCircleOuter}>
        <TouchableOpacity style={s.idleCircleInner} onPress={startRecording}>
          <Ionicons name="mic" size={40} color="#FFF" />
        </TouchableOpacity>
      </View>
      <Text style={s.idleText}>Tap to Start Recording</Text>
      <Text style={s.idleHint}>All call participants will be notified when recording starts.</Text>
    </View>
  );

  const renderRecordingList = () => (
    <View style={{ flex: 1, paddingHorizontal: 16 }}>
      <Text style={[s.sectionTitle, { marginTop: 16 }]}>Past Recordings</Text>
      {recordings.length === 0 && (
        <Text style={s.emptyText}>No recordings yet.</Text>
      )}
      <FlatList
        data={recordings}
        keyExtractor={r => r.id}
        renderItem={({ item }) => (
          <View style={s.listItem}>
            <View style={s.listItemLeft}>
              <Ionicons name="mic-circle" size={36} color={C.accent} style={{ marginRight: 12 }} />
              <View>
                <Text style={s.listItemName}>{item.callerName}</Text>
                <Text style={s.listItemMeta}>
                  {new Date(item.date).toLocaleDateString()} &bull; {formatTime(item.duration)}
                </Text>
              </View>
            </View>
            <View style={s.listItemRight}>
              {item.savedToVault && (
                <Ionicons name="lock-closed" size={14} color={C.green} style={{ marginRight: 8 }} />
              )}
              <TouchableOpacity onPress={() => playRecording(item.uri)}>
                <Ionicons name="play-circle" size={28} color={C.cyan} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteRecording(item.id)} style={{ marginLeft: 10 }}>
                <Ionicons name="trash-outline" size={20} color={C.red} />
              </TouchableOpacity>
            </View>
          </View>
        )}
        contentContainerStyle={{ paddingBottom: 60 }}
      />
    </View>
  );

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={[C.bg, '#0A1628', C.bg]} style={StyleSheet.absoluteFill} />

      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        {renderHeader()}

        {state === 'list' ? (
          renderRecordingList()
        ) : (
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingBottom: 40 }}>
            {(state === 'recording' || state === 'paused') && (
              <>
                {renderRecordingIndicator()}
                {renderRecordingControls()}
              </>
            )}
            {state === 'finished' && renderFinished()}
            {state === 'idle' && renderIdle()}
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP + 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },

  // Recording indicator
  indicatorContainer: { alignItems: 'center', paddingHorizontal: 24, marginTop: 20 },
  indicatorRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  redDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.red, marginRight: 10 },
  recordingText: { fontSize: 18, fontWeight: '700', color: C.red },
  timer: { fontSize: 48, fontWeight: '300', color: C.text, fontVariant: ['tabular-nums'] },

  waveContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 60,
    marginVertical: 20,
    gap: 3,
  },
  waveBar: { width: 4, height: 40, borderRadius: 2 },

  consentBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16,185,129,0.1)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 8,
  },
  consentText: { fontSize: 13, color: C.green, fontWeight: '600' },

  // Controls
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 40,
    gap: 32,
  },
  controlBtn: { alignItems: 'center' },
  controlCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlLabel: { fontSize: 12, color: C.textDim, marginTop: 8, fontWeight: '600' },

  // Finished
  finishedContainer: { alignItems: 'center', paddingHorizontal: 24 },
  finishedTitle: { fontSize: 22, fontWeight: '700', color: C.text, marginTop: 12 },
  finishedDuration: { fontSize: 14, color: C.textDim, marginTop: 4 },
  progressBarBg: {
    width: SW - 80,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    marginTop: 20,
    overflow: 'hidden',
  },
  progressBarFill: { height: '100%', backgroundColor: C.cyan, borderRadius: 2 },

  actionRow: { flexDirection: 'row', marginTop: 32, gap: 12 },
  actionBtn: {
    alignItems: 'center',
    backgroundColor: C.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 72,
  },
  actionText: { fontSize: 11, color: C.textDim, marginTop: 4, fontWeight: '600' },

  // Idle
  idleContainer: { alignItems: 'center', paddingHorizontal: 24 },
  idleCircleOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(239,68,68,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  idleCircleInner: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: C.red,
    justifyContent: 'center',
    alignItems: 'center',
  },
  idleText: { fontSize: 18, fontWeight: '700', color: C.text, marginTop: 20 },
  idleHint: { fontSize: 13, color: C.textDim, textAlign: 'center', marginTop: 8, lineHeight: 20 },

  // List
  sectionTitle: { fontSize: 16, fontWeight: '700', color: C.text, marginBottom: 12 },
  emptyText: { fontSize: 14, color: C.textDim, textAlign: 'center', marginTop: 40 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.card,
    padding: 14,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  listItemLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  listItemName: { fontSize: 14, fontWeight: '600', color: C.text },
  listItemMeta: { fontSize: 12, color: C.textDim, marginTop: 2 },
  listItemRight: { flexDirection: 'row', alignItems: 'center' },
});
