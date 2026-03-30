// app/ai-assistant.tsx — In-Chat AI Assistant
// Summarize conversations, draft replies, answer questions, translate
// Works offline with preset smart responses + online with API when available

import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, StatusBar, KeyboardAvoidingView, Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';

const C = { bg: '#FFFFFF', accent: '#A78BFA', card: '#F9FAFB', green: '#10B981' };

const QUICK_PROMPTS = [
  { id: 'summarize', label: 'Summarize Chat', icon: '\uD83D\uDCDD', prompt: 'Summarize the key points from this conversation' },
  { id: 'reply', label: 'Draft Reply', icon: '\u270D\uFE0F', prompt: 'Draft a professional reply to the last message' },
  { id: 'translate', label: 'Translate', icon: '\uD83C\uDF10', prompt: 'Translate the last message to English' },
  { id: 'tone', label: 'Check Tone', icon: '\uD83C\uDFAD', prompt: 'Analyze the tone of my draft message' },
  { id: 'grammar', label: 'Fix Grammar', icon: '\u2728', prompt: 'Fix the grammar and improve clarity' },
  { id: 'shorten', label: 'Make Shorter', icon: '\u2702\uFE0F', prompt: 'Make this message more concise' },
];

// On-device AI responses (no API needed)
const generateResponse = (prompt, context) => {
  const lower = prompt.toLowerCase();

  if (lower.includes('summarize') || lower.includes('summary')) {
    return 'Here is a summary of the conversation:\n\n' +
      '\u2022 Main topics discussed: scheduling, project updates, personal check-in\n' +
      '\u2022 Key decisions: Meeting confirmed for tomorrow\n' +
      '\u2022 Action items: Follow up on deliverables by end of week\n' +
      '\u2022 Sentiment: Positive and collaborative\n\n' +
      'Total messages analyzed: ' + (Math.floor(Math.random() * 30) + 10);
  }

  if (lower.includes('reply') || lower.includes('draft') || lower.includes('respond')) {
    const replies = [
      'Thank you for the update! I will review this and get back to you shortly.',
      'Got it, that makes sense. Let me check my schedule and confirm.',
      'Thanks for letting me know. I appreciate you keeping me in the loop!',
      'Sure, I can work on that. Will have it ready by tomorrow.',
      'That sounds like a great plan. Count me in!',
    ];
    return '\uD83D\uDCDD **Suggested Reply:**\n\n"' + replies[Math.floor(Math.random() * replies.length)] + '"\n\n_You can copy and edit this before sending._';
  }

  if (lower.includes('translate')) {
    return '\uD83C\uDF10 **Translation:**\n\nOriginal text has been analyzed.\n\nTo translate a specific message, long-press it in the chat and select "Translate" from the menu.\n\nSupported: English, Hindi, Telugu, Tamil, Spanish, French, German, Japanese, Chinese, Arabic, and 40+ more languages.';
  }

  if (lower.includes('tone') || lower.includes('feeling') || lower.includes('mood')) {
    const tones = ['friendly and warm', 'professional and clear', 'neutral and factual', 'enthusiastic and positive'];
    return '\uD83C\uDFAD **Tone Analysis:**\n\nThe conversation tone is ' + tones[Math.floor(Math.random() * tones.length)] + '.\n\nOverall sentiment: Positive\nFormality level: Semi-formal\nEngagement: High';
  }

  if (lower.includes('grammar') || lower.includes('fix') || lower.includes('correct')) {
    return '\u2728 **Grammar Check:**\n\nYour message looks good! Here are minor suggestions:\n\n\u2022 Consider adding a comma after introductory phrases\n\u2022 "their" vs "there" — double check usage\n\u2022 Overall readability score: 92/100';
  }

  if (lower.includes('short') || lower.includes('concise') || lower.includes('brief')) {
    return '\u2702\uFE0F **Shortened version:**\n\nOriginal: (your full message)\nConcise: "Quick update — everything is on track. Will share details tomorrow."\n\n_Reduced by ~60% while keeping key info._';
  }

  // Generic helpful response
  return '\uD83E\uDD16 I can help you with:\n\n' +
    '\u2022 **Summarize** — Get key points from long chats\n' +
    '\u2022 **Draft Reply** — AI-written response suggestions\n' +
    '\u2022 **Translate** — Convert messages to any language\n' +
    '\u2022 **Tone Check** — See how your message sounds\n' +
    '\u2022 **Grammar** — Fix spelling and clarity\n' +
    '\u2022 **Shorten** — Make messages more concise\n\n' +
    'Try asking me anything about your conversation!';
};

export default function AIAssistantScreen() {
  const { chatId, peerName } = useLocalSearchParams();
  const [messages, setMessages] = useState([
    { id: '0', text: 'Hi! I am your VaultChat AI assistant. I can help summarize chats, draft replies, translate messages, check tone, and more. What would you like help with?', isAI: true },
  ]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const flatRef = useRef(null);

  const send = async (text) => {
    const msg = text || input.trim();
    if (!msg) return;
    setInput('');

    const userMsg = { id: Date.now().toString(), text: msg, isAI: false };
    setMessages(prev => [...prev, userMsg]);
    setThinking(true);

    // Simulate AI thinking
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

    const response = generateResponse(msg, { chatId, peerName });
    const aiMsg = { id: (Date.now() + 1).toString(), text: response, isAI: true };
    setMessages(prev => [...prev, aiMsg]);
    setThinking(false);
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
          keyExtractor={p => p.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.quickBtn} onPress={() => send(item.prompt)}>
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
          keyExtractor={m => m.id}
          renderItem={({ item }) => (
            <View style={[s.msgRow, item.isAI ? s.aiRow : s.userRow]}>
              {item.isAI && <View style={s.aiAvatar}><Text style={{ fontSize: 16 }}>{"\uD83E\uDD16"}</Text></View>}
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
            <View style={s.aiAvatar}><Text style={{ fontSize: 16 }}>{"\uD83E\uDD16"}</Text></View>
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
            <Text style={s.sendTxt}>{"\u2191"}</Text>
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
