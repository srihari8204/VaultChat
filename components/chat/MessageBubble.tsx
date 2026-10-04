// components/chat/MessageBubble.tsx — one message bubble.
//
// Split out of app/chat.tsx (4,534 lines) so the screen holds the screen and
// the bubbles hold the bubbles, and then split again (it reached 1,800 lines):
// the attachment bodies are in MediaBubbles, the poll/location/reader cards in
// BubbleParts, the text renderer in bubbleText, the thread furniture (day
// chip, dividers, swipe-to-reply) in ThreadDecor and the formatters in
// chatFormat. This file decides WHICH body a message gets, and draws the
// bubble around it. MemoBubble's comparator deliberately ignores the function
// props; see it.

import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { forwardLabel, isForwarded, isForwardedManyTimes } from '../../lib/forwardPolicy';
import { extractUrl } from '../../components/LinkPreview';
import { isViewedOnce, isViewedOnceSync, markViewedOnce } from '../../lib/viewOnceStore';
import { isRevokedSync } from '../../lib/protectedMedia';

import { useTheme } from '../../lib/theme';

import { getAccessToken } from '../../lib/api';
import { putLiveKey } from '../../lib/liveLocationCrypto';
import { navigateTo } from '../../lib/nav/openNavigation';
import { type PollVoteSummary, decryptFromChat, looksEncrypted, type ChatMember, type ReactionSummary, groupRefOf, type GroupRef } from '../../lib/chatService';
import VaultBeamBubble from '../../components/VaultBeamBubble';
import { getDecryptedAttachmentUri, parseMediaContent } from '../../lib/mediaAttachments';
import { ProgressRing } from '../../components/ProgressRing';

import { useS, idealText, type DisplayMessage } from './chatStyles';
import { bubbleA11yLabel } from './bubbleA11yLabel';
import { bubbleA11yActions } from './bubbleA11yActions';
import { isProtectedMessage, previewText } from './protectedText';
import { renderRichText, openMessageUrl, type BubbleInk } from './bubbleText';
import { tickStateOf } from './chatFormat';
import { AudioBubble, FileBubble, ImageAttachment, VideoBubble } from './MediaBubbles';
import { BubbleMetaLine, LocationBubble, PollBubble, TextBody, longReadStats, openReader, parseLocation } from './BubbleParts';
// Vector, so the mark stays crisp and cannot be mis-scaled by a style box whose
// ratio disagrees with a raster's — the failure that made this look absent.
import KlipyWatermark from '../../assets/klipy/watermark-klipy-light.svg';
import { gameInviteOf, gameName, type GameInvite } from '../../lib/games/inviteLink';
import { groupTypeInfo } from '../../lib/groups/catalog';

type BubbleRouter = ReturnType<typeof useRouter>;

/**
 * A shared group card — tap it to ask to join.
 *
 * This is the receiving half of shareGroup(). The sender is told "The card is
 * in your chat with X"; before this existed the recipient saw an empty bubble,
 * because no branch in this file matched type 'group_ref'. app/group-join.tsx
 * was written to receive the tap and had no inbound navigation from anywhere.
 *
 * Deliberately a weak door, matching what group-join says about itself:
 * arriving there admits nothing, it sends a request and an admin decides. So
 * this card navigates and never joins.
 */
function openGroupRef(router: BubbleRouter, gref: GroupRef) {
  router.push({
    pathname: '/group-join',
    params: {
      groupId: gref.groupId,
      name: gref.name ?? '',
      groupType: gref.groupType ?? '',
      icon: gref.icon ?? '',
      color: gref.color ?? '',
    },
  });
}

