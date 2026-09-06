// app/in-chat-search.tsx — In-Chat Message Search (on-device, zero-knowledge).
//
// Searches the DECRYPTED local message store via searchInChat — the server only
// holds ciphertext and never sees the query or the content. Covers the chat
// history cached on this device. Debounced, highlighted, Obsidian colors.
//
// NOTE: tapping a result returns to the chat. Scroll-to-message requires
// pagination-aware loading in app/chat.tsx (the history is keyset-paginated,
// so an old match may not be in memory) — tracked as a follow-up rather than
// faked here.

import { brandAlpha } from '../constants/theme';
import React, { useState, useEffect, useRef, useCallback , useMemo} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  FlatList, StatusBar, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { searchInChat, type InChatMessageHit } from '../lib/chatService';
import { setPendingJump } from '../lib/chatJump';
import { AuroraBackground } from '../components/ui';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function InChatSearchScreen() {
  const { colors } = useTheme();
  const s = useS();
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

  const onTapResult = (messageId: number) => {
    // Hand the target to the chat screen, then return to it; it scrolls there.
    if (chatId) setPendingJump(chatId, messageId);
    router.back();
  };

  const renderItem = ({ item }: { item: InChatMessageHit }) => (
    <TouchableOpacity style={s.resultCard} activeOpacity={0.7} onPress={() => onTapResult(item.id)}>
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
      <AuroraBackground />
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>

        <View style={s.searchBox}>
          <Ionicons name="search" size={18} color={colors.textDim} style={{ marginRight: 8 }} />
          <TextInput
            ref={inputRef}
            style={s.searchInput}
            placeholder="Search messages…"
            placeholderTextColor={colors.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textDim} />
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
          <Ionicons name="alert-circle-outline" size={56} color={colors.danger} />
          <Text style={s.emptyTitle}>Couldn’t search</Text>
          <Text style={s.emptySubtitle}>{error}</Text>
        </View>
      ) : loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>Searching…</Text>
        </View>
      ) : !hasQuery ? (
        <View style={s.center}>
          <Ionicons name="search-outline" size={64} color={colors.surfaceSolid} />
          <Text style={s.emptyTitle}>Search Messages</Text>
          <Text style={s.emptySubtitle}>Searches messages saved on this device — on-device and private.</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="document-text-outline" size={64} color={colors.surfaceSolid} />
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

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
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
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.glassStroke,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 15, padding: 0 },
  badgeRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8 },
  badge: {
    backgroundColor: brandAlpha(0.13),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: { color: c.primary, fontSize: 13, fontWeight: '600' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { color: c.textDim, marginTop: 12, fontSize: 14 },
  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '600', marginTop: 16 },
  emptySubtitle: {
    color: c.textDim,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  resultCard: {
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.glassStroke,
    padding: 14,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  senderName: { color: c.accent, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  timestamp: { color: c.textFaint, fontSize: 11 },
  msgText: { color: c.textDim, fontSize: 14, lineHeight: 20 },
  highlight: { color: c.text, backgroundColor: brandAlpha(0.28), fontWeight: '700' },
});
