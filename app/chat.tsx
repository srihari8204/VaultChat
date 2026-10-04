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

import { useKeyboardInset } from '../lib/useKeyboardInset';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as ScreenCapture from 'expo-screen-capture';
import { setSecure } from '../lib/screenGuard';
import { recordScreenshotAttempt } from '../services/security/auditChain';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { E2EE_ENABLED } from '../constants/flags';
import { getCachedMessages, getPendingEncryptedMessages, hasCachedOlderMessages, cacheMessages, applyMessage, getCachedMessagesByIds, getCachedChat } from '../lib/localDb';
import { groupAlbums } from '../lib/albumGrouping';
import { mergeReactions } from '../lib/reactionMerge';
import { saveDraft, getDraft, clearDraft } from '../lib/drafts';
import { playSent, playReceived } from '../lib/sounds';
import { clearMessageNotifications } from '../lib/CallService';
import {
  AppState,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  Platform,
  StyleSheet,
  Text, TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Sheet, AuroraBackground, type SheetAction as MenuAction } from '../components/ui';
import { useChatViewers } from '../hooks/useChatViewers';
import { MentionPicker, ComposerBars } from '../components/chat/ComposerBars';
import { Composer } from '../components/chat/Composer';
import { MediaCaptionPreview } from '../components/chat/MediaCaptionPreview';
import { ChatLockGate } from '../components/chat/ChatLockGate';
import { useChatMenu } from '../components/chat/useChatMenu';
import { useMessageActions } from '../components/chat/useMessageActions';
import { useMessagePaging, INITIAL_PAGE_SIZE } from '../components/chat/useMessagePaging';
import { useVoiceRecording } from '../components/chat/useVoiceRecording';
import { useTiltReveal } from '../components/chat/useTiltReveal';
import { useMediaStaging } from '../components/chat/useMediaStaging';
import { MessageInfoModal, ProfilePhotoModal, AttachMenu, ForwardPicker } from '../components/chat/ChatModals';
import { ChatHeader } from '../components/chat/ChatHeader';
import { MessageRow } from '../components/chat/MessageRow';
import { InChatSearchBar } from '../components/chat/InChatSearchBar';
import { ErrorBar, KeyChangeBanner, ScreenshotBanner, MemoryBanner, LiveLocationBanner, PinnedBar } from '../components/chat/ChatBanners';
import { getShareViewing } from '../lib/viewerPrefs';
import type { ViewerActivity } from '../lib/socket';
import { extractFirstUrl, fetchPreviewFromDevice, type LinkPreviewData } from '../lib/linkPreview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GifPicker from '../components/GifPicker';
import { LinearGradient } from 'expo-linear-gradient';
import { getWallpaper, type WallpaperConfig } from './chat-wallpaper';
import { getBubbleColors } from './chat-themes';
import { getLock, pinRetryAfterMs, verifyBiometric, verifyPin, type LockedChat } from '../lib/chatLock';
import { permissionDenied } from '../lib/permissionDenied';
import { preloadViewedOnce } from '../lib/viewOnceStore';
import { preloadRevoked, wipeRevokedMedia } from '../lib/protectedMedia';

import { useTheme } from '../lib/theme';
import { useVisionComfort } from '../lib/visionComfort';
import { getCurrentUserAsync } from './(constants)/authService';

import { MessageActionSheet } from '../components/MessageActionSheet';
import { getAccessToken } from '../lib/api';
import { getLiveKey, clearLiveKey, decryptPosition } from '../lib/liveLocationCrypto';
import { openNavigator } from '../lib/nav/openNavigation';
import {
  attachmentUrl,
  getPollVotesBulk,
  type PollVoteSummary,
  getChat,
  getMessages,
  hydrateMessages,
  looksEncrypted,
  listChats,
  listStoriesFeed,
  pinMessage,
  reportScreenshotCaptured,
  persistMessageDeletion,
  type ChatDetail,
  type ChatMember,
  type ChatSummary,
  type Message,
  type ReactionSummary,
  normalizeMsgIds,
} from '../lib/chatService';
import { markReadDurable, markDeliveredDurable } from '../lib/receipts';
import { forwardPayload } from '../lib/forwardPayload';
import { type MediaType } from '../lib/sendMedia';
import { enqueueMedia, cancelMedia, retryMedia, pendingForChat as mediaPendingForChat, on as onMediaOutbox } from '../lib/mediaOutbox';
import ConnectionBanner from '../components/ConnectionBanner';
import { startSend as vbStartSend } from '../lib/vaultBeamController';
import { isNativeStreamAvailable as vbNativeAvailable } from '../lib/vaultBeamStreamNative';
import { makeThumb } from '../lib/thumbnails';
import { isFamEvent } from '../lib/family/alerts';
import { NOTE_PREFIX } from '../lib/groups/notes';
import { TASK_PREFIX } from '../lib/groups/tasks';
import {
  cancel as queueCancel,
  enqueueText,
  enqueueMessage,
  enqueueReaction,
  enqueueEdit,
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
} from '../lib/socket';
import { useS, type DisplayMessage } from '../components/chat/chatStyles';
import { bumpPollVote } from '../components/chat/chatFormat';

