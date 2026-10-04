// app/create-poll.tsx — Compose a poll for a chat (Postgres).
//
// Reachable from the chat attach menu. Takes ?chatId (and optional peerName)
// in route params. On submit: createPoll() → message of type='poll' posted
// to the chat with meta.options + meta.allowMultiple. The chat's PollBubble
// hydrates vote counts via the bulk endpoint on render.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { createPoll } from '../lib/chatService';
import { AppText as Text, AuroraBackground, KeyboardSafe } from '../components/ui';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function CreatePollScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { chatId, peerName } = useLocalSearchParams<{ chatId?: string; peerName?: string }>();

  const [question,      setQuestion]      = useState('');
  // Each option carries a stable id for its row key: keyed by index, removing
  // a middle option shifted every later input's focus and IME state.
  const nextId = useRef(2);
  const [options,       setOptions]       = useState<{ id: number; text: string }[]>([{ id: 0, text: '' }, { id: 1, text: '' }]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [posting,       setPosting]       = useState(false);

  // Leaving with a typed poll asks first (header back, hardware back, swipe).
  // `sent` lets the post-send pop through.
  const sent = useRef(false);
  const dirty = !!question.trim() || options.some(o => o.text.trim());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', (ev) => {
    // beforeRemove is preventable at runtime; the generic navigation type says otherwise.
    const e = ev as typeof ev & { preventDefault(): void };
    if (sent.current || !dirtyRef.current) return;
    e.preventDefault();
    Alert.alert('Discard poll?', 'Your poll has not been sent and will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);

  const updateOption = useCallback((id: number, value: string) => {
    setOptions(prev => prev.map(o => o.id === id ? { ...o, text: value } : o));
  }, []);

  const addOption = useCallback(() => {
    setOptions(prev => prev.length >= MAX_OPTIONS ? prev : [...prev, { id: nextId.current++, text: '' }]);
  }, []);

  const removeOption = useCallback((id: number) => {
    setOptions(prev => prev.length <= MIN_OPTIONS ? prev : prev.filter(o => o.id !== id));
  }, []);

  const submit = useCallback(async () => {
    if (!chatId) { Alert.alert('Missing chat', 'Open this from a chat.'); return; }
    const q = question.trim();
    if (!q) { Alert.alert('Question required', 'Type the poll question first.'); return; }
    if (q.length > 200) { Alert.alert('Too long', 'Question is over 200 characters.'); return; }

    const cleaned = options.map(o => o.text.trim()).filter(o => o.length > 0);
    if (cleaned.length < MIN_OPTIONS) {
      Alert.alert('Need more options', `Add at least ${MIN_OPTIONS} non-empty options.`);
      return;
    }
    // Two identical options split one answer's votes in two.
    if (new Set(cleaned.map(o => o.toLowerCase())).size !== cleaned.length) {
      Alert.alert('Duplicate options', 'Each option must be different.');
      return;
    }

    setPosting(true);
    try {
      await createPoll(chatId, q, cleaned, allowMultiple);
      sent.current = true;
      router.back();
    } catch (e: any) {
      Alert.alert('Could not send poll', e?.message ?? 'Try again');
    } finally {
      setPosting(false);
    }
  }, [chatId, question, options, allowMultiple, router]);

  return (
    <KeyboardSafe style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title} accessibilityRole="header">New poll</Text>
          {peerName ? <Text style={S.sub}>to {peerName}</Text> : null}
        </View>
        <TouchableOpacity
          onPress={submit}
          disabled={posting}
          style={[S.sendBtn, posting && S.sendBtnOff]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Send poll"
          accessibilityState={{ disabled: posting, busy: posting }}
        >
          {posting ? <ActivityIndicator color={colors.bubbleOutText} /> : <Text style={S.sendBtnTxt}>Send</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={S.label}>QUESTION</Text>
        <TextInput
          style={S.questionInput}
          value={question}
          onChangeText={setQuestion}
          placeholder="What should we ask?"
          placeholderTextColor={colors.textDim}
          accessibilityLabel="Poll question"
          maxLength={200}
          multiline
        />
        <Text style={S.counter}>{question.length} / 200</Text>

        <Text style={[S.label, { marginTop: 20 }]}>OPTIONS</Text>
        {options.map((o, i) => (
          <View key={o.id} style={S.optionRow}>
            <TextInput
              style={S.optionInput}
              value={o.text}
              onChangeText={(v) => updateOption(o.id, v)}
              placeholder={`Option ${i + 1}`}
              placeholderTextColor={colors.textDim}
              maxLength={100}
              accessibilityLabel={`Option ${i + 1}`}
            />
            {options.length > MIN_OPTIONS && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove option ${i + 1}`}
                onPress={() => removeOption(o.id)}
                hitSlop={8}
                style={S.removeBtn}
              >
                <Ionicons name="close" size={20} color={colors.danger} />
              </TouchableOpacity>
            )}
          </View>
        ))}
        {options.length < MAX_OPTIONS && (
          <TouchableOpacity onPress={addOption} style={S.addBtn} activeOpacity={0.7} accessibilityRole="button">
            <Ionicons name="add" size={16} color={colors.primary} />
            <Text style={[S.addBtnTxt, { marginLeft: 6 }]}>Add option</Text>
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
            accessibilityLabel="Allow multiple answers"
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor={colors.card}
          />
        </View>
      </ScrollView>
    </KeyboardSafe>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },
  sub:           { color: c.textDim, fontSize: 12 },
  sendBtn:       { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, minHeight: 44, justifyContent: 'center', borderRadius: 22 },
  sendBtnOff:    { opacity: 0.5 },
  sendBtnTxt:    { color: c.bubbleOutText, fontWeight: '700' },

  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  questionInput: { color: c.text, backgroundColor: c.glass, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, minHeight: 80, textAlignVertical: 'top' },
  counter:       { color: c.textDim, fontSize: 11, marginTop: 4, textAlign: 'right' },

  optionRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  optionInput:   { flex: 1, color: c.text, backgroundColor: c.glass, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  removeBtn:     { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glass },
  addBtn:        { flexDirection: 'row', justifyContent: 'center', padding: 12, minHeight: 44, borderRadius: 12, backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center', marginTop: 4 },
  addBtnTxt:     { color: c.primary, fontWeight: '700' },

  toggleRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.glassStroke },
  toggleTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 2 },
});
