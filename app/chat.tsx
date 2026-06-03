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

import { Audio } from 'expo-av';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { getCurrentUserAsync } from './(constants)/authService';
import { getAccessToken } from '../lib/api';
import {
  addReaction,
  attachmentUrl,
  blockUser,
  decryptFromChat,
  deleteMessage,
  editMessage,
  forwardMessage,
  getChat,
  getMessages,
  getReactionCounts,
  listChats,
  markDelivered,
  markRead,
  muteChat,
  removeReaction,
  sendMessage,
  uploadAttachment,
  type ChatDetail,
  type ChatMember,
  type ChatSummary,
  type Message,
  type ReactionSummary,
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
import {
  cancel as recCancel,
  elapsedMs as recElapsed,
  isActive as recIsActive,
  start as recStart,
  stop as recStop,
} from '../lib/voiceRecorder';

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
  const [recording, setRecording] = useState(false);
  const [recElapsedMs, setRecElapsedMs] = useState(0);
  const recTimerRef = useRef<any>(null);

  // Day 13 — in-chat search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ,    setSearchQ]    = useState('');

  // Day 8 — reactions, reply, forward
  const [reactions, setReactions] = useState<Record<number, ReactionSummary[]>>({});
  const [reactPicker, setReactPicker] = useState<DisplayMessage | null>(null);
  const [replyTo, setReplyTo]         = useState<DisplayMessage | null>(null);
  const [forwardMsg, setForwardMsg]   = useState<DisplayMessage | null>(null);
  const [forwardChats, setForwardChats] = useState<ChatSummary[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);

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

        const onPresence = (e: { userId: string; online: boolean; lastSeenAt: string | null }) => {
          if (!e?.userId) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, online: e.online, lastSeenAt: e.lastSeenAt ?? mem.lastSeenAt }
              : mem),
          } : prev);
        };

        const onReactionAdded = (e: { messageId: number; userId: string; emoji: string }) => {
          if (!e?.messageId || !e?.emoji) return;
          setReactions(prev => bumpReaction(prev, e.messageId, e.emoji, +1, e.userId === meId));
        };
        const onReactionRemoved = (e: { messageId: number; userId: string; emoji: string }) => {
          if (!e?.messageId || !e?.emoji) return;
          setReactions(prev => bumpReaction(prev, e.messageId, e.emoji, -1, e.userId === meId));
        };

        s.on('new_message',       onNew);
        s.on('message_edited',    onEdit);
        s.on('message_deleted',   onDelete);
        s.on('message_delivered', onMemberDelivered);
        s.on('message_read',      onMemberRead);
        s.on('typing_start',      onTypingStart);
        s.on('typing_stop',       onTypingStop);
        s.on('reaction_added',    onReactionAdded);
        s.on('reaction_removed',  onReactionRemoved);
        s.on('presence_changed',  onPresence);

        off.push(() => s.off('new_message',       onNew));
        off.push(() => s.off('message_edited',    onEdit));
        off.push(() => s.off('message_deleted',   onDelete));
        off.push(() => s.off('message_delivered', onMemberDelivered));
        off.push(() => s.off('message_read',      onMemberRead));
        off.push(() => s.off('typing_start',      onTypingStart));
        off.push(() => s.off('typing_stop',       onTypingStop));
        off.push(() => s.off('reaction_added',    onReactionAdded));
        off.push(() => s.off('reaction_removed',  onReactionRemoved));
        off.push(() => s.off('presence_changed',  onPresence));
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

  // ── Hydrate reactions for visible messages ───────────────
  // Refresh whenever the set of message ids changes. Cheap (one round-trip
  // per page) and keeps the reaction state in sync after edits/deletes.
  useEffect(() => {
    if (!chatId) return;
    const ids = messages.map(m => m.id).filter((n): n is number => typeof n === 'number' && n > 0);
    if (ids.length === 0) return;
    // Only re-fetch for ids we haven't seen — keep this simple and
    // refetch the full visible page. The map is small.
    let cancel = false;
    getReactionCounts(chatId, ids).then(map => {
      if (cancel) return;
      const next: Record<number, ReactionSummary[]> = {};
      for (const [k, v] of Object.entries(map)) next[Number(k)] = v;
      setReactions(next);
    }).catch(() => {});
    return () => { cancel = true; };
  }, [chatId, messages]);

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
        const replyToId = replyTo?.id ?? null;
        const q = await enqueueText(chatId, text, { replyToId });
        const optimistic: DisplayMessage = {
          id:        0,
          chatId,
          senderId:  meId ?? '',
          type:      'text',
          content:   text,
          meta:      null,
          replyToId,
          editedAt:  null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          _tempId:   q.tempId,
          _state:    'pending',
        };
        setReplyTo(null);
        setMessages(prev => [optimistic, ...prev]);
        setInput('');
        // The 'sent' / 'failed' queue events update this bubble's state.
      }
    } catch (e: any) {
      Alert.alert(editingId != null ? 'Edit failed' : 'Send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [input, sending, chatId, editingId, meId, replyTo, stopTypingIfActive]);

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

    // Normal server-confirmed bubble: React / Reply / Forward / Copy / Edit / Delete.
    const buttons: any[] = [
      { text: 'React',   onPress: () => setReactPicker(msg) },
      { text: 'Reply',   onPress: () => setReplyTo(msg) },
      { text: 'Forward', onPress: () => openForward(msg) },
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

  // ── Chat-level overflow menu: Mute / Block / Leave (Day 11) ──
  const onPressMenu = useCallback(() => {
    if (!chat) return;
    const peer = chat.type === 'direct' && meId
      ? chat.members.find(m => m.userId !== meId)
      : null;
    const isMuted = chat.muted;

    const buttons: any[] = [
      {
        text: isMuted ? '🔔 Unmute' : '🔕 Mute notifications',
        onPress: async () => {
          try {
            await muteChat(chatId, !isMuted);
            setChat(prev => prev ? { ...prev, muted: !isMuted } : prev);
          } catch (e: any) {
            Alert.alert('Mute failed', e?.message ?? 'Try again');
          }
        },
      },
    ];

    if (chat.type === 'group') {
      buttons.push({
        text: '👥 Group info',
        onPress: () => router.push({ pathname: '/group-info' as any, params: { id: chatId } }),
      });
    }

    if (peer) {
      buttons.push({
        text: '🚫 Block user',
        style: 'destructive',
        onPress: () => Alert.alert(
          'Block this user?',
          'They will no longer be able to message you. Existing chat history is preserved.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Block', style: 'destructive', onPress: async () => {
                try {
                  await blockUser(peer.userId);
                  Alert.alert('Blocked', `${peer.name || peer.email || 'User'} can no longer message you.`);
                  router.back();
                } catch (e: any) {
                  Alert.alert('Block failed', e?.message ?? 'Try again');
                }
              }
            },
          ],
        ),
      });
    }

    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(chat.name || (peer?.name ?? 'Chat'), undefined, buttons);
  }, [chat, meId, chatId, router]);

  // ── React / Reply / Forward handlers ──────────────────────
  const toggleReaction = useCallback(async (msg: DisplayMessage, emoji: string) => {
    setReactPicker(null);
    const mineAlready = (reactions[msg.id] || []).some(r => r.emoji === emoji && r.mine);
    // Optimistic — server will broadcast back and reconcile via socket handler.
    setReactions(prev => bumpReaction(prev, msg.id, emoji, mineAlready ? -1 : +1, true));
    try {
      if (mineAlready) await removeReaction(chatId, msg.id, emoji);
      else             await addReaction(chatId, msg.id, emoji);
    } catch (e: any) {
      // Roll back
      setReactions(prev => bumpReaction(prev, msg.id, emoji, mineAlready ? +1 : -1, true));
      Alert.alert('Could not react', e?.message ?? 'Try again');
    }
  }, [chatId, reactions]);

  const openForward = useCallback(async (msg: DisplayMessage) => {
    setForwardMsg(msg);
    setForwardLoading(true);
    try {
      const all = await listChats();
      setForwardChats(all.filter(c => c.id !== chatId));
    } catch (e: any) {
      Alert.alert('Could not load chats', e?.message ?? 'Try again');
      setForwardMsg(null);
    } finally {
      setForwardLoading(false);
    }
  }, [chatId]);

  const doForward = useCallback(async (target: ChatSummary) => {
    if (!forwardMsg) return;
    const m = forwardMsg;
    setForwardMsg(null);
    try {
      await forwardMessage({
        id: m.id, chatId: m.chatId, senderId: m.senderId, type: m.type,
        content: m.content, meta: m.meta,
      }, target.id);
    } catch (e: any) {
      Alert.alert('Forward failed', e?.message ?? 'Try again');
    }
  }, [forwardMsg]);

  const onCancelEdit = useCallback(() => {
    setEditingId(null);
    setInput('');
  }, []);

  // ── Voice message: start / stop / cancel ─────────────────
  const startRecording = useCallback(async () => {
    if (recording || recIsActive() || sending || editingId != null) return;
    try {
      await recStart();
      setRecording(true);
      setRecElapsedMs(0);
      recTimerRef.current = setInterval(() => setRecElapsedMs(recElapsed()), 200);
    } catch (e: any) {
      Alert.alert('Cannot record', e?.message ?? 'Microphone unavailable');
    }
  }, [recording, sending, editingId]);

  const cancelRecording = useCallback(async () => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
    setRecElapsedMs(0);
    try { await recCancel(); } catch {}
  }, []);

  const stopAndSendRecording = useCallback(async () => {
    if (!recording) return;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
    setSending(true);
    try {
      const r = await recStop();
      if (!r) { setSending(false); return; }
      // Minimum 500ms to count as a real voice message (avoid stray taps).
      if (r.durationMs < 500) {
        setSending(false);
        setRecElapsedMs(0);
        return;
      }
      const up = await uploadAttachment(r.uri, r.filename, r.mime);
      const msg = await sendMessage(chatId, '', 'audio', {
        meta: { attachmentId: up.id, mime: up.mime, size: up.size, filename: up.filename, durationMs: r.durationMs },
      });
      setMessages(prev => prev.some(x => x.id === msg.id) ? prev : [msg, ...prev]);
      setRecElapsedMs(0);
    } catch (e: any) {
      Alert.alert('Voice send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, recording]);

  // Clean up the timer + any active recording on unmount
  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      if (recIsActive()) recCancel().catch(() => {});
    };
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

  // ── Attach file (Day 9) ───────────────────────────────────
  // Generic doc picker. The server accepts any mime via /uploads; the bubble
  // renders a tappable filename + size pill (FileBubble).
  const onPickFile = useCallback(async () => {
    if (sending) return;
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setSending(true);
    try {
      const filename = asset.name || `file-${Date.now()}`;
      const mime     = asset.mimeType || 'application/octet-stream';
      const up = await uploadAttachment(asset.uri, filename, mime);
      const msg = await sendMessage(chatId, '', 'file', {
        meta: { attachmentId: up.id, mime: up.mime, size: up.size, filename: up.filename },
      });
      setMessages(prev => prev.some(x => x.id === msg.id) ? prev : [msg, ...prev]);
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, sending]);

  // ── Attach menu ───────────────────────────────────────────
  // Single attach button → Alert with "Photo" / "File" choices. Keeps the
  // composer tidy and matches WhatsApp/Telegram flow.
  const onPressAttach = useCallback(() => {
    if (sending) return;
    Alert.alert('Attach', undefined, [
      { text: '📷 Photo', onPress: onPickImage },
      { text: '📎 File',  onPress: onPickFile  },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [sending, onPickImage, onPickFile]);

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

  // Header avatar — group uses chat.photoURL, direct uses the other member's
  const headerPhotoId = useMemo(() => {
    if (!chat) return null;
    if (chat.type === 'group') return chat.photoURL ?? null;
    if (chat.type === 'direct' && meId) {
      const other = chat.members.find(m => m.userId !== meId);
      return other?.photoURL ?? null;
    }
    return null;
  }, [chat, meId]);

  // Direct-chat peer presence — drives the "online" / "last seen X" sub-text
  // and the green dot on the header avatar.
  const peerPresence = useMemo(() => {
    if (!chat || chat.type !== 'direct' || !meId) return null;
    const other = chat.members.find(m => m.userId !== meId);
    if (!other) return null;
    return { online: !!other.online, lastSeenAt: other.lastSeenAt ?? null };
  }, [chat, meId]);

  const headerSub = useMemo(() => {
    if (!chat) return '';
    if (chat.type === 'group') return `${chat.members.length} members`;
    if (peerPresence?.online) return 'online';
    if (peerPresence?.lastSeenAt) return `last seen ${formatLastSeen(peerPresence.lastSeenAt)}`;
    return 'Direct chat';
  }, [chat, peerPresence]);

  const [screenAuthHeader, setScreenAuthHeader] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      const tok = await getAccessToken();
      if (!cancel) setScreenAuthHeader(tok ? `Bearer ${tok}` : null);
    })();
    return () => { cancel = true; };
  }, []);

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
        <View style={S.headerAvatarWrap}>
          <View style={S.headerAvatar}>
            {headerPhotoId && screenAuthHeader ? (
              <Image
                source={{ uri: attachmentUrl(headerPhotoId), headers: { Authorization: screenAuthHeader } }}
                style={S.headerAvatarImg}
              />
            ) : (
              <Text style={S.headerAvatarTxt}>{(title.trim()[0] ?? '#').toUpperCase()}</Text>
            )}
          </View>
          {peerPresence?.online && <View style={S.headerPresenceDot} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={S.title} numberOfLines={1}>{title}</Text>
          {chat && <Text style={S.sub}>{headerSub}</Text>}
        </View>
        {chat?.type === 'direct' && meId && (() => {
          const peer = chat.members.find(m => m.userId !== meId);
          if (!peer) return null;
          const params = { chatId, peerUid: peer.userId, peerName: peer.name ?? peer.email ?? 'VaultChat user' };
          return (
            <>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/voicecall' as any, params })}
                activeOpacity={0.7}
              >
                <Text style={S.headerIcon}>📞</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/videocall' as any, params })}
                activeOpacity={0.7}
              >
                <Text style={S.headerIcon}>📹</Text>
              </TouchableOpacity>
            </>
          );
        })()}
        <TouchableOpacity
          style={S.headerIconBtn}
          onPress={() => { setSearchOpen(o => !o); if (searchOpen) setSearchQ(''); }}
          activeOpacity={0.7}
        >
          <Text style={S.headerIcon}>{searchOpen ? '✕' : '🔍'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={S.headerIconBtn} onPress={onPressMenu} activeOpacity={0.7}>
          <Text style={S.headerIcon}>⋮</Text>
        </TouchableOpacity>
      </View>

      {/* In-chat search bar (Day 13) */}
      {searchOpen && (
        <View style={S.inChatSearchBar}>
          <TextInput
            style={S.inChatSearchInput}
            placeholder="Find in chat…"
            placeholderTextColor={SUBTLE}
            value={searchQ}
            onChangeText={setSearchQ}
            autoFocus
            maxLength={200}
          />
          {searchQ.length > 0 && (
            <Text style={S.inChatSearchCount}>
              {messages.filter(m => !m.deletedAt && (m.content || '').toLowerCase().includes(searchQ.toLowerCase())).length} matches
            </Text>
          )}
        </View>
      )}

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
            reactionsForMsg={reactions[item.id]}
            onToggleReaction={(emoji) => toggleReaction(item, emoji)}
            replyTarget={item.replyToId ? messages.find(m => m.id === item.replyToId) ?? null : null}
            replyTargetMember={item.replyToId
              ? (() => {
                  const t = messages.find(m => m.id === item.replyToId);
                  return t ? membersById.get(t.senderId) : undefined;
                })()
              : undefined}
            highlight={searchOpen && searchQ.trim().length > 0 ? searchQ.trim() : null}
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

      {/* Reply-to banner */}
      {replyTo && (
        <View style={S.replyBar}>
          <View style={S.replyBarLine} />
          <View style={{ flex: 1 }}>
            <Text style={S.replyBarTitle} numberOfLines={1}>
              Replying to {(membersById.get(replyTo.senderId)?.name) || 'message'}
            </Text>
            <Text style={S.replyBarBody} numberOfLines={1}>
              {replyTo.type === 'image' ? '📷 Photo'
                : replyTo.type === 'audio' ? '🎙️ Voice message'
                : replyTo.type === 'video' ? '🎥 Video'
                : replyTo.type === 'file'  ? '📎 File'
                : replyTo.content ?? ''}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={8}>
            <Text style={S.editCancelTxt}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Composer — either normal or recording mode */}
      {recording ? (
        <View style={[S.composer, S.recordingComposer]}>
          <View style={S.recordingDot} />
          <Text style={S.recordingTimer}>{formatRecDuration(recElapsedMs)}</Text>
          <Text style={S.recordingHint}>Recording… tap ✕ to cancel, ▶ to send</Text>
          <TouchableOpacity style={S.recCancelBtn} onPress={cancelRecording} activeOpacity={0.8}>
            <Text style={S.recCancelTxt}>✕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.recSendBtn} onPress={stopAndSendRecording} activeOpacity={0.85}>
            <Text style={S.recSendTxt}>▶</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={S.composer}>
          {editingId == null && (
            <TouchableOpacity
              style={S.attachBtn}
              onPress={onPressAttach}
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
          {/* Mic when input is empty + not editing; otherwise the Send button takes its place */}
          {editingId == null && input.trim().length === 0 ? (
            <TouchableOpacity
              style={S.attachBtn}
              onPress={startRecording}
              disabled={sending}
              activeOpacity={0.7}
            >
              <Text style={S.attachTxt}>🎙️</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[S.sendBtn, (!input.trim() || sending) && S.sendBtnOff]}
              onPress={onSend}
              disabled={!input.trim() || sending}
              activeOpacity={0.85}
            >
              <Text style={S.sendTxt}>{sending ? '…' : editingId != null ? 'Save' : 'Send'}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Quick-react emoji picker */}
      <Modal
        visible={reactPicker != null}
        transparent
        animationType="fade"
        onRequestClose={() => setReactPicker(null)}
      >
        <Pressable style={S.modalBackdrop} onPress={() => setReactPicker(null)}>
          <Pressable style={S.reactSheet} onPress={(e) => e.stopPropagation()}>
            {QUICK_REACTS.map(emoji => (
              <TouchableOpacity
                key={emoji}
                style={S.reactSheetBtn}
                onPress={() => reactPicker && toggleReaction(reactPicker, emoji)}
                activeOpacity={0.7}
              >
                <Text style={S.reactSheetEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Forward chat picker */}
      <Modal
        visible={forwardMsg != null}
        transparent
        animationType="slide"
        onRequestClose={() => setForwardMsg(null)}
      >
        <Pressable style={S.modalBackdrop} onPress={() => setForwardMsg(null)}>
          <Pressable style={S.forwardSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={S.forwardTitle}>Forward to…</Text>
            {forwardLoading ? (
              <ActivityIndicator color={ACCENT} style={{ marginTop: 24 }} />
            ) : forwardChats.length === 0 ? (
              <Text style={S.forwardEmpty}>No other chats yet</Text>
            ) : (
              <FlatList
                data={forwardChats}
                keyExtractor={(c) => c.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={S.forwardRow}
                    onPress={() => doForward(item)}
                    activeOpacity={0.7}
                  >
                    <Text style={S.forwardRowTxt} numberOfLines={1}>
                      {item.name || item.id.slice(0, 8)}
                    </Text>
                    <Text style={S.forwardRowSub}>{item.type}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// Quick-reaction emojis. WhatsApp-style: tap one to toggle. Long-pressing
// the emoji button (future) could open the system emoji picker.
const QUICK_REACTS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Case-insensitive substring highlighter — splits `body` around every
// occurrence of `q` and wraps the matches in a styled <Text>. Empty
// query returns the body unchanged.
function renderWithHighlight(body: string, q: string | null | undefined): any {
  if (!q || !body) return body;
  const needle = q.toLowerCase();
  const hay    = body.toLowerCase();
  if (hay.indexOf(needle) === -1) return body;
  const parts: any[] = [];
  let i = 0;
  while (i < body.length) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) { parts.push(body.slice(i)); break; }
    if (idx > i) parts.push(body.slice(i, idx));
    parts.push(
      <Text key={`h${idx}`} style={S.highlight}>{body.slice(idx, idx + q.length)}</Text>,
    );
    i = idx + q.length;
  }
  return parts;
}

// Human-friendly "last seen" — same scale as the chat-list relative time.
function formatLastSeen(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000)        return 'just now';
    if (diff < 3600_000)      return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)     return `${Math.floor(diff / 3600_000)}h ago`;
    if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return ''; }
}

function formatRecDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// Apply an optimistic ±1 to the reaction-count map. Pure — returns a new
// object so React picks up the change. Removes empty buckets so the chip
// disappears when count hits zero.
function bumpReaction(
  prev: Record<number, ReactionSummary[]>,
  messageId: number,
  emoji: string,
  delta: 1 | -1,
  fromMe: boolean,
): Record<number, ReactionSummary[]> {
  const list = prev[messageId] ? [...prev[messageId]] : [];
  const idx  = list.findIndex(r => r.emoji === emoji);
  if (idx >= 0) {
    const current = list[idx];
    const nextCount = current.count + delta;
    if (nextCount <= 0) {
      list.splice(idx, 1);
    } else {
      list[idx] = { emoji, count: nextCount, mine: fromMe ? delta > 0 : current.mine };
    }
  } else if (delta > 0) {
    list.push({ emoji, count: 1, mine: fromMe });
  }
  const next = { ...prev };
  if (list.length === 0) delete next[messageId]; else next[messageId] = list;
  return next;
}

// ─── File bubble (documents) ─────────────────────────────────
// Tap to download (FileSystem) and open with the OS share sheet
// (Sharing.shareAsync). The /uploads route is auth-gated so we pass
// the Bearer header on the download request.
function FileBubble({
  attachmentId, filename, mime, size, authHeader, isMine,
}: {
  attachmentId: string;
  filename:     string;
  mime:         string;
  size:         number;
  authHeader:   string | null;
  isMine:       boolean;
}) {
  const [busy, setBusy] = useState(false);

  const onOpen = useCallback(async () => {
    if (!authHeader || busy) return;
    setBusy(true);
    try {
      const safe = (filename || `file-${attachmentId}`).replace(/[/\\:*?"<>|]/g, '_');
      // expo-file-system v19 (SDK 54) uses the legacy API
      const dest = `${(FileSystem as any).cacheDirectory}${safe}`;
      const dl = await (FileSystem as any).downloadAsync(
        attachmentUrl(attachmentId),
        dest,
        { headers: { Authorization: authHeader } },
      );
      if (dl.status !== 200) throw new Error(`Download failed (HTTP ${dl.status})`);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, { mimeType: mime, dialogTitle: filename });
      } else {
        Alert.alert('File saved', `Saved to ${dl.uri}`);
      }
    } catch (e: any) {
      Alert.alert('Could not open file', e?.message ?? 'Try again');
    } finally {
      setBusy(false);
    }
  }, [attachmentId, filename, mime, authHeader, busy]);

  return (
    <TouchableOpacity style={S.fileRow} onPress={onOpen} activeOpacity={0.7} disabled={busy}>
      <View style={[S.fileIcon, isMine ? S.fileIconMine : S.fileIconTheirs]}>
        <Text style={S.fileIconTxt}>{busy ? '⏳' : '📄'}</Text>
      </View>
      <View style={S.fileMeta}>
        <Text style={[S.fileName, isMine && S.fileNameMine]} numberOfLines={1}>{filename}</Text>
        <Text style={[S.fileSize, isMine && S.fileSizeMine]}>{formatBytes(size)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function formatBytes(n: number): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Audio bubble (voice messages) ───────────────────────────
// Tap to play / pause. Shows progress + remaining time. Streams the
// auth-gated /uploads endpoint with a Bearer header. Mono speaker icon
// stays bold while playing, otherwise dim.
function AudioBubble({
  attachmentId, durationMs, authHeader, isMine,
}: {
  attachmentId: string;
  durationMs:   number;
  authHeader:   string | null;
  isMine:       boolean;
}) {
  const [playing,  setPlaying]  = useState(false);
  const [position, setPosition] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Stop+unload when the bubble unmounts
  useEffect(() => {
    return () => {
      const s = soundRef.current;
      soundRef.current = null;
      if (s) { s.stopAsync().catch(() => {}); s.unloadAsync().catch(() => {}); }
    };
  }, []);

  const togglePlay = useCallback(async () => {
    if (!authHeader) return;
    try {
      if (playing) {
        await soundRef.current?.pauseAsync();
        setPlaying(false);
        return;
      }
      if (!soundRef.current) {
        const { sound } = await Audio.Sound.createAsync(
          { uri: attachmentUrl(attachmentId), headers: { Authorization: authHeader } },
          { shouldPlay: true, progressUpdateIntervalMillis: 150 },
          (status: any) => {
            if (!status?.isLoaded) return;
            setPosition(status.positionMillis || 0);
            if (status.didJustFinish) {
              setPlaying(false);
              setPosition(0);
              soundRef.current?.setPositionAsync(0).catch(() => {});
            }
          },
        );
        soundRef.current = sound;
        setPlaying(true);
      } else {
        await soundRef.current.playAsync();
        setPlaying(true);
      }
    } catch (e: any) {
      Alert.alert('Playback failed', e?.message ?? 'Try again');
    }
  }, [attachmentId, authHeader, playing]);

  const totalSec = Math.max(1, Math.round(durationMs / 1000));
  const playedSec = Math.min(totalSec, Math.round(position / 1000));
  const remaining = totalSec - playedSec;
  const pct = totalSec ? Math.min(1, position / Math.max(1, durationMs)) : 0;

  return (
    <View style={S.audioRow}>
      <TouchableOpacity
        style={[S.audioPlayBtn, isMine ? S.audioPlayBtnMine : S.audioPlayBtnTheirs]}
        onPress={togglePlay}
        activeOpacity={0.7}
      >
        <Text style={S.audioPlayIcon}>{playing ? '▌▌' : '▶'}</Text>
      </TouchableOpacity>
      <View style={S.audioMeter}>
        <View style={S.audioTrack}>
          <View style={[S.audioFill, { width: `${pct * 100}%` }, isMine && S.audioFillMine]} />
        </View>
        <Text style={[S.audioTime, isMine && S.audioTimeMine]}>
          {playing
            ? `${formatRecDuration(position)} / ${formatRecDuration(durationMs)}`
            : `🎙️ ${formatRecDuration(durationMs)}${remaining > 0 ? '' : ''}`}
        </Text>
      </View>
    </View>
  );
}

function MessageBubble({
  msg, meId, member, chatId, otherMembers, onLongPress,
  reactionsForMsg, onToggleReaction,
  replyTarget, replyTargetMember,
  highlight,
}: {
  msg: DisplayMessage;
  meId: string | null;
  member?: ChatMember;
  chatId: string;
  otherMembers: ChatMember[];
  onLongPress: (msg: DisplayMessage, plain: string) => void;
  reactionsForMsg?: ReactionSummary[];
  onToggleReaction?: (emoji: string) => void;
  replyTarget?: DisplayMessage | null;
  replyTargetMember?: ChatMember;
  highlight?: string | null;
}) {
  const isMine = msg.senderId === meId;
  const [plain, setPlain] = useState<string>('');
  const [replyPlain, setReplyPlain] = useState<string>('');
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

  useEffect(() => {
    if (!replyTarget) { setReplyPlain(''); return; }
    let cancel = false;
    (async () => {
      const t = await decryptFromChat(chatId, replyTarget.senderId, replyTarget.content);
      if (!cancel) setReplyPlain(t);
    })();
    return () => { cancel = true; };
  }, [replyTarget?.id, replyTarget?.content, chatId]);

  // For image / audio / file bubbles, prepare the Authorization header so
  // RN can fetch the auth-gated /uploads endpoint.
  useEffect(() => {
    if (msg.type !== 'image' && msg.type !== 'audio' && msg.type !== 'file') return;
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
  const isAudio = msg.type === 'audio' && msg.meta?.attachmentId;
  const isFile  = msg.type === 'file'  && msg.meta?.attachmentId;

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

        {/* Forwarded label */}
        {msg.meta?.forwardedFrom && (
          <Text style={S.forwardedTag}>↪ Forwarded</Text>
        )}

        {/* Inline reply preview (above the body) */}
        {replyTarget && (
          <View style={S.replyPreview}>
            <View style={S.replyPreviewLine} />
            <View style={{ flex: 1 }}>
              <Text style={S.replyPreviewWho} numberOfLines={1}>
                {replyTargetMember?.name || replyTargetMember?.email || 'Reply'}
              </Text>
              <Text style={S.replyPreviewBody} numberOfLines={1}>
                {replyTarget.type === 'image' ? '📷 Photo'
                  : replyTarget.type === 'audio' ? '🎙️ Voice message'
                  : replyTarget.type === 'video' ? '🎥 Video'
                  : replyTarget.type === 'file'  ? '📎 File'
                  : replyPlain || ''}
              </Text>
            </View>
          </View>
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
        ) : isAudio ? (
          <AudioBubble
            attachmentId={msg.meta.attachmentId}
            durationMs={Number(msg.meta?.durationMs) || 0}
            authHeader={authHeader}
            isMine={isMine}
          />
        ) : isFile ? (
          <FileBubble
            attachmentId={msg.meta.attachmentId}
            filename={String(msg.meta?.filename || 'file')}
            mime={String(msg.meta?.mime || 'application/octet-stream')}
            size={Number(msg.meta?.size) || 0}
            authHeader={authHeader}
            isMine={isMine}
          />
        ) : (
          plain ? (
            <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine]}>
              {renderWithHighlight(plain, highlight)}
            </Text>
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

      {/* Reaction chips — tap to toggle */}
      {reactionsForMsg && reactionsForMsg.length > 0 && (
        <View style={[S.reactionRow, isMine ? S.reactionRowMine : S.reactionRowTheirs]}>
          {reactionsForMsg.map(r => (
            <TouchableOpacity
              key={r.emoji}
              style={[S.reactionChip, r.mine && S.reactionChipMine]}
              onPress={() => onToggleReaction?.(r.emoji)}
              activeOpacity={0.7}
            >
              <Text style={S.reactionChipEmoji}>{r.emoji}</Text>
              <Text style={[S.reactionChipCount, r.mine && S.reactionChipCountMine]}>{r.count}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
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
  headerIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerIcon:    { fontSize: 20 },
  headerAvatarWrap:  { width: 36, height: 36 },
  headerAvatar:      { width: 36, height: 36, borderRadius: 18, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  headerAvatarImg:   { width: '100%', height: '100%' },
  headerAvatarTxt:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  headerPresenceDot: { position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, backgroundColor: '#22C55E', borderWidth: 2, borderColor: DARK_BG },

  // Day 13 — in-chat search
  inChatSearchBar:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#0F1217', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  inChatSearchInput:  { flex: 1, color: TEXT, backgroundColor: '#1F2937', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14 },
  inChatSearchCount:  { color: SUBTLE, fontSize: 11, fontWeight: '600' },
  highlight:          { backgroundColor: 'rgba(252, 211, 77, 0.45)', color: '#111' },
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

  // Recording-mode composer: pulse dot + timer + hint + cancel/send buttons
  recordingComposer: { alignItems: 'center', gap: 8 },
  recordingDot:    { width: 10, height: 10, borderRadius: 5, backgroundColor: DANGER },
  recordingTimer:  { color: TEXT, fontSize: 16, fontWeight: '700', minWidth: 52, textAlign: 'center' },
  recordingHint:   { flex: 1, color: SUBTLE, fontSize: 12 },
  recCancelBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' },
  recCancelTxt:    { color: DANGER, fontSize: 18, fontWeight: '700' },
  recSendBtn:      { width: 40, height: 40, borderRadius: 20, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  recSendTxt:      { color: '#fff', fontSize: 18, fontWeight: '700' },

  // Voice-message bubble (playback): play/pause button + track + duration
  audioRow:           { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 200, maxWidth: 260 },
  audioPlayBtn:       { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  audioPlayBtnMine:   { backgroundColor: 'rgba(255,255,255,0.22)' },
  audioPlayBtnTheirs: { backgroundColor: ACCENT },
  audioPlayIcon:      { color: '#fff', fontSize: 14, fontWeight: '700' },
  audioMeter:         { flex: 1, gap: 4 },
  audioTrack:         { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  audioFill:          { height: 4, backgroundColor: ACCENT, borderRadius: 2 },
  audioFillMine:      { backgroundColor: '#fff' },
  audioTime:          { color: SUBTLE, fontSize: 11 },
  audioTimeMine:      { color: 'rgba(255,255,255,0.85)' },

  input:         { flex: 1, color: TEXT, backgroundColor: '#1F2937', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 15 },
  sendBtn:       { backgroundColor: ACCENT, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, justifyContent: 'center' },
  sendBtnOff:    { backgroundColor: '#374151' },
  sendTxt:       { color: '#fff', fontWeight: '700' },

  imageBubble:   { padding: 4, borderRadius: 12 },
  attachedImage: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#0F1217' },
  imageError:    { width: 180, padding: 16, alignItems: 'center', gap: 4 },
  imageErrorTxt: { color: SUBTLE, fontSize: 12 },

  // Day 9 — file bubble (documents)
  fileRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 220, maxWidth: 280 },
  fileIcon:       { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  fileIconMine:   { backgroundColor: 'rgba(255,255,255,0.22)' },
  fileIconTheirs: { backgroundColor: ACCENT },
  fileIconTxt:    { fontSize: 18 },
  fileMeta:       { flex: 1, gap: 2 },
  fileName:       { color: TEXT, fontSize: 14, fontWeight: '600' },
  fileNameMine:   { color: '#fff' },
  fileSize:       { color: SUBTLE, fontSize: 11 },
  fileSizeMine:   { color: 'rgba(255,255,255,0.85)' },

  // Day 8 — reply bar above composer
  replyBar:        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#0F1217', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER },
  replyBarLine:    { width: 3, alignSelf: 'stretch', backgroundColor: ACCENT, borderRadius: 1.5 },
  replyBarTitle:   { color: ACCENT, fontSize: 12, fontWeight: '700' },
  replyBarBody:    { color: TEXT, fontSize: 13 },

  // Day 8 — inline reply preview inside a bubble
  replyPreview:        { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginBottom: 6, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 6 },
  replyPreviewLine:    { width: 2, backgroundColor: ACCENT, borderRadius: 1 },
  replyPreviewWho:     { color: ACCENT, fontSize: 11, fontWeight: '700' },
  replyPreviewBody:    { color: TEXT, fontSize: 12 },

  // Day 8 — "↪ Forwarded" tag at top of bubble
  forwardedTag:        { color: SUBTLE, fontSize: 11, fontStyle: 'italic', marginBottom: 2 },

  // Day 8 — reaction chips under a bubble
  reactionRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: -6, marginBottom: 6, paddingHorizontal: 4 },
  reactionRowMine:     { justifyContent: 'flex-end' },
  reactionRowTheirs:   { justifyContent: 'flex-start' },
  reactionChip:        { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, backgroundColor: '#1F2937', borderWidth: StyleSheet.hairlineWidth, borderColor: BORDER },
  reactionChipMine:    { backgroundColor: 'rgba(108,99,255,0.25)', borderColor: ACCENT },
  reactionChipEmoji:   { fontSize: 14 },
  reactionChipCount:   { color: SUBTLE, fontSize: 11, fontWeight: '600' },
  reactionChipCountMine: { color: ACCENT },

  // Day 8 — quick-react picker
  modalBackdrop:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  reactSheet:          { flexDirection: 'row', gap: 4, padding: 8, backgroundColor: '#1F2937', borderRadius: 32 },
  reactSheetBtn:       { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  reactSheetEmoji:     { fontSize: 26 },

  // Day 8 — forward chat picker
  forwardSheet:        { width: '100%', maxHeight: '70%', backgroundColor: '#0F1217', borderRadius: 16, padding: 16, gap: 8 },
  forwardTitle:        { color: TEXT, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  forwardEmpty:        { color: SUBTLE, textAlign: 'center', marginTop: 24 },
  forwardRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  forwardRowTxt:       { color: TEXT, fontSize: 15, flex: 1 },
  forwardRowSub:       { color: SUBTLE, fontSize: 11 },
});
