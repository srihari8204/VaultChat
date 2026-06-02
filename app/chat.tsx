// app/chat.tsx — Phase 3a message thread (Postgres + Socket.IO).
//
// Loads:
//   GET /chats/:id           — chat metadata + members (for sender names)
//   GET /chats/:id/messages  — newest 50, keyset paginate older on scroll-up
//
// Live:
//   socket `new_message`     — append if for this chat, scroll to bottom
//   socket `message_edited`  — patch existing message in-list
//   socket `message_deleted` — mark as deleted in-list
//
// Send:
//   POST /chats/:id/messages — content is currently plaintext; Phase 3b
//   wraps with E2EE in lib/chatService.ts (sendMessage already calls the
//   encryptForChat seam).
//
// Read receipts:
//   POST /chats/:id/read with the latest visible message id, debounced.

import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { getCurrentUserAsync } from './(constants)/authService';
import { getAccessToken } from '../lib/api';
import {
  attachmentUrl,
  decryptFromChat,
  deleteMessage,
  editMessage,
  getChat,
  getMessages,
  markDelivered,
  markRead,
  sendMessage,
  uploadAttachment,
  type ChatDetail,
  type ChatMember,
  type Message,
} from '../lib/chatService';
import {
  cancel as queueCancel,
  enqueueText,
  initQueue,
  on as onQueue,
  pendingForChat,
  retry as queueRetry,
} from '../lib/messageQueue';
import {
  emitTypingStart,
  emitTypingStop,
  getSocket,
  joinChatRoom,
  leaveChatRoom,
} from '../lib/socket';

// Optimistic bubbles carry a few extra fields beyond a server Message.
type DisplayMessage = Message & {
  _tempId?: string;
  _state?: 'pending' | 'failed';
  _error?: string;
};

const TYPING_IDLE_MS = 2500;

