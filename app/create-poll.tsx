// app/create-poll.tsx — Compose a poll for a chat (Postgres).
//
// Reachable from the chat attach menu. Takes ?chatId (and optional peerName)
// in route params. On submit: createPoll() → message of type='poll' posted
// to the chat with meta.options + meta.allowMultiple. The chat's PollBubble
// hydrates vote counts via the bulk endpoint on render.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { createPoll } from '../lib/chatService';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

export default function CreatePollScreen() {
  const router = useRouter();
  const { chatId, peerName } = useLocalSearchParams<{ chatId?: string; peerName?: string }>();

  const [question,      setQuestion]      = useState('');
  const [options,       setOptions]       = useState<string[]>(['', '']);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [posting,       setPosting]       = useState(false);

  const updateOption = useCallback((i: number, value: string) => {
    setOptions(prev => prev.map((o, idx) => idx === i ? value : o));
  }, []);

  const addOption = useCallback(() => {
    setOptions(prev => prev.length >= MAX_OPTIONS ? prev : [...prev, '']);
  }, []);

  const removeOption = useCallback((i: number) => {
    setOptions(prev => prev.length <= MIN_OPTIONS ? prev : prev.filter((_, idx) => idx !== i));
  }, []);

  const submit = useCallback(async () => {
    if (!chatId) { Alert.alert('Missing chat', 'Open this from a chat.'); return; }
    const q = question.trim();
    if (!q) { Alert.alert('Question required', 'Type the poll question first.'); return; }
    if (q.length > 200) { Alert.alert('Too long', 'Question is over 200 characters.'); return; }

    const cleaned = options.map(o => o.trim()).filter(o => o.length > 0);
    if (cleaned.length < MIN_OPTIONS) {
      Alert.alert('Need more options', `Add at least ${MIN_OPTIONS} non-empty options.`);
      return;
    }

    setPosting(true);
    try {
      await createPoll(chatId, q, cleaned, allowMultiple);
      router.back();
    } catch (e: any) {
      Alert.alert('Could not send poll', e?.message ?? 'Try again');
    } finally {
      setPosting(false);
    }
  }, [chatId, question, options, allowMultiple, router]);

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title}>New poll</Text>
          {peerName ? <Text style={S.sub}>to {peerName}</Text> : null}
        </View>
        <TouchableOpacity
          onPress={submit}
          disabled={posting}
          style={[S.sendBtn, posting && S.sendBtnOff]}
          activeOpacity={0.85}
        >
          {posting ? <ActivityIndicator color="#fff" /> : <Text style={S.sendBtnTxt}>Send</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={S.label}>QUESTION</Text>
        <TextInput
          style={S.questionInput}
          value={question}
          onChangeText={setQuestion}
          placeholder="What should we ask?"
          placeholderTextColor={SUBTLE}
          maxLength={200}
          multiline
        />
        <Text style={S.counter}>{question.length} / 200</Text>

        <Text style={[S.label, { marginTop: 20 }]}>OPTIONS</Text>
        {options.map((o, i) => (
          <View key={i} style={S.optionRow}>
            <TextInput
              style={S.optionInput}
              value={o}
              onChangeText={(v) => updateOption(i, v)}
              placeholder={`Option ${i + 1}`}
              placeholderTextColor={SUBTLE}
              maxLength={100}
            />
            {options.length > MIN_OPTIONS && (
              <TouchableOpacity
                onPress={() => removeOption(i)}
                hitSlop={8}
                style={S.removeBtn}
              >
                <Text style={S.removeBtnTxt}>×</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
        {options.length < MAX_OPTIONS && (
          <TouchableOpacity onPress={addOption} style={S.addBtn} activeOpacity={0.7}>
            <Text style={S.addBtnTxt}>＋ Add option</Text>
          </TouchableOpacity>
        )}

        <View style={S.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={S.toggleTitle}>Allow multiple answers</Text>
            <Text style={S.toggleSub}>
              When off, voters can pick exactly one option (radio-button style).
              Switching options swaps the vote.
            </Text>
          </View>
          <Switch
            value={allowMultiple}
            onValueChange={setAllowMultiple}
            trackColor={{ true: ACCENT, false: '#374151' }}
            thumbColor="#fff"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: DARK_BG },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: TEXT, fontSize: 26, fontWeight: '600' },
  title:         { color: TEXT, fontSize: 22, fontWeight: '800' },
  sub:           { color: SUBTLE, fontSize: 12 },
  sendBtn:       { backgroundColor: ACCENT, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
  sendBtnOff:    { backgroundColor: '#374151' },
  sendBtnTxt:    { color: '#fff', fontWeight: '700' },

  label:         { color: SUBTLE, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  questionInput: { color: TEXT, backgroundColor: CARD_BG, borderColor: BORDER, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, minHeight: 80, textAlignVertical: 'top' },
  counter:       { color: SUBTLE, fontSize: 11, marginTop: 4, textAlign: 'right' },

  optionRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  optionInput:   { flex: 1, color: TEXT, backgroundColor: CARD_BG, borderColor: BORDER, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  removeBtn:     { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 1, borderColor: BORDER, backgroundColor: CARD_BG },
  removeBtnTxt:  { color: DANGER, fontSize: 22, fontWeight: '700' },
  addBtn:        { padding: 12, borderRadius: 12, backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER, alignItems: 'center', marginTop: 4 },
  addBtnTxt:     { color: ACCENT, fontWeight: '700' },

  toggleRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER },
  toggleTitle:   { color: TEXT, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: SUBTLE, fontSize: 12, lineHeight: 16, marginTop: 2 },
});
