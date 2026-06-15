// app/decoy-chat.tsx — Ghost Protocol Decoy Conversation
// Pixel-perfect clone of real chat.tsx but with fake messages
// Even allows "typing" fake messages that disappear on reload

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import {
  appendDecoyMessage, getDecoyMessages, markDecoyDelivered, type DecoyMessage,
} from '../lib/ghostProtocol';

export default function DecoyChatScreen() {
  const { chatId, name } = useLocalSearchParams();
  const [messages, setMessages] = useState<DecoyMessage[]>([]);
  const [input, setInput] = useState('');
  const flatRef = useRef<FlatList>(null);

  // Load the persistent decoy thread (seeds on first open).
  useEffect(() => {
    let alive = true;
    getDecoyMessages(chatId as string).then((m) => { if (alive) setMessages(m); }).catch(() => {});
    return () => { alive = false; };
  }, [chatId]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    // Persist the sent message so it survives reload (real account behaviour).
    const newMsg = await appendDecoyMessage(chatId as string, text);
    setMessages(prev => [...prev, newMsg]);
    setTimeout(async () => {
      await markDecoyDelivered(chatId as string, newMsg.id);
      setMessages(prev => prev.map(m => m.id === newMsg.id ? { ...m, delivered: true } : m));
    }, 1000);
  };

  const renderMsg = ({ item }: any) => (
    <View style={[s.row, item.sent ? s.rowR : s.rowL]}>
      <View style={[s.bubble, item.sent ? s.bMe : s.bPeer]}>
        <Text style={s.msgTxt}>{item.text}</Text>
        <View style={s.meta}>
          <Text style={s.time}>{item.time}</Text>
          {item.sent && <Text style={[s.tick, item.delivered && { color: '#4A9FFF' }]}>{item.delivered ? '\u2713\u2713' : '\u2713'}</Text>}
        </View>
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{
        title: (name as string) || 'Chat',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#1F2937',
        headerRight: () => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginRight: 12 }}>
            <TouchableOpacity><Text style={{ color: '#4A9FFF', fontSize: 20 }}>{"\u260E\uFE0F"}</Text></TouchableOpacity>
            <TouchableOpacity><Text style={{ color: '#4A9FFF', fontSize: 20 }}>{"\uD83D\uDCF9"}</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <FlatList
          ref={flatRef}
          data={messages}
          keyExtractor={m => m.id}
          renderItem={renderMsg}
          contentContainerStyle={s.list}
          onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })}
        />
        <View style={s.bar}>
          <TouchableOpacity style={s.attachBtn}><Text style={{ fontSize: 22 }}>{"\u2795"}</Text></TouchableOpacity>
          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="Type a message..."
            placeholderTextColor="#6B7280"
            multiline
          />
          <TouchableOpacity style={[s.sendBtn, !input.trim() && s.sendOff]} onPress={send} disabled={!input.trim()}>
            <Text style={s.sendIco}>{"\u2191"}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  list: { padding: 12, paddingBottom: 8 },
  row: { marginBottom: 6 },
  rowR: { alignItems: 'flex-end' },
  rowL: { alignItems: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bMe: { backgroundColor: '#DCF8C6', borderBottomRightRadius: 2 },
  bPeer: { backgroundColor: '#F3F4F6', borderBottomLeftRadius: 2 },
  msgTxt: { color: '#1F2937', fontSize: 15, lineHeight: 21 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 },
  time: { color: '#9CA3AF', fontSize: 11, marginRight: 3 },
  tick: { color: '#6B7280', fontSize: 12 },
  bar: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#FFFFFF', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB' },
  attachBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, backgroundColor: '#F3F4F6', color: '#1F2937', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120, marginHorizontal: 6 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#4A9FFF', alignItems: 'center', justifyContent: 'center' },
  sendOff: { backgroundColor: '#F3F4F6' },
  sendIco: { color: '#000', fontSize: 18, fontWeight: 'bold' },
});
