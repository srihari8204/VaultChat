// @ts-nocheck
// app/in-chat-search.tsx — In-Chat Message Search
// Search through messages in a specific chat. Real-time filtering,
// highlighted matches, tap to jump to message in chat.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  FlatList, StatusBar, Dimensions, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import firestore from '@react-native-firebase/firestore';
import { Ionicons } from '@expo/vector-icons';

const { width: SW } = Dimensions.get('window');
const C = { bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF', card: '#0A1628', border: '#112240' };

interface Message {
  id: string;
  text: string;
  senderName: string;
  senderId: string;
  createdAt: any;
}

export default function InChatSearchScreen() {
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const inputRef = useRef<TextInput>(null);

  const [query, setQuery] = useState('');
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  const [filtered, setFiltered] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  // Load all messages from Firestore
  useEffect(() => {
    if (!chatId) return;
    setLoading(true);
    const unsub = firestore()
      .collection('chats')
      .doc(chatId)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .onSnapshot(
        snap => {
          const msgs: Message[] = snap.docs
            .map(d => {
              const data = d.data();
              return {
                id: d.id,
                text: data.text || data.message || '',
                senderName: data.senderName || data.userName || 'Unknown',
                senderId: data.senderId || data.uid || '',
                createdAt: data.createdAt,
              };
            })
            .filter(m => m.text.length > 0);
          setAllMessages(msgs);
          setLoading(false);
        },
        err => {
          console.warn('[InChatSearch] snapshot error:', err);
          setLoading(false);
        },
      );
    return () => unsub();
  }, [chatId]);

  // Filter messages in real time
  useEffect(() => {
    if (!query.trim()) {
      setFiltered([]);
      return;
    }
    const q = query.toLowerCase();
    const results = allMessages.filter(m => m.text.toLowerCase().includes(q));
    setFiltered(results);
  }, [query, allMessages]);

  // Auto-focus search input
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 300);
  }, []);

  const formatTime = useCallback((ts: any) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, []);

  const highlightMatch = (text: string, q: string) => {
    if (!q.trim()) return <Text style={s.msgText}>{text}</Text>;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) return <Text style={s.msgText}>{text}</Text>;

    const before = text.substring(0, idx);
    const match = text.substring(idx, idx + q.length);
    const after = text.substring(idx + q.length);

    // Show context around match (max 40 chars before, 60 after)
    const startCtx = Math.max(0, idx - 40);
    const endCtx = Math.min(text.length, idx + q.length + 60);
    const prefix = startCtx > 0 ? '...' : '';
    const suffix = endCtx < text.length ? '...' : '';

    return (
      <Text style={s.msgText} numberOfLines={2}>
        {prefix}{text.substring(startCtx, idx)}
        <Text style={s.highlight}>{match}</Text>
        {text.substring(idx + q.length, endCtx)}{suffix}
      </Text>
    );
  };

  const handleTapResult = (messageId: string) => {
    router.back();
    // Navigate back with the messageId so the chat screen can scroll to it
    setTimeout(() => {
      router.setParams({ scrollToMessage: messageId });
    }, 100);
  };

  const renderItem = ({ item }: { item: Message }) => (
    <TouchableOpacity
      style={s.resultCard}
      activeOpacity={0.7}
      onPress={() => handleTapResult(item.id)}
    >
      <View style={s.resultHeader}>
        <Text style={s.senderName}>{item.senderName}</Text>
        <Text style={s.timestamp}>{formatTime(item.createdAt)}</Text>
      </View>
      {highlightMatch(item.text, query)}
    </TouchableOpacity>
  );

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <LinearGradient colors={['#0A1628', C.bg]} style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        <View style={s.searchBox}>
          <Ionicons name="search" size={18} color="#667" style={{ marginRight: 8 }} />
          <TextInput
            ref={inputRef}
            style={s.searchInput}
            placeholder="Search messages..."
            placeholderTextColor="#556"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color="#556" />
            </TouchableOpacity>
          )}
        </View>
      </LinearGradient>

      {/* Result count badge */}
      {query.trim().length > 0 && (
        <View style={s.badgeRow}>
          <View style={s.badge}>
            <Text style={s.badgeText}>
              {filtered.length} result{filtered.length !== 1 ? 's' : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.accent} />
          <Text style={s.loadingText}>Loading messages...</Text>
        </View>
      ) : !query.trim() ? (
        <View style={s.center}>
          <Ionicons name="search-outline" size={64} color="#1a2a40" />
          <Text style={s.emptyTitle}>Search Messages</Text>
          <Text style={s.emptySubtitle}>
            Type to search through all messages in this chat
          </Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="document-text-outline" size={64} color="#1a2a40" />
          <Text style={s.emptyTitle}>No Results</Text>
          <Text style={s.emptySubtitle}>
            No messages match "{query}"
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={i => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  backBtn: { marginRight: 12 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D1B2A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: {
    flex: 1,
    color: '#fff',
    fontSize: 15,
    padding: 0,
  },
  badgeRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  badge: {
    backgroundColor: C.accent + '22',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: {
    color: C.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  loadingText: {
    color: '#556',
    marginTop: 12,
    fontSize: 14,
  },
  emptyTitle: {
    color: '#8899AA',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtitle: {
    color: '#556',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  resultCard: {
    backgroundColor: '#0A1628',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  senderName: {
    color: C.cyan,
    fontSize: 13,
    fontWeight: '600',
  },
  timestamp: {
    color: '#556',
    fontSize: 11,
  },
  msgText: {
    color: '#AAB',
    fontSize: 14,
    lineHeight: 20,
  },
  highlight: {
    color: '#fff',
    backgroundColor: C.accent + '44',
    fontWeight: '700',
  },
});
