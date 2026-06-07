// app/in-chat-search.tsx — In-Chat Message Search (Postgres-backed).
//
// Searches the text messages of a single chat via GET
// /chats/:id/messages/search (server-side ILIKE, membership-scoped).
// Debounced query, highlighted matches, Obsidian Aurora styling.
//
// NOTE: tapping a result returns to the chat. Scroll-to-message requires
// pagination-aware loading in app/chat.tsx (the history is keyset-paginated,
// so an old match may not be in memory) — tracked as a follow-up rather than
// faked here.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  FlatList, StatusBar, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import { searchInChat, type InChatMessageHit } from '../lib/chatService';

export default function InChatSearchScreen() {
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const inputRef = useRef<TextInput>(null);
  const debounce = useRef<any>(null);
  const reqSeq = useRef(0);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InChatMessageHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced server search. A monotonically increasing reqSeq guards
  // against out-of-order responses overwriting a newer query's results.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const term = query.trim();
    if (!chatId || !term) { setResults([]); setLoading(false); setError(null); return; }
    setLoading(true);
    debounce.current = setTimeout(async () => {
      const seq = ++reqSeq.current;
      try {
        const hits = await searchInChat(chatId, term, 80);
        if (seq === reqSeq.current) { setResults(hits); setError(null); }
      } catch (e: any) {
        if (seq === reqSeq.current) { setError(e?.message ?? 'Search failed'); setResults([]); }
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, chatId]);

  // Auto-focus the input on entry.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  const formatTime = useCallback((iso: string) => {
    try {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      const days = Math.floor(diff / 86400000);
      if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (days === 1) return 'Yesterday';
      if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }, []);

  const highlightMatch = (text: string, q: string) => {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) return <Text style={s.msgText} numberOfLines={2}>{text}</Text>;
    const match = text.substring(idx, idx + q.length);
    // Trim context: up to 40 chars before, 60 after, with ellipses.
    const startCtx = Math.max(0, idx - 40);
    const endCtx = Math.min(text.length, idx + q.length + 60);
    const prefix = startCtx > 0 ? '…' : '';
    const suffix = endCtx < text.length ? '…' : '';
    return (
      <Text style={s.msgText} numberOfLines={2}>
        {prefix}{text.substring(startCtx, idx)}
        <Text style={s.highlight}>{match}</Text>
        {text.substring(idx + q.length, endCtx)}{suffix}
      </Text>
    );
  };

  const onTapResult = () => {
    // Return to the chat. (Scroll-to-message is a tracked follow-up.)
    router.back();
  };

  const renderItem = ({ item }: { item: InChatMessageHit }) => (
    <TouchableOpacity style={s.resultCard} activeOpacity={0.7} onPress={onTapResult}>
      <View style={s.resultHeader}>
        <Text style={s.senderName} numberOfLines={1}>{item.senderName || 'Unknown'}</Text>
        <Text style={s.timestamp}>{formatTime(item.createdAt)}</Text>
      </View>
      {highlightMatch(item.content, query.trim())}
    </TouchableOpacity>
  );

  const hasQuery = query.trim().length > 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={Aurora.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={Aurora.text} />
        </TouchableOpacity>

        <View style={s.searchBox}>
          <Ionicons name="search" size={18} color={Aurora.textDim} style={{ marginRight: 8 }} />
          <TextInput
            ref={inputRef}
            style={s.searchInput}
            placeholder="Search messages…"
            placeholderTextColor={Aurora.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={Aurora.textDim} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {hasQuery && !loading && !error && (
        <View style={s.badgeRow}>
          <View style={s.badge}>
            <Text style={s.badgeText}>
              {results.length} result{results.length !== 1 ? 's' : ''}
            </Text>
          </View>
        </View>
      )}

      {error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={56} color={Aurora.danger} />
          <Text style={s.emptyTitle}>Couldn’t search</Text>
          <Text style={s.emptySubtitle}>{error}</Text>
        </View>
      ) : loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={Aurora.primary} />
          <Text style={s.loadingText}>Searching…</Text>
        </View>
      ) : !hasQuery ? (
        <View style={s.center}>
          <Ionicons name="search-outline" size={64} color={Aurora.surfaceSolid} />
          <Text style={s.emptyTitle}>Search Messages</Text>
          <Text style={s.emptySubtitle}>Type to search the text messages in this chat.</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="document-text-outline" size={64} color={Aurora.surfaceSolid} />
          <Text style={s.emptyTitle}>No Results</Text>
          <Text style={s.emptySubtitle}>No messages match “{query.trim()}”.</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={i => String(i.id)}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Aurora.bg },
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
    backgroundColor: Aurora.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Aurora.border,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: { flex: 1, color: Aurora.text, fontSize: 15, padding: 0 },
  badgeRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8 },
  badge: {
    backgroundColor: 'rgba(16,185,129,0.13)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: { color: Aurora.primary, fontSize: 13, fontWeight: '600' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { color: Aurora.textDim, marginTop: 12, fontSize: 14 },
  emptyTitle: { color: Aurora.text, fontSize: 18, fontWeight: '600', marginTop: 16 },
  emptySubtitle: {
    color: Aurora.textDim,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  resultCard: {
    backgroundColor: Aurora.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Aurora.border,
    padding: 14,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  senderName: { color: Aurora.accent, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  timestamp: { color: Aurora.textFaint, fontSize: 11 },
  msgText: { color: Aurora.textDim, fontSize: 14, lineHeight: 20 },
  highlight: { color: Aurora.text, backgroundColor: 'rgba(16,185,129,0.28)', fontWeight: '700' },
});
