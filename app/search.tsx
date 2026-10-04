// app/search.tsx — global search (WhatsApp-style). Filters chats by name AND
// searches message CONTENT across all chats, entirely on-device against the
// local plaintext cache (zero-knowledge — the server never sees the query).
// Messages in locked and hidden (PIN-gated) chats are not searched, and
// view-once / Invisible Ink messages are never hits (lib/localDb.searchAllMessages).
// A message hit is shown only when its chat is in the list this screen loaded
// (the server's non-hidden list, or offline the cached visible rows), so a hit
// can never open a chat around the Hidden-chats PIN.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, SectionList, StyleSheet, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Avatar, AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { attachmentUrl, listChats, chatTitle as chatDisplayName, type ChatSummary } from '../lib/chatService';
import { searchAllMessages, getCachedVisibleChats } from '../lib/localDb';
import { setPendingJump } from '../lib/chatJump';
import { searchSnippet } from '../lib/searchSnippet';
import { lockedChatIds } from '../lib/lockedChats';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

// Aliased: this screen already has a local `chatTitle` (a Map of id -> chat).
const titleOf = chatDisplayName;

type MsgHit = { chatId: string; id: number; content: string; senderId: string | null; createdAt: string };
type Section =
  | { title: string; kind: 'chat'; data: ChatSummary[] }
  | { title: string; kind: 'msg'; data: MsgHit[] };

