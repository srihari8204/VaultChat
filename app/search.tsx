// app/search.tsx — local chat search. Loads all chats once, shows them all, and
// filters client-side by title (peer/group name). No server round-trip — server
// can't search E2EE content, and chat/peer names are encrypted at rest.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getAccessToken } from '../lib/api';
import { Avatar } from '../components/ui';
import { attachmentUrl, listChats, type ChatSummary } from '../lib/chatService';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const titleOf = (c: ChatSummary) =>
  c.type === 'direct' ? (c.peerName || c.name || 'Direct chat') : (c.name || 'Group chat');

export default function SearchScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [list, tok] = await Promise.all([listChats(), getAccessToken()]);
        if (cancel) return;
        setChats(list);
        setAuthHeader(tok ? `Bearer ${tok}` : null);
      } catch { /* show empty */ }
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(c => titleOf(c).toLowerCase().includes(q));
  }, [query, chats]);

  const openChat = (id: string) => router.push({ pathname: '/chat', params: { id } } as any);

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn} activeOpacity={0.7}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <TextInput
          style={S.input}
          placeholder="Search chats…"
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
      ) : filtered.length === 0 ? (
        <View style={S.empty}>
          <Text style={S.emptyTitle}>{query.trim() ? 'No chats found' : 'No chats yet'}</Text>
          {!!query.trim() && <Text style={S.emptySub}>Try a different name.</Text>}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingBottom: 40 }}
          renderItem={({ item }) => {
            const photoId = item.type === 'direct' ? item.peerPhotoURL : item.photoURL;
            return (
              <TouchableOpacity style={S.row} onPress={() => openChat(item.id)} activeOpacity={0.7}>
                <Avatar
                  uri={photoId && authHeader ? attachmentUrl(photoId) : null}
                  headers={authHeader ? { Authorization: authHeader } : undefined}
                  name={titleOf(item)}
                  size={44}
                  presence={item.type === 'direct' && item.peerOnline ? 'online' : null}
                />
                <View style={{ flex: 1 }}>
                  <Text style={S.rowTitle} numberOfLines={1}>{titleOf(item)}</Text>
                  <Text style={S.rowSub}>
                    {item.type === 'group' ? 'Group' : 'Direct'}
                    {item.unreadCount > 0 ? ` · ${item.unreadCount} unread` : ''}
                  </Text>
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
  header:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn:    { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:    { color: c.text, fontSize: 26, fontWeight: '600' },
  input:      { flex: 1, color: c.text, backgroundColor: c.card, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  empty:      { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  emptySub:   { color: c.textDim, fontSize: 13, marginTop: 6, textAlign: 'center' },
  row:        { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  rowTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:     { color: c.textDim, fontSize: 12, marginTop: 2 },
});
