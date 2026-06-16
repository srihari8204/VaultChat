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

import { Audio, ResizeMode, Video } from 'expo-av';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as ScreenCapture from 'expo-screen-capture';
import { DeviceMotion } from 'expo-sensors';
import * as Sharing from 'expo-sharing';
import { recordScreenshotAttempt } from '../services/security/auditChain';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { consumePendingJump } from '../lib/chatJump';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { E2EE_ENABLED } from '../constants/flags';
import { getCachedMessages, cacheMessages, applyMessage } from '../lib/localDb';
import { saveDraft, getDraft, clearDraft } from '../lib/drafts';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { Sheet, Avatar } from '../components/ui';
import LinkPreview, { extractUrl } from '../components/LinkPreview';
import GifPicker from '../components/GifPicker';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { getCurrentUserAsync } from './(constants)/authService';

// Fire-and-forget haptic (no-op on web / if unavailable).
const haptic = (style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) => {
  if (Platform.OS !== 'web') Haptics.impactAsync(style).catch(() => {});
};
import { MessageActionSheet, type SheetAction } from '../components/MessageActionSheet';
import { getAccessToken } from '../lib/api';
import { getLiveKey, putLiveKey, clearLiveKey, decryptPosition } from '../lib/liveLocationCrypto';
import {
  addBookmark,
  addReaction,
  attachmentUrl,
  getPollVotesBulk,
  type PollVoteSummary,
  unvotePoll,
  voteOnPoll,
  blockUser,
  decryptFromChat,
  deleteMessage,
  editMessage,
  forwardMessage,
  getChat,
  getMessages,
  getReactionCounts,
  listChats,
  markAttachmentViewed,
  markDelivered,
  markRead,
  muteChat,
  pinMessage,
  removeReaction,
  reportScreenshotCaptured,
  sendMessage,
  setDisappearing,
  setHidden,
  setScreenshotMode,
  setVanishMode,
  type ScreenshotMode,
  type ChatDetail,
  type ChatMember,
  type ChatSummary,
  type Message,
  type ReactionSummary,
} from '../lib/chatService';
import { sendMediaMessage } from '../lib/sendMedia';
import { getDecryptedAttachmentUri, parseMediaContent } from '../lib/mediaAttachments';
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

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

