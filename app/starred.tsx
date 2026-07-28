// app/starred.tsx — Starred / Saved Messages (Postgres-backed).
//
// "Star" and "Bookmark" are the same primitive here: both persist a pointer
// to a message via /user/bookmarks. This screen lists every starred message
// across all chats and lets you un-star (remove the bookmark). Replaces the
// old Firebase-legacy implementation; backend is already deployed.

import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { listBookmarks, removeBookmark, type BookmarkRow } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { readCache, writeCache } from '../lib/localCache';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function StarredScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [items, setItems] = useState<BookmarkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meId, setMeId] = useState<string>('');

  React.useEffect(() => { getCurrentUserAsync().then(u => setMeId(u?.id ?? '')); }, []);

  const load = useCallback(async () => {
    // Local-first: paint cached starred messages instantly, then fetch fresh.
    const cached = await readCache<BookmarkRow[]>('starred');
    if (cached) { setItems(cached); setLoading(false); }
    try {
      const rows = await listBookmarks();
      setItems(rows);
      writeCache('starred', rows);
      setError(null);
    } catch (e: any) {
      // Keep cached items for offline read; only surface if nothing painted.
      if (!cached) setError(e?.message ?? 'Failed to load starred messages');
    }
  }, []);

  // Reload on focus so a newly-starred message appears when returning here.
  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    load().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Optimistic un-star with rollback on failure.
  const unstar = useCallback(async (item: BookmarkRow) => {
    const prev = items;
    const next = items.filter(b => b.id !== item.id);
    setItems(next);
    writeCache('starred', next); // keep instant-paint cache consistent
    try {
      await removeBookmark(item.id);
    } catch (e: any) {
      setItems(prev);
      writeCache('starred', prev);
      setError(e?.message ?? 'Failed to remove');
    }
  }, [items]);

  const fmt = (iso: string) => {
    try { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return ''; }
  };

  const openChat = (chatId: string) => router.push({ pathname: '/chat', params: { id: chatId } } as any);

  const renderItem = ({ item }: { item: BookmarkRow }) => {
    const m = item.message;
    const chatName = m?.chatName || (m?.chatType === 'group' ? 'Group chat' : 'Direct chat');
    const deleted = !m || !!m.deletedAt;
    // Sender (WhatsApp shows this): "You" for your own, else the sender's name
    // (from backend), falling back to the peer name for a direct chat.
    const sender = !m ? '' : (m.senderId === meId ? 'You'
      : (m.senderName || (m.chatType === 'direct' ? m.chatName : null) || 'Unknown'));
    // For groups the chat differs from the sender, so show "in <group>".
    const meta = m && m.chatType === 'group' ? `in ${chatName} · ${fmt(item.createdAt)}` : fmt(item.createdAt);
    const body = deleted
      ? 'Original message was deleted'
      : (m?.content && m.content.trim().length
        ? m.content
        : `[${m?.type ?? 'message'}]`);
    return (
      <TouchableOpacity
        style={s.item}
        activeOpacity={0.7}
        disabled={deleted}
        onPress={() => m && openChat(m.chatId)}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.chatName} numberOfLines={1}>{sender}</Text>
          <Text style={s.meta}>{meta}</Text>
          <Text style={[s.msg, deleted && s.msgDeleted]} numberOfLines={3}>{body}</Text>
          {!!item.note && <Text style={s.note} numberOfLines={2}>📝 {item.note}</Text>}
        </View>
        <TouchableOpacity onPress={() => unstar(item)} style={s.unstarBtn} hitSlop={8}>
          <Ionicons name="star" size={22} color={colors.primary} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.title}>Starred Messages</Text>
        </View>

        {error && <View style={s.errorBar}><Text style={s.errorTxt}>{error}</Text></View>}

        {loading ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} size="large" /></View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={i => i.id}
            renderItem={renderItem}
            contentContainerStyle={items.length === 0 ? { flex: 1 } : { paddingBottom: 40 }}
            refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
            ListEmptyComponent={
              <View style={s.center}>
                <Ionicons name="star-outline" size={64} color={colors.surfaceSolid} />
                <Text style={s.emptyTitle}>No starred messages</Text>
                <Text style={s.emptyTxt}>Long-press a message → Star to save it here.</Text>
              </View>
            }
          />
        )}
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 54, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: {},
  title: { color: c.text, fontSize: 20, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  errorBar: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, padding: 10, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12 },
  item: { flexDirection: 'row', alignItems: 'flex-start', padding: 14, gap: 10, borderBottomWidth: 0.5, borderBottomColor: c.separator },
  chatName: { color: c.accent, fontSize: 13, fontWeight: '700', marginBottom: 2 },
  meta: { color: c.textFaint, fontSize: 11, marginBottom: 4 },
  msg: { color: c.text, fontSize: 14, lineHeight: 20 },
  msgDeleted: { color: c.textFaint, fontStyle: 'italic' },
  note: { color: c.textDim, fontSize: 12, marginTop: 6 },
  unstarBtn: { padding: 6 },
  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '600', marginTop: 16 },
  emptyTxt: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 22, marginTop: 8 },
});
