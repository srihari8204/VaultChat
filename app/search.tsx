// app/search.tsx — Day 13 global search.
//
// Talks to GET /chats/search?q=…  → { chats, messages }
// Two sections: matching chats (by name / peer name / peer email),
// then matching messages (newest first, 240-char snippet).
//
// Phase-3a server-side search works on plaintext content. When real E2EE
// ships, server-side message search will be dropped; only chat / member
// hits will remain (and an offline client-side index becomes Phase 3b
// scope).

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { getAccessToken } from '../lib/api';
import {
  attachmentUrl,
  searchAll,
  type SearchChatHit,
  type SearchMessageHit,
  type SearchResults,
} from '../lib/chatService';

export default function SearchScreen() {
  const router = useRouter();
  const [query,   setQuery]   = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResults>({ chats: [], messages: [] });
  const [error,   setError]   = useState<string | null>(null);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const tok = await getAccessToken();
      if (!cancel) setAuthHeader(tok ? `Bearer ${tok}` : null);
    })();
    return () => { cancel = true; };
  }, []);

  const onChange = useCallback((text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) {
      setResults({ chats: [], messages: [] });
      setLoading(false);
      setError(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchAll(text.trim());
        setResults(r);
        setError(null);
      } catch (e: any) {
        setError(e?.message ?? 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 250);
  }, []);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const openChat = useCallback((chatId: string) => {
    router.push({ pathname: '/chat', params: { id: chatId } } as any);
  }, [router]);

  const hasAny = results.chats.length + results.messages.length > 0;

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn} activeOpacity={0.7}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <TextInput
          style={S.input}
          placeholder="Search chats and messages…"
          placeholderTextColor={SUBTLE}
          value={query}
          onChangeText={onChange}
          autoFocus
          returnKeyType="search"
          maxLength={200}
        />
      </View>

      {loading && <ActivityIndicator color={ACCENT} style={{ marginVertical: 12 }} />}
      {error && <Text style={S.errorTxt}>{error}</Text>}

      {!loading && query.length >= 2 && !hasAny && (
        <View style={S.empty}>
          <Text style={S.emptyTitle}>No results</Text>
          <Text style={S.emptySub}>Try a different word or check spelling.</Text>
        </View>
      )}

      <FlatList
        data={[
          ...results.chats.map(c => ({ kind: 'chat' as const, item: c })),
          ...results.messages.map(m => ({ kind: 'msg'  as const, item: m })),
        ]}
        keyExtractor={(row, idx) => row.kind === 'chat' ? `c:${row.item.id}` : `m:${row.item.id}:${idx}`}
        contentContainerStyle={{ paddingBottom: 40 }}
        renderItem={({ item }) => item.kind === 'chat'
          ? <ChatHitRow chat={item.item} authHeader={authHeader} onPress={() => openChat(item.item.id)} />
          : <MessageHitRow msg={item.item}  onPress={() => openChat(item.item.chatId)} />}
        ListHeaderComponent={hasAny ? () => (
          <View style={S.sectionLabelWrap}>
            <Text style={S.sectionLabel}>RESULTS</Text>
          </View>
        ) : null}
      />
    </View>
  );
}

function ChatHitRow({
  chat, authHeader, onPress,
}: {
  chat:        SearchChatHit;
  authHeader:  string | null;
  onPress:     () => void;
}) {
  const letter = (chat.name?.trim()[0] ?? '#').toUpperCase();
  return (
    <TouchableOpacity style={S.row} onPress={onPress} activeOpacity={0.7}>
      <View style={[S.avatar, chat.type === 'group' && S.avatarGroup]}>
        {chat.photoURL && authHeader ? (
          <Image
            source={{ uri: attachmentUrl(chat.photoURL), headers: { Authorization: authHeader } }}
            style={S.avatarImg}
          />
        ) : (
          <Text style={S.avatarTxt}>{letter}</Text>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={S.rowTitle} numberOfLines={1}>{chat.name || (chat.type === 'group' ? 'Group' : 'Direct chat')}</Text>
        <Text style={S.rowSub}>{chat.type === 'group' ? 'Group' : 'Direct'}</Text>
      </View>
    </TouchableOpacity>
  );
}

function MessageHitRow({ msg, onPress }: { msg: SearchMessageHit; onPress: () => void }) {
  return (
    <TouchableOpacity style={S.row} onPress={onPress} activeOpacity={0.7}>
      <View style={S.msgIcon}><Text style={S.msgIconTxt}>💬</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={S.rowTitle} numberOfLines={1}>{msg.chatName || (msg.chatType === 'group' ? 'Group' : 'Direct chat')}</Text>
        <Text style={S.rowSub} numberOfLines={2}>{msg.snippet}</Text>
      </View>
    </TouchableOpacity>
  );
}

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: DARK_BG },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: TEXT, fontSize: 26, fontWeight: '600' },
  input:         { flex: 1, color: TEXT, backgroundColor: CARD_BG, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  errorTxt:      { color: DANGER, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  empty:         { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyTitle:    { color: TEXT, fontSize: 16, fontWeight: '700' },
  emptySub:      { color: SUBTLE, fontSize: 13, marginTop: 6, textAlign: 'center' },

  sectionLabelWrap: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  sectionLabel:     { color: SUBTLE, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },

  row:           { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  avatar:        { width: 44, height: 44, borderRadius: 22, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarGroup:   { backgroundColor: '#22C55E' },
  avatarImg:     { width: '100%', height: '100%' },
  avatarTxt:     { color: '#fff', fontWeight: '700', fontSize: 17 },
  msgIcon:       { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' },
  msgIconTxt:    { fontSize: 18 },
  rowTitle:      { color: TEXT, fontSize: 15, fontWeight: '600' },
  rowSub:        { color: SUBTLE, fontSize: 12, marginTop: 2, lineHeight: 16 },
});