export default function SearchScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // The hits AND the query that produced them. The input runs ~220 ms ahead
  // of the debounced search, so highlighting against the live query could
  // miss the match in a hit that is still on screen from the previous query.
  const [found, setFound] = useState<{ q: string; hits: MsgHit[] }>({ q: '', hits: [] });
  const msgs = found.hits;
  const [loading, setLoading] = useState(true);
  // listChats failed: chat names below come from the device cache.
  const [chatsOffline, setChatsOffline] = useState(false);
  // The on-device message search threw: "Nothing found" would be a lie.
  const [msgError, setMsgError] = useState(false);
  // The lock table could not be read: no chat's messages are searched (fail closed).
  const [locksUnreadable, setLocksUnreadable] = useState(false);
  // Bumped by the failure notice's retry, which re-runs the search below.
  const [retry, setRetry] = useState(0);
  const authHeader = useAuthHeader();
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const list = await listChats();
        if (cancel) return;
        setChats(list);
      } catch {
        // Offline: chat names still come from the device cache, as on the Chats tab.
        if (!cancel) setChatsOffline(true);
        const cached = await getCachedVisibleChats().catch(() => []);
        if (!cancel) setChats((cached ?? []) as ChatSummary[]);
      }
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, []);

  // Debounced on-device message-content search.
  useEffect(() => {
    clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) { setFound({ q: '', hits: [] }); setMsgError(false); setLocksUnreadable(false); return; }
    // `stale` stops an older, slower search from overwriting a newer query's hits.
    let stale = false;
    debounce.current = setTimeout(() => {
      (async () => {
        // Re-read per search: a chat locked a moment ago is skipped at once.
        const locked = await lockedChatIds();
        if (stale) return;
        setLocksUnreadable(locked === null);
        const hits = locked === null ? [] : await searchAllMessages(q, 50, locked);
        if (!stale) { setFound({ q, hits }); setMsgError(false); }
      })().catch(() => { if (!stale) { setFound({ q, hits: [] }); setMsgError(true); } });
    }, 220);
    return () => { stale = true; clearTimeout(debounce.current); };
  }, [query, retry]);

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

  // Only hits whose chat is in the loaded list: a hidden chat (or one this
  // device cannot name) is never shown or opened from here.
  const listedMsgs = useMemo(() => msgs.filter(h => chatTitle.has(h.chatId)), [msgs, chatTitle]);

  const sections = useMemo(() => {
    const out: Section[] = [];
    if (filteredChats.length) out.push({ title: 'Chats', kind: 'chat', data: filteredChats });
    if (listedMsgs.length) out.push({ title: 'Messages', kind: 'msg', data: listedMsgs });
    return out;
  }, [filteredChats, listedMsgs]);

  const openChat = (id: string, jumpTo?: number) => {
    if (jumpTo) setPendingJump(id, jumpTo);   // chat.tsx consumes this on focus → scrolls to the message
    router.push({ pathname: '/chat', params: { id } });
  };

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" hitSlop={10} style={S.backBtn} activeOpacity={0.7}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <TextInput
          accessibilityLabel="Search chats and messages"
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

      {chatsOffline && !loading && (
        <View style={S.notice} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle-outline" size={16} color={colors.textDim} />
          <Text style={S.noticeTxt}>Offline: chat names are from this device.</Text>
        </View>
      )}
      {locksUnreadable && !loading && !!query.trim() && (
        <TouchableOpacity style={S.notice} onPress={() => setRetry(n => n + 1)} accessibilityLiveRegion="polite"
          accessibilityRole="button" accessibilityLabel="Couldn't read your chat locks, so messages aren't searched. Tap to try again">
          <Ionicons name="lock-closed-outline" size={16} color={colors.textDim} />
          <Text style={S.noticeTxt}>Couldn’t read your chat locks, so messages aren’t searched. Chat names still are. Tap to try again.</Text>
        </TouchableOpacity>
      )}
      {msgError && !loading && (
        <TouchableOpacity style={S.notice} onPress={() => setRetry(n => n + 1)} accessibilityLiveRegion="polite"
          accessibilityRole="button" accessibilityLabel="Couldn't search messages. Tap to try again">
          <Ionicons name="refresh" size={16} color={colors.textDim} />
          <Text style={S.noticeTxt}>Couldn’t search messages. Tap to try again.</Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
      ) : sections.length === 0 ? (
        <View style={S.empty}>
          <Text style={S.emptyTitle}>{!query.trim() ? 'Search your chats' : msgError || locksUnreadable ? 'No chats match' : 'Nothing found'}</Text>
          {!!query.trim() && !msgError && !locksUnreadable && <Text style={S.emptySub}>Try a different name or word. Messages in locked and hidden chats aren’t searched.</Text>}
        </View>
      ) : (
        <SectionList<ChatSummary | MsgHit, Section>
          sections={sections}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          keyExtractor={(item, i) => ('chatId' in item ? `m:${item.chatId}:${item.id}` : `c:${item.id}`) + ':' + i}
          contentContainerStyle={{ paddingBottom: SCREEN_BOTTOM + 16 }}
          renderSectionHeader={({ section }) => <Text numberOfLines={1} style={S.sectionLabel} accessibilityRole="header">{section.title.toUpperCase()}</Text>}
          renderItem={({ item, section }) => {
            if (section.kind === 'chat') {
              const c = item as ChatSummary;
              const photoId = c.type === 'direct' ? c.peerPhotoURL : c.photoURL;
              return (
                <TouchableOpacity style={S.row} onPress={() => openChat(c.id)} activeOpacity={0.7}
                  accessibilityRole="button" accessibilityLabel={`${titleOf(c)}, ${c.type === 'group' ? 'group' : 'direct chat'}${c.unreadCount > 0 ? `, ${c.unreadCount} unread` : ''}`}>
                  <Avatar uri={photoId && authHeader ? attachmentUrl(photoId) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={titleOf(c)} size={44} presence={c.type === 'direct' && c.peerOnline ? 'online' : null} ring />
                  <View style={{ flex: 1 }}>
                    <Text style={S.rowTitle} numberOfLines={1}>{titleOf(c)}</Text>
                    <Text style={S.rowSub}>{c.type === 'group' ? 'Group' : 'Direct'}{c.unreadCount > 0 ? ` · ${c.unreadCount} unread` : ''}</Text>
                  </View>
                </TouchableOpacity>
              );
            }
            const h = item as MsgHit;
            const c = chatTitle.get(h.chatId);
            const snip = searchSnippet(h.content ?? '', found.q);
            const photoId = c?.type === 'direct' ? c?.peerPhotoURL : c?.photoURL;
            return (
              <TouchableOpacity style={S.row} onPress={() => openChat(h.chatId, h.id)} activeOpacity={0.7}
                accessibilityRole="button" accessibilityLabel={`Message in ${c ? titleOf(c) : 'chat'}: ${h.content ?? ''}`}>
                <Avatar uri={photoId && authHeader ? attachmentUrl(photoId) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={c ? titleOf(c) : 'Chat'} size={44} ring />
                <View style={{ flex: 1 }}>
                  <Text style={S.rowTitle} numberOfLines={1}>{c ? titleOf(c) : 'Chat'}</Text>
                  <Text style={S.rowSub} numberOfLines={1}>
                    {snip.before}<Text style={S.hit}>{snip.match}</Text>{snip.after}
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:    { width: 44, height: 44, borderRadius: 16, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  input:      { flex: 1, minWidth: 0, minHeight: 48, color: c.text, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, fontSize: 16 },
  empty:      { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  emptySub:   { color: c.textDim, fontSize: 13, marginTop: 6, textAlign: 'center' },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4, backgroundColor: c.bg },
  row:        { flexDirection: 'row', gap: 12, alignItems: 'center', marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 20, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  rowTitle:   { color: c.text, fontSize: 16, fontWeight: '600' },
  rowSub:     { color: c.textDim, fontSize: 13, lineHeight: 19, marginTop: 4 },
  hit:        { color: c.text, fontWeight: '800' },
  notice:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 12, paddingVertical: 8, minHeight: 44, borderRadius: 12, backgroundColor: c.glassSoft },
  noticeTxt:  { flex: 1, color: c.textDim, fontSize: 12.5, lineHeight: 17 },
});
