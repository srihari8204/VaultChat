// components/chat/MessageBubble.tsx — every message bubble and its helpers.
//
// Split out of app/chat.tsx (4,534 lines) so the screen holds the screen and
// the bubbles hold the bubbles. Nothing here closes over ChatScreen state —
// these were already top-level functions, which is what made the cut safe.
// MemoBubble's comparator deliberately ignores the function props; see it.

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

import { Audio, ResizeMode, Video } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
// expo-image for every bubble thumbnail: memory+disk cache and recyclingKey, so
// an inverted virtualized list stops re-decoding on each mount and recycled rows
// don't flash the previous row's image.
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { IMPORT_SOURCE } from '../../constants/importSources';
import { viewerRouteFor } from '../../lib/docOpen';
import { forwardLabel, isForwarded, isForwardedManyTimes } from '../../lib/forwardPolicy';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import LinkPreview, { extractUrl } from '../../components/LinkPreview';
import { isViewedOnce, isViewedOnceSync, markViewedOnce } from '../../lib/viewOnceStore';
import { exportToGalleryInBackground } from '../../lib/galleryExport';
import { isRevokedSync } from '../../lib/protectedMedia';

import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';

import { getAccessToken } from '../../lib/api';
import { putLiveKey } from '../../lib/liveLocationCrypto';
import { navigateTo, navigateFromUrl } from '../../lib/nav/openNavigation';
import { type PollVoteSummary, unvotePoll, voteOnPoll, decryptFromChat, looksEncrypted, type ScreenshotMode, type ChatMember, type ReactionSummary, groupRefOf, type GroupRef } from '../../lib/chatService';
import VaultBeamBubble from '../../components/VaultBeamBubble';
import { getDecryptedAttachmentUri, parseMediaContent } from '../../lib/mediaAttachments';
import { shouldAutoDownloadNow } from '../../lib/mediaPrefs';
import { ProgressRing } from '../../components/ProgressRing';
import { getMedia, copyToCache } from '../../lib/mediaStore';
import { thumbDataUri } from '../../lib/thumbnails';
import { useConnectionState } from '../../lib/socket';


// Delete-for-everyone window — keep numerically identical to the server's
// REVOKE_WINDOW_MS (routes/chats.js). WhatsApp parity: 2 days 12 hours.




import { useS, idealText, HL, type DisplayMessage } from './chatStyles';
import { BRAND_ACCENT } from '../../constants/theme';
import { couldBeLongRead, readStats } from '../../lib/reader';
// Vector, so the mark stays crisp and cannot be mis-scaled by a style box whose
// ratio disagrees with a raster's — the failure that made this look absent.
import KlipyWatermark from '../../assets/klipy/watermark-klipy-light.svg';
import { gameInviteOf, gameName, type GameInvite } from '../../lib/games/inviteLink';
import { groupTypeInfo } from '../../lib/groups/catalog';

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

export function renderWithHighlight(body: string, q: string | null | undefined): any {
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
export function formatScreenshotMode(mode: ScreenshotMode): string {
  switch (mode) {
    case 'allow':         return 'Allowed';
    case 'allow_notify':  return 'Allowed + notify';
    case 'block_silent':  return 'Blocked silently';
    case 'block':
    default:              return 'Blocked';
  }
}

// Pretty-print a disappearing-messages timer (e.g. "24 h", "7 d", "90 d").
export function formatDisappearing(seconds: number | null | undefined): string {
  if (!seconds) return 'Off';
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600  === 0) return `${seconds / 3600} h`;
  if (seconds % 60    === 0) return `${seconds / 60} m`;
  return `${seconds} s`;
}

