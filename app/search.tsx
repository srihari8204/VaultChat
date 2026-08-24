// app/search.tsx — global search (WhatsApp-style). Filters chats by name AND
// searches message CONTENT across all chats, entirely on-device against the
// local plaintext cache (zero-knowledge — the server never sees the query).

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, SectionList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getAccessToken } from '../lib/api';
import { Avatar } from '../components/ui';
import { attachmentUrl, listChats, chatTitle as chatDisplayName, type ChatSummary } from '../lib/chatService';
import { searchAllMessages } from '../lib/localDb';
import { setPendingJump } from '../lib/chatJump';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

// Aliased: this screen already has a local `chatTitle` (a Map of id -> chat).
const titleOf = chatDisplayName;

type MsgHit = { chatId: string; id: number; content: string; senderId: string | null; createdAt: string };

export default function SearchScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [msgs, setMsgs] = useState<MsgHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const debounce = useRef<any>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [list, tok] = await Promise.all([listChats(), getAccessToken()]);
        if (cancel) return;
        setChats(list);
        setAuthHeader(tok ? `Bearer ${tok}` : null);
      } catch {}
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, []);

  // Debounced on-device message-content search.
  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) { setMsgs([]); return; }
    debounce.current = setTimeout(() => { searchAllMessages(q, 50).then(setMsgs).catch(() => setMsgs([])); }, 220);
    return () => clearTimeout(debounce.current);
  }, [query]);

  const chatTitle = useMemo(() => {
    const m = new Map<string, ChatSummary>();
    for (const c of chats) m.set(c.id, c);
    return m;
  }, [chats]);

  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(c => titleOf(c).toLowerCase().includes(q));
  }, [query, chats]);

  const sections = useMemo(() => {
    const out: { title: string; kind: 'chat' | 'msg'; data: any[] }[] = [];
    if (filteredChats.length) out.push({ title: 'Chats', kind: 'chat', data: filteredChats });
    if (msgs.length) out.push({ title: 'Messages', kind: 'msg', data: msgs });
    return out;
  }, [filteredChats, msgs]);

  const openChat = (id: string, jumpTo?: number) => {
    if (jumpTo) setPendingJump(id, jumpTo);   // chat.tsx consumes this on focus → scrolls to the message
    router.push({ pathname: '/chat', params: { id } } as any);
  };

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <TextInput
          style={S.input}
          placeholder="Search chats and messages…"
          placeholderTextColor={colors.textDim}
          value={query}
          onChangeText={setQuery}
          autoFocus
          returnKeyType="search"
          maxLength={120}
        />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
      ) : sections.length === 0 ? (
        <View style={S.empty}>
          <Text style={S.emptyTitle}>{query.trim() ? 'Nothing found' : 'Search your chats'}</Text>
          {!!query.trim() && <Text style={S.emptySub}>Try a different name or word.</Text>}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, i) => (item.id ?? '') + ':' + i}
          contentContainerStyle={{ paddingBottom: 40 }}
          renderSectionHeader={({ section }) => <Text style={S.sectionLabel}>{section.title.toUpperCase()}</Text>}
          renderItem={({ item, section }) => {
            if (section.kind === 'chat') {
              const c = item as ChatSummary;
              const photoId = c.type === 'direct' ? c.peerPhotoURL : c.photoURL;
              return (
                <TouchableOpacity style={S.row} onPress={() => openChat(c.id)} activeOpacity={0.7}>
                  <Avatar uri={photoId && authHeader ? attachmentUrl(photoId) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={titleOf(c)} size={44} presence={c.type === 'direct' && c.peerOnline ? 'online' : null} />
                  <View style={{ flex: 1 }}>
                    <Text style={S.rowTitle} numberOfLines={1}>{titleOf(c)}</Text>
                    <Text style={S.rowSub}>{c.type === 'group' ? 'Group' : 'Direct'}{c.unreadCount > 0 ? ` · ${c.unreadCount} unread` : ''}</Text>
                  </View>
                </TouchableOpacity>
              );
            }
            const h = item as MsgHit;
            const c = chatTitle.get(h.chatId);
            const photoId = c?.type === 'direct' ? c?.peerPhotoURL : c?.photoURL;
            return (
              <TouchableOpacity style={S.row} onPress={() => openChat(h.chatId, h.id)} activeOpacity={0.7}>
                <Avatar uri={photoId && authHeader ? attachmentUrl(photoId) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={c ? titleOf(c) : 'Chat'} size={44} />
                <View style={{ flex: 1 }}>
                  <Text style={S.rowTitle} numberOfLines={1}>{c ? titleOf(c) : 'Chat'}</Text>
                  <Text style={S.rowSub} numberOfLines={1}>{h.content}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:     { flex: 1, backgroundColor: c.bg },
  header:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn:    { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  input:      { flex: 1, color: c.text, backgroundColor: c.card, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  empty:      { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  emptySub:   { color: c.textDim, fontSize: 13, marginTop: 6, textAlign: 'center' },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4, backgroundColor: c.bg },
  row:        { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 11, paddingHorizontal: 16 },
  rowTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:     { color: c.textDim, fontSize: 12, marginTop: 2 },
});
