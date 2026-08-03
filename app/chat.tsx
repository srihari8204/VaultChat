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

import { BRAND_ACCENT, brandAlpha } from '../constants/theme';
import { Audio, ResizeMode, Video } from 'expo-av';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as ImagePicker from 'expo-image-picker';
import * as ScreenCapture from 'expo-screen-capture';
import { DeviceMotion } from 'expo-sensors';
import * as Sharing from 'expo-sharing';
import { recordScreenshotAttempt } from '../services/security/auditChain';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { consumePendingJump } from '../lib/chatJump';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { E2EE_ENABLED } from '../constants/flags';
import { getCachedMessages, cacheMessages, applyMessage, markCachedDeleted, getCachedMessagesByIds, getCachedChat } from '../lib/localDb';
import { saveDraft, getDraft, clearDraft } from '../lib/drafts';
import { playSent, playReceived } from '../lib/sounds';
import { NOTIF_CHANNELS } from '../lib/push';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { Sheet, Avatar, type SheetAction as MenuAction } from '../components/ui';
import { useChatViewers } from '../hooks/useChatViewers';
import { ViewerStack } from '../components/chat/ViewerStack';
import { getShareViewing } from '../lib/viewerPrefs';
import type { ViewerActivity } from '../lib/socket';
import LinkPreview, { extractUrl } from '../components/LinkPreview';
import { extractFirstUrl, fetchPreviewFromDevice, type LinkPreviewData } from '../lib/linkPreview';
import GifPicker from '../components/GifPicker';
import { LinearGradient } from 'expo-linear-gradient';
import { getWallpaper, type WallpaperConfig } from './chat-wallpaper';
import { getBubbleColors } from './chat-themes';
import { getLock, verifyBiometric, verifyPin, type LockedChat } from '../lib/chatLock';
import { preloadViewedOnce, isViewedOnce, isViewedOnceSync, markViewedOnce } from '../lib/viewOnceStore';
import { preloadRevoked, isRevokedSync, wipeRevokedMedia } from '../lib/protectedMedia';

// Pick black or white text for legibility on an arbitrary bubble color.
function idealText(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#fff';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0e0e14' : '#ffffff';
}
import { useTheme } from '../lib/theme';
import { type Palette, ELEVATION } from '../constants/theme';
import { getCurrentUserAsync } from './(constants)/authService';

