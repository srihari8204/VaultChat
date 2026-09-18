// app/chat.tsx — Phase 3a message thread (Postgres + CC-Wire realtime).
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

import { BRAND_ACCENT, brandAlpha, type Palette, ELEVATION } from '../constants/theme';
import { useKeyboardInset } from '../lib/useKeyboardInset';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import { Audio, ResizeMode, Video } from 'expo-av';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as ImagePicker from 'expo-image-picker';
import * as ScreenCapture from 'expo-screen-capture';
import { setSecure } from '../lib/screenGuard';
import { DeviceMotion } from 'expo-sensors';
import * as Sharing from 'expo-sharing';
import { recordScreenshotAttempt } from '../services/security/auditChain';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { consumePendingJump } from '../lib/chatJump';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { E2EE_ENABLED } from '../constants/flags';
import { getCachedMessages, getPendingEncryptedMessages, getCachedMessagesBefore, getCachedMessagesAfter, getCachedMessagesAround, hasCachedOlderMessages, hasCachedNewerMessages, cacheMessages, applyMessage, markCachedDeleted, getCachedMessagesByIds, getCachedChat, clearChatMessages } from '../lib/localDb';
import { metric } from '../lib/syncMetrics';
import { groupAlbums, resetAlbumCache } from '../lib/albumGrouping';
import { mergeReactions } from '../lib/reactionMerge';
import { saveDraft, getDraft, clearDraft } from '../lib/drafts';
import { playSent, playReceived } from '../lib/sounds';
import { NOTIF_CHANNELS } from '../lib/push';
import {
  AppState,
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  Dimensions,
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
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { Sheet, Avatar, GlassView, AuroraBackground, type SheetAction as MenuAction } from '../components/ui';
import { useChatViewers } from '../hooks/useChatViewers';
import { ViewerStack } from '../components/chat/ViewerStack';
import { getShareViewing } from '../lib/viewerPrefs';
import type { ViewerActivity } from '../lib/socket';
import LinkPreview, { extractUrl } from '../components/LinkPreview';
import { extractFirstUrl, fetchPreviewFromDevice, type LinkPreviewData } from '../lib/linkPreview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GifPicker from '../components/GifPicker';
import { LinearGradient } from 'expo-linear-gradient';
import { getWallpaper, type WallpaperConfig } from './chat-wallpaper';
import { getBubbleColors } from './chat-themes';
import { getLock, verifyBiometric, verifyPin, type LockedChat } from '../lib/chatLock';
import { permissionDenied } from '../lib/permissionDenied';
import { preloadViewedOnce, isViewedOnce, isViewedOnceSync, markViewedOnce } from '../lib/viewOnceStore';
import { preloadRevoked, isRevokedSync, wipeRevokedMedia } from '../lib/protectedMedia';

import { useTheme } from '../lib/theme';
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
  saveContact,
  revokeAttachment,
  persistMessageDeletion,
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
  groupRefOf,
  normalizeMsgIds,
} from '../lib/chatService';
import { forwardNotice } from '../lib/forwardPolicy';
import { groupTypeInfo } from '../lib/groups/catalog';
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
import { thumbDataUri, makeThumb } from '../lib/thumbnails';
import { isFamEvent } from '../lib/family/alerts';
import {
  cancel as queueCancel,
  enqueueText,
  enqueueReaction,
  enqueueEdit,
  enqueueDelete,
  initQueue,
  noteDelivered as queueNoteDelivered,
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


const TYPING_IDLE_MS = 2500;
// Delete-for-everyone window — keep numerically identical to the server's
// REVOKE_WINDOW_MS (routes/chats.js). WhatsApp parity: 2 days 12 hours.
const REVOKE_WINDOW_MS = 60 * 60 * 60 * 1000;

const INITIAL_PAGE_SIZE = 50;
const PREFETCH_PAGE_SIZE = 50;
const SCROLL_PAGE_SIZE = 100;

// Module scope on purpose: the top-up below runs on every chat focus and every
// foreground, and catchUp() is a network round trip even when it returns
// nothing. Opening six chats in a row should not be six delta requests. The
// cache re-read it guards is local and always runs, so a throttled tick still
// picks up whatever a previous catch-up wrote.
const TOPUP_MIN_GAP_MS = 5000;
let lastTopUpAt = 0;
/**
 * Most messages kept in JS state at once — eight pages.
 *
 * Enough that ordinary scrolling never touches disk, small enough that a chat
 * left open all day does not accumulate every message it has ever shown. Only
 * enforced while the user is at the bottom; see the trim effect below.
 */
const MAX_LOADED = 400;

// MUST MATCH chatsEditWindowMS IN THE SERVER (routes/chats.go).
//
// The PATCH enforces this in its WHERE clause — `created_at > NOW() - INTERVAL`
// — so past it the server returns 404 and there is nothing the client can do.
// Offering Edit anyway is what made editing look broken: the change applied
// optimistically, the PATCH 404'd, and the failure was swallowed (see the
// rollback in the queue's 'failed' handler), so the text silently reverted on
// the next sync with no error shown.
const EDIT_WINDOW_MS = 15 * 60 * 1000;



import { useS, idealText, HL, makeStyles, type DisplayMessage } from '../components/chat/chatStyles';
import { IMPORT_SOURCE } from '../constants/importSources';
import {
  MemoBubble, DateChip, UnreadDivider, ImportedDivider, SwipeToReply, FileBubble,
  DISAPPEARING_PRESETS, bumpPollVote, formatDisappearing, formatLastSeen,
  formatRecDuration, formatScreenshotMode, isSameCalendarDay, renderWithHighlight,
} from '../components/chat/MessageBubble';

/**
 * @param chatIdProp  When present, this screen is EMBEDDED (a split-view pane,
 *   app/split.tsx) rather than routed to, so the chat id comes from the parent
 *   instead of the URL. Route params still win for everything else — a pane and
 *   a full screen are otherwise the same component, which is the point: split
 *   view gets the real chat, not a cut-down copy of it.
 * @param embedded  Hides the screen-level back button; the pane has its own
 *   close/swap controls.
 */
export default function ChatScreen({ chatIdProp, embedded }: { chatIdProp?: string; embedded?: boolean } = {}) {
  // `id` is the normal entry param; `chatId` is what the capture screens
  // (/camera, /video-notes, /image-editor) echo back when they router.replace
  // here with a freshly captured/edited file — accept either.
  const routeParams = useLocalSearchParams<{
    id?: string; chatId?: string;
    capturedUri?: string; capturedType?: string; capturedViewOnce?: string;
    capturedName?: string;
  }>();
  // An embedded pane must ignore the route's chat id entirely, or both panes
  // would render whatever chat the router happens to be on.
  const params = chatIdProp ? { ...routeParams, id: chatIdProp, chatId: chatIdProp } : routeParams;
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();
  const chatId = ((params.id ?? params.chatId) ?? '') as string;
  // Read by async callbacks to answer "is this still the chat I started for?".
  // Assigned during render, not in an effect: an effect lands too late for a
  // promise that is already in flight when chatId changes under a live
  // instance (app/split.tsx swaps its two panes onto the same ChatScreen).
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  // Keyboard avoidance, driven manually. edge-to-edge breaks adjustResize, and
  // KeyboardAvoidingView's "padding" left residual space after the keyboard
  // closed. Tracking the height ourselves resets cleanly to 0 on hide.
  // The keyboard inset, from lib/keyboardInset — the same hook every other
  // screen uses through <KeyboardSafe>. This screen measures it itself rather
  // than wrapping, because the composer, the message list and the scroll-to-
  // bottom FAB each need the number, not just a padded container.
  const kbHeight = useKeyboardInset();
  // THE COMPOSER'S BOTTOM GAP, and it is not just the keyboard.
  //
  // app.json sets edgeToEdgeEnabled, so this screen draws UNDER the system
  // navigation bar. With the keyboard down the padding above was 0, which put
  // the typing bar behind the nav bar / gesture pill — the "keyboard overlapping
  // the typing bar" report, visible whenever the keyboard was closed.
  //
  // Not additive: an Android keyboard is measured from the physical bottom of
  // the screen, so its height already spans the nav bar. Adding the inset on top
  // would float the composer a nav-bar's height above the keyboard instead.
  // Whichever is larger is the correct single gap in both states.
  const insets = useSafeAreaInsets();
  const composerGap = Math.max(kbHeight, insets.bottom);

  // Warm the "already viewed" set so view-once bubbles render as consumed
  // immediately (no flash of the shield) on first paint.
  useEffect(() => { preloadViewedOnce(); preloadRevoked(); }, []);

  const [meId,      setMeId]      = useState<string | null>(null);
  // meId ALSO as a ref, because the socket handlers below must not depend on
  // the closure they were created in. It loads asynchronously, so a handler
  // subscribed before it resolves captures null forever — and `x === null` is
  // false for every real id, so each self-check fails OPEN rather than closed:
  // the device that took a screenshot banners ITSELF, your own typing comes
  // back at you, your own messages count as incoming.
  //
  // Adding meId to the effect's deps looked like the fix and was not: it
  // re-subscribes, and the observed result was the event arriving TWICE with
  // the stale null handler still attached. A ref is read at call time, so there
  // is one subscription and it always sees the current value.
  // (app/(tabs)/chats.tsx already does exactly this for the same reason.)
  const meIdRef = useRef<string | null>(null);
  useEffect(() => { meIdRef.current = meId; }, [meId]);
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
      // SPACE PLUMBING, NOT CONVERSATION (owner directive 2026-08-21: location
      // coordinates never appear in the chat page — the map is where they
      // live). Trip announcements/end markers and the family live-location
      // key-delivery messages exist only so late joiners can harvest them from
      // history; rendering them painted raw JSON and coordinate bubbles into
      // the family's thread.
      if (m.type === 'system' && typeof m.content === 'string'
        && (m.content.startsWith('VCTRIP1:') || m.content.startsWith('VCTRIPEND1:'))) continue;
      // Live-location plumbing, in BOTH the readable and the unreadable case.
      //
      // The `family:true` test alone only works once a message has decrypted,
      // and on device many of these do not (their sender-key iteration is long
      // past). Those fell through and rendered as "unable to decrypt" bubbles —
      // the exact clutter this filter exists to remove, just wearing a padlock.
      // A live-location envelope (`live:true` + a session key) is never
      // conversation, and an unreadable one carries nothing a person can act
      // on, so both are dropped. A genuine shared pin (`live:false`, no key)
      // still renders — that is a deliberate user action, not plumbing.
      if (m.type === 'location' && typeof m.content === 'string'
        && (m.content.includes('"family":true')
          || m.content.includes('"live":true')
          || looksEncrypted(m.content))) continue;
      // famEvent envelopes (geofence crossings, overspeed) are protocol riding
      // the message transport, not conversation — they render in the alerts
      // inbox, never here. SOS stays a visible system message on purpose.
      // This runs on DECRYPTED content (this screen's messages already are —
      // see the family/live checks just above), so the plain marker check is
      // correct here, unlike the raw socket listener in app/_layout.tsx.
      if (isFamEvent(m.type, m.content)) continue;
      const k = m._tempId ?? String(m.id);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
    // Collapse an album into ONE row. The rule lives in lib/albumGrouping so it
    // can be executed by a test rather than only reviewed by eye; the bubble
    // then lays the members out in a HORIZONTAL scroller, which is the only
    // nesting direction safe inside this vertical list.
    return groupAlbums(out);
  }, [messages]);
  const [loading,   setLoading]   = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasMore,   setHasMore]   = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const [newerGapBeforeId, setNewerGapBeforeId] = useState<number | null>(null);
  const [input,     setInput]     = useState('');
  const [sending,   setSending]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  // tempId → how to undo an optimistic edit the server then rejected.
  //
  // An edit has NO pending bubble: it is applied by message id, so the queue's
  // 'failed' event (which the UI matches on _tempId) found nothing and the
  // rejection was dropped on the floor. The user saw the edit stick, then
  // watched it revert on the next sync with no explanation. This is what lets
  // the failure handler put the original text back and say so.
  const editRollbacks = useRef(new Map<string, { id: number; content: string | null; editedAt: string | null }>());
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

  // Media staged for sending, shown in a caption-preview before it goes out.
  // Every send path (gallery pick, camera, video note, edited photo) routes
  // through here so the user can add a caption (WhatsApp-style).
  // Staged media awaiting send — supports WhatsApp-style multi-select. Each
  // item carries its own caption + view-once; currentIdx is the one on screen.
  const [pendingItems, setPendingItems] = useState<Array<{
    uri: string; mediaType: 'image' | 'video' | 'file'; filename: string; mime: string;
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
  // Reaction summaries, with identity preserved across unrelated updates.
  //
  // The fold itself lives in lib/reactionMerge so it can be tested. The ref
  // below is what makes it cheap: it hands the previous result back in, and any
  // message whose reaction set did not change keeps its EXACT previous array —
  // so the memo comparator skips it instead of re-rendering because something
  // arrived elsewhere in the conversation.
  const prevReactionsRef = useRef<Record<number, ReactionSummary[]>>({});
  const mergedReactions = useMemo(() => {
    const next = mergeReactions(messages as any, meId, prevReactionsRef.current);
    prevReactionsRef.current = next;
    return next;
  }, [messages, meId]);
  const [reactPicker, setReactPicker] = useState<DisplayMessage | null>(null);
  const [actionSheet, setActionSheet] = useState<{ msg: DisplayMessage; plain: string } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ title: string; actions: MenuAction[] } | null>(null);
  const [replyTo, setReplyTo]         = useState<DisplayMessage | null>(null);
  const [forwardMsg, setForwardMsg]   = useState<DisplayMessage | null>(null);
  const [forwardChats, setForwardChats] = useState<ChatSummary[]>([]);
  const [forwardLoading, setForwardLoading] = useState(false);

  // Composer growth is capped against THIS pane, not the window. The cap was a
  // flat maxHeight: 120, which is fine full-screen but is a third of a stacked
  // split pane — a few lines of typing swallowed the conversation above it.
  // onLayout gives the real pane height whether embedded or full-screen, so one
  // rule covers both. Floor of 72 keeps ~3 lines usable in the smallest pane.
  const [paneH, setPaneH] = useState(0);
  const composerMax = paneH > 0 ? Math.max(72, Math.min(120, Math.round(paneH * 0.28))) : 120;

  const listRef = useRef<FlatList>(null);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const messagesChatRef = useRef(chatId);
  // onEndReached can fire more than once before React commits loadingOlder.
  // This synchronous lock closes that gap and also serializes the local
  // post-paint prefetch with manual pagination.
  const pagingChatRef = useRef<string | null>(null);
  const prefetchedChatRef = useRef<string | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  // Scroll-to-bottom FAB (WhatsApp "↓ N new"): shown when scrolled up.
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [newSinceUp, setNewSinceUp] = useState(0);
  const atBottomRef = useRef(true);

  /**
   * Scroll handler — fires state ONLY on a transition.
   *
   * This used to call setShowScrollDown on every scroll event. At
   * scrollEventThrottle={32} that is ~31 setState calls per second while the
   * user drags, and every one of them re-renders this screen — which is the
   * largest component in the app. React bails out when the value is unchanged,
   * but reaching that bail-out still costs a scheduler pass per frame, on the
   * exact frames that need to be smooth.
   *
   * The ref already tracked the position, so the transition test is free.
   * Stable identity (useCallback) so FlatList is not handed a new prop on
   * every parent render either.
   */
  const onListScroll = useCallback((e: any) => {
    const up = e.nativeEvent.contentOffset.y > 280;  // inverted: y>0 = scrolled off newest
    if (atBottomRef.current === !up) return;         // nothing changed → no render
    atBottomRef.current = !up;
    setShowScrollDown(up);
    if (!up) setNewSinceUp(n => (n ? 0 : n));        // functional: no dep on newSinceUp
  }, []);
  const [infoMsg, setInfoMsg] = useState<DisplayMessage | null>(null); // Message Info sheet
  const [liveLoc, setLiveLoc] = useState<{ userId: string; latitude: number; longitude: number; address?: string } | null>(null);
  const readDebounce = useRef<any>(null);
  const lastReadSent = useRef<number>(0);
  const typingIdleTimer = useRef<any>(null);
  const typingActiveRef = useRef(false);
  // A cached chat screen stays mounted when Android backgrounds the app. Its
  // rows can still change as sync catches up, but that is delivery, not a user
  // reading the thread. Keep the receipt state reactive so returning to this
  // focused thread sends its read pointer then, never while it is invisible.
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  const membersById = useMemo(() => {
    const m = new Map<string, ChatMember>();
    chat?.members.forEach(x => m.set(x.userId, x));
    return m;
  }, [chat]);

  // ── Live Chat Viewers (feature #58) — who's viewing this chat right now ──
  const [cvFocused, setCvFocused] = useState(false);
  const chatFocusedRef = useRef(false);
  const [cvShareOn, setCvShareOn] = useState(false);
  // Focus toggles emission on/off and re-reads the per-chat toggle (so a change
  // made in chat-info takes effect the moment you return).
  useFocusEffect(useCallback(() => {
    chatFocusedRef.current = true;
    setCvFocused(true);
    if (chatId && chat) getShareViewing(chatId, chat.type !== 'direct').then(setCvShareOn).catch(() => {});
    return () => { chatFocusedRef.current = false; setCvFocused(false); };
  }, [chatId, chat?.type]));
  // TOP-UP: messages that arrived while this screen was not mounted.
  //
  // The initial load above deliberately asks the server for messages ONLY when
  // this device holds nothing for the chat. For every chat WITH history the
  // painted cache is the whole story, and the only live update path is the
  // socket - which delivers to an OPEN screen and nothing else. So a message
  // that landed while the app was backgrounded (its FCM push already shown)
  // was written to the local DB by lib/syncEngine's catch-up and then never
  // read back: opening the chat from the notification showed the old page and
  // the message appeared nowhere. Its id also stayed above the read cursor, so
  // the unread badge could not be cleared by reading either.
  //
  // catchUp() self-guards re-entry and upserts by id, so running it here is
  // idempotent; re-reading the cache afterwards is what this screen was
  // missing. AppState covers the case where the chat is already focused when
  // the app returns to the foreground, which fires no focus event.
  useFocusEffect(useCallback(() => {
    let cancel = false;
    const topUp = async () => {
      // chatId can change on a MOUNTED instance: app/split.tsx swaps its two
      // panes and React reuses the same ChatScreen. Everything below is async,
      // so without this the rows fetched for one chat get merged into the
      // other chat's rendered list.
      const cid = chatId;
      if (Date.now() - lastTopUpAt > TOPUP_MIN_GAP_MS) {
        lastTopUpAt = Date.now();
        try { await (await import('../lib/syncEngine')).catchUp(); } catch {}
      }
      let rows: any[] | null = null;
      try { rows = await getCachedMessages(cid, INITIAL_PAGE_SIZE); } catch { return; }
      if (cancel || chatIdRef.current !== cid || !rows || !rows.length) return;
      setMessages(prev => {
        const base = messagesChatRef.current === cid ? prev : [];
        messagesChatRef.current = cid;
        const have = new Set(base.map(x => x._tempId ?? String(x.id)));
        const add = rows!.filter(r => !have.has(String(r.id)));
        if (!add.length) return base;
        // Optimistic bubbles carry id 0 and must stay pinned to the top of the
        // inverted list; everything else is ordered newest-id-first.
        // Split on the OUTBOX MARKER, not on the sign of the id. Exit-Kit
        // imported history carries NEGATIVE ids (importMessages in
        // lib/localDb.ts is their only writer), so an `id > 0` test buckets the
        // whole imported archive as "pending" and pins it to the top of the
        // inverted list, rendering years-old history as the newest messages.
        // `_tempId` is the same key keyExtractor uses.
        const pending = base.filter(x => x._tempId);
        const real = base.filter(x => !x._tempId);
        return [...pending, ...[...real, ...add].sort((a, b) => Number(b.id) - Number(a.id))];
      });
    };
    topUp();
    const sub = AppState.addEventListener('change', s => { if (s === 'active') topUp(); });
    return () => { cancel = true; sub.remove(); };
  }, [chatId]));
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
  // Keyed on POLL ids only, not every message id. Its one consumer is the
  // poll-vote hydration effect below, so keying on the whole page meant any
  // incoming text message changed the key and re-fired that network request in
  // every chat containing a poll — and built a join of the entire page to do it.
  const pollIdKey = useMemo(
    () => messages
      .filter(m => m.type === 'poll' && typeof m.id === 'number' && m.id > 0)
      .map(m => m.id).join(','),
    [messages],
  );

  // Members of this chat that aren't me — used to compute outgoing-message
  // tick state (any → delivered / any → read, MVP semantics).
  const otherMembers = useMemo(
    () => chat?.members.filter(m => m.userId !== meId) ?? [],
    [chat, meId],
  );

  // PER-CHAT RESET. Declared immediately before the load effect below so React
  // runs it first: everything here must be cleared before anything repaints.
  //
  // lastReadSent holds the newest id already reported via POST /read, and
  // messages.id is a single global BIGSERIAL (002_chats.sql). Without the
  // reset, opening a busy chat (newest 9000) then a quieter one (newest 8500)
  // hit `8500 <= 9000` and POST /read never fired for the second chat, so its
  // unread badge stayed lit for the whole session however often it was opened.
  //
  // `messages` is cleared for the SAME reason the ref is. chatId can change on
  // a mounted instance (app/split.tsx), and the load below is async, so the
  // read effect would otherwise compute a latest id from the PREVIOUS chat's
  // rows and report it against this one. That is not cosmetic: the server
  // takes lastReadMessageId as a cursor and the vanish sweep hard-deletes
  // vanish_after_read messages at or below it, for every member.
  useEffect(() => {
    lastReadSent.current = 0;
    messagesChatRef.current = chatId;
    setMessages([]);
    setLoadingOlder(false);
    setLoadingNewer(false);
    setHasMore(true);
    setHasNewer(false);
    setNewerGapBeforeId(null);
    prefetchedChatRef.current = null;
    // Everything else that is ABOUT this chat and outlives a chatId change on a
    // mounted instance. replyTo and editingId are the dangerous two: a send
    // could carry a replyToId belonging to another conversation, and an edit
    // could PATCH a message id in it.
    setReplyTo(null);
    setEditingId(null);
    setChat(null);
    setPinnedId(null);
    setTypingUids(new Set());
    setLiveLoc(null);
    setExtraReplies(new Map());
    setNewSinceUp(0);
  }, [chatId]);

  // Clear this chat's native message notification + unread counter (F2 —
  // the content-free doorbell posts per-chat notifications tagged by chatId).
  useEffect(() => {
    if (!chatId || Platform.OS !== 'android') return;
    try { require('react-native').NativeModules?.VaultCalls?.clearMessageNotifs?.(chatId); } catch {}
  }, [chatId]);

  // ── Initial load ──────────────────────────────────────────
  useEffect(() => {
    if (!chatId) return;
    // A LOAD FOR CHAT A MUST NEVER LAND ON CHAT B.
    //
    // chatId can change on a MOUNTED instance (app/split.tsx swaps its two panes
    // onto one ChatScreen), and every step below is async. A slow getMessages or
    // getChat for the chat we just left otherwise resolved into the chat now on
    // screen: the wrong header, the wrong member list, and another conversation's
    // messages merged into this thread. `alive()` gates EVERY set* — including
    // the setLoading(false) in the finally, which would otherwise clear the NEW
    // chat's spinner while it is still loading.
    const cid = chatId;
    let cancelled = false;
    const alive = () => !cancelled && chatIdRef.current === cid;
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
        if (!alive()) return;
        setMeId(myId);

        // 2. Chat header (name / peer / members) from the local cache → the
        //    header renders offline instead of blank.
        try {
          const cc = await getCachedChat(chatId);
          if (cc && alive()) { setChat({ ...cc, members: cc.members ?? [] }); setPinnedId(cc.pinnedMessageId ?? null); }
        } catch {}

        // 3. Cached messages + still-in-flight outbox bubbles, painted instantly.
        //    knownPlain reuses already-decrypted text so we never re-decrypt.
        const knownPlain = new Map<number, string>();
        // null (not []) on failure: a locked DB, an unavailable cache DEK or an
        // op-sqlite throw is NOT "this device holds nothing". Collapsing the two
        // sent us down the cold path below and re-downloaded a full page from
        // the server — which, before the sticky-tombstone fix, also resurrected
        // every message the user had deleted locally.
        let [cachedMsgs, pendingQ, mediaQ] = await Promise.all([
          getCachedMessages(chatId, INITIAL_PAGE_SIZE).catch(() => null),
          pendingForChat(chatId).catch(() => []),
          mediaPendingForChat(chatId).catch(() => []),
        ]);
        if (!alive()) return;
        for (const m of (cachedMsgs ?? [])) if (!looksEncrypted(m.content)) knownPlain.set(m.id, m.content as string);

        // On an empty cache, the account-wide forward sync and this screen's
        // first history page can overlap. Both decrypt the same ratchet in
        // message-id order, so two concurrent batches can make a newer page
        // advance it before the older rows finish and permanently turn valid
        // ciphertext into an undecryptable cache entry. Join the sync engine's
        // single-flight run first, then use what it stored. A direct history
        // request remains the fallback only when the authoritative delta did
        // not contain this chat.
        if (cachedMsgs !== null && !cachedMsgs.length) {
          try { await (await import('../lib/syncEngine')).catchUp(); } catch {}
          const synced = await getCachedMessages(chatId, INITIAL_PAGE_SIZE).catch(() => null);
          if (!alive()) return;
          if (synced?.length) {
            cachedMsgs = synced;
            knownPlain.clear();
            for (const m of synced) if (!looksEncrypted(m.content)) knownPlain.set(m.id, m.content as string);
          }
        }

        const pendingBubbles = (pendingQ as any[]).map(q => ({
          id: 0, chatId: q.chatId, senderId: myId ?? '', type: q.type, content: q.plaintext,
          meta: null, replyToId: q.replyToId, editedAt: null, deletedAt: null,
          createdAt: new Date(q.createdAt).toISOString(), _tempId: q.tempId,
          // A permanently-rejected row is KEPT by the outbox now (it is the only
          // copy of the text), so it must come back RED with tap-to-retry rather
          // than as a clock that will never tick — same rule the media branch
          // below already applies.
          _state: q.state === 'FAILED' ? 'failed' : 'pending', _error: q.lastError ?? undefined,
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
        if (((cachedMsgs?.length ?? 0) || pendingNewestFirst.length) && alive()) {
          const snapshot = [...pendingNewestFirst, ...(cachedMsgs ?? [])];
          setMessages(prev => {
            const base = messagesChatRef.current === chatId ? prev : [];
            messagesChatRef.current = chatId;
            const seen = new Set(snapshot.map(m => m._tempId ?? String(m.id)));
            const arrived = base.filter(m => !seen.has(m._tempId ?? String(m.id)));
            const all = [...arrived, ...snapshot];
            const pending = all.filter(m => m._tempId)
              .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
            const settled = all.filter(m => !m._tempId)
              .sort((a, b) => Number(b.id) - Number(a.id));
            return [...pending, ...settled];
          });
          setLoading(false);
        }

        // 4. Reconcile from the server — RESILIENT. Each call is isolated; a
        //    failure (offline) leaves the painted cache untouched. getChat also
        //    re-caches the detail (see getChat) for the next offline open.
        getChat(chatId)
          .then(c => { if (alive()) { setChat(c); setPinnedId(c.pinnedMessageId ?? null); } })
          .catch(() => {});
        try {
          // Already-received messages are NOT re-fetched. The local DB owns
          // them: they were decrypted and cached when they arrived, and new
          // ones arrive over the socket + the /chats/delta cursor sync
          // (lib/syncEngine). Re-pulling a page on every open re-downloaded
          // history the device already had — pointless work against a server
          // that purges message bodies after delivery, and slower than the
          // cache it was overwriting.
          //
          // The server is used only when this device holds NOTHING for the chat
          // (fresh install, or a chat never opened here), which is the one case
          // the cache genuinely cannot answer.
          // `cachedMsgs === null` means the cache could not be READ, not that it
          // is empty — going to the server there would re-download a page this
          // device already has, so we leave it alone and let the next open (or
            // the delta sync) reconcile.
          if (cachedMsgs !== null && !cachedMsgs.length) {
            const msgsRaw = await getMessages(chatId, { limit: INITIAL_PAGE_SIZE });
            const msgs = await hydrateMessages(chatId, msgsRaw, knownPlain);
            cacheMessages(chatId, msgs).catch(() => {});   // persist for next instant open
            // The persist above is keyed on the captured chatId and is correct
            // whoever is on screen now; only the RENDER must be gated.
            if (alive()) {
            // MERGE, don't replace. `pendingNewestFirst` was captured BEFORE the
            // getMessages round trip above, and the composer is already live by
            // then (loading was cleared once the cache came back empty). Anything
            // sent during that trip is in `prev` but not in the snapshot, so a
            // flat replace wiped it — and the queue's 'sent' handler then found
            // no _tempId to swap, so the message never came back on this screen.
            setMessages(prev => {
              const base = messagesChatRef.current === chatId ? prev : [];
              messagesChatRef.current = chatId;
              const seen = new Set(msgs.map(m => String(m.id)));
              const stillPending = [...pendingNewestFirst, ...base].filter(x => {
                const k = x._tempId ?? String(x.id);
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });
              return [...stillPending, ...msgs];
            });
            setHasMore(msgs.length === INITIAL_PAGE_SIZE);
            }
          } else {
            // A short local page is a cache boundary, not proof that server
            // history ended. Positive ids can still have remote history; for
            // imported negative ids, only the local existence query can say
            // there is another page.
            const oldestCached = cachedMsgs?.[cachedMsgs.length - 1]?.id;
            const localOlder = oldestCached
              ? await hasCachedOlderMessages(chatId, Number(oldestCached)).catch(() => false)
              : false;
            if (alive()) setHasMore(localOlder || Number(oldestCached) > 0);
            // RETRY THE ONES THAT NEVER DECRYPTED.
            //
            // Painting from cache skips hydrate entirely, which is right for
            // readable rows and wrong for the rest: a message that failed to
            // decrypt once was rendered from cache on every open afterwards,
            // never re-attempted, so decryptFromChat was never called again and
            // maybeAutoRecoverSession — the silent "drop the dead session so our
            // next message re-initiates X3DH" path — could not fire. The chat
            // stayed on "unable to decrypt" permanently, and the only way out
            // was the manual Reset secure session, which is not something a user
            // should ever have to find. Measured on the Nothing Phone: four
            // undecryptable bubbles surviving a force-stop with ZERO decrypt
            // attempts logged.
            //
            // Bounded to the last hour and marked `live`. Old history is
            // undecryptable BY DESIGN (its ratchet state is long gone) and must
            // not count toward the auto-recovery streak — that is the fault that
            // once reset four healthy sessions after a cold sync. A message from
            // minutes ago is different: it SHOULD have opened, so its failure is
            // real evidence about the live session.
            const RETRY_AGE_MS = 60 * 60 * 1000;
            const pendingEncrypted = await getPendingEncryptedMessages(chatId);
            const retryInputs = new Map<number, Message>((cachedMsgs ?? []).map(m => [m.id, m]));
            for (const m of pendingEncrypted) {
              retryInputs.set(m.id, m);
              // An edit's old plaintext cannot satisfy decryption of its new envelope.
              knownPlain.delete(m.id);
            }
            const stuck = [...retryInputs.values()].filter(m =>
              looksEncrypted(m.content) &&
              Date.now() - new Date(m.editedAt ?? m.createdAt).getTime() < RETRY_AGE_MS);
            if (stuck.length) {
              const fixed = await hydrateMessages(chatId, stuck, knownPlain, { live: true });
              const readable = fixed.filter(m => typeof m.content === 'string' && !looksEncrypted(m.content));
              if (readable.length) {
                cacheMessages(chatId, readable).catch(() => {});
                if (alive()) {
                  const byId = new Map(readable.map(m => [m.id, m]));
                  setMessages(prev => prev.map(p => byId.get(p.id) ?? p));
                }
              }
            }
          }
          if (alive()) setError(null);
        } catch {
          // Offline / transient — keep the painted cache silently; the connection
          // banner already tells the user. A failed background refresh is not an error.
        }
      } catch (e: any) {
        if (alive()) setError(e?.message ?? 'Failed to load chat');
      } finally {
        if (alive()) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chatId]);

  // ── Queue events: replace pending bubble with real, or mark failed ──
  useEffect(() => {
    if (!chatId) return;
    const offSent = onQueue('sent', ({ tempId, chatId: cid, real }) => {
      if (cid !== chatId) return;
      // The edit landed — drop its undo snapshot so the map does not grow for
      // the life of the screen.
      editRollbacks.current.delete(tempId);
      // delete/edit ops apply optimistically by id and carry no pending bubble —
      // a delete resolves with real=null; nothing to swap or cache here.
      if (!real) return;
      setMessages(prev => {
        // If real already arrived via realtime, drop the temp — but OVERWRITE
        // the row that arrived with `real` rather than trusting it. The echo can
        // be a degraded copy (own message, plaintext not cached yet → content
        // null); keeping it and deleting the temp is what blanked sent messages.
        // `real` comes from the ack and always carries the plaintext.
        if (prev.some(x => x.id === real.id)) {
          return prev
            .filter(x => x._tempId !== tempId)
            .map(x => x.id === real.id ? ({ ...x, ...real } as DisplayMessage) : x);
        }
        return prev.map(x => x._tempId === tempId
          ? ({ ...real, _tempId: undefined, _state: undefined, _error: undefined } as DisplayMessage)
          : x);
      });
      cacheMessages(cid, [real]).catch(() => {}); // persist own sent message
    });
    const offFailed = onQueue('failed', ({ tempId, chatId: cid, error }) => {
      if (cid !== chatId) return;
      // An EDIT that the server refused. It has no pending bubble to mark, so
      // without this the rejection vanished: the optimistic text stayed on
      // screen until the next sync quietly replaced it with the original.
      const rb = editRollbacks.current.get(tempId);
      if (rb) {
        editRollbacks.current.delete(tempId);
        setMessages(prev => prev.map(x => x.id === rb.id
          ? { ...x, content: rb.content, editedAt: rb.editedAt } : x));
        Alert.alert('Edit failed', error ?? 'This message can no longer be edited.');
        return;
      }
      setMessages(prev => prev.map(x => x._tempId === tempId
        ? { ...x, _state: 'failed', _error: error } : x));
    });
    // Media outbox: same swap/fail, but keep localUri so the sender's own bubble
    // keeps rendering their local file (no re-download) after the swap.
    const offMSent = onMediaOutbox('sent', ({ tempId, chatId: cid, real }) => {
      if (cid !== chatId) return;
      setMessages(prev => {
        // Same overwrite rule as the text branch above — the echo may be the
        // degraded own-message copy, and `real` from the ack is authoritative.
        if (prev.some(x => x.id === real.id)) {
          const uri = prev.find(x => x._tempId === tempId)?.meta?.localUri;
          return prev
            .filter(x => x._tempId !== tempId)
            .map(x => x.id === real.id
              ? ({ ...x, ...real, meta: { ...(real as any).meta, ...(uri ? { localUri: uri } : {}) } } as DisplayMessage)
              : x);
        }
        const localUri = prev.find(x => x._tempId === tempId)?.meta?.localUri;
        return prev.map(x => x._tempId === tempId
          ? ({ ...real, meta: { ...(real as any).meta, ...(localUri ? { localUri } : {}) }, _tempId: undefined, _state: undefined } as DisplayMessage)
          : x);
      });
      cacheMessages(cid, [real]).catch(() => {});
    });
    const offMFailed = onMediaOutbox('failed', ({ tempId, chatId: cid }) => {
      if (cid !== chatId) return;
      // Drop the progress readout: a failed bubble shows "tap to retry", not a
      // ring frozen at whatever fraction it died on.
      setMessages(prev => prev.map(x => x._tempId === tempId
        ? { ...x, _state: 'failed', _phase: undefined, _progress: undefined } as DisplayMessage : x));
    });
    // Encrypting → uploading progress for the sender's own pending bubble. The
    // outbox already rate-limits these to ~1% steps, so this is at most a
    // couple of hundred renders across an entire upload.
    const offMProgress = onMediaOutbox('progress', ({ tempId, chatId: cid, phase, frac }) => {
      if (cid !== chatId) return;
      setMessages(prev => prev.map(x => x._tempId === tempId
        ? { ...x, _phase: phase, _progress: frac } as DisplayMessage : x));
    });
    return () => { offSent(); offFailed(); offMSent(); offMFailed(); offMProgress(); };
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

          const me = meIdRef.current;
          if (m.chatId !== chatId) return;
          // Socket payloads deliver `id` AND `replyToId` as STRINGS, but the HTTP
          // ack / cache use NUMBERs. Normalize so `x.id === m.id` dedup works —
          // otherwise the socket echo of our own just-sent message survives
          // alongside the ack'd row and both collide on the same React key — and
          // so the reply-target lookup (a Map<number,…>) can find the quoted row.
          normalizeMsgIds(m);
          // Tone immediately; the DELIVERY ACK deliberately does not fire here.
          if (m.senderId !== me) {
            playReceived();   // in-app "received" tone (respects sound prefs)
          }
          // Decrypt-on-arrival (WhatsApp-style): decrypt ONCE, then show + cache
          // the PLAINTEXT so re-opens never decrypt it again.
          (async () => {
            // `live`: this message arrived seconds ago, so a missing session is
            // the out-of-order race worth retrying — not history whose keys are
            // simply gone. Everything else hydrated on this screen is history.
            // A DECRYPT FAILURE MUST NOT COST THE ACK.
            //
            // hydrateMessages is try/FINALLY with no catch, so it can throw —
            // and on a session hitting 'aes/gcm: invalid ghash tag' it does.
            // Before the ack moved below the persist that did not matter, because
            // the ack had already fired. Now an exception here would skip it, and
            // the sender would sit on a single tick for a message the recipient
            // actually holds.
            //
            // The contract is "this device HAS the message", not "can read it":
            // an undecryptable blob is stashed and retried after the next key
            // harvest, so the row on disk is what the ack is about. Keep the
            // ciphertext and carry on.
            let fin = m;
            if (looksEncrypted(m.content)) {
              try { fin = (await hydrateMessages(chatId, [m], undefined, { live: true }))[0] ?? m; }
              catch { fin = m; }
            }
            // OUR OWN ECHO WITH NO PLAINTEXT YET — do not insert it.
            //
            // The server echoes our own send back to us. hydrateMessages takes the
            // own-message path and looks up readOwnPlaintext, but that row is only
            // written by postOnce AFTER the HTTP POST resolves — and a push on an
            // already-open socket routinely beats the round trip. The lookup misses
            // and we get a row with the real id and content === null.
            //
            // Inserting it is what breaks the send: the queue's 'sent' handler
            // below then sees `prev.some(x => x.id === real.id)`, concludes the
            // real row is already on screen, and DELETES the optimistic bubble that
            // is holding the only plaintext. The survivor renders as "Message not
            // available on this device" — the message appears, then goes blank.
            //
            // The sender already has a strictly better bubble, so the degraded echo
            // has nothing to add. Guard only the insert: the persist + ack below
            // must still run, because the ack means "this device HAS the message".
            const ownBlankEcho = fin.senderId === me && fin.content == null;
            // RE-CHECK THE CHAT AFTER THE DECRYPT.
            //
            // The `m.chatId !== chatId` test at the top of this handler ran
            // BEFORE the await above, and a decrypt takes 0.5–0.9 s on a real
            // handset. chatId can change on a mounted instance (app/split.tsx
            // pane swap), so a message for the chat we just left was prepended
            // to the thread now on screen. Only the two VISIBLE writes are
            // gated: the persist and the delivery ack below use the captured
            // chatId, are correct regardless of what is on screen, and must
            // still run — an un-acked message is re-delivered forever.
            const stillHere = chatIdRef.current === chatId;
            if (!ownBlankEcho && stillHere) {
              setMessages(prev => prev.some(x => x.id === fin.id) ? prev : [fin, ...prev]);
            }
            // ORDERING IS THE CONTRACT — same rule as lib/syncBackground.ts.
            //
            // The ack must mean "this device HAS the message", never "this device
            // was told about a message". The server reclaims a body once every
            // recipient has acked, so an ack that outruns the local write leaves
            // a window where the message exists NOWHERE: not on the server, not
            // on disk. This previously acked before the persist below, on the
            // reasoning that the tick should not wait on decrypt — but only the
            // TONE needs to be instant, and it still is.
            //
            // Persist first, and ack only if the write actually succeeded. A
            // failed write leaves the pointer un-advanced, so the sync cursor
            // re-fetches the message on the next reconnect.
            try {
              await applyMessage(chatId, fin);   // persist plaintext to local cache
              if (me && fin.senderId !== me) markDeliveredDurable(chatId, fin.id, me).catch(() => {});
            } catch { /* not on disk → do NOT ack; catch-up re-delivers it */ }
            // Bump the "↓ N new" counter when a message lands while scrolled up.
            if (chatIdRef.current === chatId && !atBottomRef.current && fin.senderId !== me) setNewSinceUp(n => n + 1);
          })();
        };
        const onMemberDelivered = (e: { userId: string; lastDeliveredMessageId: number }) => {
          const cursor = Number(e?.lastDeliveredMessageId);
          if (!e?.userId || !Number.isSafeInteger(cursor) || cursor <= 0) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, lastDeliveredMessageId: Math.max(Number(mem.lastDeliveredMessageId) || 0, cursor) }
              : mem),
          } : prev);
          // Release the sender's recovery copies now that the recipient
          // demonstrably holds these messages. The outbox keeps an accepted row
          // (and its plaintext) precisely until this moment, because the server
          // body may already have been reclaimed and this is the only copy that
          // could re-deliver. Best-effort: the queue's age cap reaps anything
          // this misses, e.g. delivery that happened while the chat was closed.
          void queueNoteDelivered(chatId, cursor);
        };
        const onMemberRead = (e: { userId: string; lastReadMessageId: number }) => {
          const cursor = Number(e?.lastReadMessageId);
          if (!e?.userId || !Number.isSafeInteger(cursor) || cursor <= 0) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, lastReadMessageId: Math.max(Number(mem.lastReadMessageId) || 0, cursor) }
              : mem),
          } : prev);
        };
        const onEdit = (e: { id: number; content: string; editedAt: string }) => {
          const me = meIdRef.current;
          const eid = Number(e.id); // socket delivers id as string; rows hold numbers
          // The server broadcasts an edit back to its author. `content` is the
          // replacement E2EE envelope, which its author cannot decrypt: a
          // double-ratchet sender only has the plaintext it just entered.
          // The optimistic edit already holds that text while editMessage()
          // persists it in the own-message store. Replacing it here turned the
          // sender's bubble into "unable to decrypt" before that write landed.
          // Keep the local plaintext and accept only the authoritative edit
          // timestamp for an edit of our own message.
          const current = messagesRef.current.find(x => x.id === eid);
          if (current && me && current.senderId === me) {
            setMessages(prev => prev.map(x =>
              x.id === eid ? { ...x, editedAt: e.editedAt } : x
            ));
            return;
          }
          // The edit event deliberately contains just the changed wire fields.
          // Merge them with the existing row, decrypt before painting, and
          // persist the result. The old direct replacement painted ciphertext
          // for recipients too until a later delta pull happened to repair it.
          if (!current) return; // global delta sync fetches rows not on screen
          void (async () => {
            const raw: Message = { ...current, content: e.content, editedAt: e.editedAt };
            let fin = raw;
            if (looksEncrypted(raw.content)) {
              try { fin = (await hydrateMessages(chatId, [raw], undefined, { live: true }))[0] ?? raw; }
              catch { /* retain the envelope for a later secure retry */ }
            }
            try { await applyMessage(chatId, fin); } catch { /* delta sync retries persistence */ }
            if (chatIdRef.current !== chatId) return;
            setMessages(prev => prev.map(x => x.id === eid ? fin : x));
          })();
        };
        const onDelete = (e: { id: number; deletedAt: string }) => {
          const me = meIdRef.current;
          const eid = Number(e.id); // socket delivers id as string; rows hold numbers
          void persistMessageDeletion(chatId, eid, e.deletedAt);
          setMessages(prev => prev.map(x =>
            x.id === eid ? { ...x, content: null, deletedAt: e.deletedAt, type: 'system' } : x
          ));
        };
        const onTypingStart = (e: { uid: string; chatId?: string }) => {
          const me = meIdRef.current;
          // Fail closed while our own id is unknown — see the same guard in
          // (tabs)/chats.tsx. `e.uid === null` is false for every real id, so
          // without this the self-check silently stops guarding and the banner
          // reads "… is typing" back at the person doing the typing.
          if (!me) return;
          if (!e?.uid || e.uid === me || (e.chatId && e.chatId !== chatId)) return;
          setTypingUids(prev => {
            if (prev.has(e.uid)) return prev;
            const next = new Set(prev); next.add(e.uid); return next;
          });
        };
        const onTypingStop = (e: { uid: string; chatId?: string }) => {
          const me = meIdRef.current;
          if (!e?.uid || (e.chatId && e.chatId !== chatId)) return;
          setTypingUids(prev => {
            if (!prev.has(e.uid)) return prev;
            const next = new Set(prev); next.delete(e.uid); return next;
          });
        };

        const onPresence = (e: { userId: string; online: boolean; lastSeenAt: string | null }) => {

          const me = meIdRef.current;
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
          const me = meIdRef.current;
          // Server already filters to chat members — but ignore the
          // echo of our own capture and any cross-chat noise.
          // Fail closed while our own id is unknown: an unfiltered echo means
          // the person who took the screenshot gets the "someone captured your
          // content" banner, and the person it was taken from gets nothing.
          if (!me) return;
          if (!e || e.chatId !== chatId || e.capturedBy === me) return;
          setScreenshotBanner({ by: e.capturedBy, at: e.capturedAt });
        };
        // Poll-vote live updates. Server emits one event per (user, option)
        // change; for single-vote polls a "switch" arrives as one
        // poll_unvoted (old option) immediately followed by one poll_voted
        // (new option). Each handler patches counts + the caller's `mine`
        // set in place — no refetch needed.
        const onPollVoted = (e: { messageId: number; userId: string; optionIndex: number }) => {
          const me = meIdRef.current;
          if (!e?.messageId) return;
          setPollVotes(prev => bumpPollVote(prev, e.messageId, e.optionIndex, +1, e.userId === me));
        };
        const onPollUnvoted = (e: { messageId: number; userId: string; optionIndex: number }) => {
          const me = meIdRef.current;
          if (!e?.messageId) return;
          setPollVotes(prev => bumpPollVote(prev, e.messageId, e.optionIndex, -1, e.userId === me));
        };

        // VaultView remote revoke. The sender destroyed the media server-side;
        // this device destroys its per-file key and every decrypted copy, then
        // repaints the bubble as a tombstone. Irreversible by design — see
        // lib/protectedMedia.
        const onMediaRevoked = (e: { chatId: string; messageId: number; attachmentId: string }) => {
          const me = meIdRef.current;
          if (!e?.attachmentId || e.chatId !== chatId) return;
          wipeRevokedMedia(e.attachmentId).catch(() => {});
          setMessages(prev => prev.map(m =>
            String(m.meta?.attachmentId ?? '') === String(e.attachmentId)
              ? { ...m, meta: { ...(m.meta || {}), revoked: true } }
              : m));
        };

        const onLiveLocation = (e: any) => {

          const me = meIdRef.current;
          if (!e?.userId || e.userId === me) return;
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
          const me = meIdRef.current;
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
    const pollIds = pollIdKey ? pollIdKey.split(',').map(Number) : [];
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
    // meId IS A DEPENDENCY, and leaving it out was the bug behind several
    // symptoms at once. It loads asynchronously, so without it every handler
    // above closed over the INITIAL null for the life of the screen — and
    // `x === null` is false for every real id, so each self-check did not fail
    // cautious, it failed OPEN:
    //   * screenshot_captured — the device that took the shot bannered ITSELF
    //     instead of the other side ("I get it, they don't")
    //   * typing_start        — your own typing shown back at you
    //   * new_message         — own messages treated as incoming (delivery
    //     receipts marked, unread counter bumped for things you sent)
    //   * poll_voted          — your own vote not marked as yours
    // With meId here the effect re-subscribes once the id resolves and every
    // one of those comparisons starts working against a real value.
  }, [chatId, pollIdKey]);

  // ── Mark-as-read (debounced) ──────────────────────────────
  useEffect(() => {
    // A durable cache write earns ✓✓. Blue ✓✓ must mean the recipient was
    // actually looking at this thread, so never mark read from a backgrounded
    // or covered chat screen.
    if (!appActive || !cvFocused || !meId || !chatId || messages.length === 0) return;
    // Newest REAL message, not messages[0]. The list is newest-first, but index 0
    // is an optimistic outbox bubble whenever a send is pending — and those carry
    // `id: 0`. A FAILED upload sits in the outbox indefinitely and is re-prepended
    // on every focus, so `messages[0].id === 0` permanently, the guard on the next
    // line returned early, and POST /read never fired for that chat again: its
    // unread badge and the tab badge stayed lit forever.
    // `.find` also skips Exit-Kit imported history, which carries negative ids.
    const latestId = messages.find(m => m.id > 0)?.id;
    if (!latestId || latestId <= lastReadSent.current) return;
    if (readDebounce.current) clearTimeout(readDebounce.current);
    readDebounce.current = setTimeout(() => {
      // Lifecycle callbacks can precede React's next effect cleanup. Recheck at
      // the point of sending so a timer due on blur cannot mark an unseen read.
      if (AppState.currentState !== 'active' || !chatFocusedRef.current) return;
      lastReadSent.current = latestId;
      // markReadDurable confirms local persistence, not server acceptance.
      // Both local watermarks refer to a real row in this focused chat.
      markReadDurable(chatId, latestId, meId)
        .then(() => import('../lib/messageNotifications'))
        .then(m => m.markSeen(chatId, latestId))
        .catch(() => { if (lastReadSent.current === latestId) lastReadSent.current = 0; });
    }, 800);
    // A GLANCE STILL COUNTS AS READING (2026-09-18).
    //
    // The cleanup used to just clearTimeout, so backing out inside the 800ms
    // window wrote NO read pointer at all - not locally, not to the server. The
    // chat therefore stayed bold in the list even though the user had opened it
    // and seen the messages, which is exactly the "I read it and it still says
    // unread" report. lib/unreadStore.applyLocalReadPointers cannot correct it
    // either: there is no pointer to correct WITH.
    //
    // On blur, fire the pending read instead of discarding it. The debounce
    // still exists for its real purpose - letting the message list settle so
    // the LATEST id is the one recorded - and the guard inside the timer still
    // stops a read being marked while the app is backgrounded. What changes is
    // only that leaving the screen flushes the pending intent rather than
    // dropping it on the floor.
    return () => {
      if (!readDebounce.current) return;
      clearTimeout(readDebounce.current);
      readDebounce.current = null;
      // Same preconditions the timer body checks, minus chatFocusedRef: focus
      // is being torn down right now, and it having been true is the point.
      if (!latestId || latestId <= lastReadSent.current) return;
      lastReadSent.current = latestId;
      markReadDurable(chatId, latestId, meId)
        .then(() => import('../lib/messageNotifications'))
        .then(m => m.markSeen(chatId, latestId))
        .catch(() => { if (lastReadSent.current === latestId) lastReadSent.current = 0; });
    };
  }, [appActive, cvFocused, meId, chatId, messages]);

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
    // FALL BACK TO THE SUMMARY'S OWN POINTER when there is no member row.
    //
    // On a warm cache this screen paints from getCachedChat first, and that row
    // has no `members` (see the `members: cc.members ?? []` above): cacheChats
    // and cacheChatDetail share ONE row keyed by chat id in lib/localDb.ts, and
    // the Chats-tab focus effect writes a members-less ChatSummary last, so the
    // detail is clobbered every time the user backs out to the list.
    //
    // boundaryId then fell to 0, which counts EVERY incoming message in the page
    // as unread — the divider reappeared identically on every open, forever. The
    // server's real answer does arrive (getChat below), but unreadCapturedRef has
    // already latched by then, so it was ignored.
    //
    // myLastReadId IS on the summary, so it survives that clobber.
    const boundaryId = myMember?.lastReadMessageId
      ?? (chat as { myLastReadId?: number }).myLastReadId
      ?? 0;
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
    // ALWAYS assign. getDraft returns '' when the chat has no draft, and the
    // old `if (d)` treated that as "nothing to do" - so on a chatId change
    // under a LIVE instance (app/split.tsx swaps two panes onto one mounted
    // ChatScreen) the composer kept the PREVIOUS chat's text. The cleanup below
    // has already saved that text under the old id, so it is not lost; leaving
    // it on screen only means the next send delivers it to the wrong chat.
    getDraft(chatId).then(d => { if (active) setInput(d); });
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
        // Snapshot BEFORE the optimistic overwrite, so a server rejection can
        // be undone instead of silently reverting on the next sync.
        const before = messagesRef.current.find(x => x.id === editId);
        setMessages(prev => prev.map(x => x.id === editId
          ? { ...x, content: text, editedAt: new Date().toISOString() } : x));
        setEditingId(null);
        setInput('');
        const q = await enqueueEdit(chatId, editId, text);
        editRollbacks.current.set(q.tempId, {
          id: editId,
          content: before?.content ?? null,
          editedAt: before?.editedAt ?? null,
        });
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
          { text: 'Retry', onPress: () => {
              retryMedia(msg._tempId!).catch(() => {});
              queueRetry(msg._tempId!);
              // Feedback. Without this the bubble stays red while the retry is
              // in flight and the tap looks ignored — which is exactly what the
              // old silent-no-op retry() looked like. 'sent' swaps it, 'failed'
              // paints it red again.
              setMessages(prev => prev.map(x => x._tempId === msg._tempId
                ? { ...x, _state: 'pending', _error: undefined } : x));
          } },
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
          // Pass the decrypted body so the bookmark keeps a LOCAL copy. The
          // server reclaims a bookmarked message's ciphertext like any other —
          // exempting it would make bookmarks a permanent server archive — so
          // this snapshot is what keeps the saved message readable afterwards.
          try { await addBookmark(msg.id, null, plain || null); }
          catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
        } },
      { key: 'remind',  label: 'Remind',  icon: 'alarm-outline', onPress: () => router.push({
          pathname: '/message-reminder' as any,
          params: { chatId, messageId: String(msg.id), preview: (plain || msg.type).slice(0, 200) },
        }) },
    ];
    if (isMine && msg.id > 0 && !msg.deletedAt) {
      acts.push({ key: 'info', label: 'Info', icon: 'information-circle-outline', onPress: () => setInfoMsg(msg) });
    }
    // Offer Edit only when the server will actually accept it.
    //
    //   msg.id > 0    a still-pending optimistic bubble has no server row yet
    //   plain         you cannot edit text you cannot see — for an own message
    //                 whose local plaintext is gone (reinstall), the composer
    //                 would open EMPTY and a stray send would overwrite the
    //                 message with whatever was typed
    //   EDIT_WINDOW   the PATCH's WHERE clause rejects anything older, and a
    //                 rejected edit used to revert silently
    const editable = isMine && !msg.deletedAt && msg.id > 0 && !!plain &&
      Date.now() - new Date(msg.createdAt).getTime() < EDIT_WINDOW_MS;
    if (editable) {
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
                // Queue FIRST, then tombstone. enqueue() now throws when the
                // outbox write does not land, and the old order painted the
                // tombstone before that could happen: the bubble read "deleted",
                // the revoke was never queued, every recipient still had the
                // message, and no 'failed' event could reach it because the row
                // was not in the outbox. Silent, permanent, and the user
                // believed the opposite.
                try {
                  await enqueueDelete(chatId, msg.id);
                } catch (e: any) {
                  Alert.alert('Could not delete', e?.message ?? 'Try again');
                  return;   // leave the message visible — it was NOT revoked
                }
                setMessages(prev => prev.map(x => x.id === msg.id
                  ? { ...x, content: null, deletedAt: new Date().toISOString(), type: 'system' } : x));
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

  // ── security-code change ──────────────────────────────────────────────
  //
  // A key substitution is invisible in normal use — the padlock still shows and
  // messages still decrypt — so it has to be surfaced unprompted rather than
  // waiting for someone to open the verify screen on the one day it matters.
  //
  // 1:1 only. A group has many identities and no single "the other person",
  // so a banner there would be noise rather than a signal.
  const [keyChange, setKeyChange] = useState<import('../lib/keyChange').KeyChange | null>(null);
  useEffect(() => {
    const peers = otherMembers;
    if (peers.length !== 1) return;
    let cancelled = false;
    (async () => {
      const { checkKeyChange } = await import('../lib/keyChange');
      const change = await checkKeyChange(peers[0].userId);
      if (!cancelled) setKeyChange(change);
    })();
    return () => { cancelled = true; };
  }, [otherMembers]);
  useEffect(() => {
    if (Platform.OS === 'web' || !chat) return;
    // THE POLICY THIS DEVICE OBEYS IS THE **PEERS'**, NOT ITS OWN.
    //
    // This used to read `chat.screenshotMode`, which is the CALLER'S OWN row —
    // so the setting actually meant "when I screenshot, tell them". Turning on
    // "block screenshots and notify" changed nothing about the other person's
    // phone, which is the only phone that can screenshot your chat. The one
    // person it never protected was the person who switched it on.
    //
    // Now: my own screenshotMode is what I DEMAND OF OTHERS (it is sent to their
    // devices via peerBlocksCapture / peerWantsCaptureNotice), and what I OBEY
    // is what they demand of me.
    //
    // Defaults are protective — an older server that does not send these fields
    // yields block + notify, the same posture as the previous default.
    const peerBlocks = chat.peerBlocksCapture ?? true;
    const peerNotify = chat.peerWantsCaptureNotice ?? true;
    const allowsCapture = !peerBlocks;
    const reportsCapture = peerNotify;
    // Observable, because this feature is invisible until it fails: nothing in
    // the UI says whether the listener armed or what policy the peers set, so a
    // silent no-op looked identical to a working one.
    // One line, no ids: this feature is invisible until it fails, and a silent
    // no-op looked identical to a working one for the whole of this bug.
    console.log(`[screenshot] policy blocks=${peerBlocks} notify=${peerNotify}`);

    // setSecure, not expo-screen-capture directly: it is the one function that
    // refuses to set FLAG_SECURE in a dev build. Calling the module here was
    // what re-armed the flag for the whole activity the moment a chat opened,
    // so gating only the root layout still left every screenshot black.
    setSecure(!allowsCapture).catch(() => {});

    let sub: { remove: () => void } | null = null;
    if (reportsCapture) {
      try {
        sub = ScreenCapture.addScreenshotListener(() => {
          reportScreenshotCaptured(chatId)
            .catch((e) => console.warn('[screenshot] report failed:', e?.message));
          // Record the capture in the on-device tamper-evident audit chain so it
          // surfaces in the Alerts tab (#41). Real local event — the inbound
          // "someone captured your content" alert is delivered separately (W7).
          recordScreenshotAttempt({ chatId, chatName: title }).catch(() => {});
          if (peerNotify) {
            Alert.alert('Screenshot captured', 'The other side has been notified.');
          }
        });
      } catch { /* listener unsupported on some platforms — non-fatal */ }
    }

    return () => {
      sub?.remove();
      // Restore the global-block posture (matches _layout.tsx default)
      setSecure(true).catch(() => {});
    };
  }, [chat?.peerBlocksCapture, chat?.peerWantsCaptureNotice, chatId]);

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
      // Search lives here, not in the header.
      //
      // The header had FOUR trailing actions where WhatsApp has three (spec
      // 6.7: video, call, overflow). Four 44pt targets plus the back arrow and
      // the avatar left roughly 160dp for the name on a 411dp screen — about
      // thirteen characters at 18pt — so ordinary names were arriving
      // ellipsised. Search is the one of the four that is not a per-message
      // action, and the one WhatsApp also files under the menu.
      {
        label: 'Search in chat',
        icon: 'search-outline',
        onPress: () => setSearchOpen(true),
      },
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
      // Exit Kit is 1:1 only, and deliberately so: a group export contains third
      // parties' messages, and there is no honest way to place those in a
      // two-person conversation. `peer` being non-null IS the direct-chat test.
      actions.push({
        label: 'Exit Kit',
        icon: 'download-outline',
        onPress: () => router.push({
          pathname: '/import-chats' as any,
          params: { chatId, peerName: peer.name || peer.email || '' },
        }),
      });
      // Chat opened by code, still anonymous (migration 119). This is the ONLY
      // way out of the mask, so it goes first — without it the two people stay
      // ghosts to each other forever and the feature looks broken rather than
      // private.
      //
      // The alert is explicit that one save is not enough. Someone who taps it
      // and sees nothing change would otherwise reasonably conclude it failed.
      if (chat?.anonMasked) {
        actions.push({
          label: 'Save contact',
          icon: 'person-add-outline',
          onPress: async () => {
            try {
              const res = await saveContact(chatId);
              Alert.alert(
                res.revealed ? 'Saved — you can see each other now' : 'Saved',
                res.revealed
                  ? 'You both saved each other, so your names and photos are now visible.'
                  : 'You will both stay hidden until they save you too.',
              );
              getChat(chatId).then(setChat).catch(() => {});
            } catch (e: any) {
              Alert.alert('Could not save', e?.message ?? 'Try again.');
            }
          },
        });
      }
      actions.push({
        label: 'Ghost Mode',
        icon: 'eye-off-outline',
        onPress: () => router.push({
          pathname: '/ghost-mode' as any,
          params: { targetId: peer.userId, targetName: peer.name || peer.email || '' },
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
        label: 'Clear chat',
        icon: 'trash-bin-outline',
        destructive: true,
        onPress: () => Alert.alert(
          'Clear this chat?',
          'Removes the chat and all its messages from THIS device. The other person keeps their copy. This cannot be undone.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Clear', style: 'destructive', onPress: async () => {
                try {
                  await clearChatMessages(chatId);
                  // Hide it server-side too. Local deletion alone is not enough:
                  // listChats() would return the chat on the next refresh and
                  // sync would pull the whole history back — which is exactly
                  // what happened when this only deleted local rows. Same call
                  // the chat list's own Delete uses, so both behave alike.
                  try { await setHidden(chatId, true); } catch {}
                  setMessages([]);
                  router.back();
                } catch (e: any) { Alert.alert('Could not clear', e?.message ?? 'Try again'); }
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
    // enqueueReaction throws when the outbox write fails. Unguarded, the haptic
    // fired, the picker closed, and nothing else happened — no reaction, no
    // alert, and an unhandled rejection. None of the four call sites await this.
    let q;
    try {
      q = await enqueueReaction(chatId, msg.id, emoji, removing ? 'remove' : 'add');
    } catch (e: any) {
      Alert.alert('Could not react', e?.message ?? 'Try again');
      return;
    }
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

    // POSTER FOR A STILL-UPLOADING VIDEO.
    //
    // An image bubble renders meta.localUri directly, but a video cannot — RN's
    // <Image> can't decode a video frame, so VideoBubble needs a real base64
    // poster and falls back to a grey videocam icon without one. meta.thumb is
    // only produced in sendMedia AFTER the upload finishes, so every video the
    // sender sent showed as a grey box for the whole encrypt+upload — minutes,
    // on a large file.
    //
    // Decoded AFTER the bubble is painted, never before: this costs a few
    // hundred ms and the whole point of the optimistic bubble is that it is
    // instant. Best-effort — a failure just leaves the icon, exactly as today.
    if (type === 'video' && !opts.metaExtra?.thumb) {
      makeThumb(file.uri, 'video')
        .then((thumb) => {
          if (!thumb) return;
          setMessages(prev => prev.map(x => x._tempId === item.tempId
            ? { ...x, meta: { ...(x.meta || {}), thumb } } as DisplayMessage : x));
        })
        .catch(() => {});
    }
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
      permissionDenied('Permission needed', `Allow ${kind === 'videos' ? 'video' : 'photo'} library access to attach.`, perm.canAskAgain);
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
    // One id shared by everything picked in this single action, so the timeline
    // can render them as ONE album instead of N stacked bubbles. Purely a
    // presentation grouping: each pick is still its own message, with its own
    // id, its own ciphertext and its own delivery state, so nothing about
    // sending, retrying or receipts changes. Only set for a genuine multi-pick.
    const albumId = result.assets.length > 1 ? `alb-${stamp}` : null;
    // Stage all picks for the multi-image caption preview.
    const items = result.assets.map((asset, i) => {
      const filename = asset.fileName ||
        (isVideo ? `video-${stamp}-${i}.mp4` : `photo-${stamp}-${i}.jpg`);
      const mime = asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
      const metaExtra: any = { width: asset.width, height: asset.height };
      if (isVideo && asset.duration) metaExtra.durationMs = asset.duration;
      if (albumId) { metaExtra.albumId = albumId; metaExtra.albumIndex = i; }
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
    // enqueueMedia now THROWS when the outbox write does not land, instead of
    // reporting success for a row that was never saved. Unguarded, that throw
    // would surface as an unhandled rejection — the user would see the picker
    // close and nothing else, which is the same silence the throw exists to
    // replace. Same shape as the file-pick handler below.
    //
    // Per item, not around the loop: one item failing to save must not silently
    // drop the ones after it.
    for (const pm of items) {
      try {
        await enqueueMediaOptimistic(pm.mediaType, { uri: pm.uri, filename: pm.filename, mime: pm.mime },
          { caption: pm.caption.trim() || undefined, viewOnce: pm.viewOnce, metaExtra: pm.metaExtra });
      } catch (e: any) {
        Alert.alert('Could not send', e?.message ?? 'Try again');
      }
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
    // SCAN mode returns one assembled PDF, not an image.
    const isFile = rawType === 'file';
    // View-once marks image/video bytes on send — a document has none to mark.
    const viewOnce = !isFile && params.capturedViewOnce === '1';
    // Clear immediately so navigating back into the chat doesn't re-stage.
    router.setParams({ capturedUri: '', capturedType: '', capturedViewOnce: '', capturedName: '' } as any);
    const filename = isFile
      ? (params.capturedName || `Scan-${Date.now()}.pdf`)
      : isVideo
        ? `${rawType === 'video-note' ? 'note' : 'video'}-${Date.now()}.mp4`
        : `photo-${Date.now()}.jpg`;
    const mime = isFile ? 'application/pdf' : isVideo ? 'video/mp4' : 'image/jpeg';
    const metaExtra: Record<string, any> = rawType === 'video-note' ? { videoNote: true } : {};
    // Stage in the caption preview (same as a gallery pick).
    setPendingItems([{ uri, mediaType: isFile ? 'file' : isVideo ? 'video' : 'image', filename, mime, viewOnce, metaExtra, caption: '' }]);
    setCurrentIdx(0);
  }, [params.capturedUri, params.capturedType, params.capturedViewOnce, params.capturedName, router]);

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
  // ~11s of hinting, then the screen is allowed to go quiet.
  const CHEV_PULSES = 6;

  // Gentle up-chevron above the camera icon so users discover slide-up.
  //
  // BOUNDED, because this is DECORATION ON THE MOST-OPENED SCREEN IN THE APP.
  //
  // It used to be an unbounded Animated.loop: it pulsed for the entire life of
  // the chat screen, forever, whether or not anyone was looking at the camera
  // icon. Two costs, one of them invisible:
  //
  //   * the UI thread never goes idle while a chat is open. Every 950ms tick is
  //     a wake-up and a frame the compositor has to produce, for a hint the
  //     user has either taken or ignored within the first few seconds.
  //   * it makes the screen untestable. `uiautomator dump` waits for an idle
  //     window and NEVER gets one, so no automated check can read a chat screen
  //     at all — which is how this was found.
  //
  // CHEV_PULSES is a discovery cue, not an indicator: after a handful of cycles
  // it has done its job. Anything that reports live STATE (a recording dot, a
  // transfer spinner) must keep looping — this is not that, and the rest of the
  // app's loops are deliberately left alone.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(chevPulse, { toValue: 1, duration: 950, useNativeDriver: true }),
        Animated.timing(chevPulse, { toValue: 0, duration: 950, useNativeDriver: true }),
      ]),
      { iterations: CHEV_PULSES },
    );
    loop.start();
    // Still stopped on unmount: leaving a running animation attached to a
    // torn-down screen keeps its node alive.
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
    // copyToCacheDirectory:false — VaultBeam streams the source in place.
    //
    // With the copy enabled a picked file was DUPLICATED into app cache before
    // the transfer started, so a 12 GB send needed 12 GB of free space on top
    // of the original plus a long silent copy, and Android was free to evict
    // that copy mid-transfer. The native reader now opens the picked
    // content:// URI directly (SrcReader in VaultBeamStreamModule.kt), so the
    // duplicate buys nothing.
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: false });
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
    if (!perm.granted) { permissionDenied('Permission needed', 'Allow photo library access to attach.', perm.canAskAgain); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
    if (result.canceled || !result.assets?.[0]) return;
    router.push({ pathname: '/image-editor' as any, params: { uri: result.assets[0].uri, chatId, returnTo: '/chat' } });
  }, [chatId, sending, router]);

  // ── Send a GIF (external Tenor URL — no upload; rendered from the URL) ──
  const sendGif = useCallback(async (url: string, preview: string) => {
    setGifOpen(false);
    if (!url) return;
    try {
      // source marks WHERE this came from, so the bubble can show KLIPY's
      // watermark on KLIPY content and only on KLIPY content. Messages sent
      // before the switch came from GIPHY and carry no source — stamping those
      // with KLIPY's mark would misattribute someone else's library.
      const msg = await sendMessage(chatId, '', 'image', { meta: { gifUrl: url, preview, source: 'klipy' } });
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
      { label: 'Scan',          icon: 'scan' as const,        color: '#8D6E63', onPress: () => router.push({ pathname: '/camera' as any, params: { chatId, peerName, returnTo: '/chat', startMode: 'scan' } }) },
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
    if (pagingChatRef.current || !hasMore || messages.length === 0) return;
    const oldest = messages[messages.length - 1]?.id;
    if (!oldest) return;
    // Same pane-swap hazard as the initial load: chatId can change on a mounted
    // instance while these reads are in flight, and appending the previous
    // chat's page to the one now on screen is worse than not paging at all.
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    pagingChatRef.current = cid;
    prefetchedChatRef.current = cid;
    setLoadingOlder(true);
    try {
      // Disk first. These rows are already plaintext, so a cached page costs no
      // network call and no decrypt — and it works offline, which the
      // server-only path never did. Only past the cache horizon do we ask the
      // server, which is also the only case where hydrate/re-cache is needed.
      let older = await getCachedMessagesBefore(
        cid, Number(oldest), SCROLL_PAGE_SIZE,
      ) as DisplayMessage[];
      metric(older.length ? 'local.message_hits' : 'local.message_misses');

      // A FULL page from disk answered the request: no network, no decrypt.
      // A SHORT page means the cache horizon, not the end of history — so top
      // up from the server rather than ending pagination on a cache boundary.
      //
      // …unless we have paged into imported history (Exit Kit), which carries
      // NEGATIVE ids. The server has no copy of it, so `before=-17559…` would be
      // a guaranteed-empty round-trip on every scroll, and it would put a
      // synthetic local id on the wire. Imported history is the true start of the
      // conversation, so a short page there really is the end.
      const cachedPositiveCount = older.reduce((n, m) => n + (Number(m.id) > 0 ? 1 : 0), 0);
      if (cachedPositiveCount < SCROLL_PAGE_SIZE && Number(oldest) > 0) {
        try {
          const olderRaw = await getMessages(cid, { before: oldest, limit: SCROLL_PAGE_SIZE });
          const fetched = await hydrateMessages(cid, olderRaw);  // decrypt once at ingest
          cacheMessages(cid, fetched).catch(() => {});           // persist for instant scroll-back
          const seen = new Set(older.map(m => String(m.id)));
          older = [...older, ...fetched.filter(m => !seen.has(String(m.id)))]
            .sort((a, b) => Number(b.id) - Number(a.id));
          // Only the SERVER can say there is nothing older. Ending on a short
          // cached page would strand history the device simply had not fetched.
          if (fetched.length < SCROLL_PAGE_SIZE && alive()) {
            const pageOldest = older[older.length - 1]?.id;
            const localMore = pageOldest != null
              ? await hasCachedOlderMessages(cid, Number(pageOldest)).catch(() => false)
              : false;
            if (alive()) setHasMore(localMore);
          }
        } catch {
          // Offline. Whatever the cache gave us still renders, and hasMore is
          // deliberately left alone so a later attempt can resume.
        }
      } else if (older.length < SCROLL_PAGE_SIZE && Number(oldest) < 0) {
        // Inside imported history with nothing older on disk: this is the start
        // of the conversation. Nobody else can tell us so, because nobody else
        // has these messages.
        if (alive()) setHasMore(false);
      }
      if (!alive()) return;
      // Dedupe against what's already loaded — a page boundary can overlap and
      // would otherwise inject duplicate ids (duplicate React keys).
      const currentIds = new Set(messages.map(x => String(x.id)));
      const projected = [...messages, ...older.filter(m => !currentIds.has(String(m.id)))];
      const projectedSettled = projected.filter(m => !m._tempId);
      const trimNewer = projectedSettled.length > MAX_LOADED;
      if (trimNewer) {
        setHasNewer(true);
        setNewerGapBeforeId(projectedSettled[projectedSettled.length - MAX_LOADED]?.id ?? null);
      }
      setMessages(prev => {
        const have = new Set(prev.map(x => String(x.id)));
        const combined = [...prev, ...older.filter(m => !have.has(String(m.id)))];
        const pending = combined.filter(m => m._tempId);
        let settled = combined.filter(m => !m._tempId);
        if (trimNewer && settled.length > MAX_LOADED) {
          // The user is moving into older history. Keep the rows around that
          // viewport and make the discarded newer side pageable again.
          settled = settled.slice(settled.length - MAX_LOADED);
        }
        return [...pending, ...settled];
      });
    } catch {}
    finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
      if (alive()) setLoadingOlder(false);
    }
  }, [chatId, hasMore, messages]);

  // When an old search window (or an upward-trimmed long thread) is open,
  // page back toward the newest local rows without rebuilding the whole gap.
  const onStartReached = useCallback(async () => {
    if (pagingChatRef.current || !hasNewer || messages.length === 0) return;
    const newest = messages.find(m => !m._tempId)?.id;
    if (newest == null) return;
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    pagingChatRef.current = cid;
    setLoadingNewer(true);
    try {
      const newerAsc = await getCachedMessagesAfter(cid, Number(newest), SCROLL_PAGE_SIZE);
      if (!alive()) return;
      const newer = [...newerAsc].reverse() as DisplayMessage[];
      const nextNewest = newer[0]?.id ?? newest;
      const more = await hasCachedNewerMessages(cid, Number(nextNewest)).catch(() => false);
      if (!alive()) return;
      const currentIds = new Set(messages.filter(m => !m._tempId).map(m => String(m.id)));
      const willTrimOlder = currentIds.size + newer.filter(m => !currentIds.has(String(m.id))).length > MAX_LOADED;
      setMessages(prev => {
        const pending = prev.filter(m => m._tempId);
        const have = new Set(prev.map(m => String(m.id)));
        const settled = [
          ...newer.filter(m => !have.has(String(m.id))),
          ...prev.filter(m => !m._tempId),
        ].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_LOADED);
        return [...pending, ...settled];
      });
      if (willTrimOlder) setHasMore(true);
      setHasNewer(more);
      setNewerGapBeforeId(more ? Number(nextNewest) : null);
    } catch {
      // Local cache may be temporarily locked; retain the affordance to retry.
    } finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
      if (alive()) setLoadingNewer(false);
    }
  }, [chatId, hasNewer, messages]);

  const returnToLatest = useCallback(async () => {
    if (pagingChatRef.current) return;
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    pagingChatRef.current = cid;
    try {
      const latest = await getCachedMessages(cid, INITIAL_PAGE_SIZE + PREFETCH_PAGE_SIZE) as DisplayMessage[];
      if (!alive()) return;
      const latestId = latest[0]?.id ?? 0;
      setMessages(prev => {
        const pending = prev.filter(m => m._tempId);
        const justArrived = prev.filter(m => !m._tempId && Number(m.id) > Number(latestId));
        const seen = new Set<string>();
        const settled = [...justArrived, ...latest].filter(m => {
          const key = String(m.id);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_LOADED);
        return [...pending, ...settled];
      });
      const oldest = latest[latest.length - 1]?.id;
      const older = oldest != null
        ? await hasCachedOlderMessages(cid, Number(oldest)).catch(() => false)
        : false;
      if (!alive()) return;
      setHasMore(older || Number(oldest) > 0);
      setHasNewer(false);
      setNewerGapBeforeId(null);
      atBottomRef.current = true;
      setShowScrollDown(false);
      setNewSinceUp(0);
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
    } catch {
      // Keep the return affordance visible so a locked cache can be retried.
    } finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
    }
  }, [chatId]);

  // Album row identity is cached by albumId; drop it when the chat changes so a
  // row can never be reused across conversations.
  useEffect(() => { resetAlbumCache(); }, [chatId]);

  // Keep a ref to loaded messages for the jump-to-message paging loop.
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Paint 50 rows first, then fill the in-memory window to roughly 100 from
  // SQLite after gestures/animations settle. This is local-only: opening a
  // chat never waits on network or a second decrypt batch.
  useEffect(() => {
    if (loading || prefetchedChatRef.current === chatId) return;
    const cid = chatId;
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(async () => {
      if (cancelled || chatIdRef.current !== cid) return;
      // A pane swap may leave the previous chat's read in flight. Its finally
      // block is ownership-checked, so the new pane can safely take the lock.
      if (pagingChatRef.current && pagingChatRef.current !== cid) pagingChatRef.current = null;
      if (pagingChatRef.current) return;
      const current = messagesRef.current;
      const oldest = current[current.length - 1]?.id;
      if (!oldest) return;
      prefetchedChatRef.current = cid;
      pagingChatRef.current = cid;
      try {
        const older = await getCachedMessagesBefore(cid, Number(oldest), PREFETCH_PAGE_SIZE);
        if (cancelled || chatIdRef.current !== cid) return;
        if (older.length) {
          setMessages(prev => {
            const have = new Set(prev.map(x => String(x.id)));
            return [...prev, ...older.filter(m => !have.has(String(m.id)))];
          });
        }
        const nextOldest = older[older.length - 1]?.id ?? oldest;
        const localOlder = await hasCachedOlderMessages(cid, Number(nextOldest)).catch(() => false);
        if (!cancelled && chatIdRef.current === cid) {
          setHasMore(localOlder || Number(nextOldest) > 0);
        }
      } catch {
        if (!cancelled && chatIdRef.current === cid) prefetchedChatRef.current = null;
      } finally {
        if (pagingChatRef.current === cid) pagingChatRef.current = null;
      }
    });
    return () => { cancelled = true; task.cancel(); };
  }, [chatId, loading]);

  /**
   * Cap the in-memory window.
   *
   * Nothing trimmed this array. A long-lived chat grew it forever — every
   * message ever paged in stayed in JS state, each one a decrypted string plus
   * a base64 thumbnail for media, and a single jumpToMessage could add two
   * thousand in one action. The cost is not only memory: every setMessages
   * re-derives the whole list, so the whole screen gets slower the longer it
   * stays open.
   *
   * ONLY WHEN AT THE BOTTOM, and that condition is the whole design. The tail
   * of this array is the OLDEST message (it is newest-first), so trimming while
   * the user is scrolled up — or has just jumped to a search hit — would delete
   * the messages they are looking at and yank the viewport. At the bottom they
   * are reading live and the tail is off-screen by definition.
   *
   * Dropping older messages means there is more to page again, so hasMore has
   * to go back to true even if we had previously reached the true start of the
   * conversation. onEndReached pages from the oldest LOADED id and the cache
   * still holds them, so scrolling up refills from disk with no network.
   *
   * As an effect rather than inside each setMessages: the array grows from six
   * different places (sends, socket arrivals, optimistic rows), and a guard in
   * one place cannot be forgotten by the seventh.
   */
  useEffect(() => {
    const settledCount = messages.reduce((n, m) => n + (m._tempId ? 0 : 1), 0);
    if (settledCount <= MAX_LOADED) return;
    if (hasNewer) {
      const retained = messages.filter(m => !m._tempId).slice(-MAX_LOADED);
      setNewerGapBeforeId(retained[0]?.id ?? null);
      setMessages(prev => {
        const pending = prev.filter(m => m._tempId);
        const settled = prev.filter(m => !m._tempId).slice(-MAX_LOADED);
        return [...pending, ...settled];
      });
      return;
    }
    if (!atBottomRef.current) return;
    setMessages(prev => {
      const pending = prev.filter(m => m._tempId);
      return [...pending, ...prev.filter(m => !m._tempId).slice(0, MAX_LOADED)];
    });
    setHasMore(true);
  }, [hasNewer, messages]);

  // Jump to a specific message (from in-chat search): page older until it's
  // loaded, scroll to it, and briefly flash it.
  const jumpToMessage = useCallback(async (targetId: number) => {
    // Pane-swap guard: paging another chat's history into this one is not recoverable.
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    while (pagingChatRef.current && alive()) {
      await new Promise<void>(resolve => setTimeout(resolve, 16));
    }
    if (!alive()) return;
    pagingChatRef.current = cid;
    try {
    const startingWindow = messagesRef.current;
    let replacedWithSegment = false;
    let idx = messagesRef.current.findIndex(m => m.id === targetId);
    // Use the centred SQLite window only when it overlaps the loaded tail.
    // Appending a distant window would make FlatList place two non-contiguous
    // history ranges next to each other with no way to page the missing middle.
    if (idx < 0) {
      try {
        const loadedOldest = messagesRef.current[messagesRef.current.length - 1]?.id;
        const around = await getCachedMessagesAround(
          cid, targetId, Math.floor(PREFETCH_PAGE_SIZE / 2),
        ) as DisplayMessage[];
        if (!alive()) return;
        const overlapsLoadedTail = loadedOldest != null && around.some(m => m.id === loadedOldest);
        if (around.some(m => m.id === targetId)) {
          const seen = new Set<string>();
          const source = overlapsLoadedTail
            ? [...messagesRef.current, ...around]
            : [...messagesRef.current.filter(m => m._tempId), ...around];
          const combined = source.filter(m => {
            const key = m._tempId ?? String(m.id);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          const pending = combined.filter(m => m._tempId);
          const settled = combined.filter(m => !m._tempId).sort((a, b) => Number(b.id) - Number(a.id));
          messagesRef.current = [...pending, ...settled];
          idx = messagesRef.current.findIndex(m => m.id === targetId);
          if (!overlapsLoadedTail) {
            replacedWithSegment = true;
            const newestSegmentId = settled[0]?.id;
            const oldestSegmentId = settled[settled.length - 1]?.id;
            const [newer, older] = await Promise.all([
              newestSegmentId == null ? false : hasCachedNewerMessages(cid, Number(newestSegmentId)).catch(() => false),
              oldestSegmentId == null ? false : hasCachedOlderMessages(cid, Number(oldestSegmentId)).catch(() => false),
            ]);
            if (!alive()) return;
            setHasNewer(newer);
            setHasMore(older || Number(oldestSegmentId) > 0);
            setNewerGapBeforeId(newer ? Number(newestSegmentId) : null);
            atBottomRef.current = false;
            setShowScrollDown(true);
          }
        }
      } catch {}
    }
    let guard = 0;
    const maxJumpPages = Math.max(
      0, Math.ceil((MAX_LOADED - messagesRef.current.length) / SCROLL_PAGE_SIZE),
    );
    // Network fallback for a target absent from local storage.
    while (idx < 0 && guard < maxJumpPages) {
      guard++;
      const oldest = messagesRef.current[messagesRef.current.length - 1]?.id;
      if (!oldest) break;
      // Same disk-first rule as onEndReached — jumping to an old search hit
      // used to re-download up to 40 pages it already had.
      let older;
      try {
        older = await getCachedMessagesBefore(cid, Number(oldest), SCROLL_PAGE_SIZE);
        // Same rule as onEndReached: a negative id is imported history, which the
        // server has never seen. Asking it would be an empty round-trip and would
        // put a local-only id on the wire.
        const cachedPositiveCount = older.reduce((n, m) => n + (Number(m.id) > 0 ? 1 : 0), 0);
        if (cachedPositiveCount < SCROLL_PAGE_SIZE && Number(oldest) > 0) {
          const fetched = await hydrateMessages(
            cid, await getMessages(cid, { before: oldest, limit: SCROLL_PAGE_SIZE }),
          );
          cacheMessages(cid, fetched).catch(() => {});
          const cachedIds = new Set(older.map(m => String(m.id)));
          older = [...older, ...fetched.filter(m => !cachedIds.has(String(m.id)))]
            .sort((a, b) => Number(b.id) - Number(a.id));
        }
      } catch { break; }
      if (!alive()) return;
      if (!older.length) { setHasMore(false); break; }
      // Accumulate in the ref only. This used to setMessages on EVERY lap, so
      // jumping to an old search hit re-rendered a growing list up to forty
      // times — forty full re-derivations of a list on its way to two thousand
      // rows — before the user saw anything. The screen is committed once,
      // below, when we actually have the target.
      const have = new Set(messagesRef.current.map(m => m._tempId ?? String(m.id)));
      const room = Math.max(0, MAX_LOADED - messagesRef.current.length);
      const add = older.filter(m => !have.has(m._tempId ?? String(m.id))).slice(0, room);
      const next = [...messagesRef.current, ...add];
      messagesRef.current = next;
      idx = next.findIndex(m => m.id === targetId);
    }
    // MERGE, DON'T REPLACE.
    //
    // The paging loop above accumulates into messagesRef, a snapshot taken
    // before up to 40 round trips. Publishing it wholesale threw away anything
    // added to the rendered list in the meantime — an optimistic bubble the user
    // sent while the jump was still paging, or a message that arrived on the
    // socket. Both are newest, so they go back at the head; everything paged in
    // is older and keeps its order.
    const paged = messagesRef.current;
    const key = (x: DisplayMessage) => x._tempId ?? String(x.id);
    let committed = paged;
    const publish = () => setMessages(prev => {
      const have = new Set(paged.map(key));
      const startingKeys = new Set(startingWindow.map(key));
      const extra = prev.filter(x => !have.has(key(x)) &&
        (!replacedWithSegment || x._tempId || !startingKeys.has(key(x))));
      committed = extra.length ? [...extra, ...paged] : paged;
      if (replacedWithSegment) {
        const pending = committed.filter(m => m._tempId);
        const settled = committed.filter(m => !m._tempId)
          .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_LOADED);
        committed = [...pending, ...settled];
      }
      return committed;
    });
    if (idx < 0) {
      // A distant target needs a bidirectional/segmented window. Do not publish
      // thousands of intermediate rows or leave the ref ahead of the screen.
      messagesRef.current = startingWindow;
      return;
    }
    if (!alive()) return;
    publish();
    requestAnimationFrame(() => {
      const at = committed.findIndex(m => m.id === targetId);
      if (at < 0) return;
      try { listRef.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.5 }); } catch {}
    });
    setFlashId(targetId);
    setTimeout(() => setFlashId(null), 2500);
    } finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
    }
  }, [chatId]);

  // Consume a pending jump when the screen regains focus (e.g. back from search).
  useFocusEffect(useCallback(() => {
    // A newly-pushed chat focuses before its asynchronous local page is ready.
    // Leave the single-shot handoff intact until that page has painted.
    if (loading) return;
    const target = consumePendingJump(chatId);
    if (target) jumpToMessage(target);
  }, [chatId, loading, jumpToMessage]));

  // Adopt outbox media enqueued from ANOTHER screen while this chat stayed
  // mounted — the document scanner is the live case. The initial load reads
  // pendingForChat once on mount, so without this the scan's bubble would not
  // appear until the upload finished, and its progress would be invisible.
  // Keyed by tempId against what is already on screen, so re-focusing can never
  // double-paint a bubble.
  useFocusEffect(useCallback(() => {
    let cancel = false;
    (async () => {
      const items = await mediaPendingForChat(chatId).catch(() => []);
      if (cancel || !items.length) return;
      setMessages(prev => {
        const have = new Set(prev.map(x => x._tempId).filter(Boolean));
        const add = items.filter(m => !have.has(m.tempId)).map(m => ({
          id: 0, chatId: m.chatId, senderId: meId ?? '', type: m.type as any,
          content: m.caption || '',
          meta: { localUri: m.srcPath, mime: m.mime, filename: m.filename, ...(m.metaExtra || {}), ...(m.viewOnce ? { viewOnce: true } : {}) },
          replyToId: null, editedAt: null, deletedAt: null,
          createdAt: new Date(m.createdAt).toISOString(),
          _tempId: m.tempId, _state: m.state === 'failed' ? 'failed' : 'pending',
        })) as DisplayMessage[];
        // Inverted list: newest first, so the oldest of the new batch goes last.
        return add.length ? [...add.reverse(), ...prev] : prev;
      });
    })();
    return () => { cancel = true; };
  }, [chatId, meId]));

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
  // Three states, not a boolean (2026-09-17). A boolean cannot say "we do not
  // know yet", and BOTH of its defaults are wrong: `true` painted a locked
  // chat's messages until getLock answered — and FOREVER if getLock threw,
  // because the overlay needed both !lockOpen AND lockInfo and a throw set
  // neither; `false` would flash a padlock over every unlocked chat. 'checking'
  // shows the bare veil: no messages, no padlock, and nothing opens until the
  // lock is known.
  const [lockState, setLockState] = useState<'checking' | 'open' | 'locked'>('checking');
  const [lockPin, setLockPin] = useState('');
  // The message, not a boolean: 'both' can now fail for a reason other than a
  // wrong PIN, and "Incorrect PIN" would be a lie the user cannot act on.
  const [lockErr, setLockErr] = useState<string | null>(null);
  // 'both' MEANS BOTH (2026-09-17). It used to be enforced as "either": the
  // biometric alone opened the chat, and so did the PIN alone, so the strongest
  // setting was single-factor in practice. This remembers that the biometric
  // half has been satisfied for THIS visit — it is reset on every focus below,
  // so returning to the chat asks for both again.
  const [lockBio, setLockBio] = useState(false);
  useFocusEffect(useCallback(() => {
    let cancel = false;
    // Synchronously, BEFORE any await: re-focusing must re-veil in the same
    // commit, or the previous session's messages sit on screen for the length of
    // an AsyncStorage read every time this chat is returned to.
    setLockState('checking');
    (async () => {
      let lock: LockedChat | null = null;
      try {
        lock = await getLock(chatId);
      } catch {
        // FAIL CLOSED. We could not read the lock table, so we cannot prove this
        // chat is unlocked. lockInfo stays null — there is nothing to verify a
        // PIN or a fingerprint against — so the veil offers only "Back to chats".
        if (!cancel) { setLockInfo(null); setLockState('locked'); }
        return;
      }
      if (cancel) return;
      setLockInfo(lock);
      setLockPin(''); setLockErr(null); setLockBio(false);
      if (!lock) { setLockState('open'); return; }
      setLockState('locked');
      if (lock.lockMethod === 'biometric' || lock.lockMethod === 'both') {
        const ok = await verifyBiometric('Unlock chat');   // already fails closed
        // 'both': passing the fingerprint only banks the first factor — the veil
        // stays up (already 'locked') until the PIN is entered too.
        if (!cancel && ok) { setLockBio(true); if (lock.lockMethod !== 'both') setLockState('open'); }
      }
    })();
    return () => { cancel = true; };
  }, [chatId]));

  const submitLockPin = useCallback(() => {
    if (!lockInfo || !verifyPin(lockInfo, lockPin)) { setLockErr('Incorrect PIN'); return; }
    // The PIN is the SECOND factor on a 'both' chat, never the only one — a
    // correct PIN on its own used to open it (2026-09-17).
    if (lockInfo.lockMethod === 'both' && !lockBio) {
      setLockErr('This chat needs biometrics too — tap “Use biometrics”.');
      return;
    }
    setLockState('open'); setLockErr(null); setLockPin('');
  }, [lockInfo, lockPin, lockBio]);

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
          router.push({ pathname: '/story-viewer' as any, params: { userId: peer.userId, userName: peer.name || peer.email || title } });
          return;
        }
      } catch {}
    }
    setPhotoViewer(true);   // no story (or group) → show the profile photo
  }, [directPeer, router, title]);

  // Tap the name/header → the contact's profile page (or group info).
  const openProfile = useCallback(() => {
    if (chat?.type === 'group') {
      // group-info reads `id` — passing `chatId` sent it fetching /chats/ (empty
      // id), which lands on go-api's catch-all "route not migrated" message.
      router.push({ pathname: '/group-info' as any, params: { id: chatId } });
      return;
    }
    const peer = directPeer();
    if (!peer) return;
    router.push({ pathname: '/contact-info' as any, params: { chatId, peerUid: peer.userId, peerName: peer.name || peer.email || 'crazzychat user' } });
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

  // ── self-destruct countdown (migration 120) ────────────────
  //
  // A chat opened by a 1h/3h code DELETES ITSELF — every message, and the
  // conversation with them. Until this existed the server knew the deadline and
  // the person in the chat did not: it simply vanished mid-conversation, which
  // reads as data loss rather than as the feature working.
  //
  // Ticks every 30s rather than every second. The number people act on is "how
  // many minutes have I got", and a per-second re-render of this screen to
  // animate a value that changes once a minute is the kind of cost that shows
  // up on an old phone for nothing.
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const expiresAt = chat?.expiresAt ?? null;
  useEffect(() => {
    if (!expiresAt) { setExpiresIn(null); return; }
    const tick = () => setExpiresIn(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const h = setInterval(tick, 30_000);
    return () => clearInterval(h);
  }, [expiresAt]);

  // Minutes until about an hour out, then hours. "in 92 min" is a worse answer
  // than "in 2h" for deciding whether to keep talking.
  const expiryLabel = useMemo(() => {
    if (expiresIn == null) return null;
    if (expiresIn <= 600) return 'deleting now';
    const m = Math.ceil(expiresIn / 60);
    return m < 60 ? `deletes itself in ${m} min` : `deletes itself in ${Math.round(m / 60)}h`;
  }, [expiresIn]);

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
      name: m?.name || m?.email || 'crazzychat user',
      uri: m?.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null,
      headers: screenAuthHeader ? { Authorization: screenAuthHeader } : undefined,
    };
  }, [membersById, screenAuthHeader]);

  // NO CHAT ID = NOTHING TO SHOW, AND THE USER MUST NOT BE STRANDED.
  //
  // Reached by a deep link with no/!invalid id (vaultchat://chat), a
  // notification whose chat was since deleted, or a restored task whose params
  // were dropped. Every effect below already no-ops on `!chatId`, so the screen
  // rendered its full frame with no header, no messages and no way back — a
  // blank wall. Say what happened and give them the exit.
  //
  // Deliberately AFTER the hooks: an early return above them would change hook
  // order between renders. `embedded` is excluded because a pane with no id is
  // the split view's own empty state, which it already draws.
  if (!chatId && !embedded) {
    return (
      <View style={[S.screen, S.center, { padding: 24, gap: 12 }]}>
        <Ionicons name="chatbubble-ellipses-outline" size={44} color={colors.textDim} />
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
          Conversation not found
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
          This link did not carry a conversation, or the chat has been deleted.
        </Text>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as any))}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: colors.primary }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Back to chats</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View
      style={[S.screen, { paddingBottom: composerGap }]}
      onLayout={e => setPaneH(e.nativeEvent.layout.height)}
    >
      {/* No custom wallpaper → the Aurora ground (U6) stands in for one. */}
      {!wallpaper && <AuroraBackground variant="chat" />}

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

      {/* Header — glass, so the thread scrolls visibly beneath it */}
      <GlassView kind="chrome" bordered={false} style={S.headerGlass}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity style={S.headerAvatarWrap} activeOpacity={0.7} onPress={onAvatarTap}>
          <Avatar
            ring
            uri={headerPhotoId && screenAuthHeader ? attachmentUrl(headerPhotoId) : null}
            headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined}
            name={title}
            size={40}
            presence={chat?.type === 'direct' && peerPresence?.online ? 'online' : null}
            anon={!!chat?.anonMasked}
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
          {/* Self-destruct countdown. Sits under the name because that is where
              the eye already is when you open a chat, and because this is the
              one fact about the conversation that changes what you do next.
              Red under ten minutes — the point where "I'll reply later" stops
              being an option. */}
          {expiryLabel && (
            <View style={S.expiryRow}>
              <Ionicons
                name="timer-outline"
                size={12}
                color={expiresIn != null && expiresIn <= 600 ? colors.danger : colors.textDim}
              />
              <Text style={[S.expiryTxt, expiresIn != null && expiresIn <= 600 && { color: colors.danger }]}>
                {expiryLabel}
              </Text>
            </View>
          )}
        </View>
        {chat?.type === 'direct' && meId && (() => {
          const peer = chat.members.find(m => m.userId !== meId);
          if (!peer) return null;
          const params = { chatId, peerUid: peer.userId, peerName: peer.name || peer.email || 'crazzychat user' };
          return (
            <>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/videocall' as any, params })} accessibilityLabel="Video call"
                activeOpacity={0.7}
              >
                <Ionicons name="videocam" size={23} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/voicecall' as any, params })} accessibilityLabel="Voice call"
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
                onPress={() => router.push({ pathname: '/group-calls' as any, params: { ...params, mode: 'video' } })} accessibilityLabel="Group video call"
                activeOpacity={0.7}
              >
                <Ionicons name="videocam" size={23} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn}
                onPress={() => router.push({ pathname: '/group-calls' as any, params: { ...params, mode: 'voice' } })} accessibilityLabel="Group voice call"
                activeOpacity={0.7}
              >
                <Ionicons name="call" size={20} color={colors.text} />
              </TouchableOpacity>
            </>
          );
        })()}
        <TouchableOpacity style={S.headerIconBtn} onPress={onPressMenu} activeOpacity={0.7} accessibilityLabel="More options">
          <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>
      </GlassView>

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
            <Text style={S.inChatSearchCount} numberOfLines={1}>
              {messages.filter(m => !m.deletedAt && (m.content || '').toLowerCase().includes(searchQ.toLowerCase())).length} matches
            </Text>
          )}
          {/* The dismiss lives on the bar now that the header toggle is gone.
              It belongs here anyway — you close a search field from the field,
              not from a button three positions away in the app bar. */}
          <TouchableOpacity
            onPress={() => { setSearchOpen(false); setSearchQ(''); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close search"
          >
            <Ionicons name="close" size={20} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      {error && (
        <View style={S.errorBar}>
          <Text style={S.errorTxt}>{error}</Text>
        </View>
      )}

      {/* Inbound screenshot alert — auto-dismisses after 4s */}
      {/* Deliberately informative, not blocking. A key change is genuinely
          ambiguous — a reinstall looks identical to an interception — so the
          honest response is to say what happened and offer the check, rather
          than throw up a scary modal people learn to tap through. */}
      {keyChange && (
        <View style={S.keyChangeBanner}>
          <Text style={S.keyChangeTxt}>
            🔑 The security code for this chat changed. This usually means they
            reinstalled crazzychat or switched device.
          </Text>
          <View style={S.keyChangeRow}>
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/verify-contact' as any,
                params: { peerId: keyChange.peerId,
                  peerName: otherMembers[0]?.name ?? chat?.name ?? '' } })}
            >
              <Text style={S.keyChangeVerify}>Verify</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                const { acknowledgeKeyChange } = await import('../lib/keyChange');
                await acknowledgeKeyChange(keyChange.peerId, keyChange.currentHex);
                setKeyChange(null);
              }}
            >
              <Text style={S.keyChangeDismiss}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

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
            {/* Falls back to raw lat/long, which at fontSize 11 ellipsised mid-
                coordinate - and half a coordinate points somewhere else entirely.
                Shrink the glyphs instead of cutting them (2026-09-17). */}
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{liveLoc.address || `${liveLoc.latitude.toFixed(5)}, ${liveLoc.longitude.toFixed(5)}`} · Navigate</Text>
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
          : pm.type === 'location' ? '📍 Location' : pm.type === 'poll' ? '📊 Poll'
          : pm.type === 'game_invite' ? '🎮 Game invite' : 'Message';
        return (
          <TouchableOpacity style={S.pinnedBar} activeOpacity={0.8} onPress={() => jumpToMessage(Number(pinnedId))}>
            <Ionicons name="pin" size={15} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={S.pinnedBarTitle}>Pinned message</Text>
              <Text style={S.pinnedBarSub} numberOfLines={1}>{label}</Text>
            </View>
            <TouchableOpacity hitSlop={10} onPress={async () => { setPinnedId(null); try { await pinMessage(chatId, null); } catch {} }} accessibilityLabel="Unpin message">
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
          // Index into renderMessages, NOT messages — renderMessages drops
          // reaction rows and duplicates, so the two diverge as soon as anyone
          // reacts, and `messages[index+1]` then points at an unrelated message
          // (date chips, sender grouping and the unread divider all land wrong).
          const older = renderMessages[index + 1];
          const showDate = !older || !isSameCalendarDay(item.createdAt, older.createdAt);
          // Group with the older message when it's the same sender, same day, and
          // within 5 minutes (suppresses the repeated sender tag + tightens spacing).
          const grouped = !showDate && !!older && older.senderId === item.senderId &&
            item.type !== 'system' && older.type !== 'system' &&
            Math.abs(new Date(item.createdAt).getTime() - new Date(older.createdAt).getTime()) < 5 * 60 * 1000;
          // Unread separator above the first message newer than the read boundary.
          const showUnread = !!unreadInfo && item.id > unreadInfo.boundaryId &&
            (!older || older.id <= unreadInfo.boundaryId);
          // Resolve once per row — this used to run twice (once for the target,
          // once inside an IIFE for its member), doubling the lookup per bubble.
          const replyTarget = resolveReply(item.replyToId);
          // Exit Kit: imported history carries negative ids, so the seam between
          // it and real crazzychat messages is exactly where the sign flips. Two
          // cases — the transition, and the top of a chat that is ALL imported
          // (nothing has been sent here yet), which has no transition to mark.
          const mine   = item.meta?.origin as string | undefined;
          const theirs = older?.meta?.origin as string | undefined;
          const importMark = !IMPORT_SOURCE[mine!] && IMPORT_SOURCE[theirs!] ? { origin: theirs!, atStart: false }
            : IMPORT_SOURCE[mine!] && !older ? { origin: mine!, atStart: true }
            : null;
          return (
          <View>
            {newerGapBeforeId === item.id && (
              <TouchableOpacity
                onPress={onStartReached}
                disabled={loadingNewer}
                accessibilityRole="button"
                accessibilityLabel="Load newer messages"
                style={{ alignSelf: 'center', marginVertical: 8, paddingHorizontal: 14, paddingVertical: 7,
                  borderRadius: 16, backgroundColor: colors.surfaceSolid }}
              >
                {loadingNewer
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>Load newer messages</Text>}
              </TouchableOpacity>
            )}
            {importMark && <ImportedDivider origin={importMark.origin} atStart={importMark.atStart} />}
            {showDate && <DateChip iso={item.createdAt} />}
            {showUnread && <UnreadDivider count={unreadInfo!.count} />}
            <SwipeToReply onReply={() => { if (!item.deletedAt && item.type !== 'system') setReplyTo(item); }}>
            <View style={item.id === flashId ? { backgroundColor: brandAlpha(0.18), borderRadius: 12 } : undefined}>
            {item._album ? (
              // Album: several media picked in one action, laid out in a
              // HORIZONTAL scroller inside this vertical list. Horizontal is
              // the only safe nesting direction — a vertical child would fight
              // the list for the pan gesture.
              //
              // Each tile is a full MemoBubble rather than a bespoke thumbnail:
              // encrypted media resolution, key handling, view-once, download
              // progress and retry already live there, and each tile owning its
              // own hooks is exactly what lets them resolve independently.
              // Duplicating that pipeline for a grid is how view-once or a
              // missing key quietly behaves differently in one place.
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                // The parent list keeps the vertical gesture; this keeps the
                // horizontal one, and taps still reach the tiles.
                directionalLockEnabled
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 6, paddingRight: 12 }}
              >
                {item._album.map((am) => (
                  <View key={am._tempId ?? String(am.id)} style={{ maxWidth: 260 }}>
                    <MemoBubble
                      msg={am}
                      meId={meId}
                      member={membersById.get(am.senderId)}
                      chatId={chatId}
                      otherMembers={otherMembers}
                      onLongPress={onLongPressMessage}
                      onJumpTo={jumpToMessage}
                      reactionsForMsg={mergedReactions[am.id]}
                      onToggleReaction={(emoji) => toggleReaction(am, emoji)}
                      replyTarget={null}
                      highlight={null}
                      tiltRevealed={tiltRevealed}
                      grouped
                      bubbleColors={bubbleColors}
                    />
                  </View>
                ))}
              </ScrollView>
            ) : (
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
              replyTarget={replyTarget}
              replyTargetMember={replyTarget ? membersById.get(replyTarget.senderId) : undefined}
              highlight={searchOpen && searchQ.trim().length > 0 ? searchQ.trim() : null}
              tiltRevealed={tiltRevealed}
              grouped={grouped}
              bubbleColors={bubbleColors}
              pollVotesForMsg={pollVotes[item.id]}
              onPollVoteChange={(next) => setPollVotes(prev => ({ ...prev, [item.id]: next }))}
            />
            )}
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
        onStartReached={onStartReached}
        onStartReachedThreshold={0.25}
        onScroll={onListScroll}
        scrollEventThrottle={32}
        ListFooterComponent={loadingOlder ? <ActivityIndicator color={colors.primary} style={{ paddingVertical: 12 }} /> : null}
        removeClippedSubviews
        // Tuned for heavy bubbles (media, reactions, replies): windowSize 11
        // keeps ~11 screens of rows MOUNTED, which is a lot of live components
        // to re-render on any parent state change. 7 still covers a fast fling
        // without blanking, and cuts mounted rows by roughly a third.
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={60}
        windowSize={7}
        initialNumToRender={12}
      />

      {/* Scroll-to-bottom FAB with new-message count (WhatsApp-style) */}
      {showScrollDown && (
        <TouchableOpacity
          style={S.scrollDownBtn}
          activeOpacity={0.85}
          onPress={() => {
            if (hasNewer) { void returnToLatest(); return; }
            try { listRef.current?.scrollToOffset({ offset: 0, animated: true }); } catch {}
            setNewSinceUp(0); setShowScrollDown(false); atBottomRef.current = true;
          }}
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

      {/* Live Chat Viewers (#58): who's viewing right now — tap for details.
          MOVED OUT OF THE HEADER. It sat under the title, where it pushed the
          header taller the moment anyone opened the chat — a header that grows
          when a second person looks at it is the worst place for it on a small
          screen. Down here it sits with the typing line, directly above the
          composer: both answer "what is the other person doing right now", and
          both belong next to where you are about to reply. */}
      {chatViewers.length > 0 && (
        <View style={S.typingBar}>
          <ViewerStack viewers={chatViewers} resolve={resolveViewer} />
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
          <TouchableOpacity hitSlop={10} onPress={() => { lpDismissedRef.current = composerLp.url; setComposerLp(null); }} accessibilityLabel="Remove link preview">
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
          <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={8} accessibilityLabel="Cancel reply">
            <Ionicons name="close" size={20} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      {/* Emoji panel (tap the 😊 icon) — inserts into the message input */}


      {/* Composer — either normal or recording mode */}
      {recording ? (
        <View style={[S.composer, S.recordingComposer]}>
          <View style={S.recordingDot} />
          <Text style={S.recordingTimer}>{formatRecDuration(recElapsedMs)}</Text>
          <Text style={S.recordingHint}>Slide to cancel · tap send</Text>
          <TouchableOpacity style={S.recCancelBtn} onPress={cancelRecording} activeOpacity={0.8} accessibilityLabel="Discard voice message">
            <Ionicons name="trash-outline" size={22} color={colors.danger} />
          </TouchableOpacity>
          <TouchableOpacity style={S.sendFab} onPress={stopAndSendRecording} activeOpacity={0.85} accessibilityLabel="Send voice message">
            <Ionicons name="send" size={20} color="#fff" style={{ marginLeft: 2 }} />
          </TouchableOpacity>
        </View>
      ) : (
        <GlassView kind="chrome" bordered={false} highlight style={S.composerGlass}>
        <View style={S.composer}>
          <View style={S.inputPill}>
            {editingId == null && (
              <TouchableOpacity
                style={S.pillIconBtn}
                onPress={() => { Keyboard.dismiss(); setGifOpen(true); }} accessibilityLabel="Stickers, emoji and GIFs"
                activeOpacity={0.7}
                hitSlop={6}
              >
                {/* ONE button for stickers, emojis and GIFs — they are three
                    tabs of the same KLIPY sheet (/gif/search?type=…), so there
                    is nothing to merge and nothing to duplicate. A sticker
                    glyph rather than a smiley because it opens ON stickers. */}
                <MaterialCommunityIcons
                  name={gifOpen ? 'sticker' : 'sticker-emoji'}
                  size={24}
                  color={gifOpen ? colors.primary : colors.textDim}
                />
              </TouchableOpacity>
            )}
            <TextInput
              style={[S.input, { maxHeight: composerMax }]}
              placeholder={editingId != null ? 'Edit message…' : 'Message'}
              placeholderTextColor={colors.textDim}
              value={input}
              onChangeText={onInputChange}
              multiline
              maxLength={4000}
            />
            {editingId == null && (
              <>
                <TouchableOpacity
                  style={S.pillIconBtn}
                  onPress={onPressAttach} accessibilityLabel="Attach"
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
              onPress={startRecording} accessibilityLabel="Record a voice message"
              disabled={sending}
              activeOpacity={0.85}
            >
              <Ionicons name="mic" size={23} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[S.sendFab, (!input.trim() || sending) && S.sendBtnOff]}
              onPress={() => onSend(false)} accessibilityLabel="Send"
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
        </GlassView>
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
                  <Avatar uri={m.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null} headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined} name={m.name || m.email || '?'} size={36} ring />
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
                  <TouchableOpacity style={S.photoActionBtn} onPress={() => { setPhotoViewer(false); const p = directPeer(); if (p) router.push({ pathname: '/voicecall' as any, params: { chatId, peerUid: p.userId, peerName: p.name || p.email || title } }); }}>
                    <Ionicons name="call" size={22} color={colors.primary} />
                    <Text style={S.photoActionTxt}>Audio</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.photoActionBtn} onPress={() => { setPhotoViewer(false); const p = directPeer(); if (p) router.push({ pathname: '/videocall' as any, params: { chatId, peerUid: p.userId, peerName: p.name || p.email || title } }); }}>
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
      <GifPicker visible={gifOpen} initialTab="stickers" onClose={() => setGifOpen(false)} onSelect={sendGif} />

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
        {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-18): behavior
            'padding' is measured against the ACTIVITY, and a React Native
            <Modal> is its own Android window that never receives the
            manifest's adjustResize — so the keyboard covered the caption
            field and the send button outright. keyboardOnly: the send row
            below already applies its own bottom inset. */}
        <KeyboardSafe
          keyboardOnly
          style={{ flex: 1, backgroundColor: colors.bg }}
        >
          {(() => {
            const cur = pendingItems[currentIdx];
            if (!cur) return null;
            const multi = pendingItems.length > 1;
            return (
              <>
                <TouchableOpacity
                  onPress={() => setPendingItems([])} accessibilityLabel="Discard all attachments"
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
                  {cur.mediaType === 'file' ? (
                    <View style={{ alignItems: 'center', gap: 12, paddingHorizontal: 32 }}>
                      <View style={{ width: 96, height: 96, borderRadius: 24, backgroundColor: BRAND_ACCENT + '22', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="document-text" size={44} color={colors.primary} />
                      </View>
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center' }} numberOfLines={2}>{cur.filename}</Text>
                      <Text style={{ color: colors.textDim, fontSize: 13 }}>Scanned document</Text>
                    </View>
                  ) : cur.mediaType === 'image' ? (
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
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 76, backgroundColor: colors.bg }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 10, gap: 8, paddingVertical: 8 }}>
                    {pendingItems.map((it, i) => (
                      <TouchableOpacity key={`${it.uri}-${i}`} activeOpacity={0.8} onPress={() => setCurrentIdx(i)}
                        style={{ width: 56, height: 56, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: i === currentIdx ? colors.primary : 'transparent' }}>
                        {it.mediaType === 'file'
                          ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceSolid }}>
                              <Ionicons name="document-text" size={22} color="#fff" />
                            </View>
                          : <Image source={{ uri: it.uri }} style={{ width: '100%', height: '100%' }} />}
                        <TouchableOpacity onPress={() => removePendingAt(i)} hitSlop={6} accessibilityLabel="Remove this attachment"
                          style={{ position: 'absolute', top: 1, right: 1, width: 18, height: 18, borderRadius: 9, backgroundColor: '#000000aa', alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name="close" size={12} color="#fff" />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity onPress={addMorePhotos} accessibilityLabel="Add more photos" style={{ width: 56, height: 56, borderRadius: 8, borderWidth: 1, borderColor: colors.glassStroke, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="add" size={26} color="#fff" />
                    </TouchableOpacity>
                  </ScrollView>
                )}

                <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, paddingBottom: Platform.OS === 'ios' ? 28 : 14, backgroundColor: colors.bg }}>
                  {/* Per-item view-once toggle (WhatsApp "1-in-a-circle") */}
                  <TouchableOpacity
                    onPress={() => updateCurrentItem({ viewOnce: !cur.viewOnce })}
                    disabled={cur.mediaType === 'file'}
                    style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: cur.viewOnce ? colors.primary : '#1F2937', alignItems: 'center', justifyContent: 'center', opacity: cur.mediaType === 'file' ? 0.4 : 1 }}
                    hitSlop={6}
                  >
                    <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.glassStroke, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>1</Text>
                    </View>
                  </TouchableOpacity>
                  <TextInput
                    value={cur.caption}
                    onChangeText={(t) => updateCurrentItem({ caption: t })}
                    placeholder={multi ? 'Add a caption…' : 'Add a caption…'}
                    placeholderTextColor="#9CA3AF"
                    multiline
                    style={{ flex: 1, color: '#fff', backgroundColor: colors.surfaceSolid, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 16 }}
                  />
                  <TouchableOpacity
                    onPress={confirmSendPendingMedia}
                    disabled={sending}
                    style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.6 : 1 }}
                  >
                    {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={22} color="#fff" />}
                    {multi && !sending && (
                      <View style={{ position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: colors.glassStroke }}>
                        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{pendingItems.length}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            );
          })()}
        </KeyboardSafe>
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
            {/* AUDIT F10. Shown only for a message that has already travelled
                far — a warning on every forward is noise that trains people to
                dismiss it unread. The picker is single-select, so the "one chat
                at a time" rule it states is already true; saying it out loud is
                what makes the next hop deliberate rather than reflexive. */}
            {forwardMsg && forwardNotice(forwardMsg.meta) && (
              <Text style={S.forwardManyNotice}>{forwardNotice(forwardMsg.meta)}</Text>
            )}
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

      {/* Per-chat lock gate. The condition is "not proven OPEN", never "known
          locked": while the lock is still being read, and when reading it failed,
          the veil is up. The `&& lockInfo` that used to be here is exactly what
          rendered the chat in full when getLock threw. */}
      {lockState !== 'open' && (
        <View style={S.lockGate}>
          {lockState === 'locked' && (<>
          <Ionicons name="lock-closed" size={56} color={colors.primary} />
          <Text style={S.lockGateTitle}>Chat locked</Text>
          <Text style={S.lockGateSub}>{lockInfo?.chatName ?? 'This chat could not be unlocked'}</Text>

          {/* 'both' has to SAY it needs both, or a user whose fingerprint just
              passed and who is still looking at a veil concludes the app is
              broken. The biometric button stays tappable either way so a failed
              scan can be retried. */}
          {lockInfo?.lockMethod === 'both' && (
            <Text style={S.lockGateSub}>
              {lockBio
                ? 'Biometrics verified — now enter this chat’s PIN.'
                : 'This chat needs both biometrics and its PIN.'}
            </Text>
          )}

          {(lockInfo?.lockMethod === 'biometric' || lockInfo?.lockMethod === 'both') && (
            <TouchableOpacity
              style={S.lockGateBtn}
              accessibilityRole="button"
              accessibilityLabel={lockBio ? 'Biometrics verified, scan again' : 'Use biometrics'}
              onPress={async () => {
                if (!(await verifyBiometric('Unlock chat'))) return;
                setLockBio(true);
                if (lockInfo?.lockMethod !== 'both') setLockState('open');
              }}
            >
              <Ionicons name={lockBio ? 'checkmark-circle' : 'finger-print'} size={18} color="#fff" />
              <Text style={S.lockGateBtnTxt}>{lockBio ? 'Biometrics verified' : 'Use biometrics'}</Text>
            </TouchableOpacity>
          )}

          {(lockInfo?.lockMethod === 'pin' || lockInfo?.lockMethod === 'both') && (
            <View style={{ width: '100%', maxWidth: 280, marginTop: 18 }}>
              <TextInput
                style={S.lockGateInput}
                value={lockPin}
                onChangeText={(t) => { setLockPin(t); setLockErr(null); }}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={8}
                placeholder="Enter PIN"
                placeholderTextColor={colors.textFaint}
                onSubmitEditing={submitLockPin}
              />
              {!!lockErr && <Text style={S.lockGateErr}>{lockErr}</Text>}
              <TouchableOpacity style={[S.lockGateBtn, { marginTop: 12 }]} onPress={submitLockPin}>
                <Text style={S.lockGateBtnTxt}>Unlock</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity style={{ marginTop: 20 }} onPress={() => router.replace('/(tabs)/chats' as any)}>
            <Text style={S.lockGateBack}>Back to chats</Text>
          </TouchableOpacity>
          </>)}
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