// Fixed accent styles (theme-agnostic) used by the plain renderWithHighlight helper.
const HL = StyleSheet.create({
  highlight: { backgroundColor: 'rgba(252, 211, 77, 0.45)', color: '#111' },
  link:      { color: '#7DD3FC', textDecorationLine: 'underline' },
  mention:   { color: '#34D399', fontWeight: '700' },
});

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();
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

  // Invisible Ink — one-shot toggle for the next outbound message.
  // When the toggle is on, the next send gets meta.invisibleInk = true
  // and the bubble renders obscured text until the receiver tilts the
  // device past ~45°. Sender always sees the plaintext.
  const [nextInvisibleInk, setNextInvisibleInk] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  // @mentions (groups): active typed query (null = none) + recorded picks.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionsRef = useRef<{ name: string; userId: string }[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // Global "tilt revealed" state — flips true when the gyro reports any
  // axis past ~45° (~0.78 rad). Shared by every invisible-ink bubble on
  // screen, so a single tilt reveals all of them at once.
  const [tiltRevealed, setTiltRevealed] = useState(false);

  // Memory Bubbles — dismissed per-session so the same anniversary doesn't
  // pop back up every time the user re-enters the chat in one sitting.
  const [dismissedMemoryIds, setDismissedMemoryIds] = useState<Set<number>>(new Set());

  // Poll vote summaries keyed by message id. Hydrated once per page load
  // via the bulk endpoint, then patched in place by socket events.
  const [pollVotes, setPollVotes] = useState<Record<number, PollVoteSummary>>({});

  // Day 8 — reactions, reply, forward
  const [reactions, setReactions] = useState<Record<number, ReactionSummary[]>>({});
  const [reactPicker, setReactPicker] = useState<DisplayMessage | null>(null);
  const [actionSheet, setActionSheet] = useState<{ msg: DisplayMessage; plain: string } | null>(null);
  const [replyTo, setReplyTo]         = useState<DisplayMessage | null>(null);
  const [forwardMsg, setForwardMsg]   = useState<DisplayMessage | null>(null);
  const [forwardChats, setForwardChats] = useState<ChatSummary[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);

  const listRef = useRef<FlatList>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [liveLoc, setLiveLoc] = useState<{ userId: string; latitude: number; longitude: number; address?: string } | null>(null);
  const readDebounce = useRef<any>(null);
  const lastReadSent = useRef<number>(0);
  const typingIdleTimer = useRef<any>(null);
  const typingActiveRef = useRef(false);

  const membersById = useMemo(() => {
    const m = new Map<string, ChatMember>();
    chat?.members.forEach(x => m.set(x.userId, x));
    return m;
  }, [chat]);

  // O(1) reply-target lookup — replaces a per-bubble messages.find() on every
  // render (was O(n²) across the visible page).
  const replyById = useMemo(() => {
    const m = new Map<number, DisplayMessage>();
    for (const msg of messages) {
      if (typeof msg.id === 'number' && msg.id > 0) m.set(msg.id, msg);
    }
    return m;
  }, [messages]);

  // Stable key over the visible message ids, so the reaction/poll hydration
  // effects only refire when the SET of ids changes — not on every edit,
  // optimistic update, or cache write that re-creates the array.
  const messageIdKey = useMemo(() => messages.map(m => m.id).join(','), [messages]);

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
        // Provision/publish this device's E2EE key bundle (no-op unless the
        // flag is on; idempotent + cheap after the first call this session).
        if (E2EE_ENABLED) {
          import('../services/crypto/e2eeSession.rn')
            .then(m => m.provisionE2EEIdentity())
            .catch(() => {});
        }

        // Local-first: paint cached messages instantly (no spinner), then
        // refresh from the server below and reconcile.
        try {
          const cached = await getCachedMessages(chatId, PAGE_SIZE);
          if (cached.length) { setMessages(cached); setLoading(false); }
        } catch { /* cache miss → fall through to server load */ }

        const [me, c, msgs, pendingQ] = await Promise.all([
          getCurrentUserAsync(),
          getChat(chatId),
          getMessages(chatId, { limit: PAGE_SIZE }),
          pendingForChat(chatId),
        ]);
        setMeId(me?.id ?? null);
        setChat(c);
        setPinnedId(c.pinnedMessageId ?? null);

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
        // Persist the fresh page to the local cache for next instant open.
        cacheMessages(chatId, msgs).catch(() => {});
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
      cacheMessages(cid, [real]).catch(() => {}); // persist own sent message
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
          applyMessage(chatId, m).catch(() => {}); // persist to local cache
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
        const onScreenshotCaptured = (e: { chatId: string; capturedBy: string; capturedAt: string }) => {
          // Server already filters to chat members — but ignore the
          // echo of our own capture and any cross-chat noise.
          if (!e || e.chatId !== chatId || e.capturedBy === meId) return;
          setScreenshotBanner({ by: e.capturedBy, at: e.capturedAt });
        };
        // Poll-vote live updates. Server emits one event per (user, option)
        // change; for single-vote polls a "switch" arrives as one
        // poll_unvoted (old option) immediately followed by one poll_voted
        // (new option). Each handler patches counts + the caller's `mine`
        // set in place — no refetch needed.
        const onPollVoted = (e: { messageId: number; userId: string; optionIndex: number }) => {
          if (!e?.messageId) return;
          setPollVotes(prev => bumpPollVote(prev, e.messageId, e.optionIndex, +1, e.userId === meId));
        };
        const onPollUnvoted = (e: { messageId: number; userId: string; optionIndex: number }) => {
          if (!e?.messageId) return;
          setPollVotes(prev => bumpPollVote(prev, e.messageId, e.optionIndex, -1, e.userId === meId));
        };

        const onLiveLocation = (e: any) => {
          if (!e?.userId || e.userId === meId) return;
          if (e.blob) {
            // E2E path: decrypt the relayed blob with the per-session key the peer
            // delivered in the initial 'location' message. No key yet → ignore
            // (the key arrives via the E2E message; updates resume once we have it).
            const key = getLiveKey(chatId, e.userId);
            if (!key) return;
            const pos = decryptPosition(key, e.blob);
            if (pos) setLiveLoc({ userId: e.userId, latitude: pos.lat, longitude: pos.lng, address: pos.address });
          } else if (e.latitude != null) {
            // Legacy plaintext path (older sender).
            setLiveLoc({ userId: e.userId, latitude: e.latitude, longitude: e.longitude, address: e.address });
          }
        };
        const onLiveLocationStop = (e: any) => {
          setLiveLoc(prev => (prev && e?.userId === prev.userId) ? null : prev);
          if (e?.userId) clearLiveKey(chatId, e.userId);
        };

        s.on('live_location_update', onLiveLocation);
        s.on('live_location_stop',   onLiveLocationStop);
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
        s.on('screenshot_captured', onScreenshotCaptured);
        s.on('poll_voted',        onPollVoted);
        s.on('poll_unvoted',      onPollUnvoted);
        const onPinned = (e: any) => setPinnedId(e?.messageId ?? null);
        s.on('message_pinned',    onPinned);

        off.push(() => s.off('message_pinned', onPinned));
        off.push(() => s.off('live_location_update', onLiveLocation));
        off.push(() => s.off('live_location_stop',   onLiveLocationStop));
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
        off.push(() => s.off('screenshot_captured', onScreenshotCaptured));
        off.push(() => s.off('poll_voted',        onPollVoted));
        off.push(() => s.off('poll_unvoted',      onPollUnvoted));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, messageIdKey]);

  // ── Hydrate poll votes for visible polls ─────────────────
  // Same pattern as reactions — bulk fetch once per message-id change.
  // Bulk endpoint returns nothing for non-poll ids, so passing the whole
  // page is safe.
  useEffect(() => {
    if (!chatId) return;
    const pollIds = messages
      .filter(m => m.type === 'poll' && typeof m.id === 'number' && m.id > 0)
      .map(m => m.id);
    if (pollIds.length === 0) return;
    let cancel = false;
    getPollVotesBulk(chatId, pollIds).then(map => {
      if (cancel) return;
      const next: Record<number, PollVoteSummary> = {};
      for (const [k, v] of Object.entries(map)) next[Number(k)] = v;
      setPollVotes(prev => ({ ...prev, ...next }));
    }).catch(() => {});
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, messageIdKey]);

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
  // ── Draft auto-save (feature 66) ──────────────────────────
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  const draftTimer = useRef<any>(null);
  useEffect(() => {
    let active = true;
    getDraft(chatId).then(d => { if (active && d) setInput(d); });
    return () => {
      active = false;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      saveDraft(chatId, inputRef.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const stopTypingIfActive = useCallback(() => {
    if (typingActiveRef.current && meId) {
      emitTypingStop(chatId, meId).catch(() => {});
      typingActiveRef.current = false;
    }
  }, [chatId, meId]);

  const onInputChange = useCallback((text: string) => {
    setInput(text);
    // @mentions: in a group, a trailing "@word" opens the member picker.
    const mm = text.match(/(?:^|\s)@(\w{0,30})$/);
    setMentionQuery(chat?.type === 'group' && mm ? mm[1] : null);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { saveDraft(chatId, text).catch(() => {}); }, 400);
    if (!meId) return;
    if (!typingActiveRef.current && text.length > 0) {
      typingActiveRef.current = true;
      emitTypingStart(chatId, meId).catch(() => {});
    }
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(stopTypingIfActive, TYPING_IDLE_MS);
  }, [chatId, meId, stopTypingIfActive]);

  // Insert a picked @mention: replace the trailing "@query" with "@Name ".
  const pickMention = useCallback((mem: ChatMember) => {
    const name = (mem.name || mem.email || 'member').split(' ')[0];
    setInput(prev => prev.replace(/@(\w{0,30})$/, `@${name} `));
    if (!mentionsRef.current.some(x => x.userId === mem.userId)) {
      mentionsRef.current.push({ name, userId: mem.userId });
    }
    setMentionQuery(null);
  }, []);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery == null) return [];
    const q = mentionQuery.toLowerCase();
    return otherMembers.filter(m => (m.name || m.email || '').toLowerCase().includes(q)).slice(0, 6);
  }, [mentionQuery, otherMembers]);

  // ── Send / Edit ───────────────────────────────────────────
  const onSend = useCallback(async (silent = false) => {
    const text = input.trim();
    if (!text || sending) return;
    haptic(silent ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
    setSending(true);
    stopTypingIfActive();
    if (draftTimer.current) clearTimeout(draftTimer.current);
    clearDraft(chatId).catch(() => {});
    try {
      if (editingId != null) {
        // Edits go straight to the backend (no offline-queue support yet).
        const updated = await editMessage(chatId, editingId, text);
        setMessages(prev => prev.map(x => x.id === editingId ? { ...x, ...updated } : x));
        setEditingId(null);
        setInput('');
      } else {
        // Enqueue + add optimistic bubble immediately. If the one-shot
        // Invisible Ink toggle was on, stamp meta.invisibleInk and reset.
        const replyToId = replyTo?.id ?? null;
        // Keep only mentions whose "@Name" still appears in the final text.
        const mentions = mentionsRef.current.filter(mn => text.includes('@' + mn.name));
        const meta: any = { ...(nextInvisibleInk ? { invisibleInk: true } : {}), ...(mentions.length ? { mentions } : {}), ...(silent ? { silent: true } : {}) };
        const q = await enqueueText(chatId, text, { replyToId, meta: Object.keys(meta).length ? meta : null });
        mentionsRef.current = [];
        const optimistic: DisplayMessage = {
          id:        0,
          chatId,
          senderId:  meId ?? '',
          type:      'text',
          content:   text,
          meta,
          replyToId,
          editedAt:  null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          _tempId:   q.tempId,
          _state:    'pending',
        };
        setReplyTo(null);
        setNextInvisibleInk(false);
        setMessages(prev => [optimistic, ...prev]);
        setInput('');
        // The 'sent' / 'failed' queue events update this bubble's state.
      }
    } catch (e: any) {
      Alert.alert(editingId != null ? 'Edit failed' : 'Send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [input, sending, chatId, editingId, meId, replyTo, nextInvisibleInk, stopTypingIfActive]);

  // ── Long-press menu on a message bubble ───────────────────
  const onLongPressMessage = useCallback((msg: DisplayMessage, plain: string) => {
    haptic(Haptics.ImpactFeedbackStyle.Medium);
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

    // Normal server-confirmed bubble → custom bottom-sheet action menu.
    setActionSheet({ msg, plain });
  }, [meId, chatId]);

  // Build the action-sheet tiles for a message — reuses the existing handlers.
  const buildSheetActions = useCallback((msg: DisplayMessage, plain: string): SheetAction[] => {
    const isMine = msg.senderId === meId;
    const isPinned = pinnedId === String(msg.id);
    const acts: SheetAction[] = [
      { key: 'reply',   label: 'Reply',   icon: '↩️', onPress: () => setReplyTo(msg) },
      { key: 'pin',     label: isPinned ? 'Unpin' : 'Pin', icon: '📌', onPress: async () => {
          const next = isPinned ? null : msg.id;
          setPinnedId(next == null ? null : String(msg.id)); // optimistic
          try { await pinMessage(chatId, next); } catch (e: any) { Alert.alert('Could not pin', e?.message ?? 'Try again'); }
        } },
      { key: 'forward', label: 'Forward', icon: '↪️', onPress: () => openForward(msg) },
      { key: 'copy',    label: 'Copy',    icon: '📋', onPress: () => copyAndAutoClear(plain) },
      { key: 'star',    label: 'Star',    icon: '🔖', onPress: async () => {
          try { await addBookmark(msg.id, null); } catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
        } },
      { key: 'remind',  label: 'Remind',  icon: '⏰', onPress: () => router.push({
          pathname: '/message-reminder' as any,
          params: { chatId, messageId: String(msg.id), preview: (plain || msg.type).slice(0, 200) },
        }) },
    ];
    if (isMine && !msg.deletedAt) {
      acts.push({ key: 'edit', label: 'Edit', icon: '✏️', onPress: () => { setEditingId(msg.id); setInput(plain); } });
      acts.push({ key: 'delete', label: 'Delete', icon: '🗑️', danger: true, onPress: async () => {
          try {
            await deleteMessage(chatId, msg.id);
            setMessages(prev => prev.map(x => x.id === msg.id
              ? { ...x, content: null, deletedAt: new Date().toISOString(), type: 'system' } : x));
          } catch (e: any) { Alert.alert('Delete failed', e?.message ?? 'Try again'); }
        } });
    }
    return acts;
  }, [meId, chatId, router, pinnedId]);

  // ── Screenshot mode (P1 polish) ──────────────────────────
  // Apply the chat's per-user screenshot policy on mount, restore the
  // global-block default on unmount. While the chat is open AND mode is
  // `allow_notify` or `block` (where iOS still lets the OS screenshot),
  // subscribe to expo-screen-capture's screenshot listener and POST
  // /screenshot-captured so the other side gets a banner.
  //
  // Modes:
  //   allow / allow_notify → allowScreenCaptureAsync (no FLAG_SECURE)
  //   block / block_silent → preventScreenCaptureAsync (FLAG_SECURE)
  //   *_notify (and block on iOS) → also listen + report
  const [screenshotBanner, setScreenshotBanner] = useState<{ by: string; at: string } | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web' || !chat) return;
    const mode: ScreenshotMode = (chat.screenshotMode as ScreenshotMode) || 'block';
    const allowsCapture = mode === 'allow' || mode === 'allow_notify';
    const reportsCapture = mode === 'allow_notify' || mode === 'block';

    if (allowsCapture) {
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    } else {
      ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    }

    let sub: { remove: () => void } | null = null;
    if (reportsCapture) {
      try {
        sub = ScreenCapture.addScreenshotListener(() => {
          reportScreenshotCaptured(chatId).catch(() => {});
          // Record the capture in the on-device tamper-evident audit chain so it
          // surfaces in the Alerts tab (#41). Real local event — the inbound
          // "someone captured your content" alert is delivered separately (W7).
          recordScreenshotAttempt({ chatId, chatName: title }).catch(() => {});
          if (mode === 'allow_notify') {
            Alert.alert('Screenshot captured', 'The other side has been notified.');
          }
        });
      } catch { /* listener unsupported on some platforms — non-fatal */ }
    }

    return () => {
      sub?.remove();
      // Restore the global-block posture (matches _layout.tsx default)
      ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    };
  }, [chat?.screenshotMode, chatId]);

  // Auto-dismiss the inbound screenshot banner after 4 seconds.
  useEffect(() => {
    if (!screenshotBanner) return;
    const t = setTimeout(() => setScreenshotBanner(null), 4000);
    return () => clearTimeout(t);
  }, [screenshotBanner]);

  // Screenshot-mode picker (header menu entry)
  const openScreenshotPicker = useCallback(() => {
    if (!chat) return;
    const current = (chat.screenshotMode as ScreenshotMode) || 'block';
    const opts: { label: string; mode: ScreenshotMode }[] = [
      { label: 'Allow screenshots',          mode: 'allow' },
      { label: 'Allow & notify chat',        mode: 'allow_notify' },
      { label: 'Block screenshots',          mode: 'block' },
      { label: 'Block silently (no alert)',  mode: 'block_silent' },
    ];
    Alert.alert(
      'Screenshots in this chat',
      'Choose how screenshots are handled while you have this chat open.',
      [
        ...opts.map(o => ({
          text: `${current === o.mode ? '✓ ' : '   '}${o.label}`,
          onPress: async () => {
            if (current === o.mode) return;
            setChat(prev => prev ? { ...prev, screenshotMode: o.mode } : prev);
            try {
              await setScreenshotMode(chatId, o.mode);
            } catch (e: any) {
              setChat(prev => prev ? { ...prev, screenshotMode: current } : prev);
              Alert.alert('Save failed', e?.message ?? 'Try again');
            }
          },
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [chat, chatId]);

  // Disappearing-messages picker — Alert sheet, Off / 24h / 7d / 90d.
  // Any member can change the timer (privacy is shared, not admin-gated).
  // Existing messages keep whatever expires_at they got at insert time —
  // the new timer only affects future messages.
  const openDisappearingPicker = useCallback(() => {
    if (!chat) return;
    const current = chat.disappearingSeconds ?? null;
    const buttons: any[] = DISAPPEARING_PRESETS.map(opt => ({
      text: `${current === opt.seconds ? '✓ ' : '   '}${opt.label}`,
      onPress: async () => {
        if (current === opt.seconds) return;
        // Optimistic update; rollback on failure.
        setChat(prev => prev ? { ...prev, disappearingSeconds: opt.seconds } : prev);
        try {
          await setDisappearing(chatId, opt.seconds);
        } catch (e: any) {
          setChat(prev => prev ? { ...prev, disappearingSeconds: current } : prev);
          Alert.alert('Could not update', e?.message ?? 'Try again');
        }
      },
    }));
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(
      'Disappearing messages',
      'New messages in this chat will auto-delete after the chosen time. Existing messages are unaffected.',
      buttons,
    );
  }, [chat, chatId]);

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
      {
        text: chat.disappearingSeconds
          ? `⏱️ Disappearing: ${formatDisappearing(chat.disappearingSeconds)}`
          : '⏱️ Disappearing messages',
        onPress: () => openDisappearingPicker(),
      },
      {
        text: chat.vanishMode
          ? '💨 Vanish Mode: ON'
          : '💨 Vanish Mode: Off',
        onPress: async () => {
          const next = !chat.vanishMode;
          setChat(prev => prev ? { ...prev, vanishMode: next } : prev);
          try {
            await setVanishMode(chatId, next);
          } catch (e: any) {
            setChat(prev => prev ? { ...prev, vanishMode: !next } : prev);
            Alert.alert('Could not update Vanish Mode', e?.message ?? 'Try again');
          }
        },
      },
      {
        text: `📸 Screenshots: ${formatScreenshotMode((chat.screenshotMode as ScreenshotMode) || 'block')}`,
        onPress: () => openScreenshotPicker(),
      },
      {
        text: chat.hidden ? '👁️ Unhide chat' : '🕶️ Hide chat',
        onPress: async () => {
          const next = !chat.hidden;
          try {
            await setHidden(chatId, next);
            // If we just hid, drop back to the chat list — the chat won't
            // appear there any more (only via PIN-gated /hidden-chats).
            if (next) router.replace('/(tabs)/chats' as any);
            else setChat(prev => prev ? { ...prev, hidden: next } : prev);
          } catch (e: any) {
            Alert.alert('Could not update', e?.message ?? 'Try again');
          }
        },
      },
      {
        text: '📅 Schedule a message',
        onPress: () => router.push({
          pathname: '/schedule-message' as any,
          params: { chatId, peerName: peer?.name ?? chat.name ?? '' },
        }),
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
        text: '👻 Ghost Mode',
        onPress: () => router.push({
          pathname: '/ghost-mode' as any,
          params: { targetId: peer.userId, targetName: peer.name ?? peer.email ?? '' },
        }),
      });
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
    haptic();
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
      const msg = await sendMediaMessage(chatId, 'audio',
        { uri: r.uri, filename: r.filename, mime: r.mime },
        { metaExtra: {
          durationMs: r.durationMs,
          // Pre-computed 0..1 amplitude bars (length up to 32). Bubble
          // renders these without re-parsing the audio file.
          waveform: r.waveform,
        } },
      );
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

  // ── Invisible Ink: tilt-to-reveal subscription ────────────
  // Subscribe to DeviceMotion at ~100 ms cadence whenever an
  // invisible-ink message is on screen. Flip `tiltRevealed` true when
  // beta (front-back) or gamma (left-right) exceeds ~45° (0.78 rad).
  // We don't need the rotation history — just the current pose. Skipped
  // entirely on web (the API isn't available).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const hasAny = messages.some(m => m.meta?.invisibleInk);
    if (!hasAny) {
      if (tiltRevealed) setTiltRevealed(false);
      return;
    }
    let sub: { remove(): void } | null = null;
    let alive = true;
    (async () => {
      const ok = await DeviceMotion.isAvailableAsync().catch(() => false);
      if (!alive || !ok) return;
      DeviceMotion.setUpdateInterval(100);
      sub = DeviceMotion.addListener(({ rotation }) => {
        if (!rotation) return;
        const REVEAL_RAD = 0.78; // ~45°
        const revealed =
          Math.abs(rotation.beta  ?? 0) > REVEAL_RAD ||
          Math.abs(rotation.gamma ?? 0) > REVEAL_RAD;
        setTiltRevealed(prev => prev === revealed ? prev : revealed);
      });
    })();
    return () => { alive = false; sub?.remove(); };
  // intentional: only re-evaluate when the *presence* of invisible-ink
  // messages changes, not on every messages-array mutation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.some(m => m.meta?.invisibleInk)]);

  // ── Attach photo / video (with optional view-once) ────────
  // One unified picker. kind='images' → photo upload, type='image' message.
  //                    kind='videos' → video upload, type='video' message.
  // viewOnce=true sets a flag on the upload AND on the message meta so the
  // receiving bubble can render the "Tap to view once" UI and the server
  // can 410 the bytes after first non-owner view.
  const onPickMedia = useCallback(async (
    kind: 'images' | 'videos',
    opts: { viewOnce?: boolean } = {},
  ) => {
    if (sending) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', `Allow ${kind === 'videos' ? 'video' : 'photo'} library access to attach.`);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: [kind],
      quality:    kind === 'videos' ? 1 : 0.7,
      allowsEditing: false,
      videoMaxDuration: 60, // hard cap to keep upload size sane on free plan
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const isVideo = kind === 'videos';

    setSending(true);
    try {
      const filename = asset.fileName ||
        (isVideo ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`);
      const mime = asset.mimeType ||
        (isVideo ? 'video/mp4' : 'image/jpeg');
      const metaExtra: any = { width: asset.width, height: asset.height };
      if (isVideo && asset.duration) metaExtra.durationMs = asset.duration;
      const msg = await sendMediaMessage(chatId, isVideo ? 'video' : 'image',
        { uri: asset.uri, filename, mime },
        { viewOnce: !!opts.viewOnce, metaExtra },
      );
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
      const msg = await sendMediaMessage(chatId, 'file',
        { uri: asset.uri, filename, mime },
      );
      setMessages(prev => prev.some(x => x.id === msg.id) ? prev : [msg, ...prev]);
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, sending]);

  // ── Send a GIF (external Tenor URL — no upload; rendered from the URL) ──
  const sendGif = useCallback(async (url: string, preview: string) => {
    setGifOpen(false);
    if (!url) return;
    try {
      const msg = await sendMessage(chatId, '', 'image', { meta: { gifUrl: url, preview } });
      setMessages(prev => prev.some(x => x.id === msg.id) ? prev : [msg, ...prev]);
    } catch (e: any) {
      Alert.alert('Could not send GIF', e?.message ?? 'Try again');
    }
  }, [chatId]);

  // ── Attach menu (bottom sheet — U4) ───────────────────────
  // Photo / Video / View-once / Sticker / Invisible Ink / Poll / Location / File.
  const onPressAttach = useCallback(() => {
    if (sending) return;
    setAttachOpen(true);
  }, [sending]);

  const attachActions = useMemo(() => {
    const peer = chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId) : null;
    const peerName = peer?.name || chat?.name || '';
    return [
      { label: 'Photo',           icon: 'image' as const,      onPress: () => onPickMedia('images') },
      { label: 'Video',           icon: 'videocam' as const,   onPress: () => onPickMedia('videos') },
      { label: 'View-once photo', icon: 'eye' as const,        onPress: () => onPickMedia('images', { viewOnce: true }) },
      { label: 'View-once video', icon: 'eye-outline' as const, onPress: () => onPickMedia('videos', { viewOnce: true }) },
      { label: 'GIF',             icon: 'film' as const,       onPress: () => setGifOpen(true) },
      { label: 'Sticker',         icon: 'happy' as const,      onPress: () => router.push({ pathname: '/stickers' as any, params: { chatId, peerName } }) },
      { label: nextInvisibleInk ? 'Invisible Ink: armed — disarm' : 'Invisible Ink (next message)', icon: 'sparkles' as const, onPress: () => setNextInvisibleInk(v => !v) },
      { label: 'Poll',            icon: 'stats-chart' as const, onPress: () => router.push({ pathname: '/create-poll' as any, params: { chatId, peerName } }) },
      { label: 'Location',        icon: 'location' as const,   onPress: () => router.push({ pathname: '/location' as any, params: { chatId, name: peerName } }) },
      { label: 'File',            icon: 'document' as const,   onPress: onPickFile },
    ];
  }, [onPickMedia, onPickFile, router, chatId, chat, meId, nextInvisibleInk]);

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

  // Keep a ref to loaded messages for the jump-to-message paging loop.
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Jump to a specific message (from in-chat search): page older until it's
  // loaded, scroll to it, and briefly flash it.
  const jumpToMessage = useCallback(async (targetId: number) => {
    let idx = messagesRef.current.findIndex(m => m.id === targetId);
    let guard = 0;
    // Page back far enough to reach old matches (40 * PAGE_SIZE messages).
    while (idx < 0 && guard < 40) {
      guard++;
      const oldest = messagesRef.current[messagesRef.current.length - 1]?.id;
      if (!oldest) break;
      let older;
      try { older = await getMessages(chatId, { before: oldest, limit: PAGE_SIZE }); }
      catch { break; }
      if (!older.length) { setHasMore(false); break; }
      const next = [...messagesRef.current, ...older];
      messagesRef.current = next;
      setMessages(next);
      if (older.length < PAGE_SIZE) setHasMore(false);
      idx = next.findIndex(m => m.id === targetId);
    }
    if (idx < 0) return;
    const at = idx;
    requestAnimationFrame(() => {
      try { listRef.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.5 }); } catch {}
    });
    setFlashId(targetId);
    setTimeout(() => setFlashId(null), 2500);
  }, [chatId]);

  // Consume a pending jump when the screen regains focus (e.g. back from search).
  useFocusEffect(useCallback(() => {
    const target = consumePendingJump(chatId);
    if (target) jumpToMessage(target);
  }, [chatId, jumpToMessage]));

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

  // ── Memory Bubble (Emotional AI spec item) ────────────────
  // Pick the longest-ago message in this chat whose calendar (month, day)
  // matches today's. Skip messages younger than 364 days so "yesterday"
  // never qualifies. Returns null if nothing matches or the surfaced
  // candidate has already been dismissed this session.
  const memoryBubble = useMemo(() => {
    if (!messages.length) return null;
    const today = new Date();
    const todayMonth = today.getMonth();
    const todayDate  = today.getDate();
    const todayMs    = today.getTime();
    let pick: { msg: DisplayMessage; yearsAgo: number } | null = null;
    for (const m of messages) {
      if (!m.createdAt || !m.content || m.deletedAt) continue;
      if (m.type !== 'text') continue;                  // anniversary banner is text-only
      if (dismissedMemoryIds.has(m.id)) continue;
      const d = new Date(m.createdAt);
      if (Number.isNaN(d.getTime())) continue;
      if (d.getMonth() !== todayMonth || d.getDate() !== todayDate) continue;
      const ageMs = todayMs - d.getTime();
      if (ageMs < 364 * 86_400_000) continue;           // must be ≥1 year old
      const yearsAgo = Math.max(1, Math.round(ageMs / (365 * 86_400_000)));
      if (!pick || yearsAgo > pick.yearsAgo) pick = { msg: m, yearsAgo };
    }
    return pick;
  }, [messages, dismissedMemoryIds]);

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
        <ActivityIndicator color={colors.primary} size="large" />
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
          <Avatar
            uri={headerPhotoId && screenAuthHeader ? attachmentUrl(headerPhotoId) : null}
            headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined}
            name={title}
            size={40}
            presence={chat?.type === 'direct' && peerPresence?.online ? 'online' : null}
          />
        </View>
        <TouchableOpacity
          style={{ flex: 1 }}
          activeOpacity={chat?.type === 'direct' ? 0.6 : 1}
          disabled={chat?.type !== 'direct' || !meId}
          onPress={() => {
            if (chat?.type !== 'direct' || !meId) return;
            const peer = chat.members.find(m => m.userId !== meId);
            if (!peer) return;
            router.push({
              pathname: '/verify-contact' as any,
              params: { peerId: peer.userId, peerName: peer.name ?? peer.email ?? 'VaultChat user' },
            });
          }}
        >
          <Text style={S.title} numberOfLines={1}>{title}</Text>
          {chat && (
            <Text style={S.sub}>
              {headerSub}
              <Text style={S.e2eBadge}>  ·  </Text>
              <Ionicons name="lock-closed" size={11} color="#10B981" />
              <Text style={S.e2eBadge}> secured</Text>
            </Text>
          )}
        </TouchableOpacity>
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
            placeholderTextColor={colors.textDim}
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

      {/* Inbound screenshot alert — auto-dismisses after 4s */}
      {screenshotBanner && (
        <View style={S.screenshotBanner}>
          <Text style={S.screenshotBannerTxt}>
            📸 {(() => {
              const who = membersById.get(screenshotBanner.by);
              return who?.name || who?.email || 'Someone';
            })()} just captured a screenshot of this chat.
          </Text>
        </View>
      )}

      {/* Memory Bubble — anniversary of a past message in this chat */}
      {memoryBubble && (
        <TouchableOpacity
          style={S.memoryBubble}
          onPress={() => setDismissedMemoryIds(prev => {
            const next = new Set(prev); next.add(memoryBubble.msg.id); return next;
          })}
          activeOpacity={0.85}
        >
          <Text style={S.memoryBubbleTitle}>
            📅 {memoryBubble.yearsAgo === 1 ? '1 year ago today' : `${memoryBubble.yearsAgo} years ago today`}
            {(() => {
              const who = membersById.get(memoryBubble.msg.senderId);
              const name = who?.name || who?.email;
              return name ? ` · ${name} said` : '';
            })()}
          </Text>
          <Text style={S.memoryBubbleBody} numberOfLines={2}>
            “{memoryBubble.msg.content}”
          </Text>
          <Text style={S.memoryBubbleDismiss}>Tap to dismiss</Text>
        </TouchableOpacity>
      )}

      {/* Live-location banner — a peer is sharing live location */}
      {liveLoc && (
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: 'rgba(255,107,53,0.12)', borderWidth: 1, borderColor: 'rgba(255,107,53,0.4)' }}
          activeOpacity={0.85}
          onPress={() => Linking.openURL(`https://maps.google.com/?q=${liveLoc.latitude},${liveLoc.longitude}`).catch(() => {})}
        >
          <Text style={{ fontSize: 18 }}>📍</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#FF6B35', fontSize: 13, fontWeight: '700' }}>{membersById.get(liveLoc.userId)?.name || 'Someone'} is sharing live location</Text>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 1 }} numberOfLines={1}>{liveLoc.address || `${liveLoc.latitude.toFixed(5)}, ${liveLoc.longitude.toFixed(5)}`} · Open in Maps</Text>
          </View>
          <TouchableOpacity onPress={() => setLiveLoc(null)} hitSlop={8}><Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16 }}>✕</Text></TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Pinned-message bar (W15) — tap to jump, × to unpin. */}
      {pinnedId && (() => {
        const pm = messages.find(m => String(m.id) === pinnedId);
        const label = !pm ? 'Message'
          : pm.type === 'image' ? '📷 Photo' : pm.type === 'video' ? '🎥 Video'
          : pm.type === 'audio' ? '🎙️ Voice message' : pm.type === 'file' ? '📎 File'
          : pm.type === 'location' ? '📍 Location' : pm.type === 'poll' ? '📊 Poll' : 'Message';
        return (
          <TouchableOpacity style={S.pinnedBar} activeOpacity={0.8} onPress={() => jumpToMessage(Number(pinnedId))}>
            <Ionicons name="pin" size={15} color="#10B981" />
            <View style={{ flex: 1 }}>
              <Text style={S.pinnedBarTitle}>Pinned message</Text>
              <Text style={S.pinnedBarSub} numberOfLines={1}>{label}</Text>
            </View>
            <TouchableOpacity hitSlop={10} onPress={async () => { setPinnedId(null); try { await pinMessage(chatId, null); } catch {} }}>
              <Ionicons name="close" size={16} color={colors.textDim} />
            </TouchableOpacity>
          </TouchableOpacity>
        );
      })()}

      {/* Messages (inverted — newest at top of the array, visually at bottom) */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        inverted
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 }}
        renderItem={({ item, index }) => {
          // Inverted list: the older message is at index+1. Show a date chip
          // above the first (oldest) message of each calendar day.
          const older = messages[index + 1];
          const showDate = !older || !isSameCalendarDay(item.createdAt, older.createdAt);
          // Group with the older message when it's the same sender, same day, and
          // within 5 minutes (suppresses the repeated sender tag + tightens spacing).
          const grouped = !showDate && !!older && older.senderId === item.senderId &&
            item.type !== 'system' && older.type !== 'system' &&
            Math.abs(new Date(item.createdAt).getTime() - new Date(older.createdAt).getTime()) < 5 * 60 * 1000;
          return (
          <View>
            {showDate && <DateChip iso={item.createdAt} />}
            <SwipeToReply onReply={() => { if (!item.deletedAt && item.type !== 'system') setReplyTo(item); }}>
            <View style={item.id === flashId ? { backgroundColor: 'rgba(16,185,129,0.18)', borderRadius: 12 } : undefined}>
            <MemoBubble
              msg={item}
              meId={meId}
              member={membersById.get(item.senderId)}
              chatId={chatId}
              otherMembers={otherMembers}
              onLongPress={onLongPressMessage}
              reactionsForMsg={reactions[item.id]}
              onToggleReaction={(emoji) => toggleReaction(item, emoji)}
              replyTarget={item.replyToId ? replyById.get(item.replyToId) ?? null : null}
              replyTargetMember={item.replyToId
                ? (() => {
                    const t = replyById.get(item.replyToId);
                    return t ? membersById.get(t.senderId) : undefined;
                  })()
                : undefined}
              highlight={searchOpen && searchQ.trim().length > 0 ? searchQ.trim() : null}
              tiltRevealed={tiltRevealed}
              grouped={grouped}
              pollVotesForMsg={pollVotes[item.id]}
              onPollVoteChange={(next) => setPollVotes(prev => ({ ...prev, [item.id]: next }))}
            />
            </View>
            </SwipeToReply>
          </View>
          );
        }}
        onScrollToIndexFailed={(info) => {
          // Inverted, variable-height rows have no getItemLayout — approximate
          // then retry the precise scroll once layout settles.
          try { listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false }); } catch {}
          setTimeout(() => { try { listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 }); } catch {} }, 350);
        }}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        ListFooterComponent={loadingOlder ? <ActivityIndicator color={colors.primary} style={{ paddingVertical: 12 }} /> : null}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        windowSize={11}
        initialNumToRender={15}
      />

      {/* @mention picker (W15) — appears while typing "@name" in a group */}
      {mentionCandidates.length > 0 && (
        <View style={S.mentionBar}>
          {mentionCandidates.map(m => (
            <TouchableOpacity key={m.userId} style={S.mentionRow} onPress={() => pickMention(m)} activeOpacity={0.7}>
              <Avatar
                uri={m.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null}
                headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined}
                name={m.name || m.email || 'member'}
                size={28}
              />
              <Text style={S.mentionName} numberOfLines={1}>{m.name || m.email}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

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

      {/* Vanish Mode banner — shown above the composer when ON */}
      {chat?.vanishMode && (
        <View style={S.vanishBar}>
          <Text style={S.vanishBarTxt}>
            💨 Vanish Mode — new messages disappear after everyone reads them
          </Text>
        </View>
      )}

      {/* Invisible Ink banner — armed for one message; tap to disarm */}
      {nextInvisibleInk && (
        <TouchableOpacity
          style={S.inkBar}
          onPress={() => setNextInvisibleInk(false)}
          activeOpacity={0.7}
        >
          <Text style={S.inkBarTxt}>
            ✨ Next message will be Invisible Ink — recipient must tilt phone to read. Tap to disarm.
          </Text>
        </TouchableOpacity>
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
            placeholderTextColor={colors.textDim}
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
              onPress={() => onSend(false)}
              onLongPress={() => { if (input.trim() && !sending && editingId == null) onSend(true); }}
              delayLongPress={300}
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

      {/* Long-press action sheet (reactions + action grid) */}
      <MessageActionSheet
        visible={actionSheet != null}
        onClose={() => setActionSheet(null)}
        onReact={(e) => { if (actionSheet) toggleReaction(actionSheet.msg, e); }}
        actions={actionSheet ? buildSheetActions(actionSheet.msg, actionSheet.plain) : []}
      />

      {/* Attach menu (U4 bottom sheet) */}
      <Sheet
        visible={attachOpen}
        title="Attach"
        actions={attachActions}
        onClose={() => setAttachOpen(false)}
      />

      {/* GIF picker (W15) */}
      <GifPicker visible={gifOpen} onClose={() => setGifOpen(false)} onSelect={sendGif} />

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
              <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
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
// Color @mention tokens (e.g. "@Alex") in a message body.
function colorMentions(body: string): any {
  if (!body || body.indexOf('@') === -1) return body;
  const parts: any[] = [];
  const re = /@\w[\w]*/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(<Text key={`mn${m.index}`} style={HL.mention}>{m[0]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length ? parts : body;
}

function renderWithHighlight(body: string, q: string | null | undefined): any {
  if (!body) return body;
  if (!q) return colorMentions(body); // no active search → color @mentions
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
      <Text key={`h${idx}`} style={HL.highlight}>{body.slice(idx, idx + q.length)}</Text>,
    );
    i = idx + q.length;
  }
  return parts;
}

// Detect URLs in `body` and tokenise into alternating plain / link chunks.
// Each link chunk becomes a tappable <Text> that opens the URL via Linking.
// Trailing punctuation (.,!?;:) is excluded from the link match so a URL
// at the end of a sentence doesn't include the trailing dot.
// Privacy: no remote fetch — we render the URL inline, not a rich card.
// (Server-proxied OG previews are a follow-up; opengraph.io with a sample
// key would leak every messaged URL to a third party.)
const URL_RE = /https?:\/\/[^\s]+?(?=[.,!?;:)]*(?:\s|$))/g;
function renderRichText(body: string, q: string | null | undefined): any {
  if (!body) return body;
  // No URLs? Defer to the existing highlight renderer.
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(body)) return renderWithHighlight(body, q);

  URL_RE.lastIndex = 0;
  const parts: any[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(body)) !== null) {
    if (m.index > cursor) {
      parts.push(renderWithHighlight(body.slice(cursor, m.index), q));
    }
    const url = m[0];
    parts.push(
      <Text
        key={`u${m.index}`}
        style={HL.link}
        onPress={() => Linking.openURL(url).catch(() => {})}
      >
        {renderWithHighlight(url, q)}
      </Text>,
    );
    cursor = m.index + url.length;
  }
  if (cursor < body.length) parts.push(renderWithHighlight(body.slice(cursor), q));
  return parts;
}

// Invisible Ink: replace each non-whitespace char with a bullet. Keep
// whitespace as-is so word boundaries are preserved (otherwise the
// obscured text reads as one long blob).
function obscureForInk(plain: string): string {
  return plain.replace(/\S/g, '●');
}

// Pretty-print the screenshot-mode for header-menu display.
function formatScreenshotMode(mode: ScreenshotMode): string {
  switch (mode) {
    case 'allow':         return 'Allowed';
    case 'allow_notify':  return 'Allowed + notify';
    case 'block_silent':  return 'Blocked silently';
    case 'block':
    default:              return 'Blocked';
  }
}

// Pretty-print a disappearing-messages timer (e.g. "24 h", "7 d", "90 d").
function formatDisappearing(seconds: number | null | undefined): string {
  if (!seconds) return 'Off';
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600  === 0) return `${seconds / 3600} h`;
  if (seconds % 60    === 0) return `${seconds / 60} m`;
  return `${seconds} s`;
}

const DISAPPEARING_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'Off',      seconds: null },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days',   seconds: 7 * 86400 },
  { label: '90 days',  seconds: 90 * 86400 },
];

// Time-to-live remaining on an expiring message ("23h", "5d", "2m").
// Past-due returns "expiring" so the bubble visibly indicates pending wipe.
function formatTtlRemaining(iso: string): string {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'expiring';
    if (ms < 60_000)        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    if (ms < 3600_000)      return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86400_000)     return `${Math.floor(ms / 3600_000)}h`;
    return `${Math.floor(ms / 86400_000)}d`;
  } catch { return ''; }
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

// Apply a ±1 patch to the per-message poll vote summary, optimistic-style.
// Used both by the user's own tap (via PollBubble.onChange) and by inbound
// socket events. Removes the bucket entirely when the count hits zero so
// the UI doesn't render a "0" pill. `fromMe` updates the caller's `mine`
// list (which drives the radio/check selected state).
function bumpPollVote(
  prev: Record<number, PollVoteSummary>,
  messageId: number,
  optionIndex: number,
  delta: 1 | -1,
  fromMe: boolean,
): Record<number, PollVoteSummary> {
  const cur = prev[messageId] ?? { counts: {}, mine: [], total: 0 };
  const key = String(optionIndex);
  const oldCount = cur.counts[key] || 0;
  const newCount = Math.max(0, oldCount + delta);
  const counts = { ...cur.counts };
  if (newCount === 0) delete counts[key]; else counts[key] = newCount;
  let mine = cur.mine;
  if (fromMe) {
    if (delta > 0) {
      if (!mine.includes(optionIndex)) mine = [...mine, optionIndex];
    } else {
      mine = mine.filter(x => x !== optionIndex);
    }
  }
  const total = Math.max(0, cur.total + delta);
  return { ...prev, [messageId]: { counts, mine, total } };
}

// ─── Poll bubble (in-chat voting) ────────────────────────────
// Renders the question + the options as horizontal rows with a fill bar
// per option (proportional to votes/total). Tapping an option toggles
// the caller's vote; single-vote polls auto-switch the active option.
// The PollBubble is "dumb" — it reads `votes` from props and calls
// `onChange` with the optimistic next state. The chat screen owns the
// authoritative store + socket reconciliation.
function PollBubble({
  chatId, msg, isMine, votes, onChange,
}: {
  chatId:   string;
  msg:      DisplayMessage;
  isMine:   boolean;
  votes?:   PollVoteSummary;
  onChange?: (next: PollVoteSummary) => void;
}) {
  const S = useS();
  const options: string[]    = Array.isArray(msg.meta?.options) ? msg.meta.options : [];
  const allowMultiple = !!msg.meta?.allowMultiple;
  const counts = votes?.counts ?? {};
  const mine   = votes?.mine ?? [];
  const total  = votes?.total ?? 0;

  const [pending, setPending] = useState<number | null>(null);

  const toggle = useCallback(async (idx: number) => {
    if (pending != null) return;
    const wasMine = mine.includes(idx);

    // Optimistic patch — pivots immediately, server reconciles via
    // 'poll_voted' / 'poll_unvoted' events on the socket.
    let next: PollVoteSummary = { counts: { ...counts }, mine: [...mine], total };
    if (wasMine) {
      next = bumpPollVote({ [msg.id]: next }, msg.id, idx, -1, true)[msg.id];
    } else {
      // Single-vote polls: remove existing mine vote(s) first.
      if (!allowMultiple) {
        for (const otherIdx of mine) {
          next = bumpPollVote({ [msg.id]: next }, msg.id, otherIdx, -1, true)[msg.id];
        }
      }
      next = bumpPollVote({ [msg.id]: next }, msg.id, idx, +1, true)[msg.id];
    }
    onChange?.(next);

    setPending(idx);
    try {
      if (wasMine) {
        await unvotePoll(chatId, msg.id, idx);
      } else {
        await voteOnPoll(chatId, msg.id, idx);
      }
    } catch (e: any) {
      // Rollback — server reject means our optimistic state is wrong.
      Alert.alert('Vote failed', e?.message ?? 'Try again');
      onChange?.({ counts, mine, total });
    } finally {
      setPending(null);
    }
  }, [pending, mine, counts, total, allowMultiple, chatId, msg.id, onChange]);

  return (
    <View style={S.pollWrap}>
      <Text style={[S.pollQuestion, isMine && S.pollQuestionMine]} numberOfLines={3}>
        {msg.content}
      </Text>
      {options.map((label, idx) => {
        const c       = counts[String(idx)] || 0;
        const pct     = total > 0 ? c / total : 0;
        const checked = mine.includes(idx);
        return (
          <TouchableOpacity
            key={idx}
            style={S.pollOptionRow}
            onPress={() => toggle(idx)}
            activeOpacity={0.7}
            disabled={pending != null}
          >
            <Text style={[S.pollOptionMark, checked && S.pollOptionMarkOn]}>
              {checked ? (allowMultiple ? '☑' : '◉') : (allowMultiple ? '☐' : '○')}
            </Text>
            <View style={{ flex: 1 }}>
              <View style={S.pollOptionLine}>
                <Text style={[S.pollOptionLabel, isMine && S.pollOptionLabelMine]} numberOfLines={2}>
                  {label}
                </Text>
                <Text style={[S.pollOptionCount, isMine && S.pollOptionCountMine]}>
                  {c}
                </Text>
              </View>
              <View style={S.pollBarTrack}>
                <View
                  style={[
                    S.pollBarFill,
                    isMine && S.pollBarFillMine,
                    { width: `${Math.round(pct * 100)}%` },
                  ]}
                />
              </View>
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={[S.pollFooter, isMine && S.pollFooterMine]}>
        {total} {total === 1 ? 'vote' : 'votes'} · {allowMultiple ? 'multiple answers' : 'single answer'}
      </Text>
    </View>
  );
}

// ─── File bubble (documents) ─────────────────────────────────
// Tap to download (FileSystem) and open with the OS share sheet
// (Sharing.shareAsync). The /uploads route is auth-gated so we pass
// the Bearer header on the download request.
function FileBubble({
  attachmentId, filename, mime, size, authHeader, resolvedUri, isMine,
}: {
  attachmentId: string;
  filename:     string;
  mime:         string;
  size:         number;
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
}) {
  const S = useS();
  const [busy, setBusy] = useState(false);

  const onOpen = useCallback(async () => {
    if (busy) return;
    // Encrypted files resolve to a local decrypted file (no auth header); plaintext
    // files still need the Bearer header to download from /uploads.
    if (!resolvedUri && !authHeader) return;
    setBusy(true);
    try {
      const safe = (filename || `file-${attachmentId}`).replace(/[/\\:*?"<>|]/g, '_');
      const dest = `${(FileSystem as any).cacheDirectory}${safe}`;
      let outUri: string;
      if (resolvedUri && !resolvedUri.headers) {
        // Already a decrypted local file — copy to a nicely-named path, then share.
        await (FileSystem as any).copyAsync({ from: resolvedUri.uri, to: dest }).catch(() => {});
        const info = await (FileSystem as any).getInfoAsync(dest);
        outUri = info?.exists ? dest : resolvedUri.uri;
      } else {
        const url = resolvedUri?.uri ?? attachmentUrl(attachmentId);
        const headers = resolvedUri?.headers ?? { Authorization: authHeader as string };
        const dl = await (FileSystem as any).downloadAsync(url, dest, { headers });
        if (dl.status !== 200) throw new Error(`Download failed (HTTP ${dl.status})`);
        outUri = dl.uri;
      }

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(outUri, { mimeType: mime, dialogTitle: filename });
      } else {
        Alert.alert('File saved', `Saved to ${outUri}`);
      }
    } catch (e: any) {
      Alert.alert('Could not open file', e?.message ?? 'Try again');
    } finally {
      setBusy(false);
    }
  }, [attachmentId, filename, mime, authHeader, resolvedUri, busy]);

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
  attachmentId, durationMs, waveform, authHeader, resolvedUri, isMine,
}: {
  attachmentId: string;
  durationMs:   number;
  waveform?:    number[];
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
}) {
  const S = useS();
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
    // Encrypted voice notes play from a local decrypted file (no header); plaintext
    // ones stream from /uploads with the Bearer header.
    const src = resolvedUri
      ?? (authHeader ? { uri: attachmentUrl(attachmentId), headers: { Authorization: authHeader } } : null);
    if (!src) return;
    try {
      if (playing) {
        await soundRef.current?.pauseAsync();
        setPlaying(false);
        return;
      }
      if (!soundRef.current) {
        const { sound } = await Audio.Sound.createAsync(
          src,
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
  }, [attachmentId, authHeader, resolvedUri, playing]);

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
        {waveform && waveform.length > 0 ? (
          // Telegram-style bars. Each bar height is amplitude*MAX. Bars
          // up to playback position are filled; the rest are dimmed.
          <View style={S.waveBars}>
            {waveform.map((amp, i) => {
              const barPct = (i + 0.5) / waveform.length;
              const played = barPct <= pct;
              return (
                <View
                  key={i}
                  style={[
                    S.waveBar,
                    { height: Math.max(3, Math.min(1, amp) * 24) },
                    isMine
                      ? (played ? S.waveBarPlayedMine : S.waveBarUnplayedMine)
                      : (played ? S.waveBarPlayedTheirs : S.waveBarUnplayedTheirs),
                  ]}
                />
              );
            })}
          </View>
        ) : (
          <View style={S.audioTrack}>
            <View style={[S.audioFill, { width: `${pct * 100}%` }, isMine && S.audioFillMine]} />
          </View>
        )}
        <Text style={[S.audioTime, isMine && S.audioTimeMine]}>
          {playing
            ? `${formatRecDuration(position)} / ${formatRecDuration(durationMs)}`
            : `🎙️ ${formatRecDuration(durationMs)}${remaining > 0 ? '' : ''}`}
        </Text>
      </View>
    </View>
  );
}

// ─── Video bubble ────────────────────────────────────────────
// Inline player using expo-av's <Video>. Tap = native controls, no
// autoplay. Streams the auth-gated /uploads endpoint via the Bearer
// header. onLoadError surfaces 410-Gone (view-once consumed) so the
// MessageBubble can flip to a "Viewed" tombstone without an extra
// HEAD round-trip.
function VideoBubble({
  attachmentId, durationMs, authHeader, resolvedUri, onErrorOnce,
}: {
  attachmentId:  string;
  durationMs:    number;
  authHeader:    string | null;
  resolvedUri?:  { uri: string; headers?: Record<string, string> } | null;
  onErrorOnce?:  () => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  // Encrypted videos play from a local decrypted file; plaintext stream from
  // /uploads with the Bearer header.
  const src = resolvedUri
    ?? (authHeader ? { uri: attachmentUrl(attachmentId), headers: { Authorization: authHeader } } : null);
  if (!src) {
    return (
      <View style={S.videoLoading}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  return (
    <View style={S.videoWrap}>
      <Video
        source={src}
        style={S.videoView}
        useNativeControls
        resizeMode={ResizeMode.COVER}
        isLooping={false}
        shouldPlay={false}
        onError={() => onErrorOnce?.()}
      />
      {durationMs > 0 && (
        <Text style={S.videoDuration}>{formatRecDuration(durationMs)}</Text>
      )}
    </View>
  );
}

// ── Date separators (U6) ─────────────────────────────────────────────
function isSameCalendarDay(a: string, b: string): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (isSameCalendarDay(iso, now.toISOString())) return 'Today';
  if (isSameCalendarDay(iso, yest.toISOString())) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function DateChip({ iso }: { iso: string }) {
  const S = useS();
  return (
    <View style={S.dateChipRow}>
      <View style={S.dateChip}><Text style={S.dateChipTxt}>{dayLabel(iso)}</Text></View>
    </View>
  );
}

// Swipe-right on a message to reply (WhatsApp/Signal gesture). Reveals a reply
// arrow; crossing the threshold fires onReply once and snaps back.
function SwipeToReply({ onReply, children }: { onReply: () => void; children: React.ReactNode }) {
  const ref = useRef<Swipeable>(null);
  return (
    <Swipeable
      ref={ref}
      friction={2}
      leftThreshold={44}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={{ justifyContent: 'center', paddingLeft: 18 }}>
          <Ionicons name="arrow-undo" size={22} color="#9CA3AF" />
        </View>
      )}
      onSwipeableWillOpen={() => {
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onReply();
        requestAnimationFrame(() => ref.current?.close());
      }}
    >
      {children}
    </Swipeable>
  );
}

function MessageBubble({
  msg, meId, member, chatId, otherMembers, onLongPress,
  reactionsForMsg, onToggleReaction,
  replyTarget, replyTargetMember,
  highlight, tiltRevealed, grouped,
  pollVotesForMsg, onPollVoteChange,
}: {
  msg: DisplayMessage;
  meId: string | null;
  member?: ChatMember;
  chatId: string;
  otherMembers: ChatMember[];
  onLongPress: (msg: DisplayMessage, plain: string) => void;
  grouped?: boolean; // true when grouped with the previous (older) same-sender msg
  reactionsForMsg?: ReactionSummary[];
  onToggleReaction?: (emoji: string) => void;
  replyTarget?: DisplayMessage | null;
  replyTargetMember?: ChatMember;
  highlight?: string | null;
  // Recipient-only Invisible Ink reveal — flipped true by the chat-screen
  // DeviceMotion subscription when phone is tilted past ~45°.
  tiltRevealed?: boolean;
  // Poll-bubble plumbing: vote summary for this message + a callback the
  // bubble can call after a successful vote/unvote to patch screen state.
  pollVotesForMsg?: PollVoteSummary;
  onPollVoteChange?: (next: PollVoteSummary) => void;
}) {
  const { colors } = useTheme();
  const S = useS();
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
      const text = await decryptFromChat(chatId, msg.senderId, msg.content, msg.id);
      if (!cancel) setPlain(text);
    })();
    return () => { cancel = true; };
  }, [msg.content, msg.senderId, chatId]);

  // A live-location message carries the per-session key (content.lk) E2E. Stash
  // it so the socket relay's opaque blobs from this sender can be decrypted.
  useEffect(() => {
    if (msg.type !== 'location' || !plain) return;
    try {
      const L = JSON.parse(plain);
      if (L?.live && typeof L.lk === 'string') putLiveKey(chatId, msg.senderId, L.lk);
    } catch { /* not a JSON location payload */ }
  }, [plain, msg.type, msg.senderId, chatId]);

  useEffect(() => {
    if (!replyTarget) { setReplyPlain(''); return; }
    let cancel = false;
    (async () => {
      const t = await decryptFromChat(chatId, replyTarget.senderId, replyTarget.content, replyTarget.id);
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

  // W6 media-at-rest: for ENCRYPTED attachments (meta.encrypted), stash the
  // per-file key from the decrypted content, then resolve a decrypted local
  // file:// URI to render. Plaintext media is untouched — the bubbles render the
  // auth-gated /uploads URL directly, exactly as before.
  const [mediaSrc, setMediaSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const isEncMedia = !!msg.meta?.encrypted && !!msg.meta?.attachmentId &&
    (msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'file');
  useEffect(() => {
    if (!isEncMedia) { setMediaSrc(null); return; }
    let cancel = false;
    (async () => {
      try {
        if (plain) await parseMediaContent(msg.meta.attachmentId, plain); // stash key
        const r = await getDecryptedAttachmentUri(msg.meta.attachmentId);  // download + decrypt
        if (!cancel) setMediaSrc(r);
      } catch { if (!cancel) setMediaSrc(null); }
    })();
    return () => { cancel = true; };
  }, [isEncMedia, plain, msg.meta?.attachmentId]);

  if (msg.deletedAt) {
    return (
      <View style={[S.bubble, S.bubbleSystem]}>
        <Text style={S.bubbleSystemTxt}>Message deleted</Text>
      </View>
    );
  }

  const isGif   = msg.type === 'image' && !!msg.meta?.gifUrl;
  const isImage = msg.type === 'image' && msg.meta?.attachmentId && !isGif;
  const isVideo = msg.type === 'video' && msg.meta?.attachmentId;
  const isAudio = msg.type === 'audio' && msg.meta?.attachmentId;
  const isFile  = msg.type === 'file'  && msg.meta?.attachmentId;
  const isSticker = msg.type === 'sticker' && !!msg.content;
  const isPoll  = msg.type === 'poll' && Array.isArray(msg.meta?.options);
  const isLocation = msg.type === 'location';

  // ── View-once gate (P1) ──────────────────────────────────
  // Only photo/video honor view-once. Owner (sender) sees the media
  // normally — they can re-watch their own send. Non-owners get a
  // tap-to-reveal shield; on tap we POST /viewed and reveal once.
  // If the GET returns 410 (already consumed by another viewer) the
  // Image/Video onError fires and we flip to the tombstone.
  const isViewOnceMedia = !!msg.meta?.viewOnce && (isImage || isVideo);
  const [revealed,  setRevealed]  = useState<boolean>(!isViewOnceMedia || isMine);
  const [tombstoned, setTombstoned] = useState<boolean>(false);
  const handleRevealViewOnce = useCallback(async () => {
    if (revealed) return;
    setRevealed(true);
    try { await markAttachmentViewed(msg.meta.attachmentId); } catch { /* best-effort */ }
  }, [revealed, msg.meta?.attachmentId]);

  return (
    <View style={[S.bubbleRow, isMine ? S.bubbleRowMine : S.bubbleRowTheirs, grouped && S.bubbleRowGrouped]}>
      <TouchableOpacity
        style={[
          S.bubble,
          isMine ? S.bubbleMine : S.bubbleTheirs,
          // Soften the tail corner on grouped (consecutive) messages.
          grouped && (isMine ? { borderTopRightRadius: 16 } : { borderTopLeftRadius: 16 }),
          isImage   && S.imageBubble,
          isSticker && S.stickerBubble,
          msg._state === 'pending' && S.bubblePending,
          msg._state === 'failed'  && S.bubbleFailed,
        ]}
        onPress={() => { if (msg._state === 'failed') onLongPress(msg, plain); }}
        onLongPress={() => onLongPress(msg, plain)}
        delayLongPress={250}
        activeOpacity={0.85}
      >
        {!isMine && member && !isSticker && !grouped && (
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

        {/* View-once tombstone — replaces media after it's been viewed */}
        {(isImage || isVideo) && tombstoned ? (
          <View style={S.viewOnceTombstone}>
            <Text style={S.viewOnceTombstoneTxt}>👁️ {isImage ? 'Photo' : 'Video'} viewed</Text>
          </View>
        ) : isViewOnceMedia && !revealed ? (
          <TouchableOpacity
            style={S.viewOnceShield}
            onPress={handleRevealViewOnce}
            activeOpacity={0.7}
          >
            <Text style={S.viewOnceShieldIcon}>👁️</Text>
            <Text style={S.viewOnceShieldTxt}>Tap to view {isImage ? 'photo' : 'video'} once</Text>
            <Text style={S.viewOnceShieldHint}>
              From {member?.name || member?.email || 'sender'} · disappears after one view
            </Text>
          </TouchableOpacity>
        ) : isGif ? (
          <Image
            source={{ uri: msg.meta.gifUrl }}
            style={S.attachedImage}
            resizeMode="cover"
          />
        ) : isImage ? (
          (isEncMedia ? mediaSrc : (authHeader ? { uri: attachmentUrl(msg.meta.attachmentId), headers: { Authorization: authHeader } } : null)) ? (
            <Image
              source={isEncMedia ? mediaSrc! : { uri: attachmentUrl(msg.meta.attachmentId), headers: { Authorization: authHeader! } }}
              style={S.attachedImage}
              resizeMode="cover"
              onError={() => { if (isViewOnceMedia && !isMine) setTombstoned(true); }}
            />
          ) : (
            <View style={S.imageError}>
              <Text style={S.imageErrorTxt}>Loading image…</Text>
            </View>
          )
        ) : isVideo ? (
          <VideoBubble
            attachmentId={msg.meta.attachmentId}
            durationMs={Number(msg.meta?.durationMs) || 0}
            authHeader={authHeader}
            resolvedUri={isEncMedia ? mediaSrc : undefined}
            onErrorOnce={() => { if (isViewOnceMedia && !isMine) setTombstoned(true); }}
          />
        ) : isAudio ? (
          <AudioBubble
            attachmentId={msg.meta.attachmentId}
            durationMs={Number(msg.meta?.durationMs) || 0}
            waveform={Array.isArray(msg.meta?.waveform) ? msg.meta.waveform : undefined}
            authHeader={authHeader}
            resolvedUri={isEncMedia ? mediaSrc : undefined}
            isMine={isMine}
          />
        ) : isFile ? (
          <FileBubble
            attachmentId={msg.meta.attachmentId}
            filename={String(msg.meta?.filename || 'file')}
            mime={String(msg.meta?.mime || 'application/octet-stream')}
            size={Number(msg.meta?.size) || 0}
            authHeader={authHeader}
            resolvedUri={isEncMedia ? mediaSrc : undefined}
            isMine={isMine}
          />
        ) : isSticker ? (
          <Text style={S.stickerEmoji}>{msg.content}</Text>
        ) : isPoll ? (
          <PollBubble
            chatId={chatId}
            msg={msg}
            isMine={isMine}
            votes={pollVotesForMsg}
            onChange={onPollVoteChange}
          />
        ) : isLocation ? (() => {
          // A 'location' message's (decrypted) content is JSON {lat,lng,address}.
          let L: any = null; try { L = JSON.parse(plain || '{}'); } catch {}
          const ok = L && typeof L.lat === 'number' && typeof L.lng === 'number';
          return (
            <TouchableOpacity
              disabled={!ok}
              activeOpacity={0.85}
              onPress={() => { if (ok) Linking.openURL(`https://www.google.com/maps?q=${L.lat},${L.lng}`).catch(() => {}); }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 190 }}>
                <Text style={{ fontSize: 24 }}>📍</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontWeight: '700' }]}>
                    {L?.live ? 'Live location' : 'Location'}
                  </Text>
                  {ok && !!L.address && (
                    <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontSize: 12, opacity: 0.85 }]} numberOfLines={2}>
                      {L.address}
                    </Text>
                  )}
                  {ok && <Text style={{ color: '#4A9FFF', fontSize: 12, fontWeight: '700', marginTop: 2 }}>Open in Maps ›</Text>}
                </View>
              </View>
            </TouchableOpacity>
          );
        })() : (
          plain ? (
            // Invisible Ink: recipient sees ●●●● until they tilt the
            // phone past 45°. Sender (isMine) always sees plaintext —
            // they obviously know what they sent.
            msg.meta?.invisibleInk && !isMine && !tiltRevealed ? (
              <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, S.invisibleInk]}>
                {obscureForInk(plain)}
              </Text>
            ) : (
              <>
                <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine]}>
                  {renderRichText(plain, highlight)}
                </Text>
                {(() => { const u = extractUrl(plain); return u ? <LinkPreview url={u} /> : null; })()}
              </>
            )
          ) : null
        )}

        <Text style={[S.bubbleMeta, !isMine && { color: colors.textDim }]}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {msg.editedAt ? ' · edited' : ''}
          {msg._state === 'pending' ? ' · sending…' : ''}
          {msg._state === 'failed'  ? ' · failed (tap to retry)' : ''}
          {msg.expiresAt && (
            <Text style={S.ttlBadge}> · ⏱️ {formatTtlRemaining(msg.expiresAt)}</Text>
          )}
          {msg.vanishAfterRead && (
            <Text style={S.vanishBadge}> · 💨 vanish</Text>
          )}
          {tickState && (
            <Ionicons
              name={tickState === 'pending' ? 'time-outline' : tickState === 'sent' ? 'checkmark' : 'checkmark-done'}
              size={14}
              color={tickState === 'read' ? '#4A9FFF' : colors.textDim}
              style={{ marginLeft: 3 }}
            />
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

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:        { flex: 1, backgroundColor: c.bg },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8 },
  headerIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerIcon:    { fontSize: 20 },
  headerAvatarWrap:  { width: 36, height: 36 },
  headerAvatar:      { width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  headerAvatarImg:   { width: '100%', height: '100%' },
  headerAvatarTxt:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  headerPresenceDot: { position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, backgroundColor: '#22C55E', borderWidth: 2, borderColor: c.bg },

  // Day 13 — in-chat search
  inChatSearchBar:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#0F1217', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  inChatSearchInput:  { flex: 1, color: c.text, backgroundColor: '#1F2937', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14 },
  inChatSearchCount:  { color: c.textDim, fontSize: 11, fontWeight: '600' },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 24 },
  title:         { color: c.text, fontSize: 18, fontWeight: '700' },
  sub:           { color: c.textDim, fontSize: 12 },
  e2eBadge:      { color: '#22C55E', fontSize: 11, fontWeight: '600' },

  errorBar:      { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  errorTxt:      { color: c.danger, fontSize: 12 },
  screenshotBanner:    { backgroundColor: 'rgba(252,211,77,0.14)', borderColor: 'rgba(252,211,77,0.5)', borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  // Memory Bubble — anniversary banner under the chat header. Distinct
  // from screenshot/error banners (purple) so the user reads it as a
  // "nostalgia" moment rather than an alert.
  memoryBubble:        { backgroundColor: 'rgba(180,160,255,0.10)', borderColor: 'rgba(180,160,255,0.35)', borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 10 },
  memoryBubbleTitle:   { color: '#C4B5FD', fontSize: 12, fontWeight: '700' },
  memoryBubbleBody:    { color: c.text, fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  memoryBubbleDismiss: { color: c.textDim, fontSize: 10, marginTop: 6 },
  screenshotBannerTxt: { color: '#FCD34D', fontSize: 12, fontWeight: '600' },

  mentionBar:    { backgroundColor: c.surfaceSolid, borderTopWidth: 1, borderTopColor: c.border, maxHeight: 220 },
  mentionRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  mentionName:   { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },

  pinnedBar:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderBottomWidth: 1, borderBottomColor: c.border },
  pinnedBarTitle:{ color: '#10B981', fontSize: 11, fontWeight: '700' },
  pinnedBarSub:  { color: c.textDim, fontSize: 12.5, marginTop: 1 },

  dateChipRow:   { alignItems: 'center', marginVertical: 10 },
  dateChip:      { backgroundColor: c.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  dateChipTxt:   { color: c.textDim, fontSize: 11.5, fontWeight: '700' },

  bubbleRow:     { marginVertical: 4, flexDirection: 'row' },
  bubbleRowGrouped: { marginTop: 1 }, // tighter spacing for consecutive same-sender msgs
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs:{ justifyContent: 'flex-start' },
  bubble:        { maxWidth: '78%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, gap: 2 },
  bubbleMine:    { backgroundColor: '#0E7256', borderTopRightRadius: 4 }, // brand emerald "sent"
  bubbleTheirs:  { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 4 }, // neutral "received" (themed)
  bubblePending: { opacity: 0.6 },
  bubbleFailed:  { borderWidth: 1, borderColor: c.danger, opacity: 0.85 },
  bubbleSystem:  { alignSelf: 'center', backgroundColor: 'transparent', paddingVertical: 4 },
  bubbleSystemTxt:{ color: c.textDim, fontSize: 11, fontStyle: 'italic' },
  senderTag:     { color: c.textDim, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  bubbleTxt:     { color: c.text, fontSize: 15, lineHeight: 20 },
  bubbleTxtMine: { color: '#fff' },
  bubbleMeta:    { color: 'rgba(255,255,255,0.5)', fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },
  ttlBadge:      { color: '#FCD34D', fontSize: 10, fontWeight: '700' },
  tick:          { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700' },
  tickRead:      { color: '#3B82F6',               fontSize: 11, fontWeight: '700' },

  typingBar:     { paddingHorizontal: 16, paddingBottom: 4 },
  typingTxt:     { color: c.textDim, fontSize: 12, fontStyle: 'italic' },

  editBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(108,99,255,0.12)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  // Vanish-Mode banner above the composer when chat.vanishMode is ON.
  vanishBar:     { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(252,211,77,0.10)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(252,211,77,0.40)' },
  vanishBarTxt:  { color: '#FCD34D', fontSize: 12, fontWeight: '600' },
  // 💨 badge inside the bubble meta line for messages stamped vanish_after_read.
  vanishBadge:   { color: '#FCD34D', fontSize: 10, fontWeight: '700' },
  // Invisible Ink obscured text: bullets render slightly tighter and a
  // touch dimmer than normal text so the bubble visibly reads as "covered".
  invisibleInk:  { letterSpacing: 1, opacity: 0.75 },
  // Composer banner when Invisible Ink is armed (matches vanishBar shape).
  inkBar:        { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: 'rgba(180,160,255,0.12)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(180,160,255,0.45)' },
  inkBarTxt:     { color: '#C4B5FD', fontSize: 12, fontWeight: '600' },
  editTxt:       { color: c.primary, fontSize: 12, fontWeight: '600' },
  editCancelTxt: { color: c.textDim, fontSize: 12 },

  composer:      { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, backgroundColor: '#0F1217' },
  attachBtn:     { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' },
  attachTxt:     { fontSize: 18 },

  // Recording-mode composer: pulse dot + timer + hint + cancel/send buttons
  recordingComposer: { alignItems: 'center', gap: 8 },
  recordingDot:    { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
  recordingTimer:  { color: c.text, fontSize: 16, fontWeight: '700', minWidth: 52, textAlign: 'center' },
  recordingHint:   { flex: 1, color: c.textDim, fontSize: 12 },
  recCancelBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' },
  recCancelTxt:    { color: c.danger, fontSize: 18, fontWeight: '700' },
  recSendBtn:      { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  recSendTxt:      { color: '#fff', fontSize: 18, fontWeight: '700' },

  // Voice-message bubble (playback): play/pause button + track + duration
  audioRow:           { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 200, maxWidth: 260 },
  audioPlayBtn:       { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  audioPlayBtnMine:   { backgroundColor: 'rgba(255,255,255,0.22)' },
  audioPlayBtnTheirs: { backgroundColor: c.primary },
  audioPlayIcon:      { color: '#fff', fontSize: 14, fontWeight: '700' },
  audioMeter:         { flex: 1, gap: 4 },
  audioTrack:         { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  audioFill:          { height: 4, backgroundColor: c.primary, borderRadius: 2 },

  // Waveform bars (Day 7 polish): 32 vertical bars sized by amplitude.
  // Played bars use the accent color; unplayed are dim so the playhead
  // is implicit. flex-end alignItems so all bars sit on the baseline.
  waveBars:               { flexDirection: 'row', alignItems: 'flex-end', height: 24, gap: 2 },
  waveBar:                { width: 3, borderRadius: 1.5 },
  waveBarPlayedMine:      { backgroundColor: '#fff' },
  waveBarUnplayedMine:    { backgroundColor: 'rgba(255,255,255,0.35)' },
  waveBarPlayedTheirs:    { backgroundColor: c.primary },
  waveBarUnplayedTheirs:  { backgroundColor: 'rgba(108,99,255,0.35)' },
  audioFillMine:      { backgroundColor: '#fff' },
  audioTime:          { color: c.textDim, fontSize: 11 },
  audioTimeMine:      { color: 'rgba(255,255,255,0.85)' },

  input:         { flex: 1, color: c.text, backgroundColor: '#1F2937', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 15 },
  sendBtn:       { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, justifyContent: 'center' },
  sendBtnOff:    { backgroundColor: '#374151' },
  sendTxt:       { color: '#fff', fontWeight: '700' },

  imageBubble:   { padding: 4, borderRadius: 12 },
  // Sticker: WhatsApp-style — transparent backdrop, no padding, just a
  // big emoji glyph. The bubble component still wraps it so long-press
  // (forward/reply/delete) works the same as any other message.
  stickerBubble: { backgroundColor: 'transparent', padding: 0 },
  stickerEmoji:  { fontSize: 72, lineHeight: 84 },

  // Poll bubble: question on top, options as rows with a horizontal fill
  // bar proportional to vote count, footer with totals + mode hint.
  pollWrap:               { minWidth: 240, maxWidth: 300, gap: 8 },
  pollQuestion:           { color: c.text, fontSize: 14, fontWeight: '700', marginBottom: 6 },
  pollQuestionMine:       { color: '#fff' },
  pollOptionRow:          { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  pollOptionMark:         { color: c.textDim, fontSize: 16, width: 18, textAlign: 'center' },
  pollOptionMarkOn:       { color: c.primary },
  pollOptionLine:         { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  pollOptionLabel:        { color: c.text, fontSize: 13, flex: 1 },
  pollOptionLabelMine:    { color: '#fff' },
  pollOptionCount:        { color: c.textDim, fontSize: 11, fontWeight: '700' },
  pollOptionCountMine:    { color: 'rgba(255,255,255,0.85)' },
  pollBarTrack:           { height: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  pollBarFill:            { height: 4, backgroundColor: c.primary, borderRadius: 2 },
  pollBarFillMine:        { backgroundColor: '#fff' },
  pollFooter:             { color: c.textDim, fontSize: 11, marginTop: 6 },
  pollFooterMine:         { color: 'rgba(255,255,255,0.7)' },
  attachedImage: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#0F1217' },
  imageError:    { width: 180, padding: 16, alignItems: 'center', gap: 4 },
  imageErrorTxt: { color: c.textDim, fontSize: 12 },

  // Video bubble — inline player with native controls + duration pill
  videoWrap:     { width: 240, height: 240, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000', position: 'relative' },
  videoView:     { width: '100%', height: '100%' },
  videoDuration: { position: 'absolute', right: 8, bottom: 8, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  videoLoading:  { width: 240, height: 240, borderRadius: 8, backgroundColor: '#0F1217', alignItems: 'center', justifyContent: 'center' },

  // View-once shield (before tap) + tombstone (after view)
  viewOnceShield:        { width: 220, padding: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(108,99,255,0.15)', borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed' },
  viewOnceShieldIcon:    { fontSize: 28 },
  viewOnceShieldTxt:     { color: c.text, fontSize: 14, fontWeight: '700' },
  viewOnceShieldHint:    { color: c.textDim, fontSize: 11, textAlign: 'center' },
  viewOnceTombstone:     { width: 220, padding: 16, borderRadius: 12, alignItems: 'center', backgroundColor: '#0F1217', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  viewOnceTombstoneTxt:  { color: c.textDim, fontSize: 12, fontStyle: 'italic' },

  // Day 9 — file bubble (documents)
  fileRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 220, maxWidth: 280 },
  fileIcon:       { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  fileIconMine:   { backgroundColor: 'rgba(255,255,255,0.22)' },
  fileIconTheirs: { backgroundColor: c.primary },
  fileIconTxt:    { fontSize: 18 },
  fileMeta:       { flex: 1, gap: 2 },
  fileName:       { color: c.text, fontSize: 14, fontWeight: '600' },
  fileNameMine:   { color: '#fff' },
  fileSize:       { color: c.textDim, fontSize: 11 },
  fileSizeMine:   { color: 'rgba(255,255,255,0.85)' },

  // Day 8 — reply bar above composer
  replyBar:        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#0F1217', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  replyBarLine:    { width: 3, alignSelf: 'stretch', backgroundColor: c.primary, borderRadius: 1.5 },
  replyBarTitle:   { color: c.primary, fontSize: 12, fontWeight: '700' },
  replyBarBody:    { color: c.text, fontSize: 13 },

  // Day 8 — inline reply preview inside a bubble
  replyPreview:        { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginBottom: 6, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 6 },
  replyPreviewLine:    { width: 2, backgroundColor: c.primary, borderRadius: 1 },
  replyPreviewWho:     { color: c.primary, fontSize: 11, fontWeight: '700' },
  replyPreviewBody:    { color: c.text, fontSize: 12 },

  // Day 8 — "↪ Forwarded" tag at top of bubble
  forwardedTag:        { color: c.textDim, fontSize: 11, fontStyle: 'italic', marginBottom: 2 },

  // Day 8 — reaction chips under a bubble
  reactionRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: -6, marginBottom: 6, paddingHorizontal: 4 },
  reactionRowMine:     { justifyContent: 'flex-end' },
  reactionRowTheirs:   { justifyContent: 'flex-start' },
  reactionChip:        { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, backgroundColor: '#1F2937', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  reactionChipMine:    { backgroundColor: 'rgba(108,99,255,0.25)', borderColor: c.primary },
  reactionChipEmoji:   { fontSize: 14 },
  reactionChipCount:   { color: c.textDim, fontSize: 11, fontWeight: '600' },
  reactionChipCountMine: { color: c.primary },

  // Day 8 — quick-react picker
  modalBackdrop:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  reactSheet:          { flexDirection: 'row', gap: 4, padding: 8, backgroundColor: '#1F2937', borderRadius: 32 },
  reactSheetBtn:       { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  reactSheetEmoji:     { fontSize: 26 },

  // Day 8 — forward chat picker
  forwardSheet:        { width: '100%', maxHeight: '70%', backgroundColor: '#0F1217', borderRadius: 16, padding: 16, gap: 8 },
  forwardTitle:        { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  forwardEmpty:        { color: c.textDim, textAlign: 'center', marginTop: 24 },
  forwardRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  forwardRowTxt:       { color: c.text, fontSize: 15, flex: 1 },
  forwardRowSub:       { color: c.textDim, fontSize: 11 },
});

// ── Memoized message bubble ──────────────────────────────────────────────
// Re-render a bubble only when its DATA changes. The function props
// (onLongPress / onToggleReaction / onPollVoteChange) are intentionally
// excluded from the comparison: each closure is keyed to the bubble's own msg
// (stable by id), so skipping a re-render when the data is unchanged is safe —
// and it's what stops one incoming message from re-rendering every visible
// bubble (the chat now scrolls/types smoothly on long threads).
function bubblePropsEqual(a: any, b: any): boolean {
  return (
    a.msg === b.msg &&
    a.meId === b.meId &&
    a.member === b.member &&
    a.chatId === b.chatId &&
    a.otherMembers === b.otherMembers &&
    a.reactionsForMsg === b.reactionsForMsg &&
    a.pollVotesForMsg === b.pollVotesForMsg &&
    a.replyTarget === b.replyTarget &&
    a.replyTargetMember === b.replyTargetMember &&
    a.highlight === b.highlight &&
    a.tiltRevealed === b.tiltRevealed &&
    a.grouped === b.grouped
  );
}
const MemoBubble = memo(MessageBubble, bubblePropsEqual);