export const DISAPPEARING_PRESETS: { label: string; seconds: number | null }[] = [
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
export function formatLastSeen(iso: string): string {
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

export function formatRecDuration(ms: number): string {
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
export function bumpPollVote(
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
export function GroupRefBubble({ gref, isMine }: { gref: GroupRef; isMine: boolean }) {
  const S = useS();
  const { colors } = useTheme();
  const gRouter = useRouter();
  const info = gref.groupType ? groupTypeInfo(gref.groupType) : null;
  const icon = (gref.icon || info?.icon || 'people') as any;
  const tint = gref.color || info?.color || colors.primary;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Open ${gref.name || 'group'}`}
      onPress={() => gRouter.push({
        pathname: '/group-join' as any,
        params: {
          groupId: gref.groupId,
          name: gref.name ?? '',
          groupType: gref.groupType ?? '',
          icon: gref.icon ?? '',
          color: gref.color ?? '',
        },
      })}
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
export function GameInviteBubble({ inv, isMine }: { inv: GameInvite; isMine: boolean }) {
  const { colors } = useTheme();
  const gRouter = useRouter();
  const name = gameName(inv.game);

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Join the ${name} table`}
      onPress={() => gRouter.push({
        pathname: '/games' as any,
        params: { game: inv.game, room: inv.room },
      })}
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

export function FileBubble({
  attachmentId, filename, mime, size, authHeader, resolvedUri, isMine, thumb, pages, encrypted,
}: {
  attachmentId: string;
  filename:     string;
  mime:         string;
  size:         number;
  pages?:       number;   // PDF page count, counted by the sender
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
  thumb?:       string;   // PDF first-page preview (base64 jpeg)
  encrypted?:   boolean;  // meta.encrypted — see mediaStore.MediaKeyMissingError
}) {
  const S = useS();
  const [busy, setBusy] = useState(false);
  const fileRouter = useRouter();
  // The data URI is a ~KB string built from base64; build it once per thumb,
  // not once per render.
  const thumbUri = useMemo(() => (thumb ? thumbDataUri(thumb) : null), [thumb]);

  // "1 page · 66 KB · PDF". Each part is dropped when it is not known, so a
  // non-PDF still reads exactly as it always did.
  const isPdf = /pdf/i.test(mime) || /[.]pdf$/i.test(filename);
  const subtitle = [
    pages ? `${pages} page${pages === 1 ? '' : 's'}` : null,
    formatBytes(size),
    isPdf ? 'PDF' : null,
  ].filter(Boolean).join(' · ');

  const onOpen = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Persistent local copy (downloaded once). Survives "Clear cache" AND the
      // server's post-delivery purge. Encrypted files arrive decrypted via
      // resolvedUri; everything else resolves through the persistent media store.
      // resolvedUri is the RENDER source and may legitimately be a REMOTE url
      // (attachmentUrl + auth headers, used by <Image>). Handing that to the
      // file layer below fails with "ENOENT ... https://…", because a URL is
      // not a path. Only take it when it is genuinely local; otherwise go
      // through getMedia, which downloads with the Authorization header and
      // returns a file:// path.
      const cached = resolvedUri?.uri;
      const localUri = cached && /^(file:\/\/|\/)/.test(cached)
        ? cached
        : await getMedia(attachmentId, { kind: 'file', isMine, mime, filename, encrypted });
      // Copy into the app cache so the OS FileProvider can hand the file to
      // another app (the provider is configured over the cache dir).
      const openUri = await copyToCache(localUri, filename || `file-${attachmentId}`);

      // Open IN-APP first, rather than throwing the file straight at the OS.
      //
      // This tap used to go directly to the system chooser, which meant the
      // in-app viewers were unreachable from a chat: an archive could only be
      // browsed from the Shelf, and text/code could only be read in another
      // app. Route by type instead, and let those screens hand off to the OS
      // when the device really is the better renderer (PDF, Office).
      // The two extension lists that used to sit here were one of THREE copies
      // of the same routing table (the others were in app/media-gallery.tsx and
      // app/media-viewer.tsx, and neither agreed with this one — .tsv and .ini
      // were missing here, and the gallery had no table at all). lib/docOpen.ts
      // is now the single copy, asserted by docOpen.selftest.ts.
      const route = viewerRouteFor(filename, mime);
      if (route === '/archive-viewer') {
        fileRouter.push({ pathname: '/archive-viewer', params: { uri: openUri, filename } } as any);
        return;
      }
      if (route === '/file-viewer') {
        fileRouter.push({
          pathname: '/file-viewer',
          params: { uri: openUri, filename, mimeType: mime || '' },
        } as any);
        return;
      }

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
  if (thumbUri) {
    return (
      <TouchableOpacity style={S.fileCard} onPress={onOpen} activeOpacity={0.85} disabled={busy}>
        {/* data: URI — already in memory, nothing to fetch, so memory cache only. */}
        <ExpoImage source={{ uri: thumbUri }} style={S.filePreview} contentFit="cover" cachePolicy="memory" recyclingKey={attachmentId} />
        <View style={S.fileCardRow}>
          <View style={[S.fileIcon, isMine ? S.fileIconMine : S.fileIconTheirs]}>
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="document-text" size={20} color="#fff" />}
          </View>
          <View style={S.fileMeta}>
            <Text style={[S.fileName, isMine && S.fileNameMine]} numberOfLines={1}>{filename}</Text>
            <Text style={[S.fileSize, isMine && S.fileSizeMine]}>{subtitle}</Text>
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
        <Text style={[S.fileSize, isMine && S.fileSizeMine]}>{subtitle}</Text>
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
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
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

function ImageAttachment({ attachmentId, resolvedUri, isMine, mime, thumb, encrypted, viewOnce, onError }: {
  attachmentId: string;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine?: boolean;
  mime?: string;
  thumb?: string;   // base64 JPEG shown instantly while the full image loads
  encrypted?: boolean;  // meta.encrypted — lets a missing key be reported as such
  /** Passed explicitly so a view-once photo can never reach the camera roll. */
  viewOnce?: boolean;
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
  // Built once per thumb instead of once per render (it is a ~KB base64 string).
  const thumbUri = useMemo(() => (thumb ? thumbDataUri(thumb) : null), [thumb]);
  // Publish to the device gallery once the bytes are a real local file. Only
  // file:// — a remote URL is not ours to copy, and the export itself refuses
  // view-once media and honours the user's setting.
  useEffect(() => {
    if (uri && uri.startsWith('file://')) {
      exportToGalleryInBackground(uri, { kind: 'image', viewOnce, attachmentId });
    }
  }, [uri, viewOnce, attachmentId]);
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
          {thumbUri ? <ExpoImage source={{ uri: thumbUri }} style={S.attachedImage} contentFit="cover" blurRadius={2} cachePolicy="memory" recyclingKey={attachmentId} /> : <View style={[S.attachedImage, S.imageError]} />}
          <View style={S.dlOverlay}><ProgressRing progress={progress} /></View>
        </View>
      );
    }
    // Auto-download skipped by policy → tap-to-download over the blurred thumb.
    if (needTap) {
      return (
        <TouchableOpacity activeOpacity={0.85} onPress={download} style={S.attachedImage}>
          {thumbUri ? <ExpoImage source={{ uri: thumbUri }} style={S.attachedImage} contentFit="cover" blurRadius={3} cachePolicy="memory" recyclingKey={attachmentId} /> : <View style={[S.attachedImage, S.imageError]} />}
          <View style={S.dlOverlay}>
            <Ionicons name="arrow-down-circle" size={40} color="#fff" />
            <Text style={S.dlOverlayTxt}>Download</Text>
          </View>
        </TouchableOpacity>
      );
    }
    // Instant low-res preview from the embedded thumbnail while the full image
    // downloads (WhatsApp-style progressive load).
    if (thumbUri) return <ExpoImage source={{ uri: thumbUri }} style={S.attachedImage} contentFit="cover" cachePolicy="memory" recyclingKey={attachmentId} />;
    return <View style={[S.attachedImage, S.imageError]}><ActivityIndicator color={colors.primary} /></View>;
  }
  return <ExpoImage source={{ uri }} style={S.attachedImage} contentFit="cover" cachePolicy="memory-disk" recyclingKey={attachmentId} onError={onError} />;
}

// ─── Video bubble ────────────────────────────────────────────
// Inline player using expo-av's <Video>. Tap = native controls, no
// autoplay. Streams the auth-gated /uploads endpoint via the Bearer
// header. onLoadError surfaces 410-Gone (view-once consumed) so the
// MessageBubble can flip to a "Viewed" tombstone without an extra
// HEAD round-trip.
function VideoBubble({
  attachmentId, durationMs, authHeader, resolvedUri, onErrorOnce, isNote, onOpen, isMine, mime, thumb, encrypted, viewOnce,
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
  /** Passed explicitly so a view-once video can never reach the camera roll. */
  viewOnce?:     boolean;
}) {
  const S = useS();
  // WhatsApp-style: do NOT mount a <Video> (ExoPlayer) at rest — each instance
  // buffers the file in memory, and many bubbles at once OOM'd the app. We show
  // a lightweight placeholder + play button. Regular videos open the full-screen
  // player on tap (one player at a time). Video notes lazily download then play
  // inline in the round bubble — so at most ONE <Video> is ever alive.
  const [playing, setPlaying] = useState(false);
  const [noteUri, setNoteUri] = useState<string | null>(resolvedUri?.uri ?? null);
  // Same rule as the image bubble: publish only real local files, never a
  // view-once video, and only when the user's setting allows it.
  useEffect(() => {
    if (noteUri && noteUri.startsWith('file://')) {
      exportToGalleryInBackground(noteUri, { kind: 'video', viewOnce, attachmentId });
    }
  }, [noteUri, viewOnce, attachmentId]);
  const [busy, setBusy] = useState(false);
  // Built once per thumb instead of once per render (it is a ~KB base64 string).
  const thumbUri = useMemo(() => (thumb ? thumbDataUri(thumb) : null), [thumb]);

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
      ) : thumbUri ? (
        <ExpoImage source={{ uri: thumbUri }} style={isNote ? S.videoNoteView : S.videoView} contentFit="cover" cachePolicy="memory" recyclingKey={attachmentId} />
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
export function isSameCalendarDay(a: string, b: string): boolean {
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
/**
 * "This message is easier as a page" — the Reader hand-off
 * (docs/design/mobile/m18-reader-detect).
 *
 * Renders NOTHING for an ordinary message: a bubble is the right shape for
 * almost everything, and an affordance under every message would be noise. It
 * appears only past lib/reader's word threshold, where a bubble genuinely stops
 * working. The already-decrypted text is handed to the Reader as a param, so no
 * plaintext is persisted and the Reader never sees ciphertext.
 */
function ReaderAffordance({ text, title, author, at }: {
  text: string; title: string; author: string; at?: string;
}) {
  const S = useS();
  const router = useRouter();
  // Length guard first: rules out almost every message without running the
  // word count, which this component asks of EVERY text bubble on screen.
  const stats = useMemo(() => (couldBeLongRead(text) ? readStats(text) : null), [text]);
  if (!stats?.longRead) return null;
  return (
    <TouchableOpacity
      style={S.readerChip}
      activeOpacity={0.75}
      onPress={() => router.push({
        pathname: '/reader',
        params: { text, title, author, at: at ?? '' },
      })}
    >
      <Ionicons name="book-outline" size={14} color={BRAND_ACCENT} />
      <Text style={S.readerChipTxt}>Read as page · {stats.minutes} min</Text>
    </TouchableOpacity>
  );
}

/**
 * The seam between imported history and messages actually sent in crazzychat.
 *
 * Imported rows carry negative ids, so the boundary is wherever the sign flips —
 * no extra bookkeeping, and it stays correct as native messages accumulate above
 * it.
 */
export function ImportedDivider({ origin, atStart }: { origin: string; atStart?: boolean }) {
  const S = useS();
  const src = IMPORT_SOURCE[origin];
  if (!src) return null;
  return (
    <View style={S.unreadDivRow}>
      <Text style={S.unreadDivTxt}>
        {atStart ? '' : '↑ '}
        <Ionicons name={src.icon} size={12} color={src.tint} />
        {` Imported from ${src.label}`}
      </Text>
    </View>
  );
}

export function DateChip({ iso }: { iso: string }) {
  const S = useS();
  return (
    <View style={S.dateChipRow}>
      <View style={S.dateChip}><Text style={S.dateChipTxt}>{dayLabel(iso)}</Text></View>
    </View>
  );
}

// WhatsApp-style "N unread messages" separator, shown above the first message
// the user hasn't read yet.
export function UnreadDivider({ count }: { count: number }) {
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

export function EmojiPanel({ onPick }: { onPick: (e: string) => void }) {
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
export function SwipeToReply({ onReply, children }: { onReply: () => void; children: React.ReactNode }) {
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
  const { profile: visionProfile } = useVisionComfort();
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

  // Tick state — only meaningful for own server-confirmed messages.
  // WhatsApp group semantics: blue (read) only when EVERY current recipient has
  // read; double-grey (delivered) only when every current recipient received.
  // Exclude members who LEFT (leftAt) so a departed member never blocks a tick,
  // and members who JOINED AFTER this message (they were never a recipient of it).
  // Guard the empty set because [].every() is vacuously true (would false-blue).
  // read implies delivered, so fold read into the delivered test — a dropped
  // `message_delivered` event must not strand a since-read message at 'sent'.
  let tickState: 'pending' | 'sent' | 'delivered' | 'read' | null = null;
  // The pending test must come BEFORE the id check. A queued message has no
  // server id yet (id is 0 until the POST is acked), so gating the whole block
  // on `msg.id > 0` meant an offline message showed no status icon at all —
  // just the "sending…" caption, which reads as stuck rather than waiting.
  if (isMine && !msg.deletedAt && (msg._state === 'pending' || msg._state === 'failed')) {
    tickState = msg._state === 'pending' ? 'pending' : null;
  } else if (isMine && msg.id > 0 && !msg.deletedAt) {
    const recipients = otherMembers.filter(
      m => !m.leftAt && (!m.joinedAt || m.joinedAt <= msg.createdAt),
    );
    if (recipients.length === 0) {
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
    bubbleRouter.push({ pathname: '/media-viewer' as any, params });
  }, [msg.meta?.attachmentId, msg.meta?.gifUrl, msg.meta?.filename, isEncMedia, mediaSrc?.uri, isMine, bubbleRouter, chatId]);
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
        // Screen readers cannot long-press reliably; expose the same action
        // menu (reply, react, forward, delete…) as a named action.
        accessibilityActions={[{ name: 'longpress', label: 'Message actions' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'longpress') onLongPress(msg, plain); }}
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
          />
        ) : isVaultbeam ? (
          <VaultBeamBubble msg={msg} isMine={isMine} plain={plain} />
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
                <ReaderAffordance
                  text={plain}
                  title={member?.name ? `${member.name}’s message` : 'Long message'}
                  author={member?.name ?? ''}
                  at={msg.createdAt}
                />
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
          ) : msg.content == null && (msg.type === 'text' || msg.type === 'poll') ? (
            // The message EXISTS and THIS DEVICE HOLDS NO READABLE COPY OF IT.
            // That is the entire claim. It is deliberately not a claim about the
            // server, because the client cannot make one.
            //
            // This said "Message no longer available", which asserts the server
            // reclaimed the body. It shipped that way because the null was read
            // as coming from one place — the ephemeral body store returning a
            // spine row with its body gone. A null reaches here from several:
            //
            //   • the sender's OWN message. A Double Ratchet ciphertext cannot be
            //     opened by the party that produced it, so hydrateMessages leaves
            //     the envelope (chatService.ts) and cacheMessages then stores NULL
            //     for it (localDb.ts) whenever the own-plaintext cache misses.
            //   • a peer message this device never managed to decrypt.
            //   • a body the retention sweep genuinely reclaimed.
            //
            // Only the third is "no longer available", and it is the one that has
            // never happened in production: MESSAGE_BODIES is unset there, so the
            // body store has never been written to. The first is what users were
            // actually shown — a bubble telling them the server had dropped a
            // message the server still held in full. Verified against production
            // for the reported chats: every one of those messages was intact on
            // the spine, a few hundred bytes of `dr1` each, with no body row and
            // no retention job ever having run against it.
            //
            // So the wording states only what is locally true, which is also true
            // in the retention case. A bubble must never report a server-side fact
            // it inferred from a local absence.
            //
            // Scoped to text/poll on purpose. A media message legitimately has a
            // null body when it carries no caption; its bubble is the attachment,
            // which renders above this and must not be labelled unavailable.
            <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontStyle: 'italic', opacity: 0.7 }]}>
              ⧗ Message not available on this device
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

        <Text style={[S.bubbleMeta, (!isMine || isImage || isVideo || isGif) && { color: visionProfile.highContrast ? colors.bubbleInText : colors.bubbleMetaIn }, (isImage || isVideo || isGif) && { paddingHorizontal: 4 }]}>
          {/* createdAt IS the original timestamp for an imported message — it is
              never the import time — so this line needs no special case to show
              the right hour. */}
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {/* Where this message came from, as the messenger's own mark. A word
              ("· WhatsApp") costs a third of the bubble's width on every single
              imported row and stops being readable at all once three sources
              exist; the logo is recognised without being read, and each source
              keeps its own colour so they never look alike. */}
          {(() => {
            const src = IMPORT_SOURCE[msg.meta?.origin];
            return src ? (
              <Text> · <Ionicons name={src.icon} size={11} color={src.tint} /></Text>
            ) : null;
          })()}
          {msg.editedAt ? ' · edited' : ''}
          {msg._state === 'failed'  ? ' · failed (tap to retry)' : ''}
          {/* Sender-side send progress. Text (not just the ring) so a document
              or voice bubble — where an overlay ring would be cramped — still
              says what is happening. Absent _progress = no sample yet, which
              keeps the original bare pending clock. */}
          {msg._state === 'pending' && msg._progress != null
            ? (msg._phase === 'preparing'
                ? ' · Preparing…'
                : ` · Uploading ${Math.round(msg._progress * 100)}%`)
            : ''}
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
              accessibilityLabel={tickState === 'pending' ? 'Sending message' : `Message ${tickState}`}
              testID={`message-status-${msg.id}`}
              style={{ marginLeft: 3 }}
            />
          )}
        </Text>

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