const PAGE_SIZE = 50;

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const chatId = (id ?? '') as string;

  const [meId,      setMeId]      = useState<string | null>(null);
  const [chat,      setChat]      = useState<ChatDetail | null>(null);
  const [messages,  setMessages]  = useState<DisplayMessage[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore,   setHasMore]   = useState(true);
  const [input,     setInput]     = useState('');
  const [sending,   setSending]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [typingUids, setTypingUids] = useState<Set<string>>(new Set());

  const listRef = useRef<FlatList>(null);
  const readDebounce = useRef<any>(null);
  const lastReadSent = useRef<number>(0);
  const typingIdleTimer = useRef<any>(null);
  const typingActiveRef = useRef(false);

  const membersById = useMemo(() => {
    const m = new Map<string, ChatMember>();
    chat?.members.forEach(x => m.set(x.userId, x));
    return m;
  }, [chat]);

  // Members of this chat that aren't me — used to compute outgoing-message
  // tick state (any → delivered / any → read, MVP semantics).
  const otherMembers = useMemo(
    () => chat?.members.filter(m => m.userId !== meId) ?? [],
    [chat, meId],
  );

  // ── Initial load ──────────────────────────────────────────
  useEffect(() => {
    if (!chatId) return;
    (async () => {
      try {
        setLoading(true);
        // Start the queue subsystem once (safe to call repeatedly).
        initQueue();

        const [me, c, msgs, pendingQ] = await Promise.all([
          getCurrentUserAsync(),
          getChat(chatId),
          getMessages(chatId, { limit: PAGE_SIZE }),
          pendingForChat(chatId),
        ]);
        setMeId(me?.id ?? null);
        setChat(c);

        // Prepend any locally-queued messages as optimistic bubbles so
        // they show up immediately after a cold start where the network
        // is still flaky.
        const pendingBubbles: DisplayMessage[] = pendingQ.map(q => ({
          id:        0,
          chatId:    q.chatId,
          senderId:  me?.id ?? '',
          type:      q.type,
          content:   q.plaintext,
          meta:      null,
          replyToId: q.replyToId,
          editedAt:  null,
          deletedAt: null,
          createdAt: new Date(q.createdAt).toISOString(),
          _tempId:   q.tempId,
          _state:    q.attempts >= 1 ? 'pending' : 'pending',
        }));

        // Inverted list: newest first. Pendings are newest (just sent).
        setMessages([...pendingBubbles.reverse(), ...msgs]);
        setHasMore(msgs.length === PAGE_SIZE);
        setError(null);
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load chat');
      } finally {
        setLoading(false);
      }
    })();
  }, [chatId]);

  // ── Queue events: replace pending bubble with real, or mark failed ──
  useEffect(() => {
    if (!chatId) return;
    const offSent = onQueue('sent', ({ tempId, chatId: cid, real }) => {
      if (cid !== chatId) return;
      setMessages(prev => {
        // If real already arrived via Socket.IO, just drop the temp.
        if (prev.some(x => x.id === real.id)) {
          return prev.filter(x => x._tempId !== tempId);
        }
        return prev.map(x => x._tempId === tempId
          ? ({ ...real, _tempId: undefined, _state: undefined, _error: undefined } as DisplayMessage)
          : x);
      });
    });
    const offFailed = onQueue('failed', ({ tempId, chatId: cid, error }) => {
      if (cid !== chatId) return;
      setMessages(prev => prev.map(x => x._tempId === tempId
        ? { ...x, _state: 'failed', _error: error } : x));
    });
    return () => { offSent(); offFailed(); };
  }, [chatId]);

  // ── Socket: join chat room + listen for live events ───────
  useEffect(() => {
    if (!chatId) return;
    let off: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      try {
        const s = await getSocket();
        await joinChatRoom(chatId);
        if (cancelled) return;

        const onNew = (m: Message) => {
          if (m.chatId !== chatId) return;
          setMessages(prev => {
            // Dedupe in case we already appended optimistically
            if (prev.some(x => x.id === m.id)) return prev;
            return [m, ...prev];
          });
          // Auto-acknowledge delivery as soon as the message lands on this
          // device — independent of whether the user has the chat open.
          // The sender's UI flips from "sent" to "delivered" via the
          // message_delivered broadcast that follows.
          if (m.senderId !== meId) {
            markDelivered(chatId, m.id).catch(() => {});
          }
        };
        const onMemberDelivered = (e: { userId: string; lastDeliveredMessageId: number }) => {
          if (!e?.userId) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, lastDeliveredMessageId: e.lastDeliveredMessageId }
              : mem),
          } : prev);
        };
        const onMemberRead = (e: { userId: string; lastReadMessageId: number }) => {
          if (!e?.userId) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, lastReadMessageId: e.lastReadMessageId }
              : mem),
          } : prev);
        };
        const onEdit = (e: { id: number; content: string; editedAt: string }) => {
          setMessages(prev => prev.map(x =>
            x.id === e.id ? { ...x, content: e.content, editedAt: e.editedAt } : x
          ));
        };
        const onDelete = (e: { id: number; deletedAt: string }) => {
          setMessages(prev => prev.map(x =>
            x.id === e.id ? { ...x, content: null, deletedAt: e.deletedAt, type: 'system' } : x
          ));
        };
        const onTypingStart = (e: { uid: string }) => {
          if (!e?.uid || e.uid === meId) return;
          setTypingUids(prev => {
            if (prev.has(e.uid)) return prev;
            const next = new Set(prev); next.add(e.uid); return next;
          });
        };
        const onTypingStop = (e: { uid: string }) => {
          if (!e?.uid) return;
          setTypingUids(prev => {
            if (!prev.has(e.uid)) return prev;
            const next = new Set(prev); next.delete(e.uid); return next;
          });
        };

        s.on('new_message',       onNew);
        s.on('message_edited',    onEdit);
        s.on('message_deleted',   onDelete);
        s.on('message_delivered', onMemberDelivered);
        s.on('message_read',      onMemberRead);
        s.on('typing_start',      onTypingStart);
        s.on('typing_stop',       onTypingStop);

        off.push(() => s.off('new_message',       onNew));
        off.push(() => s.off('message_edited',    onEdit));
        off.push(() => s.off('message_deleted',   onDelete));
        off.push(() => s.off('message_delivered', onMemberDelivered));
        off.push(() => s.off('message_read',      onMemberRead));
        off.push(() => s.off('typing_start',      onTypingStart));
        off.push(() => s.off('typing_stop',       onTypingStop));
      } catch (e) {
        if (!cancelled) console.warn('[chat] socket setup failed:', (e as any)?.message);
      }
    })();

    return () => {
      cancelled = true;
      off.forEach(fn => fn());
      leaveChatRoom(chatId).catch(() => {});
    };
  }, [chatId]);

  // ── Mark-as-read (debounced) ──────────────────────────────
  useEffect(() => {
    if (!chatId || messages.length === 0) return;
    const latestId = messages[0]?.id; // inverted list — index 0 is newest
    if (!latestId || latestId <= lastReadSent.current) return;
    if (readDebounce.current) clearTimeout(readDebounce.current);
    readDebounce.current = setTimeout(() => {
      lastReadSent.current = latestId;
      markRead(chatId, latestId).catch(() => {});
    }, 800);
    return () => { if (readDebounce.current) clearTimeout(readDebounce.current); };
  }, [chatId, messages]);

  // ── Typing indicator (emit start, then debounced stop) ────
  const stopTypingIfActive = useCallback(() => {
    if (typingActiveRef.current && meId) {
      emitTypingStop(chatId, meId).catch(() => {});
      typingActiveRef.current = false;
    }
  }, [chatId, meId]);

  const onInputChange = useCallback((text: string) => {
    setInput(text);
    if (!meId) return;
    if (!typingActiveRef.current && text.length > 0) {
      typingActiveRef.current = true;
      emitTypingStart(chatId, meId).catch(() => {});
    }
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(stopTypingIfActive, TYPING_IDLE_MS);
  }, [chatId, meId, stopTypingIfActive]);

  // ── Send / Edit ───────────────────────────────────────────
  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    stopTypingIfActive();
    try {
      if (editingId != null) {
        // Edits go straight to the backend (no offline-queue support yet).
        const updated = await editMessage(chatId, editingId, text);
        setMessages(prev => prev.map(x => x.id === editingId ? { ...x, ...updated } : x));
        setEditingId(null);
        setInput('');
      } else {
        // Enqueue + add optimistic bubble immediately.
        const q = await enqueueText(chatId, text);
        const optimistic: DisplayMessage = {
          id:        0,
          chatId,
          senderId:  meId ?? '',
          type:      'text',
          content:   text,
          meta:      null,
          replyToId: null,
          editedAt:  null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          _tempId:   q.tempId,
          _state:    'pending',
        };
        setMessages(prev => [optimistic, ...prev]);
        setInput('');
        // The 'sent' / 'failed' queue events update this bubble's state.
      }
    } catch (e: any) {
      Alert.alert(editingId != null ? 'Edit failed' : 'Send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [input, sending, chatId, editingId, meId, stopTypingIfActive]);

  // ── Long-press menu on a message bubble ───────────────────
  const onLongPressMessage = useCallback((msg: DisplayMessage, plain: string) => {
    const isMine = msg.senderId === meId;

    // Failed (queued) bubble: offer Retry / Cancel-and-remove.
    if (msg._state === 'failed' && msg._tempId) {
      Alert.alert(
        'Message failed',
        msg._error || 'Could not send',
        [
          { text: 'Retry', onPress: () => queueRetry(msg._tempId!) },
          { text: 'Delete', style: 'destructive', onPress: async () => {
              await queueCancel(msg._tempId!);
              setMessages(prev => prev.filter(x => x._tempId !== msg._tempId));
          }},
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    // Pending (still in queue): only allow Cancel.
    if (msg._state === 'pending' && msg._tempId) {
      Alert.alert(
        'Message sending…',
        'This message hasn\'t been confirmed by the server yet.',
        [
          { text: 'Cancel send', style: 'destructive', onPress: async () => {
              await queueCancel(msg._tempId!);
              setMessages(prev => prev.filter(x => x._tempId !== msg._tempId));
          }},
          { text: 'OK', style: 'cancel' },
        ]
      );
      return;
    }

    // Normal server-confirmed bubble: Copy / Edit / Delete.
    const buttons: any[] = [
      { text: 'Copy text', onPress: () => Clipboard.setStringAsync(plain) },
    ];
    if (isMine && !msg.deletedAt) {
      buttons.push({ text: 'Edit', onPress: () => { setEditingId(msg.id); setInput(plain); } });
      buttons.push({ text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await deleteMessage(chatId, msg.id);
          setMessages(prev => prev.map(x => x.id === msg.id
            ? { ...x, content: null, deletedAt: new Date().toISOString(), type: 'system' } : x));
        } catch (e: any) {
          Alert.alert('Delete failed', e?.message ?? 'Try again');
        }
      }});
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Message', undefined, buttons);
  }, [meId, chatId]);

  const onCancelEdit = useCallback(() => {
    setEditingId(null);
    setInput('');
  }, []);

  // ── Attach image ──────────────────────────────────────────
  const onPickImage = useCallback(async () => {
    if (sending) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to attach images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setSending(true);
    try {
      const filename = asset.fileName || `photo-${Date.now()}.jpg`;
      const mime     = asset.mimeType || 'image/jpeg';
      const up = await uploadAttachment(asset.uri, filename, mime);
      const msg = await sendMessage(chatId, '', 'image', {
        meta: { attachmentId: up.id, mime: up.mime, size: up.size, filename: up.filename,
                width: asset.width, height: asset.height },
      });
      setMessages(prev => prev.some(x => x.id === msg.id) ? prev : [msg, ...prev]);
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, sending]);

  // ── Load older on scroll-up ───────────────────────────────
  const onEndReached = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const oldest = messages[messages.length - 1]?.id;
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await getMessages(chatId, { before: oldest, limit: PAGE_SIZE });
      setMessages(prev => [...prev, ...older]);
      if (older.length < PAGE_SIZE) setHasMore(false);
    } catch {}
    finally { setLoadingOlder(false); }
  }, [chatId, hasMore, loadingOlder, messages]);

  const title = useMemo(() => {
    if (!chat) return '…';
    if (chat.name) return chat.name;
    if (chat.type === 'direct' && meId) {
      const other = chat.members.find(m => m.userId !== meId);
      return other?.name || other?.email || 'Direct chat';
    }
    return chat.type === 'group' ? 'Group' : 'Direct chat';
  }, [chat, meId]);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={ACCENT} size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={S.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      {/* Header */}
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title} numberOfLines={1}>{title}</Text>
          {chat && (
            <Text style={S.sub}>
              {chat.type === 'group' ? `${chat.members.length} members` : 'Direct chat'}
            </Text>
          )}
        </View>
      </View>

      {error && (
        <View style={S.errorBar}>
          <Text style={S.errorTxt}>{error}</Text>
        </View>
      )}

      {/* Messages (inverted — newest at top of the array, visually at bottom) */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        inverted
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 }}
        renderItem={({ item }) => (
          <MessageBubble
            msg={item}
            meId={meId}
            member={membersById.get(item.senderId)}
            chatId={chatId}
            otherMembers={otherMembers}
            onLongPress={onLongPressMessage}
          />
        )}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        ListFooterComponent={loadingOlder ? <ActivityIndicator color={ACCENT} style={{ paddingVertical: 12 }} /> : null}
      />

      {/* Typing indicator */}
      {typingUids.size > 0 && (
        <View style={S.typingBar}>
          <Text style={S.typingTxt}>
            {Array.from(typingUids).map(uid => {
              const m = membersById.get(uid);
              return m?.name || m?.email || uid.slice(0, 8);
            }).join(', ')} {typingUids.size === 1 ? 'is' : 'are'} typing…
          </Text>
        </View>
      )}

      {/* Edit-mode banner */}
      {editingId != null && (
        <View style={S.editBar}>
          <Text style={S.editTxt}>Editing message #{editingId}</Text>
          <TouchableOpacity onPress={onCancelEdit} hitSlop={8}>
            <Text style={S.editCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Composer */}
      <View style={S.composer}>
        {editingId == null && (
          <TouchableOpacity
            style={S.attachBtn}
            onPress={onPickImage}
            disabled={sending}
            activeOpacity={0.7}
          >
            <Text style={S.attachTxt}>📎</Text>
          </TouchableOpacity>
        )}
        <TextInput
          style={S.input}
          placeholder={editingId != null ? 'Edit message…' : 'Message'}
          placeholderTextColor={SUBTLE}
          value={input}
          onChangeText={onInputChange}
          multiline
          maxLength={4000}
        />
        <TouchableOpacity
          style={[S.sendBtn, (!input.trim() || sending) && S.sendBtnOff]}
          onPress={onSend}
          disabled={!input.trim() || sending}
          activeOpacity={0.85}
        >
          <Text style={S.sendTxt}>{sending ? '…' : editingId != null ? 'Save' : 'Send'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({
  msg, meId, member, chatId, otherMembers, onLongPress,
}: {
  msg: DisplayMessage;
  meId: string | null;
  member?: ChatMember;
  chatId: string;
  otherMembers: ChatMember[];
  onLongPress: (msg: DisplayMessage, plain: string) => void;
}) {
  const isMine = msg.senderId === meId;
  const [plain, setPlain] = useState<string>('');
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  // Tick state — only meaningful for own server-confirmed messages.
  // Group MVP semantic: "any other member" rather than "all members".
  // Tightening to "all" is a UX polish once we observe usage.
  let tickState: 'pending' | 'sent' | 'delivered' | 'read' | null = null;
  if (isMine && msg.id > 0 && !msg.deletedAt) {
    if (msg._state === 'pending' || msg._state === 'failed') {
      tickState = msg._state === 'pending' ? 'pending' : null;
    } else if (otherMembers.some(m => (m.lastReadMessageId ?? 0) >= msg.id)) {
      tickState = 'read';
    } else if (otherMembers.some(m => (m.lastDeliveredMessageId ?? 0) >= msg.id)) {
      tickState = 'delivered';
    } else {
      tickState = 'sent';
    }
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      const text = await decryptFromChat(chatId, msg.senderId, msg.content);
      if (!cancel) setPlain(text);
    })();
    return () => { cancel = true; };
  }, [msg.content, msg.senderId, chatId]);

  // For image bubbles, prepare the Authorization header so RN's Image can
  // fetch the auth-gated /uploads endpoint.
  useEffect(() => {
    if (msg.type !== 'image') return;
    let cancel = false;
    (async () => {
      const tok = await getAccessToken();
      if (!cancel) setAuthHeader(tok ? `Bearer ${tok}` : null);
    })();
    return () => { cancel = true; };
  }, [msg.type]);

  if (msg.deletedAt) {
    return (
      <View style={[S.bubble, S.bubbleSystem]}>
        <Text style={S.bubbleSystemTxt}>Message deleted</Text>
      </View>
    );
  }

  const isImage = msg.type === 'image' && msg.meta?.attachmentId;

  return (
    <View style={[S.bubbleRow, isMine ? S.bubbleRowMine : S.bubbleRowTheirs]}>
      <TouchableOpacity
        style={[
          S.bubble,
          isMine ? S.bubbleMine : S.bubbleTheirs,
          isImage && S.imageBubble,
          msg._state === 'pending' && S.bubblePending,
          msg._state === 'failed'  && S.bubbleFailed,
        ]}
        onPress={() => { if (msg._state === 'failed') onLongPress(msg, plain); }}
        onLongPress={() => onLongPress(msg, plain)}
        delayLongPress={250}
        activeOpacity={0.85}
      >
        {!isMine && member && (
          <Text style={S.senderTag}>{member.name || member.email || msg.senderId.slice(0, 8)}</Text>
        )}

        {isImage ? (
          authHeader ? (
            <Image
              source={{
                uri: attachmentUrl(msg.meta.attachmentId),
                headers: { Authorization: authHeader },
              }}
              style={S.attachedImage}
              resizeMode="cover"
            />
          ) : (
            <View style={S.imageError}>
              <Text style={S.imageErrorTxt}>Loading image…</Text>
            </View>
          )
        ) : (
          plain ? (
            <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine]}>{plain}</Text>
          ) : null
        )}

        <Text style={S.bubbleMeta}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {msg.editedAt ? ' · edited' : ''}
          {msg._state === 'pending' ? ' · sending…' : ''}
          {msg._state === 'failed'  ? ' · failed (tap to retry)' : ''}
          {tickState && (
            <Text style={tickState === 'read' ? S.tickRead : S.tick}>
              {' '}
              {tickState === 'pending'   ? '⏳'
                : tickState === 'sent'   ? '✓'
                : '✓✓'}
            </Text>
          )}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const DARK_BG = '#0D0F14';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: DARK_BG },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: TEXT, fontSize: 24 },
  title:         { color: TEXT, fontSize: 18, fontWeight: '700' },
  sub:           { color: SUBTLE, fontSize: 12 },

  errorBar:      { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  errorTxt:      { color: DANGER, fontSize: 12 },

  bubbleRow:     { marginVertical: 4, flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs:{ justifyContent: 'flex-start' },
  bubble:        { maxWidth: '78%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, gap: 2 },
  bubbleMine:    { backgroundColor: ACCENT, borderTopRightRadius: 4 },
  bubbleTheirs:  { backgroundColor: '#1F2937', borderTopLeftRadius: 4 },
  bubblePending: { opacity: 0.6 },
  bubbleFailed:  { borderWidth: 1, borderColor: DANGER, opacity: 0.85 },
  bubbleSystem:  { alignSelf: 'center', backgroundColor: 'transparent', paddingVertical: 4 },
  bubbleSystemTxt:{ color: SUBTLE, fontSize: 11, fontStyle: 'italic' },
  senderTag:     { color: SUBTLE, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  bubbleTxt:     { color: TEXT, fontSize: 15, lineHeight: 20 },
  bubbleTxtMine: { color: '#fff' },
  bubbleMeta:    { color: 'rgba(255,255,255,0.5)', fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },
  tick:          { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700' },
  tickRead:      { color: '#3B82F6',               fontSize: 11, fontWeight: '700' },

  typingBar:     { paddingHorizontal: 16, paddingBottom: 4 },
  typingTxt:     { color: SUBTLE, fontSize: 12, fontStyle: 'italic' },

  editBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(108,99,255,0.12)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER },
  editTxt:       { color: ACCENT, fontSize: 12, fontWeight: '600' },
  editCancelTxt: { color: SUBTLE, fontSize: 12 },

  composer:      { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER, backgroundColor: '#0F1217' },
  attachBtn:     { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' },
  attachTxt:     { fontSize: 18 },
  input:         { flex: 1, color: TEXT, backgroundColor: '#1F2937', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 15 },
  sendBtn:       { backgroundColor: ACCENT, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, justifyContent: 'center' },
  sendBtnOff:    { backgroundColor: '#374151' },
  sendTxt:       { color: '#fff', fontWeight: '700' },

  imageBubble:   { padding: 4, borderRadius: 12 },
  attachedImage: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#0F1217' },
  imageError:    { width: 180, padding: 16, alignItems: 'center', gap: 4 },
  imageErrorTxt: { color: SUBTLE, fontSize: 12 },
});