// Fire-and-forget haptic (no-op on web / if unavailable).
const haptic = (style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) => {
  if (Platform.OS !== 'web') Haptics.impactAsync(style).catch(() => {});
};

const TYPING_IDLE_MS = 2500;

// Module scope on purpose: the top-up below runs on every chat focus and every
// foreground, and catchUp() is a network round trip even when it returns
// nothing. Opening six chats in a row should not be six delta requests. The
// cache re-read it guards is local and always runs, so a throttled tick still
// picks up whatever a previous catch-up wrote.
const TOPUP_MIN_GAP_MS = 5000;
let lastTopUpAt = 0;

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
  // COMPACT MEANS THE SPLIT-VIEW PANE, NOT "a phone".
  //
  // This was `embedded || windowWidth < 520`. 520dp is wider than essentially
  // every handset in portrait — a Pixel 8 is 412, an iPhone 15 Pro Max 430 —
  // so it was true on ALL of them, and the two things it gates are Voice and
  // Video. The chat header on a real phone quietly lost the app's two most
  // used actions to the overflow menu while an always-rendered eye toggle took
  // their place. WhatsApp puts video and call in the header on every phone;
  // that is the bar.
  //
  // The width test existed to make room for a fourth trailing icon. The header
  // is specced for three (video, call, overflow) — see the note on Search in
  // onPressMenu, which is the same crowding, solved the same way — so the
  // fourth icon moves to the menu instead and the calls come back.
  const compactHeader = embedded;
  const { activeProfile, setActiveProfile } = useVisionComfort();
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
      // Group notes/tasks ops ride the message spine as an event log; they
      // render in group-notes / group-tasks, never as bubbles.
      if (typeof m.content === 'string'
        && (m.content.startsWith(NOTE_PREFIX) || m.content.startsWith(TASK_PREFIX))) continue;
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
  // Bumped by the error bar's Retry to re-run the initial load effect.
  const [loadNonce, setLoadNonce] = useState(0);
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
  // Embedded (split pane) only: set when Leave / Hide / Clear ended this chat
  // for the user. A pane cannot navigate away (useChatMenu onPaneEnded), so it
  // says what happened instead of going on showing the chat.
  const [paneNotice, setPaneNotice] = useState<string | null>(null);

  // @mentions (groups): active typed query (null = none) + recorded picks.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionsRef = useRef<{ name: string; userId: string }[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);


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

  // ── Per-chat lock state (the gate itself is further down) ──
  // Three states, not a boolean (2026-09-17). A boolean cannot say "we do not
  // know yet", and BOTH of its defaults are wrong: `true` painted a locked
  // chat's messages until getLock answered — and FOREVER if getLock threw,
  // because the overlay needed both !lockOpen AND lockInfo and a throw set
  // neither; `false` would flash a padlock over every unlocked chat. 'checking'
  // shows the bare veil: no messages, no padlock, and nothing opens until the
  // lock is known.
  const [lockState, setLockState] = useState<'checking' | 'open' | 'locked'>('checking');
  // While the gate covers the chat the user has not seen it, so nothing may
  // tell the other side they have: no read receipt, no "viewing" presence and
  // no clearing of its notifications. Assigned during render (not in an
  // effect) so the read effect's cleanup — which flushes a pending read — sees
  // the re-veil of a refocus in the same commit that caused it.
  const lockOpenRef = useRef(false);
  lockOpenRef.current = lockState === 'open';

  // ── Live Chat Viewers (feature #58) — who's viewing this chat right now ──
  const [cvFocused, setCvFocused] = useState(false);
  const chatFocusedRef = useRef(false);
  const [cvShareOn, setCvShareOn] = useState(false);
  // Focus toggles emission on/off and re-reads the per-chat toggle (so a change
  // made in chat-info takes effect the moment you return).
  // Keyed on the TYPE, not the chat object: presence and receipt events replace
  // `chat` constantly, and re-running this would blink focus off and on.
  const chatType = chat?.type;
  useFocusEffect(useCallback(() => {
    chatFocusedRef.current = true;
    setCvFocused(true);
    if (chatId && chatType) getShareViewing(chatId, chatType !== 'direct').then(setCvShareOn).catch(() => {});
    return () => { chatFocusedRef.current = false; setCvFocused(false); };
  }, [chatId, chatType]));
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
  const chatViewers = useChatViewers({ chatId, meId, enabled: cvShareOn && lockState === 'open', focused: cvFocused, activity: myViewerActivity });

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
    setPaneNotice(null);
    mentionsRef.current = [];   // a mention picked in one chat must not ride a send in another
  }, [chatId]);

  // Clear this chat's native message notification + unread counter (F2 —
  // the content-free doorbell posts per-chat notifications tagged by chatId).
  // Not while a chat lock still covers it (see lockOpenRef).
  useEffect(() => {
    if (lockState === 'open') clearMessageNotifications(chatId);
  }, [chatId, lockState]);

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
          // meta too: a queued GIF card is nothing but meta, and a text keeps
          // its ink / mentions / link preview across the restart.
          id: 0, chatId: q.chatId, senderId: myId ?? '', type: q.type, content: q.plaintext,
          meta: q.meta ?? null, replyToId: q.replyToId, editedAt: null, deletedAt: null,
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
  }, [chatId, loadNonce]);

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
    let off: (() => void)[] = [];
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
  }, [chatId, pollIdKey]);

  // ── Mark-as-read (debounced) ──────────────────────────────
  useEffect(() => {
    // A durable cache write earns ✓✓. Blue ✓✓ must mean the recipient was
    // actually looking at this thread, so never mark read from a backgrounded
    // or covered chat screen.
    if (!appActive || !cvFocused || lockState !== 'open' || !meId || !chatId || messages.length === 0) return;
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
      if (AppState.currentState !== 'active' || !chatFocusedRef.current || !lockOpenRef.current) return;
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
      // A re-veiled lock is different: that is not "leaving after reading".
      if (!lockOpenRef.current || !latestId || latestId <= lastReadSent.current) return;
      lastReadSent.current = latestId;
      markReadDurable(chatId, latestId, meId)
        .then(() => import('../lib/messageNotifications'))
        .then(m => m.markSeen(chatId, latestId))
        .catch(() => { if (lastReadSent.current === latestId) lastReadSent.current = 0; });
    };
  }, [appActive, cvFocused, lockState, meId, chatId, messages]);

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
    const mm = text.match(/(?:^|\s)@([\p{L}\p{N}_]{0,30})$/u);
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
  }, [chatId, meId, stopTypingIfActive, chat?.type]);

  // Insert a picked @mention: replace the trailing "@query" with "@Name ".
  const pickMention = useCallback((mem: ChatMember) => {
    const name = (mem.name || mem.email || 'member').split(' ')[0];
    setInput(prev => prev.replace(/@([\p{L}\p{N}_]{0,30})$/u, `@${name} `));
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
    // Set once the optimistic edit is applied, so the catch can undo it when
    // enqueueEdit itself throws (the queue's 'failed' rollback never runs then).
    let undoEdit: (() => void) | null = null;
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
        undoEdit = () => {
          if (before) setMessages(prev => prev.map(x => x.id === editId
            ? { ...x, content: before.content, editedAt: before.editedAt } : x));
          setEditingId(editId);
          setInput(text);
        };
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
      undoEdit?.();
      Alert.alert(editingId != null ? 'Edit failed' : 'Send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [input, sending, chatId, editingId, meId, replyTo, nextInvisibleInk, composerLp, stopTypingIfActive]);

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
  }, []);

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

  // Build the action-sheet tiles for a message — reuses the existing handlers.
  const buildSheetActions = useMessageActions({
    meId, chatId, router, pinnedId, setPinnedId, openForward, setReplyTo, setInfoMsg, setEditingId, setInput, setMessages,
  });

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

  // Primitives, so the effect below re-arms only when the policy (or the chat's
  // arrival) changes — not on every presence/receipt update of `chat`.
  const hasChat = !!chat;
  const peerBlocksCapture = chat?.peerBlocksCapture;
  const peerWantsCaptureNotice = chat?.peerWantsCaptureNotice;
  // Read at capture time: the listener outlives the render that armed it.
  const titleRef = useRef('…');
  useEffect(() => {
    if (Platform.OS === 'web' || !hasChat) return;
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
    const peerBlocks = peerBlocksCapture ?? true;
    const peerNotify = peerWantsCaptureNotice ?? true;
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
          // Claim "notified" only once the report has actually landed.
          reportScreenshotCaptured(chatId)
            .then(() => { if (peerNotify) Alert.alert('Screenshot captured', 'The other side has been notified.'); })
            .catch((e) => {
              console.warn('[screenshot] report failed:', e?.message);
              if (peerNotify) Alert.alert('Screenshot captured', 'The other side could not be notified right now.');
            });
          // Record the capture in the on-device tamper-evident audit chain so it
          // surfaces in the Alerts tab (#41). Real local event — the inbound
          // "someone captured your content" alert is delivered separately (W7).
          recordScreenshotAttempt({ chatId, chatName: titleRef.current }).catch(() => {});
        });
      } catch { /* listener unsupported on some platforms — non-fatal */ }
    }

    return () => {
      sub?.remove();
      // Restore the global-block posture (matches _layout.tsx default)
      setSecure(true).catch(() => {});
    };
  }, [hasChat, peerBlocksCapture, peerWantsCaptureNotice, chatId]);

  // Auto-dismiss the inbound screenshot banner after 4 seconds.
  useEffect(() => {
    if (!screenshotBanner) return;
    const t = setTimeout(() => setScreenshotBanner(null), 4000);
    return () => clearTimeout(t);
  }, [screenshotBanner]);

  // ── Chat-level overflow menu (⋮) and its pickers ──
  const onPressMenu = useChatMenu({
    chat, setChat, chatId, meId, router, compactHeader, embedded, activeProfile, setActiveProfile,
    setOverflowMenu, setSearchOpen, setMessages, onPaneEnded: embedded ? setPaneNotice : undefined,
  });

  // ── React / Reply / Forward handlers ──────────────────────
  const toggleReaction = useCallback(async (msg: DisplayMessage, emoji: string) => {
    haptic();
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

  const doForward = useCallback(async (target: ChatSummary) => {
    if (!forwardMsg) return;
    const m = forwardMsg;
    setForwardMsg(null);
    try {
      // Through the outbox (durable offline, same E2EE path as text). The rules
      // forwardMessage applied — no protected content, no local path, the hop
      // count — live in forwardPayload. The pending bubble is in the TARGET
      // chat, so it shows there (pendingForChat) rather than here.
      const p = forwardPayload({
        id: m.id, chatId: m.chatId, senderId: m.senderId, type: m.type,
        content: m.content, meta: m.meta,
      });
      await enqueueMessage(target.id, { type: p.type as DisplayMessage['type'], plaintext: p.plaintext, meta: p.meta });
    } catch (e: any) {
      Alert.alert('Forward failed', e?.message ?? 'Try again');
    }
  }, [forwardMsg]);

  const onCancelEdit = useCallback(() => {
    setEditingId(null);
    setInput('');
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

  // ── Voice message: start / stop / cancel / send ──
  const { recording, recElapsedMs, startRecording, cancelRecording, stopAndSendRecording } = useVoiceRecording({
    sending, setSending, editingId, enqueueMediaOptimistic,
  });

  // ── Invisible Ink: tilt-to-reveal ──
  const tiltRevealed = useTiltReveal(messages);

  // ── Staged media: gallery picks, captures handed back, the caption preview ──
  const {
    pendingItems, setPendingItems, currentIdx, setCurrentIdx,
    onPickMedia, confirmSendPendingMedia, updateCurrentItem, removePendingAt, addMorePhotos,
  } = useMediaStaging({ sending, enqueueMediaOptimistic, params, router });

  // ── Composer camera button: tap = camera, slide up = video note ──────
  // (WhatsApp-style. startMode='note' makes /camera open in round-video mode.)
  const openCamera = useCallback((startMode?: 'note') => {
    if (sending) return;
    Keyboard.dismiss();
    const peerName = (chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId)?.name : chat?.name) || '';
    router.push({ pathname: '/camera', params: { chatId, peerName, returnTo: '/chat', ...(startMode ? { startMode } : {}) } });
  }, [sending, chat, meId, chatId, router]);
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
  }, [sending, enqueueMediaOptimistic]);

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
    const peer = chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId) : null;
    router.push({ pathname: '/image-editor', params: {
      uri: result.assets[0].uri, chatId, returnTo: '/chat',
      peerUid: peer?.userId || '', peerName: peer?.name || chat?.name || '',
    } });
  }, [chatId, sending, router, chat, meId]);

  // ── Send a GIF (external KLIPY URL — no upload; rendered from the URL) ──
  // Through the outbox like text: a pending bubble now, durable retry offline,
  // and the 'sent'/'failed' queue events above swap or mark it.
  const sendGif = useCallback(async (url: string, preview: string) => {
    setGifOpen(false);
    if (!url) return;
    // source marks WHERE this came from, so the bubble can show KLIPY's
    // watermark on KLIPY content and only on KLIPY content. Messages sent
    // before the switch came from GIPHY and carry no source — stamping those
    // with KLIPY's mark would misattribute someone else's library.
    const meta = { gifUrl: url, preview, source: 'klipy' };
    try {
      const q = await enqueueMessage(chatId, { type: 'image', meta });
      const optimistic: DisplayMessage = {
        id: 0, chatId, senderId: meId ?? '', type: 'image', content: '', meta,
        replyToId: null, editedAt: null, deletedAt: null,
        createdAt: new Date().toISOString(), _tempId: q.tempId, _state: 'pending',
      };
      setMessages(prev => [optimistic, ...prev]);
    } catch (e: any) {
      Alert.alert('Could not send GIF', e?.message ?? 'Try again');
    }
  }, [chatId, meId]);

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
      { label: 'Camera',        icon: 'camera' as const, onPress: () => router.push({ pathname: '/camera', params: { chatId, peerName, returnTo: '/chat' } }) },
      { label: 'Gallery',       icon: 'image' as const, onPress: () => onPickMedia('images') },
      { label: 'Video',         icon: 'videocam' as const, onPress: () => onPickMedia('videos') },
      // View once was reachable only from the camera toggle and the send-preview
      // eye button — never from the attach sheet, so the app's headline privacy
      // affordance was effectively undiscoverable from the main entry point.
      { label: 'View once',     icon: 'eye-off' as const, onPress: () => onPickMedia('images', { viewOnce: true }) },
      { label: 'Edit photo',    icon: 'create' as const, onPress: onEditPhoto },
      { label: 'File',          icon: 'document' as const, onPress: onPickFile },
      // VaultBeam large-file transfer (up to 12 GB, R2 relay) — 1:1 only.
      ...(isDirect ? [{ label: 'Big File', icon: 'cube' as const, onPress: onSendVaultBeam }] : []),
      { label: 'Scan',          icon: 'scan' as const, onPress: () => router.push({ pathname: '/camera', params: { chatId, peerName, returnTo: '/chat', startMode: 'scan' } }) },
      { label: 'Location',      icon: 'location' as const, onPress: () => router.push({ pathname: '/location', params: { chatId, name: peerName } }) },
      { label: 'Navigate',      icon: 'navigate' as const, onPress: () => openNavigator() },
      { label: 'Poll',          icon: 'stats-chart' as const, onPress: () => router.push({ pathname: '/create-poll', params: { chatId, peerName } }) },
      // Whiteboard: returns the drawing to this chat through the same
      // capturedUri contract as /image-editor, so it needs the same params.
      { label: 'Whiteboard',    icon: 'brush' as const, onPress: () => {
        const peer = chat?.type === 'direct' && meId ? chat.members.find(m => m.userId !== meId) : null;
        router.push({ pathname: '/whiteboard', params: {
          chatId, returnTo: '/chat', peerUid: peer?.userId || '', peerName: peer?.name || chat?.name || '',
        } });
      } },
      { label: nextInvisibleInk ? 'Ink: armed' : 'Invisible Ink', icon: 'sparkles' as const, onPress: () => setNextInvisibleInk(v => !v) },
    ];
  }, [onPickMedia, onPickFile, onEditPhoto, onSendVaultBeam, router, chatId, chat, meId, nextInvisibleInk]);

  // ── Paging, the in-memory window and jump-to-message ──
  const { onEndReached, onStartReached, returnToLatest, jumpToMessage } = useMessagePaging({
    chatId, chatIdRef, loading, messages, setMessages, messagesRef, hasMore, setHasMore, hasNewer, setHasNewer,
    setNewerGapBeforeId, setLoadingOlder, setLoadingNewer, pagingChatRef, prefetchedChatRef, atBottomRef,
    setShowScrollDown, setNewSinceUp, setFlashId, listRef,
  });

  // Search stepping: the row is already loaded, so scroll straight to it and
  // flash it like a jump does.
  const goToRow = useCallback((row: DisplayMessage) => {
    const at = renderMessages.indexOf(row);
    if (at < 0) return;
    try { listRef.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.5 }); } catch {}
    setFlashId(row.id);
    setTimeout(() => setFlashId(id => (id === row.id ? null : id)), 2500);
  }, [renderMessages]);

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
  // lockState is declared near the top of the component: the read-receipt,
  // viewer-presence and notification-clear effects all gate on it.
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
    if (!lockInfo) return;
    if (!verifyPin(lockInfo, lockPin)) {
      // verifyPin also returns false, unchecked, while a wrong-PIN backoff runs.
      const wait = pinRetryAfterMs(lockInfo);
      setLockPin('');
      setLockErr(wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` : 'Incorrect PIN');
      return;
    }
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
  titleRef.current = title;

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
          router.push({ pathname: '/story-viewer', params: { userId: peer.userId, userName: peer.name || peer.email || title } });
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
      router.push({ pathname: '/group-info', params: { id: chatId } });
      return;
    }
    const peer = directPeer();
    if (!peer) return;
    router.push({ pathname: '/contact-info', params: { chatId, peerUid: peer.userId, peerName: peer.name || peer.email || 'crazzychat user' } });
  }, [chat, chatId, directPeer, router]);

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
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: colors.primary }}
        >
          <Text style={{ color: colors.onPrimary, fontWeight: '700' }}>Back to chats</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // The chat is hidden from screen readers while something covers it: the lock
  // veil, or the GIF sheet — an absolute overlay, not a Modal, so on Android
  // TalkBack would otherwise walk the conversation behind it.
  const behindA11y = lockState !== 'open' || gifOpen;

  if (embedded && paneNotice) {
    return (
      <View style={[S.screen, S.center, { padding: 24, gap: 10 }]}>
        <Ionicons name="checkmark-circle-outline" size={40} color={colors.textDim} />
        <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' }}>
          {paneNotice}
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
          Use Swap or Close in the split bar to continue.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={colors.primary} size="large" accessibilityLabel="Loading chat" />
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

      {/* Header, search and banners. Hidden from screen readers while the lock
          veil is up, like the list and composer below: on Android TalkBack still
          walks the veil's siblings, and ⋮ / Search here act on the locked chat. */}
      <View
        importantForAccessibility={behindA11y ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={behindA11y}
      >
      {/* Header — glass, so the thread scrolls visibly beneath it */}
      <ChatHeader
        embedded={embedded}
        compactHeader={compactHeader}
        chat={chat}
        meId={meId}
        chatId={chatId}
        title={title}
        headerPhotoId={headerPhotoId}
        screenAuthHeader={screenAuthHeader}
        onAvatarTap={onAvatarTap}
        openProfile={openProfile}
        onPressMenu={onPressMenu}
      />

      {/* Connectivity strip (Connecting… / Waiting for network) — local-first:
          the message list below never changes when this appears. */}
      <ConnectionBanner />

      {/* In-chat search bar (Day 13) */}
      {searchOpen && (
        <InChatSearchBar
          renderMessages={renderMessages}
          searchQ={searchQ}
          setSearchQ={setSearchQ}
          onClose={() => { setSearchOpen(false); setSearchQ(''); }}
          onGoTo={goToRow}
          onSearchAll={() => router.push({ pathname: '/in-chat-search', params: { chatId } })}
        />
      )}

      {error && <ErrorBar error={error} onRetry={() => { setError(null); setLoadNonce(n => n + 1); }} />}

      <KeyChangeBanner otherMembers={otherMembers} chatName={chat?.name} />

      {screenshotBanner && <ScreenshotBanner by={screenshotBanner.by} membersById={membersById} />}

      <MemoryBanner messages={messages} membersById={membersById} visible={lockState === 'open'} />

      {liveLoc && <LiveLocationBanner liveLoc={liveLoc} membersById={membersById} onHide={() => setLiveLoc(null)} />}

      {pinnedId && lockState === 'open' && (
        <PinnedBar
          pinnedId={pinnedId}
          messages={messages}
          onJump={() => jumpToMessage(Number(pinnedId))}
          onUnpin={async () => {
            // OPTIMISTIC, AND IT PUTS THE PIN BACK IF THE SERVER REFUSES.
            //
            // This used to be `try { await pinMessage(chatId, null) } catch {}`:
            // the bar vanished, the server kept pinnedMessageId, and the next
            // sync (see setPinnedId(cc.pinnedMessageId) where the cached chat
            // loads) made the pin reappear with no explanation. The same
            // mutation in the message action sheet already alerts on failure,
            // so the silence here was an oversight rather than a policy.
            const prev = pinnedId;
            setPinnedId(null);
            try { await pinMessage(chatId, null); }
            catch (e: any) { setPinnedId(prev); Alert.alert('Could not unpin', e?.message ?? 'Try again'); }
          }}
        />
      )}
      </View>

      {/* Messages (inverted — newest at top of the array, visually at bottom).
          Hidden from screen readers until the lock veil is lifted. The rows stay
          mounted on purpose: a pending jump (search result, bookmark) consumed
          while the chat is still veiled needs them to scroll to. */}
      <FlatList
        ref={listRef}
        data={renderMessages}
        importantForAccessibility={behindA11y ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={behindA11y}
        keyExtractor={(m) => m._tempId ?? String(m.id)}
        inverted
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 }}
        renderItem={({ item, index }) => (
          <MessageRow
            item={item}
            // Index into renderMessages, NOT messages — renderMessages drops
            // reaction rows and duplicates, so the two diverge as soon as anyone
            // reacts (date chips, sender grouping and the unread divider).
            older={renderMessages[index + 1]}
            unreadInfo={unreadInfo}
            newerGapBeforeId={newerGapBeforeId}
            loadingNewer={loadingNewer}
            onStartReached={onStartReached}
            flashId={flashId}
            resolveReply={resolveReply}
            membersById={membersById}
            meId={meId}
            chatId={chatId}
            otherMembers={otherMembers}
            onLongPressMessage={onLongPressMessage}
            jumpToMessage={jumpToMessage}
            mergedReactions={mergedReactions}
            toggleReaction={toggleReaction}
            highlight={searchOpen && searchQ.trim().length > 0 ? searchQ.trim() : null}
            tiltRevealed={tiltRevealed}
            bubbleColors={bubbleColors}
            pollVotesForMsg={pollVotes[item.id]}
            onPollVoteChange={(id, next) => setPollVotes(prev => ({ ...prev, [id]: next }))}
            onReply={setReplyTo}
          />
        )}
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
          accessibilityRole="button"
          accessibilityLabel={newSinceUp > 0 ? `Scroll to latest, ${newSinceUp} new` : 'Scroll to latest'}
          importantForAccessibility={behindA11y ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={behindA11y}
        >
          <Ionicons name="chevron-down" size={24} color={colors.text} />
          {newSinceUp > 0 && (
            <View style={S.scrollDownBadge}><Text style={S.scrollDownBadgeTxt}>{newSinceUp > 99 ? '99+' : newSinceUp}</Text></View>
          )}
        </TouchableOpacity>
      )}

      {/* Everything above the keyboard. Hidden from screen readers while the
          lock veil is up: the reply/edit bars can quote a message and the
          composer can hold a draft. iOS already skips the veil's siblings
          (accessibilityViewIsModal); Android needs this. */}
      <View
        importantForAccessibility={behindA11y ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={behindA11y}
      >
        {/* @mention picker (W15) — appears while typing "@name" in a group */}
        <MentionPicker candidates={mentionCandidates} onPick={pickMention} screenAuthHeader={screenAuthHeader} />

        <ComposerBars
          chatViewers={chatViewers}
          resolveViewer={resolveViewer}
          typingUids={typingUids}
          membersById={membersById}
          editingId={editingId}
          editingText={editingId != null ? messages.find(m => m.id === editingId)?.content : null}
          onCancelEdit={onCancelEdit}
          vanishMode={chat?.vanishMode}
          nextInvisibleInk={nextInvisibleInk}
          onDisarmInk={() => setNextInvisibleInk(false)}
          composerLp={composerLp}
          onDismissLp={() => { if (composerLp) lpDismissedRef.current = composerLp.url; setComposerLp(null); }}
          replyTo={replyTo}
          meId={meId}
          onCancelReply={() => setReplyTo(null)}
        />

        {/* Composer — either normal or recording mode */}
        <Composer
          recording={recording}
          recElapsedMs={recElapsedMs}
          cancelRecording={cancelRecording}
          stopAndSendRecording={stopAndSendRecording}
          editingId={editingId}
          gifOpen={gifOpen}
          onOpenGif={() => { Keyboard.dismiss(); setGifOpen(true); }}
          input={input}
          onInputChange={onInputChange}
          composerMax={composerMax}
          onPressAttach={onPressAttach}
          sending={sending}
          onOpenCamera={openCamera}
          startRecording={startRecording}
          onSend={onSend}
        />
      </View>

      {/* Long-press action sheet (reactions + action grid) */}
      <MessageActionSheet
        visible={actionSheet != null}
        onClose={() => setActionSheet(null)}
        onReact={(e) => { if (actionSheet) toggleReaction(actionSheet.msg, e); }}
        actions={actionSheet ? buildSheetActions(actionSheet.msg, actionSheet.plain) : []}
      />

      {/* Message Info — who delivered/read this message (WhatsApp-style) */}
      <MessageInfoModal infoMsg={infoMsg} onClose={() => setInfoMsg(null)} otherMembers={otherMembers} screenAuthHeader={screenAuthHeader} chatId={chatId} />

      {/* Profile photo viewer (avatar tap with no active story) — WhatsApp popup */}
      <ProfilePhotoModal
        visible={photoViewer}
        onClose={() => setPhotoViewer(false)}
        headerPhotoId={headerPhotoId}
        screenAuthHeader={screenAuthHeader}
        title={title}
        isDirect={chat?.type === 'direct'}
        onCall={(kind) => {
          const p = directPeer();
          if (p) router.push({ pathname: kind === 'voice' ? '/voicecall' : '/videocall', params: { chatId, peerUid: p.userId, peerName: p.name || p.email || title } });
        }}
        onInfo={openProfile}
      />

      {/* Attach menu — WhatsApp-style grid of round icons */}
      <AttachMenu visible={attachOpen} onClose={() => setAttachOpen(false)} actions={attachActions} />

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
      <MediaCaptionPreview
        pendingItems={pendingItems}
        setPendingItems={setPendingItems}
        currentIdx={currentIdx}
        setCurrentIdx={setCurrentIdx}
        updateCurrentItem={updateCurrentItem}
        removePendingAt={removePendingAt}
        addMorePhotos={addMorePhotos}
        confirmSendPendingMedia={confirmSendPendingMedia}
        sending={sending}
      />

      {/* Forward chat picker */}
      <ForwardPicker
        forwardMsg={forwardMsg}
        onClose={() => setForwardMsg(null)}
        forwardChats={forwardChats}
        forwardLoading={forwardLoading}
        meId={meId}
        membersById={membersById}
        onPick={doForward}
      />

      {/* Per-chat lock gate. The condition is "not proven OPEN", never "known
          locked": while the lock is still being read, and when reading it failed,
          the veil is up. The `&& lockInfo` that used to be here is exactly what
          rendered the chat in full when getLock threw. */}
      <ChatLockGate
        lockState={lockState}
        setLockState={setLockState}
        lockInfo={lockInfo}
        lockBio={lockBio}
        setLockBio={setLockBio}
        lockPin={lockPin}
        setLockPin={setLockPin}
        lockErr={lockErr}
        setLockErr={setLockErr}
        submitLockPin={submitLockPin}
        embedded={embedded}
      />
    </View>
  );
}