export function GroupRefBubble({ gref, isMine }: { gref: GroupRef; isMine: boolean }) {
  const { colors } = useTheme();
  const gRouter = useRouter();
  const info = gref.groupType ? groupTypeInfo(gref.groupType) : null;
  // gref.icon is a server string: an unknown glyph name falls back rather than
  // rendering Ionicons' '?' box.
  const icon = [gref.icon, info?.icon].find((n): n is keyof typeof Ionicons.glyphMap =>
    !!n && n in Ionicons.glyphMap) ?? 'people';
  const tint = gref.color || info?.color || colors.primary;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Open ${gref.name || 'group'}`}
      onPress={() => openGroupRef(gRouter, gref)}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
        borderWidth: 1, borderColor: colors.hairline,
        backgroundColor: isMine ? 'transparent' : colors.surface,
        minWidth: 200,
      }}
    >
      <View style={{
        width: 38, height: 38, borderRadius: 10, alignItems: 'center',
        justifyContent: 'center', backgroundColor: colors.hairline,
      }}>
        <Ionicons name={icon} size={20} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
          {gref.name || 'Group'}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 12, marginTop: 1 }}>
          {info?.label ? `${info.label} · Tap to join` : 'Tap to join'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </TouchableOpacity>
  );
}

/**
 * A game table invite — tap it to sit down at that exact table.
 *
 * The receiving half of sendGameInvite(). Before this existed, inviting someone
 * meant leaving crazzychat through the OS share sheet and hoping the link came
 * back into the app it had just left.
 *
 * The card carries a game and a room id and NO token: the games server does its
 * own seating, exactly as it does for a shared link. Tapping opens /games with
 * the params that screen already reads — the same route the `vaultchat://games`
 * deep link and the turn notifications land on, so there is one way in, not
 * three. Rummy joining by `tableId` while the other three use `roomId` is
 * settled inside lib/gamesSocket.ts and is not this card's problem.
 *
 * gameInviteOf() returns null for anything but the four games this app ships
 * and a plain-slug room, so a malformed card renders as its readable text body
 * rather than a button that leads nowhere.
 */
function openGameInvite(router: BubbleRouter, inv: GameInvite) {
  router.push({
    pathname: '/games',
    params: { game: inv.game, room: inv.room },
  });
}

export function GameInviteBubble({ inv, isMine }: { inv: GameInvite; isMine: boolean }) {
  const { colors } = useTheme();
  const gRouter = useRouter();
  const name = gameName(inv.game);

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Join the ${name} table`}
      onPress={() => openGameInvite(gRouter, inv)}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
        borderWidth: 1, borderColor: colors.hairline,
        backgroundColor: isMine ? 'transparent' : colors.surface,
        minWidth: 200,
      }}
    >
      <View style={{
        width: 38, height: 38, borderRadius: 10, alignItems: 'center',
        justifyContent: 'center', backgroundColor: colors.hairline,
      }}>
        <Ionicons name="game-controller" size={20} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
          {name}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 12, marginTop: 1 }}>
          Tap to join · {inv.room}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </TouchableOpacity>
  );
}

function MessageBubble({
  msg, meId, member, chatId, otherMembers, onLongPress, onJumpTo, onReply,
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
  /** Same as swipe-to-reply, for the bubble's Reply accessibility action. */
  onReply?: () => void;
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
  const [replyPlain, setReplyPlain] = useState<string>(() =>
    replyTarget && !looksEncrypted(replyTarget.content) ? (replyTarget.content ?? '') : '',
  );
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  // Tick state — only meaningful for own messages (chatFormat.tickStateOf).
  const tickState = tickStateOf(msg, isMine, otherMembers);

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
  }, [msg.content, msg.senderId, msg.id, chatId]);

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
    if (!looksEncrypted(replyTarget.content)) {
      setReplyPlain(replyTarget.content ?? '');
      return;
    }
    let cancel = false;
    (async () => {
      const t = await decryptFromChat(chatId, replyTarget.senderId, replyTarget.content, replyTarget.id);
      if (!cancel) setReplyPlain(t);
    })();
    return () => { cancel = true; };
  }, [replyTarget, chatId]);

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
    } else if (msg.meta?.localUri) {
      // STILL UPLOADING, and the sender already holds the bytes.
      //
      // Until the send finalises there is no attachmentId, so every branch
      // above missed and this fell through to the bail-out below — the tap did
      // nothing at all. On a big video that is minutes of a dead bubble, which
      // reads as "the player only works for VaultBeam" (that bubble is a
      // different component with its own player). Open the local file instead:
      // it is the very same media, and it is already on disk.
      params.mediaUrl = String(msg.meta.localUri);
      params.mime = String(msg.meta?.mime || '');
    } else { openingRef.current = false; return; }
    bubbleRouter.push({ pathname: '/media-viewer', params });
  }, [msg.meta?.attachmentId, msg.meta?.gifUrl, msg.meta?.filename, msg.meta?.localUri, msg.meta?.mime, isEncMedia, mediaSrc?.uri, isMine, bubbleRouter, chatId]);
  const isSticker = msg.type === 'sticker' && !!msg.content;
  const isPoll  = msg.type === 'poll' && Array.isArray(msg.meta?.options);
  const isLocation = msg.type === 'location';
  // A SHARED GROUP CARD, WHICH NOTHING USED TO DRAW.
  //
  // shareGroup() sends type 'group_ref' with an empty content and a server-
  // enriched meta, and tells the sender "The card is in your chat with X". No
  // branch here matched that type, so the recipient got an EMPTY bubble — and
  // app/group-join.tsx, the screen the card is supposed to open, had zero
  // inbound navigation anywhere in the codebase. The whole path was dead:
  // server written, parser written, screen written, nothing wired.
  //
  // groupRefOf returns exactly the params group-join reads.
  const groupRef = msg.type === 'group_ref' ? groupRefOf(msg.meta) : null;
  // A game table invite (migration 124). A malformed one falls through to the
  // text body deliberately: the E2EE content carries the same invite as a
  // readable line, which is also what a client too old to know this type shows.
  const gameInvite = msg.type === 'game_invite' ? gameInviteOf(msg.meta) : null;

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

  // Handlers registered by nested controls (voice play, file open, poll vote)
  // so the bubble's accessibility actions can reach them — see bubbleA11yActions.
  const audioActionRef = useRef<(() => void) | null>(null);
  const fileActionRef = useRef<(() => void) | null>(null);
  const pollVoteRef = useRef<((idx: number) => void) | null>(null);
  // VaultBeam card control: handler by ref, label by state (it follows the transfer).
  const beamActionRef = useRef<(() => void) | null>(null);
  const [beamLabel, setBeamLabel] = useState<string | null>(null);

  // Deleted tombstone — safe here: every hook above has already run this render.
  if (msg.deletedAt) {
    return (
      <View style={[S.bubble, S.bubbleSystem]}>
        <Text style={S.bubbleSystemTxt}>Message deleted</Text>
      </View>
    );
  }

  // In-chat search skips protected messages (InChatSearchBar), so the bubble
  // must not highlight them either or the marks and the count disagree.
  const searchHl = isProtectedMessage(msg) ? null : highlight;

  // One spoken summary for the whole bubble (sender, body, time, ticks). It
  // follows the bubble's own hiding rules — see bubbleA11yLabel.
  let a11yCaption = '';
  if ((isImage || isVideo) && plain) {
    if (msg.meta?.encrypted) { try { a11yCaption = JSON.parse(plain)?.t || ''; } catch { a11yCaption = ''; } }
    else a11yCaption = plain;
  }
  const a11yLabel = bubbleA11yLabel({
    isMine,
    senderName: member?.name || member?.email,
    type: isGif ? 'image' : String(msg.type),
    text: looksEncrypted(msg.content) ? '' : plain,
    inkHidden: !!msg.meta?.invisibleInk && !isMine && !tiltRevealed,
    viewOnce: isViewOnceMedia && !isMine,
    revoked: isRevokedMedia,
    caption: a11yCaption,
    filename: msg.meta?.filename ? String(msg.meta.filename) : undefined,
    time: new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    edited: !!msg.editedAt,
    failed: msg._state === 'failed',
    tick: tickState,
  });

  // Link and mention ink. On your own (filled) bubble they take the bubble's
  // text colour, underlined/bold, so they read on any bubble theme; on a
  // received bubble and on a media caption (over the chat ground) they take
  // the theme's accent text colour.
  const accentInk: BubbleInk = {
    link: { color: colors.accentOn, textDecorationLine: 'underline' },
    mention: { color: colors.accentOn, fontWeight: '700' },
  };
  const ownInk = bubbleTxtColor ?? colors.bubbleOutText;
  const bodyInk: BubbleInk = isMine
    ? { link: { color: ownInk, textDecorationLine: 'underline' }, mention: { color: ownInk, fontWeight: '700' } }
    : accentInk;

  // Everything nested in the bubble, offered as accessibility actions (the
  // bubble is one element, so VoiceOver cannot focus its inner controls).
  const inkHidden = !!msg.meta?.invisibleInk && !isMine && !tiltRevealed;
  const textShown = !!plain && !inkHidden && !isLocation && !isPoll && !groupRef && !gameInvite
    && !isSticker && !isVaultbeam && !isImage && !isVideo && !isAudio && !isFile && !isGif;
  const linkUrl: string | null = textShown
    ? (msg.meta?.linkPreview?.t ? msg.meta.linkPreview.u : extractUrl(plain)) || null
    : null;
  const longRead = textShown && !!longReadStats(plain);
  const spentOnce = (isImage || isVideo) && (tombstoned || isRevokedMedia);
  const pollOptions: string[] = isPoll ? msg.meta.options : [];
  const readerArgs = {
    text: plain, title: member?.name ? `${member.name}’s message` : 'Long message', author: member?.name ?? '',
    at: msg.createdAt, chatId, msgId: msg.id, cached: msg.id > 0,
  };
  const a11yActions = bubbleA11yActions({
    state: msg._state,
    confirmed: msg.id > 0 && msg.type !== 'system',
    quote: (msg.replyToId ?? 0) > 0 && !isForwarded(msg.meta),
    revealOnce: isViewOnceMedia && !revealed && !spentOnce ? (isVideo ? 'video' : 'photo') : null,
    media: isRevokedMedia || spentOnce || (isViewOnceMedia && !revealed) ? null
      // A photo opens exactly when a tap would open it (your own view-once does not).
      : ((isImage && !isViewOnceMedia) || isGif) ? 'photo' : isVideo ? 'video' : isAudio ? 'voice' : isFile ? 'file' : null,
    location: isLocation && !!parseLocation(plain),
    card: groupRef ? `Open ${groupRef.name || 'group'}` : gameInvite ? `Join the ${gameName(gameInvite.game)} table` : null,
    link: !!linkUrl,
    longRead,
    beam: isVaultbeam ? beamLabel : null,
    poll: pollOptions.map((label, i) => ({ label, mine: !!pollVotesForMsg?.mine.includes(i) })),
  });
  const onA11yAction = (name: string) => {
    if (name === 'longpress' || name === 'react') onLongPress(msg, plain);
    else if (name === 'reply') onReply?.();
    else if (name === 'quote') { const t = replyTarget?.id ?? msg.replyToId; if (t && t > 0) onJumpTo?.(t); }
    else if (name === 'reveal') handleRevealViewOnce();
    else if (name === 'open') {
      if (isImage || isGif) openFullScreen('image');
      else if (isVideo) openFullScreen('video');
      else if (isFile) fileActionRef.current?.();
    }
    else if (name === 'play') audioActionRef.current?.();
    else if (name === 'location') { const l = parseLocation(plain); if (l) navigateTo(l.lat, l.lng, l.address || 'Shared location'); }
    else if (name === 'card') { if (groupRef) openGroupRef(bubbleRouter, groupRef); else if (gameInvite) openGameInvite(bubbleRouter, gameInvite); }
    else if (name === 'link') { if (linkUrl) openMessageUrl(linkUrl); }
    else if (name === 'reader') openReader(bubbleRouter, readerArgs);
    else if (name === 'beam') beamActionRef.current?.();
    else if (name.startsWith('vote:')) pollVoteRef.current?.(Number(name.slice(5)));
  };
  // A bubble you can tap (photo, GIF, a failed send) is a button; the rest
  // are text with actions.
  const tappable = msg._state === 'failed' || (isImage && !isViewOnceMedia) || isGif;

  return (
    <View style={[S.bubbleRow, isMine ? S.bubbleRowMine : S.bubbleRowTheirs, grouped && S.bubbleRowGrouped]}>
      <TouchableOpacity
        accessibilityLabel={a11yLabel}
        accessibilityRole={tappable ? 'button' : 'text'}
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
        // Screen readers cannot long-press reliably, and cannot reach the
        // controls nested in this element: both are offered as named actions.
        accessibilityActions={a11yActions}
        onAccessibilityAction={(e) => onA11yAction(e.nativeEvent.actionName)}
      >
        {!isMine && member && !isSticker && !grouped && (
          <Text numberOfLines={1} style={S.senderTag}>{member.name || member.email || msg.senderId.slice(0, 8)}</Text>
        )}

        {/* Forwarded label — two tiers (audit F10). The text comes from
            forwardPolicy so the bubble and the forward sheet can never disagree
            about what counts as "many times". */}
        {forwardLabel(msg.meta) && (
          <Text style={[S.forwardedTag, isForwardedManyTimes(msg.meta) && S.forwardedTagMany]}>
            {forwardLabel(msg.meta)}
          </Text>
        )}

        {/* Inline reply preview (above the body) — tap to jump to the original.
            Suppressed on forwarded messages: a forward carries no reply context
            (it shows "↪ Forwarded"), so we must never render a reply quote. */}
        {(msg.replyToId ?? 0) > 0 && !isForwarded(msg.meta) && (
          <TouchableOpacity
            style={S.replyPreview}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="Quoted message, double tap to jump to it"
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
                  : previewText(replyTarget, replyPlain || '…')}
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
            accessibilityRole="button"
            accessibilityLabel={`View ${isImage ? 'photo' : 'video'} once`}
          >
            <Ionicons name="eye-outline" size={26} color={colors.textDim} style={{ marginBottom: 4 }} />
            <Text style={S.viewOnceShieldTxt}>Tap to view {isImage ? 'photo' : 'video'} once</Text>
            <Text style={S.viewOnceShieldHint}>
              From {member?.name || member?.email || 'sender'} · disappears after one view
            </Text>
          </TouchableOpacity>
        ) : isGif ? (
          // KLIPY watermark, bottom-left, semi-transparent white — their brand
          // guideline for a sent GIF/sticker/emoji card. Attribution compliance
          // is a stated condition of production API approval, not a courtesy.
          //
          // Gated on meta.source rather than on gifUrl alone: messages sent
          // before the KLIPY switch came from GIPHY, and stamping someone
          // else's content with KLIPY's mark would be a worse attribution
          // failure than showing none.
          <View>
            <Image
              source={{ uri: msg.meta.gifUrl }}
              style={S.attachedImage}
              resizeMode="cover"
            />
            {msg.meta?.source === 'klipy' && (
              // pointerEvents on the WRAPPER, not the mark: the card is
              // tappable (it opens the viewer) and an overlay that swallowed
              // touches would create a small dead zone in its corner.
              //
              // The scrim is why this is now visible. The mark is a WHITE
              // outlined wordmark, and the previous attempt leaned on
              // shadowColor — which Android ignores entirely, it only honours
              // elevation. So on a pale or busy GIF the watermark was drawn,
              // correct, and effectively invisible, which reads as "no
              // watermark". A soft dark pill behind it guarantees contrast on
              // any content without touching KLIPY's artwork, which must not be
              // recoloured or altered.
              <View style={S.klipyWatermark} pointerEvents="none">
                <KlipyWatermark width={62} height={21} accessibilityLabel="via KLIPY" />
              </View>
            )}
          </View>
        ) : isImage ? (
          <ImageAttachment
            attachmentId={msg.meta.attachmentId || ''}
            resolvedUri={msg.meta?.localUri ? { uri: String(msg.meta.localUri) } : (isEncMedia ? mediaSrc : undefined)}
            isMine={isMine}
            mime={String(msg.meta?.mime || '')}
            thumb={typeof msg.meta?.thumb === 'string' ? msg.meta.thumb : undefined}
            encrypted={isEncMedia}
            viewOnce={isViewOnceMedia}
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
            viewOnce={isViewOnceMedia}
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
            actionRef={audioActionRef}
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
            pages={Number(msg.meta?.pages) || undefined}
            encrypted={isEncMedia}
            actionRef={fileActionRef}
          />
        ) : isVaultbeam ? (
          <VaultBeamBubble msg={msg} isMine={isMine} plain={plain} actionRef={beamActionRef} onActionLabel={setBeamLabel} />
        ) : groupRef ? (
          <GroupRefBubble gref={groupRef} isMine={isMine} />
        ) : gameInvite ? (
          <GameInviteBubble inv={gameInvite} isMine={isMine} />
        ) : isSticker ? (
          <Text style={S.stickerEmoji}>{msg.content}</Text>
        ) : isPoll ? (
          <PollBubble
            chatId={chatId}
            msg={msg}
            isMine={isMine}
            votes={pollVotesForMsg}
            onChange={onPollVoteChange}
            voteRef={pollVoteRef}
          />
        ) : isLocation ? (
          <LocationBubble plain={plain} isMine={isMine} />
        ) : (
          <TextBody msg={msg} plain={plain} isMine={isMine} inkHidden={inkHidden} txtColor={bubbleTxtColor}
            highlight={searchHl} ink={bodyInk} readerArgs={readerArgs} />
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
              {renderRichText(cap, searchHl, accentInk)}
            </Text>
          ) : null;
        })()}

        <BubbleMetaLine msg={msg} tickState={tickState} isMine={isMine} isMedia={!!(isImage || isVideo || isGif)} fill={bubbleBg} />

        {/* Upload ring over visual media only — the WhatsApp read. File/voice
            bubbles get the meta-row text above instead, where a scrim over a
            40px row would just hide the filename. pointerEvents:'none' leaves
            long-press-to-cancel with the bubble underneath. */}
        {isMine && msg._state === 'pending' && msg._progress != null && (isImage || isVideo || isGif) && (
          <View style={S.upOverlay} pointerEvents="none">
            <ProgressRing progress={msg._progress} />
            <Text style={S.upOverlayTxt}>
              {msg._phase === 'preparing' ? 'Preparing…' : 'Uploading'}
            </Text>
          </View>
        )}
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
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`${r.emoji} ${r.count}${r.mine ? ', your reaction, double tap to remove' : ', double tap to react'}`}
              accessibilityState={{ selected: !!r.mine }}
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
export const MemoBubble = memo(MessageBubble, bubblePropsEqual);
