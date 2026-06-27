// components/VoiceRecorder.tsx
// Hold to record voice message

import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Audio } from 'expo-av';

interface Props {
  onSend: (uri: string, duration: number) => void;
  onCancel: () => void;
}

export default function VoiceRecorder({ onSend, onCancel }: Props) {
  const [recording, setRecording]   = useState<Audio.Recording | null>(null);
  const [seconds,   setSeconds]     = useState(0);
  const [uploading, setUploading]   = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permission denied', 'Microphone permission is required.'); return; }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(rec);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch (e: any) { Alert.alert('Error', 'Could not start recording: ' + e.message); }
  };

  const stopAndSend = async () => {
    if (!recording) return;
    setUploading(true);
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recording.getURI();
      if (uri) onSend(uri, seconds);
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setUploading(false); setRecording(null); }
  };

  const cancel = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recording) {
      try { await recording.stopAndUnloadAsync(); } catch {}
    }
    setRecording(null); setSeconds(0); onCancel();
  };

  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;

  return (
    <View style={s.wrap}>
      <TouchableOpacity onPress={cancel} style={s.cancelBtn}>
        <Text style={s.cancelTxt}>✕</Text>
      </TouchableOpacity>

      <View style={s.center}>
        {recording
          ? <View style={s.recRow}>
              <View style={s.dot} />
              <Text style={s.timer}>{fmt(seconds)}</Text>
            </View>
          : <Text style={s.hint}>Tap mic to record</Text>
        }
      </View>

      {uploading
        ? <ActivityIndicator color="#00E5FF" />
        : recording
          ? <TouchableOpacity onPress={stopAndSend} style={[s.micBtn, s.micStop]}>
              <Text style={s.micIco}>⬛</Text>
            </TouchableOpacity>
          : <TouchableOpacity onPress={startRecording} style={s.micBtn}>
              <Text style={s.micIco}>🎤</Text>
            </TouchableOpacity>
      }
    </View>
  );
}

const s = StyleSheet.create({
  wrap:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#111' },
  cancelBtn: { padding: 8 },
  cancelTxt: { color: '#555', fontSize: 20 },
  center:    { flex: 1, alignItems: 'center' },
  recRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot:       { width: 10, height: 10, borderRadius: 5, backgroundColor: '#FF3C6E' },
  timer:     { color: '#E0E0F0', fontSize: 16, fontVariant: ['tabular-nums'] },
  hint:      { color: '#555', fontSize: 13 },
  micBtn:    { width: 48, height: 48, borderRadius: 24, backgroundColor: '#00E5FF', alignItems: 'center', justifyContent: 'center' },
  micStop:   { backgroundColor: '#FF3C6E' },
  micIco:    { fontSize: 22 },
});