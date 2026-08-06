// components/chat/SplitChatPane.tsx
// One half of the split view: a self-contained conversation with its own
// header, history and composer, reading and writing through the same message
// store the full chat screen uses.
//
// This is deliberately a focused pane rather than the whole chat screen — the
// full screen reads its id from route params and carries a great deal of
// per-screen state, so mounting it twice would fight itself. Anything the pane
// does not handle is one tap away via "Open full".

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { BRAND_ACCENT } from '../../constants/theme';
import { getMessages, hydrateMessages, sendMessage, type Message } from '../../lib/chatService';
import { getCachedMessages, cacheMessages } from '../../lib/localDb';
import { getCurrentUserAsync } from '../../app/(constants)/authService';

const PAGE = 30;

const C = {
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.58)',
  faint: 'rgba(255,255,255,0.32)',
  line: 'rgba(255,255,255,0.09)',
  accent: BRAND_ACCENT,
  accentSoft: 'rgba(124,77,255,0.16)',
  accentLine: 'rgba(124,77,255,0.42)',
  panel: 'rgba(255,255,255,0.05)',
  inBubble: 'rgba(255,255,255,0.07)',
};

interface Props {
  chatId: string;
  title: string;
  /** e.g. "50%" — shown in the pane header so the split ratio is legible. */
  share: string;
}

export default function SplitChatPane({ chatId, title, share }: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Identity comes from the local session, so bubble alignment is correct
      // even with no network — the same source the full chat screen uses.
      const me = await getCurrentUserAsync().catch(() => null);
      if (!cancelled) setMeId(me?.id ?? null);
      // Show cached history immediately, then refresh from the server.
      try {
        const cached = await getCachedMessages(chatId, PAGE);
        if (!cancelled && cached.length) setMessages(cached);
      } catch {
        /* cache miss is fine */
      }
      try {
        const fresh = await hydrateMessages(chatId, await getMessages(chatId, { limit: PAGE }));
        if (!cancelled) {
          setMessages(fresh);
          cacheMessages(chatId, fresh).catch(() => {});
        }
      } catch {
        /* offline: the cached view above still stands */
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft('');
    try {
      const sent = await sendMessage(chatId, body, 'text');
      if (alive.current && sent) {
        setMessages((prev) => [sent, ...prev]);
      }
    } catch {
      // Put the text back so nothing is silently lost.
      if (alive.current) setDraft(body);
    } finally {
      if (alive.current) setSending(false);
    }
  }, [chatId, draft, sending]);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => {
      const mine = meId != null && item.senderId === meId;
      const text =
        item.deletedAt != null
          ? 'This message was deleted'
          : item.type === 'text'
            ? (item.content ?? '')
            : `[${item.type}]`;
      return (
        <View style={[s.bubbleRow, mine ? s.rowOut : s.rowIn]}>
          <View style={[s.bubble, mine ? s.out : s.in, item.deletedAt != null && s.deleted]}>
            <Text style={[s.bubbleText, mine && s.outText]} numberOfLines={12}>
              {text}
            </Text>
          </View>
        </View>
      );
    },
    [meId]
  );

  return (
    <View style={s.pane}>
      <View style={s.header}>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={s.shareChip}>
          <Text style={s.shareText}>{share}</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push({ pathname: '/chat', params: { id: chatId } } as any)}
          style={s.headerBtn}
          activeOpacity={0.8}
          accessibilityLabel={`Open ${title} full screen`}
        >
          <Ionicons name="open-outline" size={17} color={C.dim} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : messages.length === 0 ? (
        <View style={s.center}>
          <Text style={s.emptyText}>No messages yet</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderItem}
          inverted
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      <View style={s.composer}>
        <TextInput
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={`Message ${title}`}
          placeholderTextColor={C.faint}
          multiline
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <TouchableOpacity
          onPress={send}
          disabled={!draft.trim() || sending}
          style={[s.send, (!draft.trim() || sending) && s.sendOff]}
          activeOpacity={0.85}
          accessibilityLabel="Send"
        >
          <Ionicons name="send" size={16} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  pane: { flex: 1, overflow: 'hidden' },

  header: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  title: { color: C.text, fontSize: 14.5, fontWeight: '700', flexShrink: 1 },
  shareChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accentLine,
  },
  shareText: { color: C.accent, fontSize: 10.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headerBtn: { marginLeft: 'auto', width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: C.faint, fontSize: 13 },

  listContent: { paddingHorizontal: 10, paddingVertical: 8 },
  bubbleRow: { flexDirection: 'row', marginBottom: 6 },
  rowIn: { justifyContent: 'flex-start' },
  rowOut: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '84%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  in: { backgroundColor: C.inBubble, borderBottomLeftRadius: 6 },
  out: { backgroundColor: C.accent, borderBottomRightRadius: 6 },
  deleted: { opacity: 0.5 },
  bubbleText: { color: C.text, fontSize: 14, lineHeight: 19 },
  outText: { color: '#FFFFFF' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 88,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    borderRadius: 19,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.line,
    color: C.text,
    fontSize: 14.5,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.accent,
  },
  sendOff: { opacity: 0.4 },
});
