// components/VoiceRecorder.tsx
// Hold to record voice message

import React, { useState, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Audio } from 'expo-av';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { permissionDenied } from '../lib/permissionDenied';

interface Props {
  onSend: (uri: string, duration: number) => void;
  onCancel: () => void;
}

export default function VoiceRecorder({ onSend, onCancel }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  const [recording, setRecording]   = useState<Audio.Recording | null>(null);
  const [seconds,   setSeconds]     = useState(0);
  const [uploading, setUploading]   = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { permissionDenied('Permission denied', 'Microphone permission is required.', perm.canAskAgain); return; }

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
      <TouchableOpacity onPress={cancel} style={s.cancelBtn} accessibilityRole="button" accessibilityLabel="Cancel recording" hitSlop={8}>
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
        ? <ActivityIndicator color={c.primary} accessibilityLabel="Sending voice message" />
        : recording
          ? <TouchableOpacity onPress={stopAndSend} style={[s.micBtn, s.micStop]} accessibilityRole="button" accessibilityLabel="Stop and send voice message">
              <Text style={s.micIco}>⬛</Text>
            </TouchableOpacity>
          : <TouchableOpacity onPress={startRecording} style={s.micBtn} accessibilityRole="button" accessibilityLabel="Record a voice message">
              <Text style={s.micIco}>🎤</Text>
            </TouchableOpacity>
      }
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bg, paddingHorizontal: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.glassStroke },
  cancelBtn: { padding: 8 },
  cancelTxt: { color: c.textDim, fontSize: 20 },
  center: { flex: 1, alignItems: 'center' },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
  timer: { color: c.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  hint: { color: c.textDim, fontSize: 13 },
  micBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  micStop: { backgroundColor: c.danger },
  micIco: { fontSize: 22 },
});