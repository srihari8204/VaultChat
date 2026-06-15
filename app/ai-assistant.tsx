// app/ai-assistant.tsx — In-Chat AI Assistant
// Real LLM (Ollama via the backend): summarize the conversation, draft replies,
// translate, check tone, fix grammar, shorten. Conversation tasks decrypt the
// recent messages locally (E2E) before sending the text to the on-prem model.

import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, StatusBar, KeyboardAvoidingView, Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { aiChat, aiAssist, type AiTask } from '../lib/ai';
import { getMessages, decryptFromChat } from '../lib/chatService';

const C = { bg: '#FFFFFF', accent: '#A78BFA', card: '#F9FAFB', green: '#10B981' };

const QUICK_PROMPTS: { id: string; label: string; icon: string }[] = [
  { id: 'summarize', label: 'Summarize Chat', icon: '📝' },
  { id: 'reply',     label: 'Draft Reply',    icon: '✍️' },
  { id: 'translate', label: 'Translate',      icon: '🌐' },
  { id: 'tone',      label: 'Check Tone',     icon: '🎭' },
  { id: 'grammar',   label: 'Fix Grammar',    icon: '✨' },
  { id: 'shorten',   label: 'Make Shorter',   icon: '✂️' },
];

// Quick-prompt id → backend AI task. 'reply' maps to reply-suggestions.
const TASK_FOR: Record<string, AiTask> = {
  summarize: 'summarize', reply: 'suggest', translate: 'translate',
  tone: 'tone', grammar: 'grammar', shorten: 'shorten',
};

interface Msg { id: string; text: string; isAI: boolean }

export default function AIAssistantScreen() {
  const { chatId, peerName } = useLocalSearchParams();
  const [messages, setMessages] = useState<Msg[]>([
    { id: '0', text: 'Hi! I can summarize this chat, draft replies, translate, check tone, fix grammar, and answer questions. Tap a shortcut or just ask.', isAI: true },
  ]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const flatRef = useRef<FlatList>(null);

  // Load + decrypt the recent conversation (E2E plaintext stays on-device).
  async function loadConversation(limit = 30): Promise<string> {
    if (!chatId) return '';
    const msgs = await getMessages(String(chatId), { limit });
    const texts = await Promise.all(
      [...msgs].reverse().map((m) =>
        decryptFromChat(String(chatId), m.senderId, m.content, m.id).catch(() => '')),
    );
    return texts.filter(Boolean).join('\n').slice(0, 4000);
  }
  async function loadLastMessage(): Promise<string> {
    if (!chatId) return '';
    const msgs = await getMessages(String(chatId), { limit: 1 });
    if (!msgs.length) return '';
    return (await decryptFromChat(String(chatId), msgs[0].senderId, msgs[0].content, msgs[0].id).catch(() => '')) || '';
  }

  const send = async (text?: string, taskId?: string) => {
    const typed = (text ?? input).trim();
    if (!typed && !taskId) return;
    setInput('');

    const label = taskId ? (QUICK_PROMPTS.find((p) => p.id === taskId)?.label ?? typed) : typed;
    setMessages((prev) => [...prev, { id: Date.now().toString(), text: label, isAI: false }]);
    setThinking(true);

    try {
      let response: string;
      if (taskId) {
        let target = '';
        if (taskId === 'summarize') target = await loadConversation();
        else if (taskId === 'reply' || taskId === 'translate' || taskId === 'tone') target = typed || await loadLastMessage();
        else target = typed; // grammar / shorten — operate on the typed draft

        if (!target) {
          response = (taskId === 'grammar' || taskId === 'shorten')
            ? 'Type the text you want me to work on, then tap this again.'
            : 'There are no messages in this chat yet.';
        } else {
          response = await aiAssist(TASK_FOR[taskId], target);
        }
      } else {
        response = await aiChat(typed);
      }
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), text: response || '(no response)', isAI: true }]);
    } catch (e: any) {
      const text2 = e?.status === 503
        ? 'The assistant is offline right now — please try again shortly.'
        : 'Sorry, I couldn’t reach the assistant just now.';
      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), text: text2, isAI: true }]);
    } finally {
      setThinking(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'AI Assistant', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <StatusBar barStyle="light-content" />

        {peerName && <View style={s.contextBar}><Text style={s.contextTxt}>Context: Chat with {peerName}</Text></View>}

        {/* Quick prompts */}
        <FlatList
          data={QUICK_PROMPTS}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.quickBtn} onPress={() => send(undefined, item.id)} disabled={thinking}>
              <Text style={s.quickIcon}>{item.icon}</Text>
              <Text style={s.quickLabel}>{item.label}</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={s.quickRow}
        />

        {/* Messages */}
        <FlatList
          ref={flatRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <View style={[s.msgRow, item.isAI ? s.aiRow : s.userRow]}>
              {item.isAI && <View style={s.aiAvatar}><Text style={{ fontSize: 16 }}>{"🤖"}</Text></View>}
              <View style={[s.bubble, item.isAI ? s.aiBubble : s.userBubble]}>
                <Text style={s.msgTxt}>{item.text}</Text>
              </View>
            </View>
          )}
          contentContainerStyle={{ padding: 12, paddingBottom: 8 }}
          onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: true })}
        />

        {thinking && (
          <View style={s.thinkingRow}>
            <View style={s.aiAvatar}><Text style={{ fontSize: 16 }}>{"🤖"}</Text></View>
            <View style={s.thinkingBubble}>
              <ActivityIndicator color={C.accent} size="small" />
              <Text style={s.thinkingTxt}>Thinking...</Text>
            </View>
          </View>
        )}

        {/* Input */}
        <View style={s.inputBar}>
          <TextInput style={s.input} value={input} onChangeText={setInput}
            placeholder="Ask AI anything..." placeholderTextColor="#6B7280" multiline />
          <TouchableOpacity style={[s.sendBtn, !input.trim() && { opacity: 0.3 }]} onPress={() => send()} disabled={!input.trim() || thinking}>
            <Text style={s.sendTxt}>{"↑"}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  contextBar: { backgroundColor: '#A78BFA15', paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  contextTxt: { color: C.accent, fontSize: 11, fontWeight: '600' },
  quickRow: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  quickBtn: { backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#E5E7EB' },
  quickIcon: { fontSize: 14 },
  quickLabel: { color: '#ccc', fontSize: 12, fontWeight: '600' },
  msgRow: { marginBottom: 8, flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  aiRow: { justifyContent: 'flex-start' },
  userRow: { justifyContent: 'flex-end' },
  aiAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#A78BFA22', justifyContent: 'center', alignItems: 'center' },
  bubble: { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  aiBubble: { backgroundColor: C.card, borderBottomLeftRadius: 2 },
  userBubble: { backgroundColor: '#DCF8C6', borderBottomRightRadius: 2 },
  msgTxt: { color: '#1F2937', fontSize: 14, lineHeight: 21 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  thinkingBubble: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  thinkingTxt: { color: '#6B7280', fontSize: 13 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#FFFFFF', padding: 10, borderTopWidth: 1, borderTopColor: '#E5E7EB' },
  input: { flex: 1, backgroundColor: '#F3F4F6', color: '#1F2937', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, maxHeight: 100, marginRight: 8 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center' },
  sendTxt: { color: '#000', fontSize: 18, fontWeight: '900' },
});