// Fire-and-forget haptic (no-op on web / if unavailable).
const haptic = (style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) => {
  if (Platform.OS !== 'web') Haptics.impactAsync(style).catch(() => {});
};
import { MessageActionSheet, type SheetAction } from '../components/MessageActionSheet';
import { getAccessToken } from '../lib/api';
import { getLiveKey, putLiveKey, clearLiveKey, decryptPosition } from '../lib/liveLocationCrypto';
import { navigateTo, openNavigator, navigateFromUrl } from '../lib/nav/openNavigation';
import {
  addBookmark,
  attachmentUrl,
  getPollVotesBulk,
  type PollVoteSummary,
  unvotePoll,
  voteOnPoll,
  blockUser,
  decryptFromChat,
  forwardMessage,
  getChat,
  getMessages,
  hydrateMessages,
  looksEncrypted,
  listChats,
  listStoriesFeed,
  muteChat,
  pinMessage,
  reportScreenshotCaptured,
  resetChatSession,
  revokeAttachment,
  setChatNotifSound,
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
import { markReadDurable, markDeliveredDurable } from '../lib/receipts';
import { type MediaType } from '../lib/sendMedia';
import { enqueueMedia, cancelMedia, retryMedia, pendingForChat as mediaPendingForChat, on as onMediaOutbox } from '../lib/mediaOutbox';
import VaultBeamBubble from '../components/VaultBeamBubble';
import ConnectionBanner from '../components/ConnectionBanner';
import { startSend as vbStartSend } from '../lib/vaultBeamController';
import { isNativeStreamAvailable as vbNativeAvailable } from '../lib/vaultBeamStreamNative';
import { getDecryptedAttachmentUri, getAttachmentLocalUri, parseMediaContent } from '../lib/mediaAttachments';
import { shouldAutoDownloadNow } from '../lib/mediaPrefs';
import { ProgressRing } from '../components/ProgressRing';
import { getMedia, copyToCache } from '../lib/mediaStore';
import { thumbDataUri } from '../lib/thumbnails';
import {
  cancel as queueCancel,
  enqueueText,
  enqueueReaction,
  enqueueEdit,
  enqueueDelete,
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
  useConnectionState,
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
// Delete-for-everyone window — keep numerically identical to the server's
// REVOKE_WINDOW_MS (routes/chats.js). WhatsApp parity: 2 days 12 hours.
const REVOKE_WINDOW_MS = 60 * 60 * 60 * 1000;

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
  // `id` is the normal entry param; `chatId` is what the capture screens
  // (/camera, /video-notes, /image-editor) echo back when they router.replace
  // here with a freshly captured/edited file — accept either.
  const params = useLocalSearchParams<{
    id?: string; chatId?: string;
    capturedUri?: string; capturedType?: string; capturedViewOnce?: string;
  }>();
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();
  const chatId = ((params.id ?? params.chatId) ?? '') as string;

  // Keyboard avoidance, driven manually. edge-to-edge breaks adjustResize, and
  // KeyboardAvoidingView's "padding" left residual space after the keyboard
  // closed. Tracking the height ourselves resets cleanly to 0 on hide.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const h = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { s.remove(); h.remove(); };
  }, []);

  // Warm the "already viewed" set so view-once bubbles render as consumed
  // immediately (no flash of the shield) on first paint.
  useEffect(() => { preloadViewedOnce(); preloadRevoked(); }, []);

  const [meId,      setMeId]      = useState<string | null>(null);
  const [chat,      setChat]      = useState<ChatDetail | null>(null);
  const [messages,  setMessages]  = useState<DisplayMessage[]>([]);
  // Guaranteed-unique render list: dedupe by the SAME key the FlatList uses
  // (_tempId for optimistic rows, else id). No merge path — initial load, socket,
  // pagination, or an optimistic→real swap — can ever crash the list with a
  // duplicate key. Keeps the first occurrence (newest, since the list is inverted).
  const renderMessages = useMemo(() => {
    const seen = new Set<string>();
    const out: DisplayMessage[] = [];
    for (const m of messages) {
      if (m.type === 'reaction') continue;   // F4: reference messages, never timeline bubbles
      const k = m._tempId ?? String(m.id);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
    return out;
  }, [messages]);
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

  // ── Compose-time link preview (F5, WhatsApp model) ────────────────
  // While typing, if the draft contains a URL, the SENDER's device resolves the
  // preview (title/desc/thumb) and shows a card above the composer; on send it
  // rides INSIDE the E2EE payload. Receiver + server never touch the URL.
  const [composerLp, setComposerLp] = useState<{ url: string; data: LinkPreviewData } | null>(null);
  const lpDismissedRef = useRef<string | null>(null);   // user closed the card for this URL
  const lpInputRef = useRef('');
  useEffect(() => { lpInputRef.current = input; }, [input]);
  useEffect(() => {
    const url = extractFirstUrl(input);
    if (!url) { setComposerLp(null); lpDismissedRef.current = null; return; }
    if (composerLp?.url === url || lpDismissedRef.current === url) return;
    let cancel = false;
    const t = setTimeout(async () => {
      const data = await fetchPreviewFromDevice(url);
      if (!cancel && data && extractFirstUrl(lpInputRef.current ?? '') === url) setComposerLp({ url, data });
    }, 600);   // debounce — fetch once typing pauses
    return () => { cancel = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Media staged for sending, shown in a caption-preview before it goes out.
  // Every send path (gallery pick, camera, video note, edited photo) routes
  // through here so the user can add a caption (WhatsApp-style).
  // Staged media awaiting send — supports WhatsApp-style multi-select. Each
  // item carries its own caption + view-once; currentIdx is the one on screen.
  const [pendingItems, setPendingItems] = useState<Array<{
    uri: string; mediaType: 'image' | 'video'; filename: string; mime: string;
    viewOnce: boolean; metaExtra: Record<string, any>; caption: string;
  }>>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
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

  // ── E2EE reactions (F4, WhatsApp model) ─────────────────────────
  // Reactions are tiny E2E-encrypted reference messages in the ordered stream
  // ({reactsTo, op, emoji} sealed inside content — the server never reads them).
  // Derive the per-message map here: the LATEST reaction per (target, sender)
  // wins (one reaction per user per message), 'remove' clears it. The dedup by
  // (target, sender) also makes optimistic + server rows collapse to one.
  const mergedReactions = useMemo(() => {
    const latest = new Map<string, { at: string; emoji: string | null; mine: boolean; target: number }>();
    for (const m of messages) {
      if (m.type !== 'reaction' || !m.content || m.deletedAt) continue;
      let p: any; try { p = JSON.parse(m.content); } catch { continue; }
      const target = Number(p?.reactsTo);
      if (!Number.isFinite(target) || target <= 0) continue;
      const key = `${target}:${m.senderId}`;
      const at = `${m.createdAt ?? ''}#${String(m.id ?? 0).padStart(12, '0')}`;
      const prev = latest.get(key);
      if (prev && prev.at >= at) continue;
      latest.set(key, { at, emoji: p.op === 'remove' ? null : String(p.emoji || ''), mine: m.senderId === meId, target });
    }
    const out: Record<number, ReactionSummary[]> = {};
    for (const v of latest.values()) {
      if (!v.emoji) continue;
      const list = out[v.target] ?? (out[v.target] = []);
      const hit = list.find(r => r.emoji === v.emoji);
      if (hit) { hit.count++; hit.mine = hit.mine || v.mine; }
      else list.push({ emoji: v.emoji, count: 1, mine: v.mine });
    }
    return out;
  }, [messages, meId]);
  const [reactPicker, setReactPicker] = useState<DisplayMessage | null>(null);
  const [actionSheet, setActionSheet] = useState<{ msg: DisplayMessage; plain: string } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ title: string; actions: MenuAction[] } | null>(null);
  const [replyTo, setReplyTo]         = useState<DisplayMessage | null>(null);
  const [forwardMsg, setForwardMsg]   = useState<DisplayMessage | null>(null);
  const [forwardChats, setForwardChats] = useState<ChatSummary[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);

  const listRef = useRef<FlatList>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const [flashId, setFlashId] = useState<number | null>(null);
  // Scroll-to-bottom FAB (WhatsApp "↓ N new"): shown when scrolled up.
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [newSinceUp, setNewSinceUp] = useState(0);
  const atBottomRef = useRef(true);
  const [infoMsg, setInfoMsg] = useState<DisplayMessage | null>(null); // Message Info sheet
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

  // ── Live Chat Viewers (feature #58) — who's viewing this chat right now ──
  const [cvFocused, setCvFocused] = useState(true);
  const [cvShareOn, setCvShareOn] = useState(false);
  // Focus toggles emission on/off and re-reads the per-chat toggle (so a change
  // made in chat-info takes effect the moment you return).
  useFocusEffect(useCallback(() => {
    setCvFocused(true);
    if (chatId && chat) getShareViewing(chatId, chat.type !== 'direct').then(setCvShareOn).catch(() => {});
    return () => setCvFocused(false);
  }, [chatId, chat?.type]));
  const myViewerActivity: ViewerActivity = sending ? 'uploading' : (input.trim().length > 0 ? 'typing' : 'reading');
  const chatViewers = useChatViewers({ chatId, meId, enabled: cvShareOn, focused: cvFocused, activity: myViewerActivity });

  // O(1) reply-target lookup — replaces a per-bubble messages.find() on every
  // render (was O(n²) across the visible page).
  const replyById = useMemo(() => {
    const m = new Map<number, DisplayMessage>();
    for (const msg of messages) {
      if (typeof msg.id === 'number' && msg.id > 0) m.set(msg.id, msg);
    }
    return m;
  }, [messages]);

  // Reply targets that aren't in the current page (older messages) — resolve
  // them from the local plaintext cache so the quoted preview still shows, like
  // WhatsApp. Stays on-device: no content goes to the server.
  const [extraReplies, setExtraReplies] = useState<Map<number, DisplayMessage>>(new Map());
  useEffect(() => {
    const need = new Set<number>();
    for (const m of messages) {
      const rid = m.replyToId;
      if (rid && rid > 0 && !replyById.has(rid) && !extraReplies.has(rid)) need.add(rid);
    }
    if (!need.size) return;
    let cancel = false;
    getCachedMessagesByIds(chatId, [...need]).then(rows => {
      if (cancel || !rows.length) return;
      setExtraReplies(prev => {
        const n = new Map(prev);
        for (const r of rows) if (typeof r.id === 'number') n.set(r.id, r as DisplayMessage);
        return n;
      });
    }).catch(() => {});
    return () => { cancel = true; };
    // extraReplies intentionally omitted (the has-guard prevents refetch loops)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, replyById, chatId]);

  const resolveReply = useCallback(
    (id?: number | null) => (id ? (replyById.get(id) ?? extraReplies.get(id) ?? null) : null),
    [replyById, extraReplies],
  );

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

  // Clear this chat's native message notification + unread counter (F2 —
  // the content-free doorbell posts per-chat notifications tagged by chatId).
  useEffect(() => {
    if (!chatId || Platform.OS !== 'android') return;
    try { require('react-native').NativeModules?.VaultCalls?.clearMessageNotifs?.(chatId); } catch {}
  }, [chatId]);

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

        // ── Local-first load (WhatsApp model) ────────────────────────────
        // Everything the user sees is rendered from LOCAL storage first, with
        // zero network calls; the server is then reconciled in the background.
        // No network failure may ever blank what's already on screen.

        // 1. Who am I — from the local session (never gated on the network), so
        //    bubble alignment (isMine) is right even fully offline.
        const me = await getCurrentUserAsync().catch(() => null);
        const myId = me?.id ?? null;
        setMeId(myId);

        // 2. Chat header (name / peer / members) from the local cache → the
        //    header renders offline instead of blank.
        try {
          const cc = await getCachedChat(chatId);
          if (cc) { setChat({ ...cc, members: cc.members ?? [] }); setPinnedId(cc.pinnedMessageId ?? null); }
        } catch {}

        // 3. Cached messages + still-in-flight outbox bubbles, painted instantly.
        //    knownPlain reuses already-decrypted text so we never re-decrypt.
        const knownPlain = new Map<number, string>();
        const [cachedMsgs, pendingQ, mediaQ] = await Promise.all([
          getCachedMessages(chatId, PAGE_SIZE).catch(() => []),
          pendingForChat(chatId).catch(() => []),
          mediaPendingForChat(chatId).catch(() => []),
        ]);
        for (const m of cachedMsgs) if (!looksEncrypted(m.content)) knownPlain.set(m.id, m.content as string);

        const pendingBubbles = (pendingQ as any[]).map(q => ({
          id: 0, chatId: q.chatId, senderId: myId ?? '', type: q.type, content: q.plaintext,
          meta: null, replyToId: q.replyToId, editedAt: null, deletedAt: null,
          createdAt: new Date(q.createdAt).toISOString(), _tempId: q.tempId, _state: 'pending',
        })) as DisplayMessage[];
        const mediaBubbles = (mediaQ as any[]).map(m => ({
          id: 0, chatId: m.chatId, senderId: myId ?? '', type: m.type as any, content: m.caption || '',
          meta: { localUri: m.srcPath, mime: m.mime, filename: m.filename, ...(m.metaExtra || {}), ...(m.viewOnce ? { viewOnce: true } : {}) },
          replyToId: null, editedAt: null, deletedAt: null,
          createdAt: new Date(m.createdAt).toISOString(), _tempId: m.tempId, _state: m.state === 'failed' ? 'failed' : 'pending',
        })) as DisplayMessage[];
        // Inverted list = newest first. Reversed ONCE, reused for the reconcile.
        const pendingNewestFirst = [...pendingBubbles, ...mediaBubbles]
          .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt)).reverse();
        if (cachedMsgs.length || pendingNewestFirst.length) {
          setMessages([...pendingNewestFirst, ...cachedMsgs]);
          setLoading(false);
        }

        // 4. Reconcile from the server — RESILIENT. Each call is isolated; a
        //    failure (offline) leaves the painted cache untouched. getChat also
        //    re-caches the detail (see getChat) for the next offline open.
        getChat(chatId)
          .then(c => { setChat(c); setPinnedId(c.pinnedMessageId ?? null); })
          .catch(() => {});
        try {
          const msgsRaw = await getMessages(chatId, { limit: PAGE_SIZE });
          const msgs = await hydrateMessages(chatId, msgsRaw, knownPlain);
          setMessages([...pendingNewestFirst, ...msgs]);
          setHasMore(msgs.length === PAGE_SIZE);
          setError(null);
          cacheMessages(chatId, msgs).catch(() => {});   // persist for next instant open
        } catch {
          // Offline / transient — keep the painted cache silently; the connection
          // banner already tells the user. A failed background refresh is not an error.
        }
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
      // delete/edit ops apply optimistically by id and carry no pending bubble —
      // a delete resolves with real=null; nothing to swap or cache here.
      if (!real) return;
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
    // Media outbox: same swap/fail, but keep localUri so the sender's own bubble
    // keeps rendering their local file (no re-download) after the swap.
    const offMSent = onMediaOutbox('sent', ({ tempId, chatId: cid, real }) => {
      if (cid !== chatId) return;
      setMessages(prev => {
        if (prev.some(x => x.id === real.id)) return prev.filter(x => x._tempId !== tempId);
        const localUri = prev.find(x => x._tempId === tempId)?.meta?.localUri;
        return prev.map(x => x._tempId === tempId
          ? ({ ...real, meta: { ...(real as any).meta, ...(localUri ? { localUri } : {}) }, _tempId: undefined, _state: undefined } as DisplayMessage)
          : x);
      });
      cacheMessages(cid, [real]).catch(() => {});
    });
    const offMFailed = onMediaOutbox('failed', ({ tempId, chatId: cid }) => {
      if (cid !== chatId) return;
      setMessages(prev => prev.map(x => x._tempId === tempId
        ? { ...x, _state: 'failed' } as DisplayMessage : x));
    });
    return () => { offSent(); offFailed(); offMSent(); offMFailed(); };
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
          // Socket payloads deliver `id` as a STRING, but the HTTP ack / cache use
          // a NUMBER. Normalize so `x.id === m.id` dedup works — otherwise the
          // socket echo of our own just-sent message survives alongside the ack'd
          // row and both collide on the same React key.
          if (m.id != null) (m as any).id = Number(m.id);
          // Auto-acknowledge delivery + tone immediately (don't wait on decrypt).
          if (m.senderId !== meId) {
            markDeliveredDurable(chatId, m.id).catch(() => {});
            playReceived();   // in-app "received" tone (respects sound prefs)
          }
          // Decrypt-on-arrival (WhatsApp-style): decrypt ONCE, then show + cache
          // the PLAINTEXT so re-opens never decrypt it again.
          (async () => {
            const fin = looksEncrypted(m.content) ? (await hydrateMessages(chatId, [m]))[0] ?? m : m;
            setMessages(prev => prev.some(x => x.id === fin.id) ? prev : [fin, ...prev]);
            applyMessage(chatId, fin).catch(() => {}); // persist plaintext to local cache
            // Bump the "↓ N new" counter when a message lands while scrolled up.
            if (!atBottomRef.current && fin.senderId !== meId) setNewSinceUp(n => n + 1);
          })();
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
          const eid = Number(e.id); // socket delivers id as string; rows hold numbers
          setMessages(prev => prev.map(x =>
            x.id === eid ? { ...x, content: e.content, editedAt: e.editedAt } : x
          ));
        };
        const onDelete = (e: { id: number; deletedAt: string }) => {
          const eid = Number(e.id); // socket delivers id as string; rows hold numbers
          setMessages(prev => prev.map(x =>
            x.id === eid ? { ...x, content: null, deletedAt: e.deletedAt, type: 'system' } : x
          ));
        };
        const onTypingStart = (e: { uid: string; chatId?: string }) => {
          if (!e?.uid || e.uid === meId || (e.chatId && e.chatId !== chatId)) return;
          setTypingUids(prev => {
            if (prev.has(e.uid)) return prev;
            const next = new Set(prev); next.add(e.uid); return next;
          });
        };
        const onTypingStop = (e: { uid: string; chatId?: string }) => {
          if (!e?.uid || (e.chatId && e.chatId !== chatId)) return;
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

        // Reactions are now E2EE reference-messages in the ordered stream (F4) —
        // no separate reaction_added/removed socket events, no legacy fetch.
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

        // VaultView remote revoke. The sender destroyed the media server-side;
        // this device destroys its per-file key and every decrypted copy, then
        // repaints the bubble as a tombstone. Irreversible by design — see
        // lib/protectedMedia.
        const onMediaRevoked = (e: { chatId: string; messageId: number; attachmentId: string }) => {
          if (!e?.attachmentId || e.chatId !== chatId) return;
          wipeRevokedMedia(e.attachmentId).catch(() => {});
          setMessages(prev => prev.map(m =>
            String(m.meta?.attachmentId ?? '') === String(e.attachmentId)
              ? { ...m, meta: { ...(m.meta || {}), revoked: true } }
              : m));
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
        s.on('presence_changed',  onPresence);
        s.on('screenshot_captured', onScreenshotCaptured);
        s.on('media_revoked',     onMediaRevoked);
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
        off.push(() => s.off('presence_changed',  onPresence));
        off.push(() => s.off('screenshot_captured', onScreenshotCaptured));
        off.push(() => s.off('media_revoked',     onMediaRevoked));
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

  // Reactions no longer need a separate hydration round-trip — they arrive as
  // E2EE reference messages in the ordered stream and are derived in the
  // e2eeReactions memo (F4). Legacy /reactions endpoints retired.

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
      markReadDurable(chatId, latestId).catch(() => {});
      // Reading here means we've seen up to latestId — don't let a later
      // background sweep re-notify for these (Phase 4 no-GMS notifications).
      import('../lib/messageNotifications').then(m => m.markSeen(chatId, latestId)).catch(() => {});
    }, 800);
    return () => { if (readDebounce.current) clearTimeout(readDebounce.current); };
  }, [chatId, messages]);

  // ── Unread divider (WhatsApp "N unread messages") ─────────
  // Capture the read boundary ONCE when the chat opens — before mark-as-read
  // advances it — so the divider stays put above the first message we hadn't read.
  const [unreadInfo, setUnreadInfo] = useState<{ boundaryId: number; count: number } | null>(null);
  const unreadCapturedRef = useRef(false);
  useEffect(() => { unreadCapturedRef.current = false; setUnreadInfo(null); }, [chatId]);
  useEffect(() => {
    if (unreadCapturedRef.current) return;
    if (!chat || !meId || messages.length === 0) return;
    unreadCapturedRef.current = true;
    const myMember = chat.members.find(m => m.userId === meId);
    const boundaryId = myMember?.lastReadMessageId ?? 0;
    const count = messages.filter(m => m.id > 0 && m.id > boundaryId && m.senderId !== meId).length;
    if (count > 0) setUnreadInfo({ boundaryId, count });
  }, [chat, messages, meId]);

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
    if (editingId == null) playSent();   // in-app "sent" tone (respects sound prefs)
    setSending(true);
    stopTypingIfActive();
    if (draftTimer.current) clearTimeout(draftTimer.current);
    clearDraft(chatId).catch(() => {});
    try {
      if (editingId != null) {
        // WhatsApp: the edit shows instantly and syncs when back online. Apply
        // optimistically by id, then durably enqueue (encrypt+PATCH on flush).
        const editId = editingId;
        setMessages(prev => prev.map(x => x.id === editId
          ? { ...x, content: text, editedAt: new Date().toISOString() } : x));
        setEditingId(null);
        setInput('');
        await enqueueEdit(chatId, editId, text);
      } else {
        // Enqueue + add optimistic bubble immediately. If the one-shot
        // Invisible Ink toggle was on, stamp meta.invisibleInk and reset.
        const replyToId = replyTo?.id ?? null;
        // Keep only mentions whose "@Name" still appears in the final text.
        const mentions = mentionsRef.current.filter(mn => text.includes('@' + mn.name));
        // F5: attach the sender-resolved link preview (LOCAL meta only — the
        // queue folds it inside the E2EE content and strips it before POST).
        const lp = composerLp && text.includes(composerLp.url) ? composerLp.data : null;
        const meta: any = { ...(nextInvisibleInk ? { invisibleInk: true } : {}), ...(mentions.length ? { mentions } : {}), ...(silent ? { silent: true } : {}), ...(lp ? { linkPreview: lp } : {}) };
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
        setComposerLp(null);
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
          { text: 'Retry', onPress: () => { retryMedia(msg._tempId!).catch(() => {}); queueRetry(msg._tempId!); } },
          { text: 'Delete', style: 'destructive', onPress: async () => {
              await cancelMedia(msg._tempId!).catch(() => {});
              await queueCancel(msg._tempId!);
              setMessages(prev => prev.filter(x => x._tempId !== msg._tempId));
          }},
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    // Pending (still in queue / uploading): only allow Cancel.
    if (msg._state === 'pending' && msg._tempId) {
      Alert.alert(
        'Message sending…',
        'This message hasn\'t been confirmed by the server yet.',
        [
          { text: 'Cancel send', style: 'destructive', onPress: async () => {
              // Media: abort the (resumable) upload + delete the copy → frees R2.
              // Text: drop from the queue. Each no-ops for the other kind.
              await cancelMedia(msg._tempId!).catch(() => {});
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
      { key: 'reply',   label: 'Reply',   icon: 'arrow-undo', onPress: () => setReplyTo(msg) },
      { key: 'pin',     label: isPinned ? 'Unpin' : 'Pin', icon: 'pin', onPress: async () => {
          const next = isPinned ? null : msg.id;
          setPinnedId(next == null ? null : String(msg.id)); // optimistic
          try { await pinMessage(chatId, next); } catch (e: any) { Alert.alert('Could not pin', e?.message ?? 'Try again'); }
        } },
      { key: 'forward', label: 'Forward', icon: 'arrow-redo', onPress: () => openForward(msg) },
      { key: 'copy',    label: 'Copy',    icon: 'copy-outline', onPress: () => copyAndAutoClear(plain) },
      { key: 'star',    label: 'Star',    icon: 'star-outline', onPress: async () => {
          try { await addBookmark(msg.id, null); } catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
        } },
      { key: 'remind',  label: 'Remind',  icon: 'alarm-outline', onPress: () => router.push({
          pathname: '/message-reminder' as any,
          params: { chatId, messageId: String(msg.id), preview: (plain || msg.type).slice(0, 200) },
        }) },
    ];
    if (isMine && msg.id > 0 && !msg.deletedAt) {
      acts.push({ key: 'info', label: 'Info', icon: 'information-circle-outline', onPress: () => setInfoMsg(msg) });
    }
    if (isMine && !msg.deletedAt) {
      acts.push({ key: 'edit', label: 'Edit', icon: 'create-outline', onPress: () => { setEditingId(msg.id); setInput(plain); } });
    }
    // VaultCheck — authenticity verification on received photos/video. Offered
    // on media you did NOT send (verifying your own file tells you nothing) and
    // only where there are pixels to analyse.
    if (!isMine && !msg.deletedAt && msg.meta?.attachmentId && !msg.meta?.revoked
        && (msg.type === 'image' || msg.type === 'video')) {
      acts.push({ key: 'verify', label: 'Verify', icon: 'shield-checkmark-outline', onPress: () => {
          router.push({
            pathname: '/vaultcheck' as any,
            params: {
              attachmentId: String(msg.meta!.attachmentId),
              msgType: msg.type,
              mime: String(msg.meta?.mime || ''),
              filename: String(msg.meta?.filename || ''),
              isMine: '',
            },
          });
        } });
    }
    // VaultView remote revoke — sender only, on media you still own. Distinct
    // from "Delete for everyone": that removes the MESSAGE inside a 2d12h
    // window, this destroys the MEDIA itself (server bytes + the recipient's
    // key and plaintext) with no time limit and no undo.
    const revokableAttachment = msg.meta?.attachmentId && !msg.meta?.revoked
      && ['image', 'video', 'audio', 'voice', 'file'].includes(String(msg.type));
    if (isMine && msg.id > 0 && !msg.deletedAt && revokableAttachment) {
      acts.push({ key: 'revoke', label: 'Revoke', icon: 'eye-off-outline', danger: true, onPress: () => {
          Alert.alert(
            'Revoke this media?',
            'It will be deleted from the server and from the other person\'s phone, even if they already downloaded it. This cannot be undone.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Revoke', style: 'destructive', onPress: async () => {
                  const attId = String(msg.meta!.attachmentId);
                  // Optimistic tombstone — the sender never receives the
                  // broadcast for their own revoke.
                  setMessages(prev => prev.map(x => x.id === msg.id
                    ? { ...x, meta: { ...(x.meta || {}), revoked: true } } : x));
                  try {
                    await revokeAttachment(attId);
                  } catch (e: any) {
                    setMessages(prev => prev.map(x => x.id === msg.id
                      ? { ...x, meta: { ...(x.meta || {}), revoked: false } } : x));
                    Alert.alert('Could not revoke', e?.message ?? 'Try again when you are back online.');
                    return;
                  }
                  // Wipe our own copies too — revoked means gone on both sides.
                  await wipeRevokedMedia(attId).catch(() => {});
                } },
            ],
          );
        } });
    }
    // Delete is available on EVERY message: "Delete for me" always (local-only
    // hide), plus "Delete for everyone" on your own messages (server revoke) —
    // matching WhatsApp.
    if (!msg.deletedAt) {
      acts.push({ key: 'delete', label: 'Delete', icon: 'trash-outline', danger: true, onPress: () => {
          const opts: any[] = [{
            text: 'Delete for me', style: 'destructive', onPress: async () => {
              try { await markCachedDeleted(chatId, msg.id); } catch {}
              setMessages(prev => prev.filter(x => x.id !== msg.id));
            },
          }];
          // Delete-for-everyone window (WhatsApp: 2d12h). Server enforces the
          // same window; this is only the UX hint. NaN-hardened: a missing
          // createdAt must not silently hide the option via NaN comparisons.
          const _t = new Date(msg.createdAt).getTime();
          const withinRevoke = Number.isFinite(_t) && (Date.now() - _t < REVOKE_WINDOW_MS);
          if (isMine && msg.id > 0 && withinRevoke) {
            opts.push({
              text: 'Delete for everyone', style: 'destructive', onPress: async () => {
                // WhatsApp: tombstone instantly, sync the revoke when back online.
                setMessages(prev => prev.map(x => x.id === msg.id
                  ? { ...x, content: null, deletedAt: new Date().toISOString(), type: 'system' } : x));
                await enqueueDelete(chatId, msg.id);
              },
            });
          }
          opts.push({ text: 'Cancel', style: 'cancel' });
          Alert.alert('Delete message?', undefined, opts);
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
    setOverflowMenu({
      title: 'Screenshots in this chat',
      actions: opts.map(o => ({
        label: o.label,
        icon: current === o.mode ? 'radio-button-on' : 'radio-button-off',
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
    });
  }, [chat, chatId]);

  // Per-chat notification sound picker (themed sheet). Sets the Android channel
  // the server will address for this chat's pushes.
  const openNotifSoundPicker = useCallback(() => {
    if (!chat) return;
    setOverflowMenu({
      title: 'Notification sound',
      actions: NOTIF_CHANNELS.map(ch => ({
        label: ch.name,
        icon: 'musical-note-outline' as const,
        onPress: async () => {
          try { await setChatNotifSound(chatId, ch.id); }
          catch (e: any) { Alert.alert('Could not update', e?.message ?? 'Try again'); }
        },
      })),
    });
  }, [chat, chatId]);

  // Disappearing-messages picker — Alert sheet, Off / 24h / 7d / 90d.
  // Any member can change the timer (privacy is shared, not admin-gated).
  // Existing messages keep whatever expires_at they got at insert time —
  // the new timer only affects future messages.
  const openDisappearingPicker = useCallback(() => {
    if (!chat) return;
    const current = chat.disappearingSeconds ?? null;
    setOverflowMenu({
      title: 'Disappearing messages',
      actions: DISAPPEARING_PRESETS.map(opt => ({
        label: opt.label,
        icon: current === opt.seconds ? 'radio-button-on' : 'radio-button-off',
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
      })),
    });
  }, [chat, chatId]);

  // ── Chat-level overflow menu — a themed bottom sheet (not Alert.alert, which
  // caps at 3 buttons on Android and looks like a system dialog). ──
  const onPressMenu = useCallback(() => {
    if (!chat) return;
    const peer = chat.type === 'direct' && meId
      ? chat.members.find(m => m.userId !== meId)
      : null;
    const isMuted = chat.muted;

    const actions: MenuAction[] = [
      {
        label: isMuted ? 'Unmute notifications' : 'Mute notifications',
        icon: isMuted ? 'notifications-outline' : 'notifications-off-outline',
        onPress: async () => {
          try {
            await muteChat(chatId, !isMuted);
            setChat(prev => prev ? { ...prev, muted: !isMuted } : prev);
          } catch (e: any) { Alert.alert('Mute failed', e?.message ?? 'Try again'); }
        },
      },
      {
        label: 'Notification sound',
        icon: 'musical-notes-outline',
        onPress: () => openNotifSoundPicker(),
      },
      {
        label: chat.disappearingSeconds
          ? `Disappearing: ${formatDisappearing(chat.disappearingSeconds)}`
          : 'Disappearing messages',
        icon: 'timer-outline',
        onPress: () => openDisappearingPicker(),
      },
      {
        label: chat.vanishMode ? 'Vanish Mode: On' : 'Vanish Mode: Off',
        icon: 'flame-outline',
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
        label: `Screenshots: ${formatScreenshotMode((chat.screenshotMode as ScreenshotMode) || 'block')}`,
        icon: 'camera-outline',
        onPress: () => openScreenshotPicker(),
      },
      {
        label: chat.hidden ? 'Unhide chat' : 'Hide chat',
        icon: chat.hidden ? 'eye-outline' : 'eye-off-outline',
        onPress: async () => {
          const next = !chat.hidden;
          try {
            await setHidden(chatId, next);
            if (next) router.replace('/(tabs)/chats' as any);
            else setChat(prev => prev ? { ...prev, hidden: next } : prev);
          } catch (e: any) { Alert.alert('Could not update', e?.message ?? 'Try again'); }
        },
      },
      {
        label: 'Schedule a message',
        icon: 'calendar-outline',
        onPress: () => router.push({
          pathname: '/schedule-message' as any,
          params: { chatId, peerName: peer?.name ?? chat.name ?? '' },
        }),
      },
      {
        label: 'Wallpaper',
        icon: 'image-outline',
        onPress: () => router.push({ pathname: '/chat-wallpaper' as any, params: { chatId } }),
      },
      {
        label: 'Bubble theme',
        icon: 'color-palette-outline',
        onPress: () => router.push({ pathname: '/chat-themes' as any, params: { chatId } }),
      },
    ];

    if (chat.type === 'group') {
      actions.push({
        label: 'Group info',
        icon: 'people-outline',
        onPress: () => router.push({ pathname: '/group-info' as any, params: { id: chatId } }),
      });
    }

    if (peer) {
      actions.push({
        label: 'Ghost Mode',
        icon: 'eye-off-outline',
        onPress: () => router.push({
          pathname: '/ghost-mode' as any,
          params: { targetId: peer.userId, targetName: peer.name ?? peer.email ?? '' },
        }),
      });
      actions.push({
        label: 'Reset secure session',
        icon: 'refresh-outline',
        onPress: () => Alert.alert(
          'Reset secure session?',
          'Use this if messages show "unable to decrypt". It re-establishes encryption keys with this contact on your next message. Past undecryptable messages stay unreadable.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Reset', onPress: async () => {
                try {
                  await resetChatSession(chatId);
                  Alert.alert('Session reset', 'Send a message to re-establish encryption.');
                } catch (e: any) { Alert.alert('Reset failed', e?.message ?? 'Try again'); }
              } },
          ],
        ),
      });
      actions.push({
        label: 'Block user',
        icon: 'ban-outline',
        destructive: true,
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
                } catch (e: any) { Alert.alert('Block failed', e?.message ?? 'Try again'); }
              } },
          ],
        ),
      });
    }

    setOverflowMenu({ title: chat.name || (peer?.name ?? 'Chat'), actions });
  }, [chat, meId, chatId, router]);

  // ── React / Reply / Forward handlers ──────────────────────
  const toggleReaction = useCallback(async (msg: DisplayMessage, emoji: string) => {
    haptic();
    setReactPicker(null);
    if (!msg.id || msg.id <= 0) return;
    // WhatsApp semantics: ONE reaction per user per message. Tapping my current
    // emoji removes it; tapping a different one replaces it (latest-wins in the
    // E2EE reducer handles the replace — no explicit remove needed).
    const removing = (mergedReactions[msg.id] || []).some(r => r.emoji === emoji && r.mine);
    // WhatsApp: a reaction works offline — durably enqueue it (it's an E2EE
    // message under the hood) and reconcile on the queue's 'sent' event.
    const q = await enqueueReaction(chatId, msg.id, emoji, removing ? 'remove' : 'add');
    // Optimistic: inject a local reaction MESSAGE keyed by the QUEUE tempId, so
    // 'sent' swaps it for the real row (no double count). The derived map updates
    // instantly; if it never sends, the row resolves to the server truth on reload.
    const optimistic: DisplayMessage = {
      id: 0, chatId, senderId: meId ?? '', type: 'reaction',
      content: JSON.stringify({ reactsTo: msg.id, op: removing ? 'remove' : 'add', emoji }),
      meta: null, replyToId: null, editedAt: null, deletedAt: null,
      createdAt: new Date().toISOString(), _tempId: q.tempId, _state: 'pending',
    };
    setMessages(prev => [optimistic, ...prev]);
  }, [chatId, mergedReactions, meId]);

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

  // Paint the user's own LOCAL file as a pending bubble instantly (they already
  // have the bytes) and hand the send to the DURABLE media outbox: it copies the
  // file, uploads (resumable), then posts the message — retrying across
  // reconnects and app restarts. The 'sent'/'failed' outbox events (subscribed
  // above) swap the bubble. Media now "sends" offline exactly like text.
  const enqueueMediaOptimistic = useCallback(async (
    type: MediaType,
    file: { uri: string; filename: string; mime: string },
    opts: { caption?: string; viewOnce?: boolean; metaExtra?: Record<string, any> } = {},
  ) => {
    const item = await enqueueMedia(chatId, type, file, opts);
    const optimistic: DisplayMessage = {
      id: 0, chatId, senderId: meId ?? '', type: type as any,
      content: opts.caption?.trim() || '',
      // localUri lets the bubble render instantly (no download).
      meta: { localUri: file.uri, mime: file.mime, filename: file.filename, ...(opts.metaExtra || {}), ...(opts.viewOnce ? { viewOnce: true } : {}) },
      replyToId: null, editedAt: null, deletedAt: null,
      createdAt: new Date().toISOString(), _tempId: item.tempId, _state: 'pending',
    };
    setMessages(prev => [optimistic, ...prev]);
  }, [chatId, meId]);

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
      await enqueueMediaOptimistic('audio',
        { uri: r.uri, filename: r.filename, mime: r.mime },
        // Pre-computed 0..1 amplitude bars (length up to 32) so the bubble
        // renders without re-parsing the audio file.
        { metaExtra: { durationMs: r.durationMs, waveform: r.waveform } },
      );
      setRecElapsedMs(0);
    } catch (e: any) {
      Alert.alert('Voice send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, recording, enqueueMediaOptimistic]);

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
      allowsMultipleSelection: true,   // WhatsApp-style multi-select
      selectionLimit: 10,
      orderedSelection: true,
      videoMaxDuration: 60, // hard cap to keep upload size sane on free plan
    });
    if (result.canceled || !result.assets?.length) return;
    const isVideo = kind === 'videos';
    const stamp = Date.now();
    // Stage all picks for the multi-image caption preview.
    const items = result.assets.map((asset, i) => {
      const filename = asset.fileName ||
        (isVideo ? `video-${stamp}-${i}.mp4` : `photo-${stamp}-${i}.jpg`);
      const mime = asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
      const metaExtra: any = { width: asset.width, height: asset.height };
      if (isVideo && asset.duration) metaExtra.durationMs = asset.duration;
      return {
        uri: asset.uri, mediaType: (isVideo ? 'video' : 'image') as 'image' | 'video',
        filename, mime, viewOnce: !!opts.viewOnce, metaExtra, caption: '',
      };
    });
    setPendingItems(items);
    setCurrentIdx(0);
  }, [sending]);

  const confirmSendPendingMedia = useCallback(async () => {
    if (pendingItems.length === 0) return;
    const items = pendingItems;
    setPendingItems([]);
    setCurrentIdx(0);
    for (const pm of items) {
      await enqueueMediaOptimistic(pm.mediaType, { uri: pm.uri, filename: pm.filename, mime: pm.mime },
        { caption: pm.caption.trim() || undefined, viewOnce: pm.viewOnce, metaExtra: pm.metaExtra });
    }
  }, [pendingItems, enqueueMediaOptimistic]);

  // Helpers for the multi-item preview.
  const updateCurrentItem = useCallback((patch: Partial<{ caption: string; viewOnce: boolean }>) => {
    setPendingItems(prev => prev.map((it, i) => i === currentIdx ? { ...it, ...patch } : it));
  }, [currentIdx]);
  const removePendingAt = useCallback((idx: number) => {
    setPendingItems(prev => {
      const next = prev.filter((_, i) => i !== idx);
      setCurrentIdx(ci => Math.max(0, Math.min(ci - (idx <= ci ? 1 : 0), next.length - 1)));
      return next;
    });
  }, []);
  const addMorePhotos = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: true, selectionLimit: 10, orderedSelection: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const stamp = Date.now();
    const more = result.assets.map((asset, i) => ({
      uri: asset.uri, mediaType: 'image' as const,
      filename: asset.fileName || `photo-${stamp}-${i}.jpg`,
      mime: asset.mimeType || 'image/jpeg', viewOnce: false,
      metaExtra: { width: asset.width, height: asset.height } as Record<string, any>, caption: '',
    }));
    setPendingItems(prev => [...prev, ...more]);
  }, []);

  // ── Consume media captured by /camera, /video-notes, /image-editor ──
  // Those screens router.replace back here with capturedUri + capturedType.
  // Send it exactly once, then clear the params so a re-render or Back never
  // re-sends the same file.
  const consumedCaptureRef = useRef<string | null>(null);
  useEffect(() => {
    const uri = params.capturedUri || '';
    if (!uri || consumedCaptureRef.current === uri) return;
    consumedCaptureRef.current = uri;
    const rawType = params.capturedType || 'image';
    const isVideo = rawType === 'video' || rawType === 'video-note';
    const viewOnce = params.capturedViewOnce === '1';
    // Clear immediately so navigating back into the chat doesn't re-stage.
    router.setParams({ capturedUri: '', capturedType: '', capturedViewOnce: '' } as any);
    const filename = isVideo
      ? `${rawType === 'video-note' ? 'note' : 'video'}-${Date.now()}.mp4`
      : `photo-${Date.now()}.jpg`;
    const mime = isVideo ? 'video/mp4' : 'image/jpeg';
    const metaExtra: Record<string, any> = rawType === 'video-note' ? { videoNote: true } : {};
    // Stage in the caption preview (same as a gallery pick).
    setPendingItems([{ uri, mediaType: isVideo ? 'video' : 'image', filename, mime, viewOnce, metaExtra, caption: '' }]);
    setCurrentIdx(0);
  }, [params.capturedUri, params.capturedType, params.capturedViewOnce, router]);

  // ── Composer camera button: tap = camera, slide up = video note ──────
  // (WhatsApp-style. startMode='note' makes /camera open in round-video mode.)
  const openCamera = useCallback((startMode?: 'note') => {
    if (sending) return;
    Keyboard.dismiss();
    const peerName = (chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId)?.name : chat?.name) || '';
    router.push({ pathname: '/camera' as any, params: { chatId, peerName, returnTo: '/chat', ...(startMode ? { startMode } : {}) } });
  }, [sending, chat, meId, chatId, router]);
  // Keep the latest handler in a ref so the once-created PanResponder never goes stale.
  const openCameraRef = useRef(openCamera);
  openCameraRef.current = openCamera;

  // Animation values: camDragY (icon follows finger), hintProg (drag hint 0→1
  // as you slide up, "armed" near 1), chevPulse (idle discovery cue loop).
  const camDragY = useRef(new Animated.Value(0)).current;
  const hintProg = useRef(new Animated.Value(0)).current;
  const chevPulse = useRef(new Animated.Value(0)).current;
  const [camDragging, setCamDragging] = useState(false);
  const camDraggingRef = useRef(false);
  const ARM_DIST = 56; // px to slide up to "arm" the video note

  // Gentle, looping up-chevron above the camera icon so users discover slide-up.
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(chevPulse, { toValue: 1, duration: 950, useNativeDriver: true }),
      Animated.timing(chevPulse, { toValue: 0, duration: 950, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [chevPulse]);

  const resetCamDrag = useCallback(() => {
    camDraggingRef.current = false; setCamDragging(false);
    Animated.spring(camDragY, { toValue: 0, useNativeDriver: true, friction: 6, tension: 90 }).start();
    Animated.timing(hintProg, { toValue: 0, duration: 140, useNativeDriver: true }).start();
  }, [camDragY, hintProg]);

  const cameraPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6,
      onPanResponderMove: (_e, g) => {
        if (!camDraggingRef.current && Math.abs(g.dy) > 6) { camDraggingRef.current = true; setCamDragging(true); }
        const dy = Math.max(-72, Math.min(0, g.dy));
        camDragY.setValue(dy);
        hintProg.setValue(Math.min(1, -dy / ARM_DIST));
      },
      onPanResponderRelease: (_e, g) => {
        const armed = g.dy < -24;
        const tap = Math.abs(g.dy) < 12 && Math.abs(g.dx) < 12;
        resetCamDrag();
        if (armed) openCameraRef.current('note');   // slid up → video note
        else if (tap) openCameraRef.current();       // tap → camera
      },
      onPanResponderTerminate: () => resetCamDrag(),
    }),
  ).current;

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
      await enqueueMediaOptimistic('file', { uri: asset.uri, filename, mime });
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, sending, enqueueMediaOptimistic]);

  // ── VaultBeam: send a large file (up to 12 GB) over the R2 relay ──────
  // Direct chats only. Picks a file (copied to cache → real path for the native
  // streaming module), opens a relay transfer, posts the E2EE manifest message,
  // and streams encrypted blocks in the background. The bubble shows live
  // progress; the recipient taps Accept to pull it.
  const onSendVaultBeam = useCallback(async () => {
    if (sending) return;
    const peer = chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId) : null;
    if (!peer?.userId) { Alert.alert('VaultBeam', 'Large-file transfer is available in 1:1 chats only.'); return; }
    if (!vbNativeAvailable()) { Alert.alert('VaultBeam', 'Large-file transfer needs the latest app build (Android). Update to send big files.'); return; }
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const size = Number(asset.size) || 0;
    if (!size) { Alert.alert('VaultBeam', 'Could not read that file. Try another.'); return; }
    setSending(true);
    try {
      const msg = await vbStartSend({
        chatId, recipientId: peer.userId, srcPath: asset.uri,
        name: asset.name || `file-${Date.now()}`, mime: asset.mimeType || 'application/octet-stream', size,
      });
      setMessages(prev => prev.some(x => x.id === msg.id) ? prev : [msg, ...prev]);
    } catch (e: any) {
      Alert.alert('VaultBeam', e?.message ?? 'Could not start the transfer.');
    } finally {
      setSending(false);
    }
  }, [chatId, sending, chat, meId]);

  // ── Pick a photo, edit it (crop/rotate/draw), then send ──
  // /image-editor returns via the same capturedUri contract the effect above
  // consumes, so the edited file is actually delivered (not lost).
  const onEditPhoto = useCallback(async () => {
    if (sending) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo library access to attach.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
    if (result.canceled || !result.assets?.[0]) return;
    router.push({ pathname: '/image-editor' as any, params: { uri: result.assets[0].uri, chatId, returnTo: '/chat' } });
  }, [chatId, sending, router]);

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
  // Camera / Gallery / Video / View once / Edit photo / File / Big File / Scan /
  // Location / Navigate / Poll / Invisible Ink.
  const onPressAttach = useCallback(() => {
    if (sending) return;
    setAttachOpen(true);
  }, [sending]);

  const attachActions = useMemo(() => {
    const peer = chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId) : null;
    const peerName = peer?.name || chat?.name || '';
    const isDirect = chat?.type === 'direct';
    return [
      { label: 'Camera',        icon: 'camera' as const,      color: '#E1306C', onPress: () => router.push({ pathname: '/camera' as any, params: { chatId, peerName, returnTo: '/chat' } }) },
      { label: 'Gallery',       icon: 'image' as const,       color: '#7E57C2', onPress: () => onPickMedia('images') },
      { label: 'Video',         icon: 'videocam' as const,    color: '#EC407A', onPress: () => onPickMedia('videos') },
      // View once was reachable only from the camera toggle and the send-preview
      // eye button — never from the attach sheet, so the app's headline privacy
      // affordance was effectively undiscoverable from the main entry point.
      { label: 'View once',     icon: 'eye-off' as const,     color: BRAND_ACCENT, onPress: () => onPickMedia('images', { viewOnce: true }) },
      { label: 'Edit photo',    icon: 'create' as const,      color: '#5C6BC0', onPress: onEditPhoto },
      { label: 'File',          icon: 'document' as const,    color: '#42A5F5', onPress: onPickFile },
      // VaultBeam large-file transfer (up to 12 GB, R2 relay) — 1:1 only.
      ...(isDirect ? [{ label: 'Big File', icon: 'cube' as const, color: BRAND_ACCENT, onPress: onSendVaultBeam }] : []),
      { label: 'Scan',          icon: 'scan' as const,        color: '#8D6E63', onPress: () => router.push({ pathname: '/docscanner' as any, params: { chatId } }) },
      { label: 'Location',      icon: 'location' as const,    color: '#66BB6A', onPress: () => router.push({ pathname: '/location' as any, params: { chatId, name: peerName } }) },
      { label: 'Navigate',      icon: 'navigate' as const,    color: '#4A9FFF', onPress: () => openNavigator() },
      { label: 'Poll',          icon: 'stats-chart' as const, color: '#FFA726', onPress: () => router.push({ pathname: '/create-poll' as any, params: { chatId, peerName } }) },
      // Whiteboard: a working sketch canvas that shipped with no entry point
      // anywhere in the app. Its output is shared through the normal share
      // sheet, so the attach menu is where it belongs.
      { label: 'Whiteboard',    icon: 'brush' as const,       color: '#26A69A', onPress: () => router.push({ pathname: '/whiteboard' as any, params: { chatId } }) },
      { label: nextInvisibleInk ? 'Ink: armed' : 'Invisible Ink', icon: 'sparkles' as const, color: '#AB47BC', onPress: () => setNextInvisibleInk(v => !v) },
    ];
  }, [onPickMedia, onPickFile, onEditPhoto, onSendVaultBeam, router, chatId, chat, meId, nextInvisibleInk]);

  // ── Load older on scroll-up ───────────────────────────────
  const onEndReached = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const oldest = messages[messages.length - 1]?.id;
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const olderRaw = await getMessages(chatId, { before: oldest, limit: PAGE_SIZE });
      const older = await hydrateMessages(chatId, olderRaw);   // decrypt once at ingest
      // Dedupe against what's already loaded — a page boundary can overlap and
      // would otherwise inject duplicate ids (duplicate React keys).
      setMessages(prev => {
        const have = new Set(prev.map(x => String(x.id)));
        return [...prev, ...older.filter(m => !have.has(String(m.id)))];
      });
      if (older.length < PAGE_SIZE) setHasMore(false);
      cacheMessages(chatId, older).catch(() => {});            // persist plaintext for instant scroll-back
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
      try { older = await hydrateMessages(chatId, await getMessages(chatId, { before: oldest, limit: PAGE_SIZE })); }
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

  // Per-chat appearance (wallpaper + bubble colors). Reloaded on focus so a
  // change made in the selector applies the moment we navigate back.
  const [wallpaper, setWallpaper] = useState<WallpaperConfig | null>(null);
  const [bubbleColors, setBubbleColors] = useState<{ mine: string; peer: string } | null>(null);
  useFocusEffect(useCallback(() => {
    let cancel = false;
    (async () => {
      const [wp, bc] = await Promise.all([getWallpaper(chatId), getBubbleColors(chatId)]);
      if (!cancel) { setWallpaper(wp); setBubbleColors(bc); }
    })();
    return () => { cancel = true; };
  }, [chatId]));

  // ── Per-chat lock gate ──────────────────────────────────────
  // If this chat is locked, cover it until the user authenticates. Biometric is
  // attempted automatically; PIN-locked chats show a keypad. Enforced on every
  // focus so backgrounding + returning re-locks.
  const [lockInfo, setLockInfo] = useState<LockedChat | null>(null);
  const [lockOpen, setLockOpen] = useState(true);
  const [lockPin, setLockPin] = useState('');
  const [lockErr, setLockErr] = useState(false);
  useFocusEffect(useCallback(() => {
    let cancel = false;
    (async () => {
      const lock = await getLock(chatId);
      if (cancel) return;
      setLockInfo(lock);
      setLockPin(''); setLockErr(false);
      if (!lock) { setLockOpen(true); return; }
      setLockOpen(false);
      if (lock.lockMethod === 'biometric' || lock.lockMethod === 'both') {
        const ok = await verifyBiometric('Unlock chat');
        if (!cancel && ok) setLockOpen(true);
      }
    })();
    return () => { cancel = true; };
  }, [chatId]));

  const submitLockPin = useCallback(() => {
    if (lockInfo && verifyPin(lockInfo, lockPin)) { setLockOpen(true); setLockErr(false); setLockPin(''); }
    else setLockErr(true);
  }, [lockInfo, lockPin]);

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

  // ── Avatar tap (WhatsApp): if the peer has an active story → open it;
  // otherwise show the profile photo in a popup with quick actions. ──────
  const [photoViewer, setPhotoViewer] = useState(false);
  const directPeer = useCallback(() => {
    if (chat?.type !== 'direct' || !meId) return null;
    return chat.members.find(m => m.userId !== meId) ?? null;
  }, [chat, meId]);

  const onAvatarTap = useCallback(async () => {
    const peer = directPeer();
    if (peer) {
      try {
        const feed = await listStoriesFeed();
        if (feed.some(e => e.userId === peer.userId)) {
          router.push({ pathname: '/story-viewer' as any, params: { userId: peer.userId, userName: peer.name ?? peer.email ?? title } });
          return;
        }
      } catch {}
    }
    setPhotoViewer(true);   // no story (or group) → show the profile photo
  }, [directPeer, router, title]);

  // Tap the name/header → the contact's profile page (or group info).
  const openProfile = useCallback(() => {
    if (chat?.type === 'group') {
      router.push({ pathname: '/group-info' as any, params: { chatId } });
      return;
    }
    const peer = directPeer();
    if (!peer) return;
    router.push({ pathname: '/contact-info' as any, params: { chatId, peerUid: peer.userId, peerName: peer.name ?? peer.email ?? 'VaultChat user' } });
  }, [chat, chatId, directPeer, router]);

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

  // Resolve a viewer's name/avatar from chat members (Live Chat Viewers, #58).
  const resolveViewer = useCallback((userId: string) => {
    const m = membersById.get(userId);
    return {
      name: m?.name || m?.email || 'VaultChat user',
      uri: m?.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null,
      headers: screenAuthHeader ? { Authorization: screenAuthHeader } : undefined,
    };
  }, [membersById, screenAuthHeader]);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[S.screen, { paddingBottom: kbHeight }]}>
      {/* Per-chat wallpaper — painted behind the (transparent) message list */}
      {wallpaper && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {wallpaper.type === 'image' ? (
            <Image source={{ uri: wallpaper.value }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : wallpaper.type === 'gradient' && wallpaper.colors ? (
            <LinearGradient colors={wallpaper.colors as [string, string, ...string[]]} style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: wallpaper.value }]} />
          )}
        </View>
      )}

      {/* Header */}
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity style={S.headerAvatarWrap} activeOpacity={0.7} onPress={onAvatarTap}>
          <Avatar
            uri={headerPhotoId && screenAuthHeader ? attachmentUrl(headerPhotoId) : null}
            headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined}
            name={title}
            size={40}
            presence={chat?.type === 'direct' && peerPresence?.online ? 'online' : null}
          />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <TouchableOpacity activeOpacity={0.6} onPress={openProfile}>
            <Text style={S.title} numberOfLines={1}>{title}</Text>
            {chat && (
              <Text style={S.sub}>
                {headerSub}
                <Text style={S.e2eBadge}>  ·  </Text>
                <Ionicons name="lock-closed" size={11} color="#22C55E" />
                <Text style={S.e2eBadge}> secured</Text>
              </Text>
            )}
          </TouchableOpacity>
          {/* Live Chat Viewers (#58): who's viewing right now — tap for details */}
          {chatViewers.length > 0 && (
            <View style={{ marginTop: 3 }}>
              <ViewerStack viewers={chatViewers} resolve={resolveViewer} />
            </View>
          )}
        </View>
        {chat?.type === 'direct' && meId && (() => {
          const peer = chat.members.find(m => m.userId !== meId);
          if (!peer) return null;
          const params = { chatId, peerUid: peer.userId, peerName: peer.name ?? peer.email ?? 'VaultChat user' };
          return (
            <>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/videocall' as any, params })}
                activeOpacity={0.7}
              >
                <Ionicons name="videocam" size={23} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/voicecall' as any, params })}
                activeOpacity={0.7}
              >
                <Ionicons name="call" size={20} color={colors.text} />
              </TouchableOpacity>
            </>
          );
        })()}
        {/* Group call. Mirrors the direct-chat pair above and opens the group
            call hub, which rings every member and joins the mesh room. The hub
            takes `mode`, so both icons land in the right place. */}
        {chat?.type === 'group' && (() => {
          const params = { chatId, groupName: chat.name ?? 'Group' };
          return (
            <>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/group-calls' as any, params: { ...params, mode: 'video' } })}
                activeOpacity={0.7}
              >
                <Ionicons name="videocam" size={23} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/group-calls' as any, params: { ...params, mode: 'voice' } })}
                activeOpacity={0.7}
              >
                <Ionicons name="call" size={20} color={colors.text} />
              </TouchableOpacity>
            </>
          );
        })()}
        <TouchableOpacity
          style={S.headerIconBtn}
          onPress={() => { setSearchOpen(o => !o); if (searchOpen) setSearchQ(''); }}
          activeOpacity={0.7}
        >
          <Ionicons name={searchOpen ? 'close' : 'search'} size={22} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity style={S.headerIconBtn} onPress={onPressMenu} activeOpacity={0.7}>
          <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Connectivity strip (Connecting… / Waiting for network) — local-first:
          the message list below never changes when this appears. */}
      <ConnectionBanner />

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
          onPress={() => navigateTo(liveLoc.latitude, liveLoc.longitude, membersById.get(liveLoc.userId)?.name || 'Live location')}
        >
          <Ionicons name="navigate" size={20} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>{membersById.get(liveLoc.userId)?.name || 'Someone'} is sharing live location</Text>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 1 }} numberOfLines={1}>{liveLoc.address || `${liveLoc.latitude.toFixed(5)}, ${liveLoc.longitude.toFixed(5)}`} · Navigate</Text>
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
          : pm.type === 'vaultbeam' ? '📦 File'
          : pm.type === 'location' ? '📍 Location' : pm.type === 'poll' ? '📊 Poll' : 'Message';
        return (
          <TouchableOpacity style={S.pinnedBar} activeOpacity={0.8} onPress={() => jumpToMessage(Number(pinnedId))}>
            <Ionicons name="pin" size={15} color={colors.primary} />
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
        data={renderMessages}
        keyExtractor={(m) => m._tempId ?? String(m.id)}
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
          // Unread separator above the first message newer than the read boundary.
          const showUnread = !!unreadInfo && item.id > unreadInfo.boundaryId &&
            (!older || older.id <= unreadInfo.boundaryId);
          return (
          <View>
            {showDate && <DateChip iso={item.createdAt} />}
            {showUnread && <UnreadDivider count={unreadInfo!.count} />}
            <SwipeToReply onReply={() => { if (!item.deletedAt && item.type !== 'system') setReplyTo(item); }}>
            <View style={item.id === flashId ? { backgroundColor: brandAlpha(0.18), borderRadius: 12 } : undefined}>
            <MemoBubble
              msg={item}
              meId={meId}
              member={membersById.get(item.senderId)}
              chatId={chatId}
              otherMembers={otherMembers}
              onLongPress={onLongPressMessage}
              onJumpTo={jumpToMessage}
              reactionsForMsg={mergedReactions[item.id]}
              onToggleReaction={(emoji) => toggleReaction(item, emoji)}
              replyTarget={resolveReply(item.replyToId)}
              replyTargetMember={(() => {
                const t = resolveReply(item.replyToId);
                return t ? membersById.get(t.senderId) : undefined;
              })()}
              highlight={searchOpen && searchQ.trim().length > 0 ? searchQ.trim() : null}
              tiltRevealed={tiltRevealed}
              grouped={grouped}
              bubbleColors={bubbleColors}
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
        onScroll={(e) => {
          const up = e.nativeEvent.contentOffset.y > 280; // inverted: y>0 = scrolled off newest
          atBottomRef.current = !up;
          setShowScrollDown(up);
          if (!up && newSinceUp) setNewSinceUp(0);
        }}
        scrollEventThrottle={32}
        ListFooterComponent={loadingOlder ? <ActivityIndicator color={colors.primary} style={{ paddingVertical: 12 }} /> : null}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        windowSize={11}
        initialNumToRender={15}
      />

      {/* Scroll-to-bottom FAB with new-message count (WhatsApp-style) */}
      {showScrollDown && (
        <TouchableOpacity
          style={S.scrollDownBtn}
          activeOpacity={0.85}
          onPress={() => { try { listRef.current?.scrollToOffset({ offset: 0, animated: true }); } catch {}; setNewSinceUp(0); setShowScrollDown(false); atBottomRef.current = true; }}
        >
          <Ionicons name="chevron-down" size={24} color={colors.text} />
          {newSinceUp > 0 && (
            <View style={S.scrollDownBadge}><Text style={S.scrollDownBadgeTxt}>{newSinceUp > 99 ? '99+' : newSinceUp}</Text></View>
          )}
        </TouchableOpacity>
      )}

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

      {/* Compose-time link preview (F5) — resolved on the sender's device,
          travels inside the E2EE payload. Tap ✕ to send without a preview. */}
      {composerLp && (
        <View style={S.lpBar}>
          {composerLp.data.i ? <Image source={{ uri: composerLp.data.i }} style={S.lpBarImg} /> : null}
          <View style={{ flex: 1, marginHorizontal: 8 }}>
            <Text style={S.lpBarTitle} numberOfLines={1}>{composerLp.data.t}</Text>
            {composerLp.data.d ? <Text style={S.lpBarDesc} numberOfLines={1}>{composerLp.data.d}</Text> : null}
          </View>
          <TouchableOpacity hitSlop={10} onPress={() => { lpDismissedRef.current = composerLp.url; setComposerLp(null); }}>
            <Ionicons name="close" size={18} color={colors.textDim} />
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {replyTo.type === 'image' ? <Ionicons name="image" size={13} color={colors.textDim} />
                : replyTo.type === 'audio' ? <Ionicons name="mic" size={13} color={colors.textDim} />
                : replyTo.type === 'video' ? <Ionicons name="videocam" size={13} color={colors.textDim} />
                : replyTo.type === 'file'  ? <Ionicons name="document" size={13} color={colors.textDim} />
                : replyTo.type === 'vaultbeam' ? <Ionicons name="cube" size={13} color={colors.textDim} /> : null}
              <Text style={S.replyBarBody} numberOfLines={1}>
                {replyTo.type === 'image' ? 'Photo'
                  : replyTo.type === 'audio' ? 'Voice message'
                  : replyTo.type === 'video' ? 'Video'
                  : replyTo.type === 'file'  ? 'File'
                  : replyTo.type === 'vaultbeam' ? 'File'
                  : replyTo.content ?? ''}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={8}>
            <Ionicons name="close" size={20} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      {/* Emoji panel (tap the 😊 icon) — inserts into the message input */}
      {emojiOpen && editingId == null && !recording && (
        <EmojiPanel onPick={(e) => setInput(prev => (prev + e).slice(0, 4000))} />
      )}

      {/* Composer — either normal or recording mode */}
      {recording ? (
        <View style={[S.composer, S.recordingComposer]}>
          <View style={S.recordingDot} />
          <Text style={S.recordingTimer}>{formatRecDuration(recElapsedMs)}</Text>
          <Text style={S.recordingHint}>Slide to cancel · tap send</Text>
          <TouchableOpacity style={S.recCancelBtn} onPress={cancelRecording} activeOpacity={0.8}>
            <Ionicons name="trash-outline" size={22} color={colors.danger} />
          </TouchableOpacity>
          <TouchableOpacity style={S.sendFab} onPress={stopAndSendRecording} activeOpacity={0.85}>
            <Ionicons name="send" size={20} color="#fff" style={{ marginLeft: 2 }} />
          </TouchableOpacity>
        </View>
      ) : (
        <View style={S.composer}>
          <View style={S.inputPill}>
            {editingId == null && (
              <TouchableOpacity
                style={S.pillIconBtn}
                onPress={() => { if (!emojiOpen) Keyboard.dismiss(); setEmojiOpen(o => !o); }}
                activeOpacity={0.7}
                hitSlop={6}
              >
                <Ionicons name={emojiOpen ? 'happy' : 'happy-outline'} size={24} color={emojiOpen ? colors.primary : colors.textDim} />
              </TouchableOpacity>
            )}
            <TextInput
              style={S.input}
              placeholder={editingId != null ? 'Edit message…' : 'Message'}
              placeholderTextColor={colors.textDim}
              value={input}
              onChangeText={onInputChange}
              onFocus={() => setEmojiOpen(false)}
              multiline
              maxLength={4000}
            />
            {editingId == null && (
              <>
                <TouchableOpacity
                  style={S.pillIconBtn}
                  onPress={() => { setEmojiOpen(false); Keyboard.dismiss(); setGifOpen(true); }}
                  disabled={sending}
                  activeOpacity={0.7}
                  hitSlop={6}
                >
                  <Ionicons name="film-outline" size={23} color={colors.textDim} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={S.pillIconBtn}
                  onPress={onPressAttach}
                  disabled={sending}
                  activeOpacity={0.7}
                  hitSlop={6}
                >
                  <Ionicons name="attach" size={24} color={colors.textDim} style={{ transform: [{ rotate: '45deg' }] }} />
                </TouchableOpacity>
                <View style={S.camWrap}>
                  {/* Drag hint pill — rises + arms as you slide up */}
                  {camDragging && (
                    <Animated.View
                      pointerEvents="none"
                      style={[S.camDragHint, {
                        opacity: hintProg,
                        transform: [
                          { translateY: hintProg.interpolate({ inputRange: [0, 1], outputRange: [4, -8] }) },
                          { scale: hintProg.interpolate({ inputRange: [0, 0.85, 1], outputRange: [0.8, 1, 1.12] }) },
                        ],
                      }]}
                    >
                      <Ionicons name="videocam" size={13} color="#fff" />
                      <Text style={S.camDragHintTxt}>Video note</Text>
                    </Animated.View>
                  )}
                  {/* Idle discovery cue — subtle pulsing chevron */}
                  {!camDragging && !sending && (
                    <Animated.View
                      pointerEvents="none"
                      style={[S.camHintChevron, {
                        opacity: chevPulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.65] }),
                        transform: [{ translateY: chevPulse.interpolate({ inputRange: [0, 1], outputRange: [2, -3] }) }],
                      }]}
                    >
                      <Ionicons name="chevron-up" size={12} color={colors.textDim} />
                    </Animated.View>
                  )}
                  <Animated.View style={[S.pillIconBtn, { transform: [{ translateY: camDragY }] }]} {...cameraPan.panHandlers}>
                    {/* Arming ring fades/scales in while dragging up */}
                    <Animated.View
                      pointerEvents="none"
                      style={[S.camRing, {
                        opacity: hintProg,
                        transform: [{ scale: hintProg.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.15] }) }],
                      }]}
                    />
                    <Ionicons name="camera-outline" size={24} color={colors.textDim} />
                  </Animated.View>
                </View>
              </>
            )}
          </View>
          {/* Mic when input is empty + not editing; otherwise Send takes its place */}
          {editingId == null && input.trim().length === 0 ? (
            <TouchableOpacity
              style={S.sendFab}
              onPress={startRecording}
              disabled={sending}
              activeOpacity={0.85}
            >
              <Ionicons name="mic" size={23} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[S.sendFab, (!input.trim() || sending) && S.sendBtnOff]}
              onPress={() => onSend(false)}
              onLongPress={() => { if (input.trim() && !sending && editingId == null) onSend(true); }}
              delayLongPress={300}
              disabled={!input.trim() || sending}
              activeOpacity={0.85}
            >
              {sending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name={editingId != null ? 'checkmark' : 'send'} size={editingId != null ? 24 : 20} color="#fff" style={editingId != null ? undefined : { marginLeft: 2 }} />}
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

      {/* Message Info — who delivered/read this message (WhatsApp-style) */}
      <Modal visible={infoMsg != null} transparent animationType="slide" onRequestClose={() => setInfoMsg(null)}>
        <Pressable style={S.infoBackdrop} onPress={() => setInfoMsg(null)}>
          <Pressable style={S.infoSheet} onPress={() => {}}>
            <View style={S.sheetGrip} />
            <Text style={S.infoTitle}>Message info</Text>
            {infoMsg && (() => {
              const mid = infoMsg.id;
              // Exclude departed members so this breakdown agrees with the summary
              // tick (a left member must not show as "never delivered" under a blue tick).
              const recips = otherMembers.filter(m => !m.leftAt);
              const read = recips.filter(m => (m.lastReadMessageId ?? 0) >= mid);
              const delivered = recips.filter(m => (m.lastDeliveredMessageId ?? 0) >= mid && (m.lastReadMessageId ?? 0) < mid);
              const sent = recips.filter(m => (m.lastDeliveredMessageId ?? 0) < mid);
              const Row = (m: ChatMember) => (
                <View key={m.userId} style={S.infoRow}>
                  <Avatar uri={m.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null} headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined} name={m.name || m.email || '?'} size={36} />
                  <Text style={S.infoName} numberOfLines={1}>{m.name || m.email || m.userId.slice(0, 8)}</Text>
                </View>
              );
              const Section = (title: string, icon: any, color: string, list: ChatMember[]) => list.length ? (
                <View key={title} style={{ marginTop: 14 }}>
                  <View style={S.infoSecHdr}>
                    <Ionicons name={icon} size={16} color={color} />
                    <Text style={S.infoSecTitle}>{title} · {list.length}</Text>
                  </View>
                  {list.map(Row)}
                </View>
              ) : null;
              return (
                <ScrollView style={{ maxHeight: 420 }}>
                  {Section('Read', 'checkmark-done', '#4A9FFF', read)}
                  {Section('Delivered', 'checkmark-done', colors.textDim, delivered)}
                  {Section('Sent', 'checkmark', colors.textDim, sent)}
                  {otherMembers.length === 0 && <Text style={S.infoEmpty}>No other members.</Text>}
                </ScrollView>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Profile photo viewer (avatar tap with no active story) — WhatsApp popup */}
      <Modal visible={photoViewer} transparent animationType="fade" onRequestClose={() => setPhotoViewer(false)}>
        <Pressable style={S.photoBackdrop} onPress={() => setPhotoViewer(false)}>
          <Pressable style={S.photoCard} onPress={() => {}}>
            <View style={S.photoImgWrap}>
              {headerPhotoId && screenAuthHeader ? (
                <Image source={{ uri: attachmentUrl(headerPhotoId), headers: { Authorization: screenAuthHeader } }} style={S.photoImg} resizeMode="cover" />
              ) : (
                <View style={[S.photoImg, S.photoInitialsWrap]}><Text style={S.photoInitials}>{(title?.trim()[0] ?? '?').toUpperCase()}</Text></View>
              )}
              <View style={S.photoNameBar}><Text style={S.photoNameTxt} numberOfLines={1}>{title}</Text></View>
            </View>
            <View style={S.photoActions}>
              <TouchableOpacity style={S.photoActionBtn} onPress={() => setPhotoViewer(false)}>
                <Ionicons name="chatbubble-ellipses" size={22} color={colors.primary} />
                <Text style={S.photoActionTxt}>Message</Text>
              </TouchableOpacity>
              {chat?.type === 'direct' && (
                <>
                  <TouchableOpacity style={S.photoActionBtn} onPress={() => { setPhotoViewer(false); const p = directPeer(); if (p) router.push({ pathname: '/voicecall' as any, params: { chatId, peerUid: p.userId, peerName: p.name ?? p.email ?? title } }); }}>
                    <Ionicons name="call" size={22} color={colors.primary} />
                    <Text style={S.photoActionTxt}>Audio</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.photoActionBtn} onPress={() => { setPhotoViewer(false); const p = directPeer(); if (p) router.push({ pathname: '/videocall' as any, params: { chatId, peerUid: p.userId, peerName: p.name ?? p.email ?? title } }); }}>
                    <Ionicons name="videocam" size={22} color={colors.primary} />
                    <Text style={S.photoActionTxt}>Video</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity style={S.photoActionBtn} onPress={() => { setPhotoViewer(false); openProfile(); }}>
                <Ionicons name="information-circle" size={22} color={colors.primary} />
                <Text style={S.photoActionTxt}>Info</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Attach menu — WhatsApp-style grid of colored round icons */}
      <Modal visible={attachOpen} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={S.attachBackdrop} onPress={() => setAttachOpen(false)}>
          <Pressable style={S.attachSheet} onPress={() => {}}>
            <View style={S.attachHandle} />
            <View style={S.attachGrid}>
              {attachActions.map((a) => (
                <TouchableOpacity
                  key={a.label}
                  style={S.attachCell}
                  activeOpacity={0.7}
                  onPress={() => { setAttachOpen(false); setTimeout(a.onPress, 120); }}
                >
                  <View style={S.attachIcon}>
                    <Ionicons name={a.icon} size={26} color={colors.text} />
                  </View>
                  <Text style={S.attachLabel} numberOfLines={1}>{a.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* GIF picker (W15) */}
      <GifPicker visible={gifOpen} onClose={() => setGifOpen(false)} onSelect={sendGif} />

      {/* Chat overflow menu — themed bottom sheet (replaces the 3-button Alert) */}
      <Sheet
        visible={!!overflowMenu}
        title={overflowMenu?.title}
        actions={overflowMenu?.actions ?? []}
        onClose={() => setOverflowMenu(null)}
      />

      {/* Media caption preview — WhatsApp-style, supports multiple images */}
      <Modal
        visible={pendingItems.length > 0}
        transparent={false}
        animationType="slide"
        onRequestClose={() => setPendingItems([])}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, backgroundColor: '#000' }}
        >
          {(() => {
            const cur = pendingItems[currentIdx];
            if (!cur) return null;
            const multi = pendingItems.length > 1;
            return (
              <>
                <TouchableOpacity
                  onPress={() => setPendingItems([])}
                  hitSlop={12}
                  style={{ position: 'absolute', top: 48, left: 16, zIndex: 2, width: 40, height: 40, borderRadius: 20, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="close" size={26} color="#fff" />
                </TouchableOpacity>
                {multi && (
                  <View style={{ position: 'absolute', top: 54, right: 16, zIndex: 2, backgroundColor: '#00000088', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 }}>
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{currentIdx + 1} / {pendingItems.length}</Text>
                  </View>
                )}

                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  {cur.mediaType === 'image' ? (
                    <Image source={{ uri: cur.uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                  ) : (
                    <Video
                      source={{ uri: cur.uri }}
                      style={{ width: '100%', height: '100%' }}
                      resizeMode={ResizeMode.CONTAIN}
                      useNativeControls
                      shouldPlay
                      isLooping
                    />
                  )}
                  {cur.viewOnce && (
                    <View style={{ position: 'absolute', top: 100, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: BRAND_ACCENT + '33', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 }}>
                      <Ionicons name="eye" size={14} color={colors.primary} />
                      <Text style={{ color: colors.primary, fontWeight: '700' }}>View once</Text>
                    </View>
                  )}
                </View>

                {/* Thumbnail strip (multi-select) */}
                {multi && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 76, backgroundColor: '#000' }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 10, gap: 8, paddingVertical: 8 }}>
                    {pendingItems.map((it, i) => (
                      <TouchableOpacity key={`${it.uri}-${i}`} activeOpacity={0.8} onPress={() => setCurrentIdx(i)}
                        style={{ width: 56, height: 56, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: i === currentIdx ? colors.primary : 'transparent' }}>
                        <Image source={{ uri: it.uri }} style={{ width: '100%', height: '100%' }} />
                        <TouchableOpacity onPress={() => removePendingAt(i)} hitSlop={6}
                          style={{ position: 'absolute', top: 1, right: 1, width: 18, height: 18, borderRadius: 9, backgroundColor: '#000000aa', alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name="close" size={12} color="#fff" />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity onPress={addMorePhotos} style={{ width: 56, height: 56, borderRadius: 8, borderWidth: 1, borderColor: '#3A3A44', alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="add" size={26} color="#fff" />
                    </TouchableOpacity>
                  </ScrollView>
                )}

                <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, paddingBottom: Platform.OS === 'ios' ? 28 : 14, backgroundColor: '#000' }}>
                  {/* Per-item view-once toggle (WhatsApp "1-in-a-circle") */}
                  <TouchableOpacity
                    onPress={() => updateCurrentItem({ viewOnce: !cur.viewOnce })}
                    style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: cur.viewOnce ? colors.primary : '#1F2937', alignItems: 'center', justifyContent: 'center' }}
                    hitSlop={6}
                  >
                    <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>1</Text>
                    </View>
                  </TouchableOpacity>
                  <TextInput
                    value={cur.caption}
                    onChangeText={(t) => updateCurrentItem({ caption: t })}
                    placeholder={multi ? 'Add a caption…' : 'Add a caption…'}
                    placeholderTextColor="#9CA3AF"
                    multiline
                    style={{ flex: 1, color: '#fff', backgroundColor: '#1F2937', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 16 }}
                  />
                  <TouchableOpacity
                    onPress={confirmSendPendingMedia}
                    disabled={sending}
                    style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.6 : 1 }}
                  >
                    {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={22} color="#fff" />}
                    {multi && !sending && (
                      <View style={{ position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: '#000' }}>
                        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{pendingItems.length}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            );
          })()}
        </KeyboardAvoidingView>
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
            {/* Preview of the message being forwarded (which msg) */}
            {forwardMsg && (
              <View style={S.forwardPreview}>
                <View style={S.replyPreviewLine} />
                <View style={{ flex: 1 }}>
                  <Text style={S.forwardPreviewWho} numberOfLines={1}>
                    {forwardMsg.senderId === meId ? 'You' : (membersById.get(forwardMsg.senderId)?.name || membersById.get(forwardMsg.senderId)?.email || 'Message')}
                  </Text>
                  <Text style={S.forwardPreviewBody} numberOfLines={2}>
                    {forwardMsg.type === 'image' ? '📷 Photo'
                      : forwardMsg.type === 'video' ? '🎥 Video'
                      : forwardMsg.type === 'audio' ? '🎙️ Voice message'
                      : forwardMsg.type === 'file'  ? '📎 File'
                      : forwardMsg.type === 'vaultbeam' ? '📦 File'
                      : (forwardMsg.content && !looksEncrypted(forwardMsg.content) ? forwardMsg.content : `[${forwardMsg.type}]`)}
                  </Text>
                </View>
              </View>
            )}
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

      {/* Per-chat lock gate — covers the chat until the user authenticates */}
      {!lockOpen && lockInfo && (
        <View style={S.lockGate}>
          <Ionicons name="lock-closed" size={56} color={colors.primary} />
          <Text style={S.lockGateTitle}>Chat locked</Text>
          <Text style={S.lockGateSub}>{lockInfo.chatName}</Text>

          {(lockInfo.lockMethod === 'biometric' || lockInfo.lockMethod === 'both') && (
            <TouchableOpacity
              style={S.lockGateBtn}
              onPress={async () => { if (await verifyBiometric('Unlock chat')) setLockOpen(true); }}
            >
              <Ionicons name="finger-print" size={18} color="#fff" />
              <Text style={S.lockGateBtnTxt}>Use biometrics</Text>
            </TouchableOpacity>
          )}

          {(lockInfo.lockMethod === 'pin' || lockInfo.lockMethod === 'both') && (
            <View style={{ width: '100%', maxWidth: 280, marginTop: 18 }}>
              <TextInput
                style={S.lockGateInput}
                value={lockPin}
                onChangeText={(t) => { setLockPin(t); setLockErr(false); }}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={8}
                placeholder="Enter PIN"
                placeholderTextColor={colors.textFaint}
                onSubmitEditing={submitLockPin}
              />
              {lockErr && <Text style={S.lockGateErr}>Incorrect PIN</Text>}
              <TouchableOpacity style={[S.lockGateBtn, { marginTop: 12 }]} onPress={submitLockPin}>
                <Text style={S.lockGateBtnTxt}>Unlock</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity style={{ marginTop: 20 }} onPress={() => router.replace('/(tabs)/chats' as any)}>
            <Text style={S.lockGateBack}>Back to chats</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
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
        onPress={() => { if (!navigateFromUrl(url)) Linking.openURL(url).catch(() => {}); }}
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
  attachmentId, filename, mime, size, authHeader, resolvedUri, isMine, thumb, encrypted,
}: {
  attachmentId: string;
  filename:     string;
  mime:         string;
  size:         number;
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
  thumb?:       string;   // PDF first-page preview (base64 jpeg)
  encrypted?:   boolean;  // meta.encrypted — see mediaStore.MediaKeyMissingError
}) {
  const S = useS();
  const [busy, setBusy] = useState(false);

  const onOpen = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Persistent local copy (downloaded once). Survives "Clear cache" AND the
      // server's post-delivery purge. Encrypted files arrive decrypted via
      // resolvedUri; everything else resolves through the persistent media store.
      const localUri = resolvedUri?.uri ?? await getMedia(attachmentId, { kind: 'file', isMine, mime, filename, encrypted });
      // Copy into the app cache so the OS FileProvider can hand the file to
      // another app (the provider is configured over the cache dir).
      const openUri = await copyToCache(localUri, filename || `file-${attachmentId}`);

      if (Platform.OS === 'android') {
        // WhatsApp-style: hand the file to the system "Open with" chooser so apps
        // that can VIEW this type open it (ACTION_VIEW), instead of a share sheet.
        try {
          const contentUri = await FileSystem.getContentUriAsync(openUri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
            type: mime || undefined,
          });
        } catch {
          // No app can open this type → offer to share/save instead.
          try {
            if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(openUri, { mimeType: mime, dialogTitle: filename });
            else Alert.alert('Can’t open file', 'No app on this device can open this file type.');
          } catch { Alert.alert('Can’t open file', 'No app on this device can open this file type.'); }
        }
      } else if (await Sharing.isAvailableAsync()) {
        // iOS has no ACTION_VIEW; its share/open-in sheet is the equivalent.
        await Sharing.shareAsync(openUri, { mimeType: mime, dialogTitle: filename });
      }
    } catch (e: any) {
      Alert.alert('Could not open file', e?.message ?? 'Try again');
    } finally {
      setBusy(false);
    }
  }, [attachmentId, filename, mime, resolvedUri, busy]);

  // PDF with a page-1 preview → WhatsApp-style document card (preview on top,
  // filename row below). Other files → the plain icon + name row.
  if (thumb) {
    return (
      <TouchableOpacity style={S.fileCard} onPress={onOpen} activeOpacity={0.85} disabled={busy}>
        <Image source={{ uri: thumbDataUri(thumb) }} style={S.filePreview} resizeMode="cover" />
        <View style={S.fileCardRow}>
          <View style={[S.fileIcon, isMine ? S.fileIconMine : S.fileIconTheirs]}>
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="document-text" size={20} color="#fff" />}
          </View>
          <View style={S.fileMeta}>
            <Text style={[S.fileName, isMine && S.fileNameMine]} numberOfLines={1}>{filename}</Text>
            <Text style={[S.fileSize, isMine && S.fileSizeMine]}>{formatBytes(size)}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={S.fileRow} onPress={onOpen} activeOpacity={0.7} disabled={busy}>
      <View style={[S.fileIcon, isMine ? S.fileIconMine : S.fileIconTheirs]}>
        {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="document-text" size={22} color="#fff" />}
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
  attachmentId, durationMs, waveform, authHeader, resolvedUri, isMine, mime, encrypted,
}: {
  attachmentId: string;
  durationMs:   number;
  waveform?:    number[];
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
  mime?:        string;
  encrypted?:   boolean;  // meta.encrypted — see mediaStore.MediaKeyMissingError
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
    try {
      if (playing) {
        await soundRef.current?.pauseAsync();
        setPlaying(false);
        return;
      }
      if (!soundRef.current) {
        // Play from the PERSISTENT local copy (download once). Survives "Clear
        // cache" and the server's post-delivery purge. Encrypted notes already
        // arrive as a local decrypted file via resolvedUri.
        let src: { uri: string } | null = resolvedUri ? { uri: resolvedUri.uri } : null;
        if (!src) { try { src = { uri: await getMedia(attachmentId, { kind: 'voice', isMine, mime, encrypted }) }; } catch { return; } }
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
  }, [attachmentId, authHeader, resolvedUri, playing, isMine, mime, encrypted]);

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
        <Ionicons name={playing ? 'pause' : 'play'} size={19} color="#fff" style={playing ? undefined : { marginLeft: 2 }} />
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

// ─── Image bubble ────────────────────────────────────────────
// Renders an image from the PERSISTENT on-device media folder (downloaded once
// via getAttachmentLocalUri). Survives "Clear cache" AND the server's
// post-delivery purge — only an uninstall removes it, like WhatsApp's media
// folder. Encrypted media arrives as an already-decrypted local file.
// Retry a failed media download the moment the network comes back (WhatsApp
// auto-download-on-reconnect). Fires only on an OFFLINE/CONNECTING → ONLINE edge.
function useRetryOnReconnect(eligible: boolean, retry: () => void) {
  const conn = useConnectionState();
  const prev = useRef(conn);
  useEffect(() => {
    if (prev.current !== 'ONLINE' && conn === 'ONLINE' && eligible) retry();
    prev.current = conn;
  }, [conn, eligible, retry]);
}

function ImageAttachment({ attachmentId, resolvedUri, isMine, mime, thumb, encrypted, onError }: {
  attachmentId: string;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine?: boolean;
  mime?: string;
  thumb?: string;   // base64 JPEG shown instantly while the full image loads
  encrypted?: boolean;  // meta.encrypted — lets a missing key be reported as such
  onError?: () => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  const [uri, setUri] = useState<string | null>(resolvedUri?.uri ?? null);
  const [needTap, setNeedTap] = useState(false);    // gated by auto-download policy
  const [progress, setProgress] = useState<number | null>(null); // null=idle, 0-1=downloading
  // The bytes exist but this install has no key for them (typically: the media
  // predates a reinstall, which destroys both the per-file keys and the E2EE
  // identity). Distinct from a failed download — retrying can never fix it.
  const [keyMissing, setKeyMissing] = useState(false);
  const download = useCallback(() => {
    setNeedTap(false);
    setProgress(0);
    getMedia(attachmentId, { kind: 'image', isMine, mime, encrypted, onProgress: setProgress })
      .then(u => { setUri(u || null); setProgress(null); })
      .catch((e: any) => {
        setProgress(null);
        if (e?.code === 'MEDIA_KEY_MISSING') { setKeyMissing(true); return; }
        onError?.();
      });
  }, [attachmentId, isMine, mime, encrypted, onError]);
  useEffect(() => {
    if (resolvedUri?.uri) { setUri(resolvedUri.uri); return; }
    let cancel = false;
    (async () => {
      // Already cached? render instantly (no gating). Own media is always local.
      const local = await getMedia(attachmentId, { kind: 'image', isMine, mime, encrypted, cacheOnly: true }).catch(() => '');
      if (cancel) return;
      if (local) { setUri(local); return; }
      // Not cached → honor the media auto-download policy.
      const ok = !!isMine || await shouldAutoDownloadNow();
      if (cancel) return;
      if (ok) download();
      else setNeedTap(true);
    })();
    return () => { cancel = true; };
  }, [attachmentId, resolvedUri?.uri, isMine, mime, encrypted]);
  // Auto-download failed offline → retry as soon as we're back online. Never for
  // a missing key: the network was never the problem.
  useRetryOnReconnect(!uri && !keyMissing && progress == null && !needTap && !resolvedUri?.uri, download);
  if (!uri) {
    // No key on this device → say so, instead of showing a broken image (and
    // instead of writing ciphertext into the media folder under a .jpg name).
    if (keyMissing) {
      return (
        <View style={[S.attachedImage, S.imageError]}>
          <Ionicons name="lock-closed-outline" size={26} color={colors.textDim} />
          <Text style={S.mediaUnavailableTxt}>Not available on this device</Text>
        </View>
      );
    }
    // Downloading → blurred thumb + determinate progress ring.
    if (progress != null) {
      return (
        <View style={S.attachedImage}>
          {thumb ? <Image source={{ uri: thumbDataUri(thumb) }} style={S.attachedImage} resizeMode="cover" blurRadius={2} /> : <View style={[S.attachedImage, S.imageError]} />}
          <View style={S.dlOverlay}><ProgressRing progress={progress} /></View>
        </View>
      );
    }
    // Auto-download skipped by policy → tap-to-download over the blurred thumb.
    if (needTap) {
      return (
        <TouchableOpacity activeOpacity={0.85} onPress={download} style={S.attachedImage}>
          {thumb ? <Image source={{ uri: thumbDataUri(thumb) }} style={S.attachedImage} resizeMode="cover" blurRadius={3} /> : <View style={[S.attachedImage, S.imageError]} />}
          <View style={S.dlOverlay}>
            <Ionicons name="arrow-down-circle" size={40} color="#fff" />
            <Text style={S.dlOverlayTxt}>Download</Text>
          </View>
        </TouchableOpacity>
      );
    }
    // Instant low-res preview from the embedded thumbnail while the full image
    // downloads (WhatsApp-style progressive load).
    if (thumb) return <Image source={{ uri: thumbDataUri(thumb) }} style={S.attachedImage} resizeMode="cover" />;
    return <View style={[S.attachedImage, S.imageError]}><ActivityIndicator color={colors.primary} /></View>;
  }
  return <Image source={{ uri }} style={S.attachedImage} resizeMode="cover" onError={onError} />;
}

// ─── Video bubble ────────────────────────────────────────────
// Inline player using expo-av's <Video>. Tap = native controls, no
// autoplay. Streams the auth-gated /uploads endpoint via the Bearer
// header. onLoadError surfaces 410-Gone (view-once consumed) so the
// MessageBubble can flip to a "Viewed" tombstone without an extra
// HEAD round-trip.
function VideoBubble({
  attachmentId, durationMs, authHeader, resolvedUri, onErrorOnce, isNote, onOpen, isMine, mime, thumb, encrypted,
}: {
  attachmentId:  string;
  durationMs:    number;
  authHeader:    string | null;
  resolvedUri?:  { uri: string; headers?: Record<string, string> } | null;
  onErrorOnce?:  () => void;
  isNote?:       boolean;   // round "video note" vs rectangular video
  onOpen?:       () => void; // open full-screen player
  isMine?:       boolean;
  mime?:         string;
  thumb?:        string;    // base64 JPEG poster (instant, no download)
  encrypted?:    boolean;   // meta.encrypted — see mediaStore.MediaKeyMissingError
}) {
  const S = useS();
  // WhatsApp-style: do NOT mount a <Video> (ExoPlayer) at rest — each instance
  // buffers the file in memory, and many bubbles at once OOM'd the app. We show
  // a lightweight placeholder + play button. Regular videos open the full-screen
  // player on tap (one player at a time). Video notes lazily download then play
  // inline in the round bubble — so at most ONE <Video> is ever alive.
  const [playing, setPlaying] = useState(false);
  const [noteUri, setNoteUri] = useState<string | null>(resolvedUri?.uri ?? null);
  const [busy, setBusy] = useState(false);

  const onTap = useCallback(async () => {
    if (!isNote) { onOpen?.(); return; }
    if (playing) { setPlaying(false); return; }
    let uri = noteUri;
    if (!uri) {
      setBusy(true);
      try { uri = resolvedUri?.uri ?? await getMedia(attachmentId, { kind: 'video', isMine, mime, encrypted }); setNoteUri(uri); }
      catch { onErrorOnce?.(); setBusy(false); return; }
      setBusy(false);
    }
    setPlaying(true);
  }, [isNote, playing, noteUri, resolvedUri?.uri, attachmentId, onOpen, onErrorOnce, isMine, mime, encrypted]);

  const showingVideo = isNote && playing && !!noteUri;
  return (
    <TouchableOpacity
      style={isNote ? S.videoNoteWrap : S.videoWrap}
      activeOpacity={0.9}
      onPress={onTap}
    >
      {showingVideo ? (
        <Video
          source={{ uri: noteUri! }}
          style={S.videoNoteView}
          useNativeControls={false}
          resizeMode={ResizeMode.COVER}
          isLooping={false}
          shouldPlay
          onPlaybackStatusUpdate={(st: any) => { if (st?.didJustFinish) setPlaying(false); }}
          onError={() => { setPlaying(false); onErrorOnce?.(); }}
        />
      ) : thumb ? (
        <Image source={{ uri: thumbDataUri(thumb) }} style={isNote ? S.videoNoteView : S.videoView} resizeMode="cover" />
      ) : (
        <View style={[isNote ? S.videoNoteView : S.videoView, S.videoPlaceholder]}>
          <Ionicons name="videocam" size={34} color="#5B6470" />
        </View>
      )}
      {!showingVideo && (
        <View style={S.videoPlayOverlay} pointerEvents="none">
          <View style={S.videoPlayBtn}>
            {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="play" size={26} color="#fff" style={{ marginLeft: 3 }} />}
          </View>
        </View>
      )}
      {durationMs > 0 && !showingVideo && (
        <Text style={[S.videoDuration, isNote && S.videoNoteDuration]}>{formatRecDuration(durationMs)}</Text>
      )}
    </TouchableOpacity>
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

// WhatsApp-style "N unread messages" separator, shown above the first message
// the user hasn't read yet.
function UnreadDivider({ count }: { count: number }) {
  const S = useS();
  return (
    <View style={S.unreadDivRow}>
      <Text style={S.unreadDivTxt}>{count} unread message{count === 1 ? '' : 's'}</Text>
    </View>
  );
}

// Compact emoji picker for inserting into the composer (no native dep).
const EMOJIS = (
  '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😊 😇 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 🤩 ' +
  '😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🫠 🥲 ' +
  '😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👻 💀 👀 ' +
  '👍 👎 👊 ✊ 🤛 🤜 👏 🙌 👐 🤝 🙏 ✌️ 🤞 🫶 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ 🖐️ ✋ 🖖 👋 🤙 💪 ' +
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 🔥 ✨ ⭐ 🌟 💫 ⚡ 💥 🎉 🎊 🎈 🎁'
).split(' ').filter(Boolean);

function EmojiPanel({ onPick }: { onPick: (e: string) => void }) {
  const S = useS();
  return (
    <View style={S.emojiPanel}>
      <ScrollView contentContainerStyle={S.emojiWrap} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {EMOJIS.map((e, i) => (
          <TouchableOpacity key={`${e}-${i}`} style={S.emojiCell} onPress={() => onPick(e)} activeOpacity={0.6}>
            <Text style={S.emojiGlyph}>{e}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
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
  msg, meId, member, chatId, otherMembers, onLongPress, onJumpTo,
  reactionsForMsg, onToggleReaction,
  replyTarget, replyTargetMember,
  highlight, tiltRevealed, grouped, bubbleColors,
  pollVotesForMsg, onPollVoteChange,
}: {
  msg: DisplayMessage;
  meId: string | null;
  member?: ChatMember;
  chatId: string;
  otherMembers: ChatMember[];
  onLongPress: (msg: DisplayMessage, plain: string) => void;
  onJumpTo?: (targetId: number) => void;
  grouped?: boolean; // true when grouped with the previous (older) same-sender msg
  bubbleColors?: { mine: string; peer: string } | null;
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
  // Per-chat bubble theme: recolors only YOUR (outgoing) bubble — received
  // bubbles always follow the theme (WhatsApp-style). Text color auto-picked
  // for legibility on the chosen background.
  const bubbleBg = bubbleColors && isMine ? bubbleColors.mine : null;
  const bubbleTxtColor = bubbleBg ? idealText(bubbleBg) : null;
  // Init from content directly when it's already plaintext (the common case
  // after decrypt-at-ingest) → no decryption flash on first render.
  const [plain, setPlain] = useState<string>(() => looksEncrypted(msg.content) ? '' : (msg.content ?? ''));
  const [replyPlain, setReplyPlain] = useState<string>('');
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  // Tick state — only meaningful for own server-confirmed messages.
  // WhatsApp group semantics: blue (read) only when EVERY current recipient has
  // read; double-grey (delivered) only when every current recipient received.
  // Exclude members who LEFT (leftAt) so a departed member never blocks a tick,
  // and members who JOINED AFTER this message (they were never a recipient of it).
  // Guard the empty set because [].every() is vacuously true (would false-blue).
  // read implies delivered, so fold read into the delivered test — a dropped
  // `message_delivered` event must not strand a since-read message at 'sent'.
  let tickState: 'pending' | 'sent' | 'delivered' | 'read' | null = null;
  if (isMine && msg.id > 0 && !msg.deletedAt) {
    const recipients = otherMembers.filter(
      m => !m.leftAt && (!m.joinedAt || m.joinedAt <= msg.createdAt),
    );
    if (msg._state === 'pending' || msg._state === 'failed') {
      tickState = msg._state === 'pending' ? 'pending' : null;
    } else if (recipients.length === 0) {
      tickState = 'sent';
    } else if (recipients.every(m => (m.lastReadMessageId ?? 0) >= msg.id)) {
      tickState = 'read';
    } else if (recipients.every(m => Math.max(m.lastDeliveredMessageId ?? 0, m.lastReadMessageId ?? 0) >= msg.id)) {
      tickState = 'delivered';
    } else {
      tickState = 'sent';
    }
  }

  useEffect(() => {
    // Messages are decrypted once at ingest, so content is usually already
    // plaintext → render directly, no async work. Only a still-encrypted
    // envelope (rare: failed/out-of-order ingest) decrypts here as a fallback.
    if (!looksEncrypted(msg.content)) { setPlain(msg.content ?? ''); return; }
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

  // NOTE: the deleted-message early return lives BELOW all hooks (after
  // handleRevealViewOnce) — an early return up here renders fewer hooks when a
  // visible message transitions to deleted (delete-for-everyone / vanish /
  // disappearing) and crashes the list with "Rendered fewer hooks than expected".

  const isGif   = msg.type === 'image' && !!msg.meta?.gifUrl;
  // `localUri` = an optimistic (still-uploading) bubble rendering the sender's
  // own local file; treat it as image/video so it paints before it has an id.
  const isImage = msg.type === 'image' && (msg.meta?.attachmentId || msg.meta?.localUri) && !isGif;
  const isVideo = msg.type === 'video' && (msg.meta?.attachmentId || msg.meta?.localUri);
  const isAudio = msg.type === 'audio' && msg.meta?.attachmentId;
  const isFile  = msg.type === 'file'  && msg.meta?.attachmentId;
  const isVaultbeam = msg.type === 'vaultbeam';

  // Open image/video full-screen (WhatsApp-style). Navigate INSTANTLY and let
  // the viewer resolve a local file — so taps are reliable and never stack.
  const bubbleRouter = useRouter();
  const openingRef = useRef(false);
  const openFullScreen = useCallback((kind: 'image' | 'video', viewOnce = false) => {
    if (openingRef.current) return;                      // guard against rapid double-taps
    openingRef.current = true;
    setTimeout(() => { openingRef.current = false; }, 700);
    const params: any = { filename: String(msg.meta?.filename || ''), msgType: kind };
    if (viewOnce) {
      params.viewOnce = '1';        // viewer loads to cache + marks viewed after load
      params.chatId = chatId;       // so the protected viewer can alert the sender on capture
    }
    if (msg.meta?.gifUrl) {
      params.mediaUrl = String(msg.meta.gifUrl);                 // external GIF — no auth
    } else if (isEncMedia && mediaSrc?.uri) {
      params.mediaUrl = mediaSrc.uri;                            // encrypted → already-decrypted local file
    } else if (msg.meta?.attachmentId) {
      // The bubble already saved this to the PERSISTENT media folder, so the
      // viewer resolves it instantly (no re-download) and it works even after
      // the server purges its copy.
      params.attachmentId = String(msg.meta.attachmentId);
      params.isMine = isMine ? '1' : '';
      params.mime = String(msg.meta?.mime || '');
    } else { openingRef.current = false; return; }
    bubbleRouter.push({ pathname: '/media-viewer' as any, params });
  }, [msg.meta?.attachmentId, msg.meta?.gifUrl, msg.meta?.filename, isEncMedia, mediaSrc?.uri, isMine, bubbleRouter, chatId]);
  const isSticker = msg.type === 'sticker' && !!msg.content;
  const isPoll  = msg.type === 'poll' && Array.isArray(msg.meta?.options);
  const isLocation = msg.type === 'location';

  // ── View-once gate (WhatsApp-style) ──────────────────────
  // Photo/video only. The OWNER sees their own media inline. A recipient gets a
  // tap-to-view shield; tapping opens it full-screen ONCE, then it's permanently
  // a "viewed" tombstone — persisted locally (lib/viewOnceStore) so it survives
  // re-renders, scrolls, and restarts. The server also 410s after the first GET.
  const isViewOnceMedia = !!msg.meta?.viewOnce && (isImage || isVideo);
  const revealed = !isViewOnceMedia || isMine;   // owner sees inline; recipients use the shield
  const [tombstoned, setTombstoned] = useState<boolean>(
    isViewOnceMedia && !isMine && isViewedOnceSync(String(msg.id)),
  );
  useEffect(() => {
    if (isViewOnceMedia && !isMine) {
      isViewedOnce(String(msg.id)).then(v => { if (v) setTombstoned(true); });
    }
  }, [isViewOnceMedia, isMine, msg.id]);
  // ── Revoked gate (VaultView) ─────────────────────────────
  // Independent of view-once and of who sent it: once the sender revokes, the
  // media is gone for BOTH sides. meta.revoked is set by the socket handler
  // (recipient) or optimistically by the Revoke action (sender); the local
  // store is the durable record so it survives a restart with no round-trip.
  const attId = msg.meta?.attachmentId ? String(msg.meta.attachmentId) : '';
  const isRevokedMedia = !!msg.meta?.revoked || (!!attId && isRevokedSync(attId));

  const handleRevealViewOnce = useCallback(() => {
    if (tombstoned || isRevokedMedia) return;
    markViewedOnce(String(msg.id));   // persist locally so it never re-appears
    setTombstoned(true);              // bubble becomes "viewed" immediately
    // Open full-screen as view-once: the viewer downloads to CACHE (never the
    // browsable folder) and marks the server "viewed" only AFTER the media has
    // loaded — otherwise the POST /viewed races the GET and the GET 410s
    // ("Failed to load media").
    openFullScreen(isVideo ? 'video' : 'image', true);
  }, [tombstoned, isRevokedMedia, msg.id, isVideo, openFullScreen]);

  // Deleted tombstone — safe here: every hook above has already run this render.
  if (msg.deletedAt) {
    return (
      <View style={[S.bubble, S.bubbleSystem]}>
        <Text style={S.bubbleSystemTxt}>Message deleted</Text>
      </View>
    );
  }

  return (
    <View style={[S.bubbleRow, isMine ? S.bubbleRowMine : S.bubbleRowTheirs, grouped && S.bubbleRowGrouped]}>
      <TouchableOpacity
        style={[
          S.bubble,
          isMine ? S.bubbleMine : S.bubbleTheirs,
          bubbleBg ? { backgroundColor: bubbleBg } : null,
          // Soften the tail corner on grouped (consecutive) messages.
          grouped && (isMine ? { borderTopRightRadius: 16 } : { borderTopLeftRadius: 16 }),
          (isImage || isVideo || isGif) && S.mediaBubble,
          isSticker && S.stickerBubble,
          msg._state === 'pending' && S.bubblePending,
          msg._state === 'failed'  && S.bubbleFailed,
        ]}
        onPress={() => {
          if (msg._state === 'failed') { onLongPress(msg, plain); return; }
          // Tap an image bubble → open full screen (WhatsApp-style). Video bubbles
          // have their own play/tap handling inside VideoBubble.
          if (isImage && !isViewOnceMedia) openFullScreen('image');
          else if (isGif) openFullScreen('image');
        }}
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

        {/* Inline reply preview (above the body) — tap to jump to the original.
            Suppressed on forwarded messages: a forward carries no reply context
            (it shows "↪ Forwarded"), so we must never render a reply quote. */}
        {(msg.replyToId ?? 0) > 0 && !msg.meta?.forwardedFrom && (
          <TouchableOpacity
            style={S.replyPreview}
            activeOpacity={0.6}
            onPress={() => { const t = replyTarget?.id ?? msg.replyToId; if (t && t > 0) onJumpTo?.(t); }}
          >
            <View style={S.replyPreviewLine} />
            <View style={{ flex: 1 }}>
              <Text style={S.replyPreviewWho} numberOfLines={1}>
                {replyTarget
                  ? (replyTarget.senderId === meId ? 'You' : (replyTargetMember?.name || replyTargetMember?.email || 'Unknown'))
                  : 'Replied message'}
              </Text>
              <Text style={S.replyPreviewBody} numberOfLines={1}>
                {!replyTarget ? 'Tap to view'
                  : replyTarget.type === 'image' ? '📷 Photo'
                  : replyTarget.type === 'audio' ? '🎙️ Voice message'
                  : replyTarget.type === 'video' ? '🎥 Video'
                  : replyTarget.type === 'file'  ? '📎 File'
                  : replyTarget.type === 'vaultbeam' ? '📦 File'
                  : (replyPlain || '…')}
              </Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Revoked tombstone — outranks every other media state, both sides */}
        {isRevokedMedia ? (
          <View style={S.viewOnceTombstone}>
            <Text style={S.viewOnceTombstoneTxt}>
              🚫 {isMine ? 'You revoked this media' : 'Media revoked by sender'}
            </Text>
          </View>
        ) : /* View-once tombstone — replaces media after it's been viewed */
        (isImage || isVideo) && tombstoned ? (
          <View style={S.viewOnceTombstone}>
            <Text style={S.viewOnceTombstoneTxt}>👁️ {isImage ? 'Photo' : 'Video'} viewed</Text>
          </View>
        ) : isViewOnceMedia && !revealed ? (
          <TouchableOpacity
            style={S.viewOnceShield}
            onPress={handleRevealViewOnce}
            activeOpacity={0.7}
          >
            <Ionicons name="eye-outline" size={26} color={colors.textDim} style={{ marginBottom: 4 }} />
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
          <ImageAttachment
            attachmentId={msg.meta.attachmentId || ''}
            resolvedUri={msg.meta?.localUri ? { uri: String(msg.meta.localUri) } : (isEncMedia ? mediaSrc : undefined)}
            isMine={isMine}
            mime={String(msg.meta?.mime || '')}
            thumb={typeof msg.meta?.thumb === 'string' ? msg.meta.thumb : undefined}
            encrypted={isEncMedia}
            onError={() => { if (isViewOnceMedia && !isMine) setTombstoned(true); }}
          />
        ) : isVideo ? (
          <VideoBubble
            attachmentId={msg.meta.attachmentId || ''}
            durationMs={Number(msg.meta?.durationMs) || 0}
            authHeader={authHeader}
            resolvedUri={msg.meta?.localUri ? { uri: String(msg.meta.localUri) } : (isEncMedia ? mediaSrc : undefined)}
            isNote={!!msg.meta?.videoNote}
            onOpen={() => openFullScreen('video')}
            onErrorOnce={() => { if (isViewOnceMedia && !isMine) setTombstoned(true); }}
            isMine={isMine}
            mime={String(msg.meta?.mime || '')}
            thumb={typeof msg.meta?.thumb === 'string' ? msg.meta.thumb : undefined}
            encrypted={isEncMedia}
          />
        ) : isAudio ? (
          <AudioBubble
            attachmentId={msg.meta.attachmentId}
            durationMs={Number(msg.meta?.durationMs) || 0}
            waveform={Array.isArray(msg.meta?.waveform) ? msg.meta.waveform : undefined}
            authHeader={authHeader}
            resolvedUri={isEncMedia ? mediaSrc : undefined}
            isMine={isMine}
            mime={String(msg.meta?.mime || '')}
            encrypted={isEncMedia}
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
            thumb={typeof msg.meta?.thumb === 'string' ? msg.meta.thumb : undefined}
            encrypted={isEncMedia}
          />
        ) : isVaultbeam ? (
          <VaultBeamBubble msg={msg} isMine={isMine} plain={plain} />
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
              onPress={() => { if (ok) navigateTo(L.lat, L.lng, L.address || 'Shared location'); }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 190 }}>
                <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: 'rgba(157,111,208,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={L?.live ? 'navigate' : 'location'} size={22} color="#9D6FD0" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontWeight: '700' }]}>
                    {L?.live ? 'Live location' : 'Location'}
                  </Text>
                  {ok && !!L.address && (
                    <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontSize: 12, opacity: 0.85 }]} numberOfLines={2}>
                      {L.address}
                    </Text>
                  )}
                  {ok && <Text style={{ color: '#9D6FD0', fontSize: 12, fontWeight: '700', marginTop: 2 }}>Open in Maps ›</Text>}
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
                <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, bubbleTxtColor ? { color: bubbleTxtColor } : null]}>
                  {renderRichText(plain, highlight)}
                </Text>
                {(() => {
                  // F5: prefer the sender-embedded E2EE preview (no fetch at
                  // all); legacy messages without one fall back to the old
                  // server-proxied lookup so old chats keep their cards.
                  const lp = msg.meta?.linkPreview;
                  if (lp?.t) return <LinkPreview url={lp.u} data={lp} />;
                  const u = extractUrl(plain);
                  return u ? <LinkPreview url={u} /> : null;
                })()}
              </>
            )
          ) : looksEncrypted(msg.content) ? (
            // Envelope that never decrypted (desynced ratchet / E2EE off): show the
            // standard lock indicator instead of a blank bubble or raw ciphertext.
            <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontStyle: 'italic', opacity: 0.7 }]}>
              🔒 unable to decrypt
            </Text>
          ) : null
        )}

        {/* Caption under a photo/video. For plaintext media the decrypted
            content IS the caption; for encrypted media it's {t,mk} JSON. */}
        {(isImage || isVideo) && (() => {
          let cap = '';
          if (plain) {
            if (msg.meta?.encrypted) { try { cap = JSON.parse(plain)?.t || ''; } catch { cap = ''; } }
            else cap = plain;
          }
          // Media bubble is transparent (no fill) — caption sits over the chat
          // background, so use the normal readable text color, not the on-orange white.
          return cap ? (
            <Text style={[S.bubbleTxt, { marginTop: 6, color: colors.text, paddingHorizontal: 4 }]}>
              {renderRichText(cap, highlight)}
            </Text>
          ) : null;
        })()}

        <Text style={[S.bubbleMeta, (!isMine || isImage || isVideo || isGif) && { color: colors.bubbleMetaIn }, (isImage || isVideo || isGif) && { paddingHorizontal: 4 }]}>
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
  screen:        { flex: 1, backgroundColor: c.chatBg },
  lockGate:      { ...StyleSheet.absoluteFillObject, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32, zIndex: 50 },
  lockGateTitle: { color: c.text, fontSize: 20, fontWeight: '800', marginTop: 16 },
  lockGateSub:   { color: c.textDim, fontSize: 14, marginTop: 6, textAlign: 'center' },
  lockGateBtn:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.primary, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 24, marginTop: 20, minWidth: 200 },
  lockGateBtnTxt:{ color: '#fff', fontSize: 15, fontWeight: '800' },
  lockGateInput: { backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, color: c.text, fontSize: 18, textAlign: 'center', letterSpacing: 6, paddingVertical: 12 },
  lockGateErr:   { color: c.danger, fontSize: 13, textAlign: 'center', marginTop: 8 },
  lockGateBack:  { color: c.textDim, fontSize: 14, fontWeight: '600' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8, backgroundColor: c.bg },
  headerIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerIcon:    { fontSize: 20 },
  headerAvatarWrap:  { width: 36, height: 36 },
  // Scroll-to-bottom FAB
  scrollDownBtn:     { position: 'absolute', right: 14, bottom: 92, width: 44, height: 44, borderRadius: 22, backgroundColor: c.surfaceSolid, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, alignItems: 'center', justifyContent: 'center', ...ELEVATION.md, shadowColor: '#000' },
  scrollDownBadge:   { position: 'absolute', top: -5, right: -5, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, borderWidth: 2, borderColor: c.bg },
  scrollDownBadgeTxt:{ color: '#fff', fontSize: 11, fontWeight: '800' },
  // Message Info sheet
  infoBackdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  infoSheet:         { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28 },
  sheetGrip:         { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 10 },
  infoTitle:         { color: c.text, fontSize: 17, fontWeight: '800', marginBottom: 4 },
  infoSecHdr:        { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  infoSecTitle:      { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  infoRow:           { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  infoName:          { color: c.text, fontSize: 15, fontWeight: '600', flex: 1 },
  infoEmpty:         { color: c.textDim, fontSize: 13, paddingVertical: 16, textAlign: 'center' },
  // Profile-photo popup (avatar tap)
  photoBackdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  photoCard:         { width: '100%', maxWidth: 360, borderRadius: 16, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  photoImgWrap:      { width: '100%', aspectRatio: 1, backgroundColor: c.primary },
  photoImg:          { width: '100%', height: '100%' },
  photoInitialsWrap: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  photoInitials:     { color: '#fff', fontSize: 84, fontWeight: '800' },
  photoNameBar:      { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.45)' },
  photoNameTxt:      { color: '#fff', fontSize: 19, fontWeight: '700' },
  photoActions:      { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, backgroundColor: c.surfaceSolid },
  photoActionBtn:    { alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  photoActionTxt:    { color: c.primary, fontSize: 12, fontWeight: '600' },
  headerAvatar:      { width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  headerAvatarImg:   { width: '100%', height: '100%' },
  headerAvatarTxt:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  headerPresenceDot: { position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, backgroundColor: '#22C55E', borderWidth: 2, borderColor: c.bg },

  // Day 13 — in-chat search
  inChatSearchBar:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  inChatSearchInput:  { flex: 1, color: c.text, backgroundColor: c.surface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
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
  pinnedBarTitle:{ color: c.primary, fontSize: 11, fontWeight: '700' },
  pinnedBarSub:  { color: c.textDim, fontSize: 12.5, marginTop: 1 },

  dateChipRow:   { alignItems: 'center', marginVertical: 10 },
  dateChip:      { backgroundColor: c.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  dateChipTxt:   { color: c.textDim, fontSize: 11.5, fontWeight: '700' },
  unreadDivRow:  { alignItems: 'center', marginVertical: 8 },
  unreadDivTxt:  { color: c.primary, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.3, backgroundColor: brandAlpha(0.14), borderRadius: 999, paddingHorizontal: 14, paddingVertical: 4, overflow: 'hidden' },

  // Emoji insertion panel above the composer
  emojiPanel:    { height: 240, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  emojiWrap:     { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 6, paddingVertical: 8 },
  emojiCell:     { width: `${100 / 8}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  emojiGlyph:    { fontSize: 26 },

  bubbleRow:     { marginVertical: 4, flexDirection: 'row' },
  bubbleRowGrouped: { marginTop: 1 }, // tighter spacing for consecutive same-sender msgs
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs:{ justifyContent: 'flex-start' },
  bubble:        { maxWidth: '78%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, gap: 2 },
  bubbleMine:    { backgroundColor: c.bubbleOut, borderTopRightRadius: 4 },   // WhatsApp "sent"
  bubbleTheirs:  { backgroundColor: c.bubbleIn, borderTopLeftRadius: 4 },     // WhatsApp "received"
  bubblePending: { opacity: 0.6 },
  bubbleFailed:  { borderWidth: 1, borderColor: c.danger, opacity: 0.85 },
  bubbleSystem:  { alignSelf: 'center', backgroundColor: 'transparent', paddingVertical: 4 },
  bubbleSystemTxt:{ color: c.textDim, fontSize: 11, fontStyle: 'italic' },
  senderTag:     { color: c.textDim, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  bubbleTxt:     { color: c.bubbleInText, fontSize: 15, lineHeight: 20 },
  bubbleTxtMine: { color: c.bubbleOutText },
  bubbleMeta:    { color: c.bubbleMetaOut, fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },
  ttlBadge:      { color: '#FCD34D', fontSize: 10, fontWeight: '700' },
  tick:          { color: c.bubbleMetaOut, fontSize: 11, fontWeight: '700' },
  tickRead:      { color: c.tickRead,      fontSize: 11, fontWeight: '700' },

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

  composer:      { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 8, paddingVertical: 7, gap: 7, backgroundColor: c.bg },
  inputPill:     { flex: 1, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: c.surface, borderRadius: 24, minHeight: 48, paddingLeft: 16, paddingRight: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  pillIconBtn:   { width: 38, height: 46, alignItems: 'center', justifyContent: 'center' },
  camWrap:       { width: 38, height: 46, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  camRing:       { position: 'absolute', width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: c.primary, backgroundColor: 'rgba(0,0,0,0)' },
  camDragHint:   { position: 'absolute', bottom: 50, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.primary, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, ...ELEVATION.sm, shadowColor: c.primary },
  camDragHintTxt:{ color: '#fff', fontSize: 12, fontWeight: '800' },
  camHintChevron:{ position: 'absolute', bottom: 42, alignSelf: 'center' },
  sendFab:       { width: 48, height: 48, borderRadius: 24, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', elevation: 3, shadowColor: '#000', shadowOpacity: 0.25, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4 },
  attachBtn:     { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  attachTxt:     { fontSize: 18 },

  // Attach menu — WhatsApp-style grid
  attachBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  attachSheet:    { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 10, paddingBottom: 32, paddingHorizontal: 8 },
  attachHandle:   { width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginBottom: 14 },
  attachGrid:     { flexDirection: 'row', flexWrap: 'wrap' },
  attachCell:     { width: '25%', alignItems: 'center', paddingVertical: 12, gap: 8 },
  attachIcon:     { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  attachLabel:    { color: c.text, fontSize: 12, textAlign: 'center' },

  // Recording-mode composer: pulse dot + timer + hint + cancel/send buttons
  recordingComposer: { alignItems: 'center', gap: 8 },
  recordingDot:    { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
  recordingTimer:  { color: c.text, fontSize: 16, fontWeight: '700', minWidth: 52, textAlign: 'center' },
  recordingHint:   { flex: 1, color: c.textDim, fontSize: 12 },
  recCancelBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  recCancelTxt:    { color: c.danger, fontSize: 18, fontWeight: '700' },
  recSendBtn:      { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  recSendTxt:      { color: '#fff', fontSize: 18, fontWeight: '700' },

  // Voice-message bubble (playback): play/pause button + track + duration
  audioRow:           { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 200, maxWidth: 260 },
  audioPlayBtn:       { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  audioPlayBtnMine:   { backgroundColor: c.primary },
  audioPlayBtnTheirs: { backgroundColor: c.primary },
  audioPlayIcon:      { color: '#fff', fontSize: 14, fontWeight: '700' },
  audioMeter:         { flex: 1, gap: 4 },
  audioTrack:         { height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.30)', overflow: 'hidden' },
  audioFill:          { height: 4, backgroundColor: c.primary, borderRadius: 2 },

  // Waveform bars (Day 7 polish): 32 vertical bars sized by amplitude.
  // Played bars use the accent color; unplayed are dim so the playhead
  // is implicit. flex-end alignItems so all bars sit on the baseline.
  waveBars:               { flexDirection: 'row', alignItems: 'flex-end', height: 24, gap: 2 },
  waveBar:                { width: 3, borderRadius: 1.5 },
  waveBarPlayedMine:      { backgroundColor: c.bubbleOutText },
  waveBarUnplayedMine:    { backgroundColor: c.bubbleMetaOut },
  waveBarPlayedTheirs:    { backgroundColor: c.primary },
  waveBarUnplayedTheirs:  { backgroundColor: 'rgba(128,128,128,0.35)' },
  audioFillMine:      { backgroundColor: c.bubbleOutText },
  audioTime:          { color: c.bubbleMetaIn, fontSize: 11 },
  audioTimeMine:      { color: c.bubbleMetaOut },

  input:         { flex: 1, color: c.text, paddingVertical: 11, paddingRight: 4, maxHeight: 120, fontSize: 16, lineHeight: 21 },
  sendBtn:       { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, justifyContent: 'center' },
  sendBtnOff:    { backgroundColor: c.textFaint, elevation: 0, shadowOpacity: 0 },
  sendTxt:       { color: '#fff', fontWeight: '700' },

  imageBubble:   { padding: 4, borderRadius: 12 },
  // Media (image/video/gif) bubbles: no fill, just a thin frame so the media
  // sits nearly edge-to-edge (the orange fill looked awkward around photos).
  mediaBubble:   { backgroundColor: 'transparent', padding: 3, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  // Sticker: WhatsApp-style — transparent backdrop, no padding, just a
  // big emoji glyph. The bubble component still wraps it so long-press
  // (forward/reply/delete) works the same as any other message.
  stickerBubble: { backgroundColor: 'transparent', padding: 0 },
  stickerEmoji:  { fontSize: 72, lineHeight: 84 },

  // Poll bubble: question on top, options as rows with a horizontal fill
  // bar proportional to vote count, footer with totals + mode hint.
  pollWrap:               { minWidth: 240, maxWidth: 300, gap: 8 },
  pollQuestion:           { color: c.text, fontSize: 14, fontWeight: '700', marginBottom: 6 },
  pollQuestionMine:       { color: c.bubbleOutText },
  pollOptionRow:          { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  pollOptionMark:         { color: c.textDim, fontSize: 16, width: 18, textAlign: 'center' },
  pollOptionMarkOn:       { color: c.primary },
  pollOptionLine:         { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  pollOptionLabel:        { color: c.text, fontSize: 13, flex: 1 },
  pollOptionLabelMine:    { color: c.bubbleOutText },
  pollOptionCount:        { color: c.textDim, fontSize: 11, fontWeight: '700' },
  pollOptionCountMine:    { color: c.bubbleMetaOut },
  pollBarTrack:           { height: 4, backgroundColor: 'rgba(128,128,128,0.25)', borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  pollBarFill:            { height: 4, backgroundColor: c.primary, borderRadius: 2 },
  pollBarFillMine:        { backgroundColor: c.bubbleOutText },
  pollFooter:             { color: c.textDim, fontSize: 11, marginTop: 6 },
  pollFooterMine:         { color: c.bubbleMetaOut },
  attachedImage: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#0F1217' },
  dlOverlay:     { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.25)' },
  dlOverlayTxt:  { color: '#fff', fontSize: 12, fontWeight: '700' },
  imageError:    { width: 180, padding: 16, alignItems: 'center', gap: 4 },
  mediaUnavailableTxt: { color: c.textDim, fontSize: 12, textAlign: 'center' },
  imageErrorTxt: { color: c.textDim, fontSize: 12 },

  // Video bubble — inline player with native controls + duration pill
  videoWrap:     { width: 240, height: 240, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000', position: 'relative' },
  videoView:     { width: '100%', height: '100%' },
  videoDuration: { position: 'absolute', right: 8, bottom: 8, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  videoLoading:  { width: 240, height: 240, borderRadius: 8, backgroundColor: '#0F1217', alignItems: 'center', justifyContent: 'center' },
  videoPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#10141B' },
  // Round "video note" (Telegram/WhatsApp style) — distinct from a rectangular video.
  videoNoteWrap: { width: 200, height: 200, borderRadius: 100, overflow: 'hidden', backgroundColor: '#000', position: 'relative', alignSelf: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)' },
  videoNoteView: { width: '100%', height: '100%' },
  videoNoteDuration: { right: undefined, bottom: 10, alignSelf: 'center', left: 0, textAlign: 'center', width: '100%', backgroundColor: 'transparent' },
  videoPlayOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  videoPlayBtn:  { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)' },
  videoPlayIcon: { color: '#fff', fontSize: 22, marginLeft: 4 },

  // View-once shield (before tap) + tombstone (after view)
  viewOnceShield:        { width: 220, padding: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(108,99,255,0.15)', borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed' },
  viewOnceShieldIcon:    { fontSize: 28 },
  viewOnceShieldTxt:     { color: c.text, fontSize: 14, fontWeight: '700' },
  viewOnceShieldHint:    { color: c.textDim, fontSize: 11, textAlign: 'center' },
  viewOnceTombstone:     { width: 220, padding: 16, borderRadius: 12, alignItems: 'center', backgroundColor: '#0F1217', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  viewOnceTombstoneTxt:  { color: c.textDim, fontSize: 12, fontStyle: 'italic' },

  // Day 9 — file bubble (documents)
  fileRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 220, maxWidth: 280 },
  fileCard:       { width: 240, borderRadius: 8, overflow: 'hidden' },
  filePreview:    { width: 240, height: 170, backgroundColor: 'rgba(0,0,0,0.06)' },
  fileCardRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 },
  fileIcon:       { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  fileIconMine:   { backgroundColor: c.primary },
  fileIconTheirs: { backgroundColor: c.primary },
  fileIconTxt:    { fontSize: 18 },
  fileMeta:       { flex: 1, gap: 2 },
  fileName:       { color: c.bubbleInText, fontSize: 14, fontWeight: '600' },
  fileNameMine:   { color: c.bubbleOutText },
  fileSize:       { color: c.bubbleMetaIn, fontSize: 11 },
  fileSizeMine:   { color: c.bubbleMetaOut },

  // Day 8 — reply bar above composer
  replyBar:        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  lpBar:           { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  lpBarImg:        { width: 36, height: 36, borderRadius: 6, backgroundColor: c.border },
  lpBarTitle:      { color: c.text, fontSize: 12, fontWeight: '700' },
  lpBarDesc:       { color: c.textDim, fontSize: 11, marginTop: 1 },
  replyBarLine:    { width: 3, alignSelf: 'stretch', backgroundColor: c.primary, borderRadius: 1.5 },
  replyBarTitle:   { color: c.primary, fontSize: 12, fontWeight: '700' },
  replyBarBody:    { color: c.text, fontSize: 13 },

  // Day 8 — inline reply preview inside a bubble
  replyPreview:        { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginBottom: 6, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: 'rgba(0,0,0,0.16)', borderRadius: 6 },
  replyPreviewLine:    { width: 2, backgroundColor: c.primary, borderRadius: 1 },
  replyPreviewWho:     { color: c.primary, fontSize: 11, fontWeight: '700' },
  replyPreviewBody:    { color: c.bubbleInText, fontSize: 12 },

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
  forwardPreview:      { flexDirection: 'row', gap: 8, backgroundColor: c.card, borderRadius: 10, padding: 10, marginBottom: 8 },
  forwardPreviewWho:   { color: c.primary, fontSize: 13, fontWeight: '700' },
  forwardPreviewBody:  { color: c.textDim, fontSize: 13, marginTop: 2 },
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
    a.grouped === b.grouped &&
    a.bubbleColors === b.bubbleColors
  );
}
const MemoBubble = memo(MessageBubble, bubblePropsEqual);
