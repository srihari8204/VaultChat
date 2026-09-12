// app/voice-transcribe.tsx — Voice → Text (real on-device dictation).
//
// Uses @react-native-voice/voice for real on-device speech recognition (the OS
// recognizer — Android SpeechRecognizer / iOS Speech). Speak and get live text
// you can edit and send to the chat. Requires a dev/native build (not Expo Go)
// — the native module is autolinked on prebuild.
//
// (File-transcription of *received* audio messages needs a cloud STT service
// like Whisper/Google Speech — that's a separate, key-gated integration. This
// screen does real live dictation, which the on-device recognizer supports.)

import { HEADER_TOP } from '../constants/layout';
import { BRAND_ACCENT, type Palette } from '../constants/theme';
import React, { useState, useEffect, useRef, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, Alert, TextInput, ScrollView,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Voice, { type SpeechResultsEvent, type SpeechErrorEvent } from '@react-native-voice/voice';
import { useTheme } from '../lib/theme';
import { sendMessage } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VoiceTranscribeScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId?: string }>();
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const baseRef = useRef('');

  useEffect(() => {
    Voice.onSpeechStart = () => setListening(true);
    Voice.onSpeechEnd = () => setListening(false);
    Voice.onSpeechResults = (e: SpeechResultsEvent) => {
      const best = e.value?.[0] ?? '';
      setText((baseRef.current ? baseRef.current + ' ' : '') + best);
      setPartial('');
    };
    Voice.onSpeechPartialResults = (e: SpeechResultsEvent) => setPartial(e.value?.[0] ?? '');
    Voice.onSpeechError = (e: SpeechErrorEvent) => {
      setListening(false);
      const msg = e.error?.message || 'Speech recognition error';
      if (!/No speech|1110|recognizer is busy/i.test(msg)) Alert.alert('Voice', msg);
    };
    return () => { Voice.destroy().then(() => Voice.removeAllListeners()).catch(() => {}); };
  }, []);

  const start = useCallback(async () => {
    try {
      baseRef.current = text.trim();
      setPartial('');
      await Voice.start('en-US');
    } catch (e: any) {
      Alert.alert('Cannot start', e?.message ?? 'Speech recognition unavailable on this device/build.');
    }
  }, [text]);

  const stop = useCallback(async () => {
    try { await Voice.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  const send = async () => {
    const body = text.trim();
    if (!body || !chatId) { if (!chatId) Alert.alert('No chat', 'Open from a chat to send.'); return; }
    setSending(true);
    try {
      await sendMessage(chatId, body, 'text');
      router.back();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not send');
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Voice to Text</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Text style={{ fontSize: 22 }}>🎙️</Text>
          <Text style={s.infoTxt}>Tap the mic and speak. Words are transcribed on-device; edit and send to the chat.</Text>
        </View>

        <ScrollView style={s.textArea} contentContainerStyle={{ padding: 14 }}>
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder="Your transcribed text appears here…"
            placeholderTextColor={colors.textFaint}
            multiline
          />
          {!!partial && <Text style={s.partial}>{partial}…</Text>}
        </ScrollView>

        <View style={s.controls}>
          <TouchableOpacity
            style={[s.micBtn, listening && s.micActive]}
            onPress={listening ? stop : start}
            activeOpacity={0.85}
          >
            <Ionicons name={listening ? 'stop' : 'mic'} size={30} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={s.micLabel}>{listening ? 'Listening… tap to stop' : 'Tap to speak'}</Text>
        </View>

        <View style={s.actions}>
          <TouchableOpacity style={[s.actionBtn, s.clearBtn]} onPress={() => { setText(''); setPartial(''); }} disabled={!text}>
            <Text style={[s.actionTxt, { color: colors.textDim }]}>Clear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.actionBtn, s.sendBtn, (!text.trim() || sending) && s.dim]} onPress={send} disabled={!text.trim() || sending}>
            <Text style={[s.actionTxt, { color: '#FFFFFF' }]}>{sending ? 'Sending…' : 'Send to chat'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.glassStroke, marginBottom: 14 },
  infoTxt: { flex: 1, color: c.textDim, fontSize: 12, lineHeight: 18 },
  textArea: { flex: 1, backgroundColor: c.glassSoft, borderRadius: 14, borderWidth: 1, borderColor: c.glassStroke, marginBottom: 14 },
  input: { color: c.text, fontSize: 16, lineHeight: 24, minHeight: 120, textAlignVertical: 'top' },
  partial: { color: c.textDim, fontSize: 15, fontStyle: 'italic', marginTop: 6 },
  controls: { alignItems: 'center', marginBottom: 16 },
  micBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  micActive: { backgroundColor: BRAND_ACCENT },
  micLabel: { color: c.textDim, fontSize: 12, marginTop: 8 },
  actions: { flexDirection: 'row', gap: 10 },
  actionBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  clearBtn: { backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  sendBtn: { backgroundColor: c.primary },
  dim: { opacity: 0.5 },
  actionTxt: { fontSize: 14, fontWeight: '800' },
});
