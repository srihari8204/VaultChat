// Chat / message REST helpers. Wraps the /chats backend routes (Phase 3a)
// and handles the encrypt/decrypt seam — currently pass-through, swap to
// double-ratchet in Phase 3b without touching call sites.

import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { api, getAccessToken } from './api';
import { SERVER_URL } from '../constants/server';
import { E2EE_ENABLED, GROUP_E2EE, E2EE_STRICT } from '../constants/flags';

export interface ChatSummary {
  id:            string;
  type:          'direct' | 'group';
  name:          string | null;
  photoURL:      string | null;
  createdBy:     string | null;
  createdAt:     string;
  updatedAt:     string;
  lastMessageId: number | null;
  lastMessageAt: string | null;
  myRole:        'member' | 'admin' | 'owner';
  myLastReadId:  number | null;
  muted:         boolean;
  pinned:        boolean;
  archived:      boolean;
  hidden:        boolean;
  unreadCount:   number;
  // Direct-chat only — the other user's profile snapshot (null for groups)
  peerUserId?:     string | null;
  peerName?:       string | null;
  peerPhotoURL?:   string | null;
  peerOnline?:     boolean;
  peerLastSeenAt?: string | null;
  peerLastReadMessageId?:      number | null;
  peerLastDeliveredMessageId?: number | null;
  // Per-user screenshot policy for this chat. Backend defaults to 'block'.
  screenshotMode?: 'allow' | 'allow_notify' | 'block' | 'block_silent';
  // Per-user Vanish Mode: while ON, new messages I send are flagged for
  // hard-delete-on-all-read.
  vanishMode?: boolean;
}

export type ScreenshotMode = 'allow' | 'allow_notify' | 'block' | 'block_silent';

export async function setScreenshotMode(chatId: string, mode: ScreenshotMode): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/screenshot-mode`, {
    method: 'PATCH',
    json: { mode },
  });
}

// Called by the chat screen when expo-screen-capture's listener fires
// AND the current mode is `allow_notify` (or `block` on iOS where the
// black-frame protection still lets the OS take a screenshot). Server
// broadcasts a `screenshot_captured` socket event to chat-mates.
export async function reportScreenshotCaptured(chatId: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/screenshot-captured`, { method: 'POST' });
}

// Vanish Mode (per-user, per-chat). While ON, every new message I send
// in this chat is stamped vanish_after_read = TRUE and is hard-deleted
// once every non-sender active member has read it.
export async function setVanishMode(chatId: string, enabled: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/vanish-mode`, {
    method: 'PATCH',
    json: { enabled },
  });
}

export interface ChatMember {
  userId:                 string;
  role:                   'member' | 'admin' | 'owner';
  joinedAt:               string;
  lastReadMessageId:      number | null;
  lastDeliveredMessageId: number | null;
  muted:                  boolean;
  leftAt:                 string | null;
  email?:                 string;
  name?:                  string | null;
  photoURL?:              string | null;
  online?:                boolean;
  lastSeenAt?:            string | null;
  status?:                string | null;   // "About" text (WhatsApp)
}

export interface ChatDetail extends ChatSummary {
  members:              ChatMember[];
  description?:         string | null;   // group description (WhatsApp)
  // Chat-level disappearing-messages timer. null = off.
  disappearingSeconds?: number | null;
  // Group admin controls.
  slowModeSeconds?:     number;
  sendPolicy?:          'everyone' | 'admins';
  mediaPolicy?:         'everyone' | 'admins';
  addMembersPolicy?:    'everyone' | 'admins';
  antiSpamLinks?:       boolean;
  approveMembers?:      boolean;
  // W15: a chat-wide pinned message (null = none).
  pinnedMessageId?:     string | null;
}

/** Pin a message chat-wide (messageId = null clears the pin). */
export async function pinMessage(chatId: string, messageId: string | number | null): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/pin-message`, {
    method: 'POST',
    json: { messageId: messageId == null ? null : Number(messageId) },
  });
}

export interface Message {
  id:        number;
  chatId:    string;
  senderId:  string;
  type:      'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'system' | 'sticker' | 'poll';
  content:   string | null;        // opaque ciphertext (currently plaintext during Phase 3a)
  meta?:     any;
  replyToId: number | null;
  editedAt:  string | null;
  deletedAt: string | null;
  createdAt: string;
  expiresAt?: string | null;       // disappearing-messages: hard-delete on/after this time
  vanishAfterRead?: boolean;       // Vanish Mode: delete once every non-sender member has read it
}

// ─── Encryption seam (P0.1: real E2EE, behind E2EE_ENABLED) ──────────
// OFF (default): pure pass-through — identical to the pre-E2EE behaviour and
// none of the crypto is loaded at runtime. ON: direct-chat messages use the
// per-peer Double Ratchet (services/crypto). Groups + pre-E2EE history stay
// plaintext. Everything is lazy-imported and every failure falls back to
// plaintext, so messaging never breaks.

// chatId → direct-chat peer, populated by listChats/getChat below.
const _chatPeer = new Map<string, { type: 'direct' | 'group'; peerId: string | null }>();
function rememberChatPeer(c: { id: string; type: 'direct' | 'group'; peerUserId?: string | null }): void {
  _chatPeer.set(c.id, { type: c.type, peerId: c.peerUserId ?? null });
}
function directPeerOf(chatId: string): string | null {
  const e = _chatPeer.get(chatId);
  return e && e.type === 'direct' ? e.peerId : null;
}

/** True when this chat is a known direct (1:1) chat — i.e. media/text can be E2E
 *  encrypted to a single peer. Group chats return false (no group E2EE yet). */
export function isDirectChat(chatId: string): boolean {
  return directPeerOf(chatId) != null;
}

export async function encryptForChat(chatId: string, plaintext: string): Promise<string> {
  if (!E2EE_ENABLED) return plaintext;
  // Group chats (W5): encrypt with the sender-key group session when enabled.
  if (_chatPeer.get(chatId)?.type === 'group') {
    if (!GROUP_E2EE) return plaintext; // groups stay plaintext until enabled
    try {
      const g = await import('../services/crypto/groupSession.rn');
      return await g.groupEncryptMessage(chatId, plaintext);
    } catch (err) {
      if (__DEV__) console.warn('[e2ee] group encrypt fell back to plaintext:', (err as any)?.message);
      return plaintext;
    }
  }
  const peerId = directPeerOf(chatId);
  if (!peerId) {
    // Can't resolve the recipient → can't encrypt. STRICT: refuse to leak
    // plaintext (the send fails + retries once the chat/peer is resolved).
    if (E2EE_STRICT) throw new Error('Encryption not ready — recipient not resolved yet. Retrying…');
    return plaintext;
  }
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    return await e2ee.e2eeEncrypt(chatId, peerId, plaintext);
  } catch (err) {
    if (__DEV__) console.warn('[e2ee] encrypt failed:', (err as any)?.message);
    // STRICT: never silently send plaintext. Throwing surfaces a failed/retry
    // bubble; the retry re-fetches the peer's key bundle and almost always
    // succeeds. (Legacy graceful mode falls back to plaintext.)
    if (E2EE_STRICT) throw new Error("Couldn't encrypt this message — the recipient's encryption keys aren't available yet. It will retry.");
    return plaintext;
  }
}

/**
 * Reset the E2EE session for a direct chat ("reset secure session"). Drops the
 * local ratchet so the next message we send re-initiates X3DH with the peer's
 * current keys — recovers a conversation stuck on "unable to decrypt" after a
 * peer reinstalled. No-op for group chats.
 */
export async function resetChatSession(chatId: string): Promise<void> {
  if (!E2EE_ENABLED) return;
  const peerId = directPeerOf(chatId);
  if (!peerId) return;
  const e2ee = await import('../services/crypto/e2eeSession.rn');
  await e2ee.e2eeResetSession(peerId);
}

export async function decryptFromChat(
  chatId: string,
  senderId: string,
  ciphertext: string | null,
  messageId?: number,
): Promise<string> {
  if (ciphertext == null) return '';
  if (!E2EE_ENABLED) return ciphertext;
  // Group chats (W5): a group envelope (GSK1:) is decrypted via the sender-key
  // session; anything else is pre-E2EE / plaintext history and passes through.
  if (_chatPeer.get(chatId)?.type === 'group') {
    if (!GROUP_E2EE) return ciphertext;
    try {
      const g = await import('../services/crypto/groupSession.rn');
      if (!g.isGroupEnvelope(ciphertext)) return ciphertext;
      return await g.groupDecryptMessage(chatId, senderId, messageId ?? 0, ciphertext);
    } catch (err) {
      if (__DEV__) console.warn('[e2ee] group decrypt failed:', (err as any)?.message);
      return '🔒 unable to decrypt';
    }
  }
  const e2ee = await import('../services/crypto/e2eeSession.rn');
  if (!e2ee.isEnvelope(ciphertext)) return ciphertext; // pre-E2EE plaintext history
  const peerId = directPeerOf(chatId) ?? senderId;     // peer = the other party
  try {
    return await e2ee.e2eeDecrypt(chatId, peerId, messageId ?? 0, ciphertext);
  } catch (err) {
    const m = String((err as any)?.message || '');
    // ONLY retry the transient out-of-order case (a follow-up message can arrive
    // before the X3DH-bearing first message bootstraps the session). Permanent
    // failures are tombstoned in e2eeDecrypt — no retry, no re-attempt, no spam.
    if (m.includes('no session and no X3DH')) {
      for (let i = 0; i < 2; i++) {
        await new Promise(r => setTimeout(r, 250));
        try { return await e2ee.e2eeDecrypt(chatId, peerId, messageId ?? 0, ciphertext); } catch {}
      }
    } else if (__DEV__ && !m.includes('undecryptable (cached)')) {
      console.warn('[e2ee] decrypt failed:', m);
    }
    return '🔒 unable to decrypt';
  }
}

/** Sync check: does this wire string look like an E2EE envelope (vs plaintext)? */
export function looksEncrypted(s: string | null | undefined): boolean {
  if (!s || typeof s !== 'string') return false;
  if (s.startsWith('GSK1:')) return true;                                   // group sender-key
  if (s[0] === '{') { try { return JSON.parse(s)?.v === 'dr1'; } catch { return false; } } // 1:1 double-ratchet
  return false;
}

/**
 * WhatsApp-style ingest: decrypt each envelope EXACTLY ONCE, reusing plaintext
 * we already have (knownPlain: id→text), and return messages whose `content`
 * is plaintext. Failed decrypts keep their envelope so a later open retries.
 * Decrypts oldest→newest to keep the double-ratchet in order.
 */
export async function hydrateMessages(
  chatId: string,
  msgs: Message[],
  knownPlain?: Map<number, string>,
): Promise<Message[]> {
  const out = msgs.slice();
  for (let i = out.length - 1; i >= 0; i--) {   // msgs arrive newest-first → iterate oldest-first
    const m = out[i];
    const c = m.content;
    if (!looksEncrypted(c)) continue;            // already plaintext (cache / pre-E2EE history)
    const cached = knownPlain?.get(m.id);
    if (cached != null && !looksEncrypted(cached)) { out[i] = { ...m, content: cached }; continue; }
    const plain = await decryptFromChat(chatId, (m as any).senderId ?? '', c, m.id);
    if (plain && !looksEncrypted(plain) && plain !== '🔒 unable to decrypt') {
      out[i] = { ...m, content: plain };
    }
  }
  return out;
}

// Cache an own-sent message's plaintext once the server assigns its id, so the
// sender renders it from the local store (server content is ciphertext).
export async function cacheOwnPlaintext(chatId: string, messageId: number | undefined, plaintext: string): Promise<void> {
  if (!E2EE_ENABLED || !messageId || messageId <= 0) return;
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    await e2ee.e2eeCachePlaintext(chatId, messageId, plaintext);
  } catch {}
}

// ─── REST ───────────────────────────────────────────────────────────

export async function listChats(opts: { includeHidden?: boolean } = {}): Promise<ChatSummary[]> {
  const qs = opts.includeHidden ? '?includeHidden=1' : '';
  const rows = await api<ChatSummary[]>(`/chats${qs}`);
  for (const r of rows) rememberChatPeer(r);
  return rows;
}

export async function getChat(chatId: string): Promise<ChatDetail> {
  const c = await api<ChatDetail>(`/chats/${encodeURIComponent(chatId)}`);
  rememberChatPeer(c);
  return c;
}

/**
 * Start (or open existing) a direct chat with another user.
 * Identify them by email, phone, or userId — pass exactly one.
 * userId is the form contacts-discovery uses (we already know the user id).
 */
export async function createDirectChat(
  who: { email?: string; phone?: string; userId?: string },
): Promise<{ id: string; type: 'direct'; existing?: boolean }> {
  const body: any = { type: 'direct' };
  if (who.userId)      body.otherUserId = who.userId;
  else if (who.email)  body.otherEmail  = who.email.trim().toLowerCase();
  else if (who.phone)  body.otherPhone  = who.phone.trim();
  else throw new Error('Provide one of userId / email / phone');
  return api(`/chats`, { method: 'POST', json: body });
}

export async function createGroupChat(
  name: string,
  members: { ids?: string[]; emails?: string[] } = {},
): Promise<{ id: string; type: 'group'; name: string }> {
  return api(`/chats`, {
    method: 'POST',
    json: {
      type: 'group', name,
      memberIds:    members.ids    ?? [],
      memberEmails: members.emails ?? [],
    },
  });
}

// ─── Gaming (durable layer; realtime is Socket.IO) ──────────────────
export interface GameProfile {
  coins:       number;
  wins:        number;
  losses:      number;
  gamesPlayed: number;
}
export interface GameHistoryItem {
  id:           string;
  gameType:     string;
  bet:          number;
  opponentId:   string;
  opponentName: string | null;
  result:       'win' | 'loss' | 'draw' | 'active' | 'abandoned';
  startedAt:    string;
  endedAt:      string | null;
}
export async function getGameProfile(): Promise<GameProfile> {
  return api<GameProfile>('/games/profile');
}
export async function getGameHistory(): Promise<GameHistoryItem[]> {
  return api<GameHistoryItem[]>('/games/history');
}
export interface LeaderboardEntry {
  rank:        number;
  userId:      string;
  name:        string | null;
  coins:       number;
  wins:        number;
  losses:      number;
  gamesPlayed: number;
  isMe:        boolean;
}
export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return api<LeaderboardEntry[]>('/games/leaderboard');
}

// ─── Emergency SOS ──────────────────────────────────────────────────
export interface SOSHistoryItem {
  id:               number;
  type:             'emergency' | 'test';
  latitude:         number | null;
  longitude:        number | null;
  contactsNotified: number;
  createdAt:        string;
}
export async function sendSOS(
  latitude: number | null, longitude: number | null, test: boolean, contactIds?: string[],
): Promise<{ contactsNotified: number; id: number; createdAt: string }> {
  return api('/user/sos', { method: 'POST', json: { latitude, longitude, test, contactIds } });
}
export async function listSOSHistory(): Promise<SOSHistoryItem[]> {
  return api<SOSHistoryItem[]>('/user/sos');
}

// ─── Trusted (emergency) contacts ───────────────────────────────────
export interface TrustedContact {
  userId:  string;
  name:    string | null;
  vaultId: string | null;
  online:  boolean;
}
export async function listTrustedContacts(): Promise<TrustedContact[]> {
  return api<TrustedContact[]>('/contacts/trusted');
}
export async function addTrustedContact(vaultId: string): Promise<TrustedContact> {
  return api<TrustedContact>('/contacts/trusted', { method: 'POST', json: { vaultId: vaultId.replace(/^@/, '') } });
}
export async function removeTrustedContact(userId: string): Promise<void> {
  await api(`/contacts/trusted/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// ─── Mutual-consent contact sync ────────────────────────────────────
export interface SyncInitiator {
  userId:      string;
  displayName: string | null;
  email:       string | null;
  phoneNumber: string | null;
}
export async function createSyncCode(): Promise<{ success: boolean; code: string }> {
  return api('/contacts/sync/create', { method: 'POST' });
}
export async function getSyncStatus(code: string): Promise<{ verified: boolean }> {
  return api(`/contacts/sync/${encodeURIComponent(code)}`);
}
export async function verifySyncCode(code: string): Promise<{ success: boolean; initiator: SyncInitiator }> {
  return api('/contacts/sync/verify', { method: 'POST', json: { code } });
}

// ─── Broadcast channels ─────────────────────────────────────────────
export interface Channel {
  id:              string;
  name:            string;
  description:     string | null;
  adminId:         string;
  isAdmin:         boolean;
  inviteCode:      string;
  createdAt:       string;
  lastPostAt:      string | null;
  lastPost:        string | null;
  subscriberCount?: number;
}
export interface ChannelPost {
  id:         number;
  text:       string;
  authorId:   string;
  authorName?: string | null;
  createdAt:  string;
}
export async function listChannels(): Promise<Channel[]> {
  return api<Channel[]>('/channels');
}
export async function createChannel(name: string, description?: string): Promise<Channel> {
  return api<Channel>('/channels', { method: 'POST', json: { name, description: description ?? '' } });
}
export async function joinChannel(code: string): Promise<Channel> {
  return api<Channel>('/channels/join', { method: 'POST', json: { code } });
}
export async function listChannelPosts(
  channelId: string, opts: { before?: number; limit?: number } = {},
): Promise<ChannelPost[]> {
  const p: string[] = [];
  if (opts.before) p.push(`before=${opts.before}`);
  if (opts.limit) p.push(`limit=${opts.limit}`);
  const qs = p.length ? `?${p.join('&')}` : '';
  return api<ChannelPost[]>(`/channels/${encodeURIComponent(channelId)}/posts${qs}`);
}
export async function postToChannel(channelId: string, text: string): Promise<ChannelPost> {
  return api<ChannelPost>(`/channels/${encodeURIComponent(channelId)}/posts`, { method: 'POST', json: { text } });
}

// ─── Profile / VaultID ──────────────────────────────────────────────
export interface MyProfile {
  id:       string;
  email:    string | null;
  name:     string | null;
  phone:    string | null;
  photoURL: string | null;
  vaultId:  string | null;
  status:   string | null;
}
export async function getMyProfile(): Promise<MyProfile> {
  return api<MyProfile>('/user/profile');
}

export interface ResolvedVault {
  userId:   string;
  name:     string | null;
  photoURL: string | null;
  vaultId:  string;
}
// Resolve a public VaultID handle (leading '@' tolerated) to a user stub.
export async function resolveVaultId(vaultId: string): Promise<ResolvedVault> {
  const vid = vaultId.replace(/^@/, '').trim();
  return api<ResolvedVault>(`/user/by-vault/${encodeURIComponent(vid)}`);
}

export async function getMessages(chatId: string, opts: { before?: number; limit?: number } = {}): Promise<Message[]> {
  const params: string[] = [];
  if (opts.before) params.push(`before=${opts.before}`);
  if (opts.limit) params.push(`limit=${opts.limit}`);
  const qs = params.length ? `?${params.join('&')}` : '';
  return api<Message[]>(`/chats/${encodeURIComponent(chatId)}/messages${qs}`);
}

export async function sendMessage(
  chatId: string,
  plaintext: string,
  type: Message['type'] = 'text',
  opts: { replyToId?: number | null; meta?: any } = {},
): Promise<Message> {
  const content = await encryptForChat(chatId, plaintext);
  const msg = await api<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    json: { content, type, replyToId: opts.replyToId ?? null, meta: opts.meta ?? null },
  });
  if (content !== plaintext) await cacheOwnPlaintext(chatId, msg?.id, plaintext);
  return msg;
}

export async function editMessage(chatId: string, msgId: number, plaintext: string): Promise<Message> {
  const content = await encryptForChat(chatId, plaintext);
  const msg = await api<Message>(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}`, {
    method: 'PATCH',
    json: { content },
  });
  // Cache the edited plaintext so the sender can read their own edited message
  // (the server now holds ciphertext we can't self-decrypt).
  if (content !== plaintext) await cacheOwnPlaintext(chatId, msgId, plaintext);
  return msg;
}

export async function deleteMessage(chatId: string, msgId: number): Promise<{ id: number; deletedAt: string }> {
  return api(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}`, { method: 'DELETE' });
}

export async function markRead(chatId: string, lastReadMessageId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/read`, {
    method: 'POST',
    json: { lastReadMessageId },
  });
}

export async function markDelivered(chatId: string, lastDeliveredMessageId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/delivered`, {
    method: 'POST',
    json: { lastDeliveredMessageId },
  });
}

// ─── Polls ──────────────────────────────────────────────────────────
// A poll is a message of type 'poll' whose content is the question and
// whose meta.options is a string[] of choice labels. Votes are stored
// separately keyed by message_id.
export interface PollVoteSummary {
  counts: Record<string, number>;  // optionIndex (string) → count
  mine:   number[];                 // option indices I voted for
  total:  number;
}

// Send a poll message. Allowed lengths: question ≤ 200, 2..10 options each ≤ 100.
export async function createPoll(
  chatId: string,
  question: string,
  options: string[],
  allowMultiple = false,
): Promise<Message> {
  return sendMessage(chatId, question, 'poll', {
    meta: { options, allowMultiple },
  });
}

export async function voteOnPoll(
  chatId: string, messageId: number, optionIndex: number,
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/messages/${messageId}/vote`, {
    method: 'POST',
    json:   { optionIndex },
  });
}

export async function unvotePoll(
  chatId: string, messageId: number, optionIndex: number,
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/messages/${messageId}/vote/${optionIndex}`, {
    method: 'DELETE',
  });
}

export async function getPollVotes(
  chatId: string, messageId: number,
): Promise<PollVoteSummary> {
  return api(`/chats/${encodeURIComponent(chatId)}/messages/${messageId}/votes`);
}

export async function getPollVotesBulk(
  chatId: string, messageIds: number[],
): Promise<Record<string, PollVoteSummary>> {
  if (messageIds.length === 0) return {};
  return api(`/chats/${encodeURIComponent(chatId)}/poll-votes?messageIds=${messageIds.join(',')}`);
}

// ─── Bookmarks (saved messages) ─────────────────────────────────────
export interface BookmarkRow {
  id:        string;
  note:      string | null;
  createdAt: string;
  message:   {
    id:        number;
    chatId:    string;
    chatType:  'direct' | 'group';
    chatName:  string | null;
    senderId:  string;
    senderName?: string | null;
    type:      Message['type'];
    content:   string | null;
    meta?:     any;
    createdAt: string;
    deletedAt: string | null;
  } | null;
}

export async function listBookmarks(): Promise<BookmarkRow[]> {
  return api<BookmarkRow[]>('/user/bookmarks');
}

export async function addBookmark(messageId: number, note?: string | null): Promise<{ id: string }> {
  return api('/user/bookmarks', { method: 'POST', json: { messageId, note: note ?? null } });
}

export async function removeBookmark(id: string): Promise<void> {
  await api(`/user/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Stories (24-hour ephemeral posts) ──────────────────────────────
export interface StoryItem {
  id:           string;
  attachmentId: string;
  mediaType:    'image' | 'video' | 'text';
  caption:      string | null;
  text?:        string | null;     // text status
  bgColor?:     string | null;     // text status background
  encrypted?:   boolean;
  createdAt:    string;
  expiresAt:    string;
  seen:         boolean;
}
export interface StoryFeedEntry {
  userId:    string;
  name:      string | null;
  email:     string | null;
  photoURL:  string | null;
  isMine:    boolean;
  seenAll:   boolean;
  latestAt:  string;
  stories:   StoryItem[];
}
export interface StoryViewer {
  userId:    string;
  name:      string | null;
  email:     string | null;
  photoURL:  string | null;
  viewedAt:  string;
}

export async function addStory(
  attachmentId: string,
  mediaType: 'image' | 'video',
  caption?: string,
): Promise<StoryItem> {
  return api('/stories', { method: 'POST', json: { attachmentId, mediaType, caption } });
}

/** Post a WhatsApp-style text status (no attachment — just text + a bg color). */
export async function postTextStory(text: string, bgColor: string): Promise<any> {
  return api('/stories', { method: 'POST', json: { mediaType: 'text', text, bgColor } });
}

export type StatusPrivacyMode = 'contacts' | 'except' | 'only';
export async function getStatusPrivacy(): Promise<{ mode: StatusPrivacyMode; userIds: string[] }> {
  try { return await api<{ mode: StatusPrivacyMode; userIds: string[] }>('/stories/privacy'); }
  catch { return { mode: 'contacts', userIds: [] }; }
}
export async function setStatusPrivacy(mode: StatusPrivacyMode, userIds: string[]): Promise<void> {
  await api('/stories/privacy', { method: 'PUT', json: { mode, userIds } });
}

// W7: viewer ids to wrap an encrypted story's content key for (the author's
// current audience). Fetched before posting an encrypted story.
export async function getStoryAudience(): Promise<string[]> {
  const r = await api<{ viewerIds: string[] }>('/stories/audience');
  return r?.viewerIds ?? [];
}

// W7: post an encrypted story (opaque ciphertext attachment + per-viewer wrapped keys).
export async function addEncryptedStory(
  attachmentId: string,
  mediaType: 'image' | 'video',
  keys: { viewerId: string; wrappedKey: string }[],
  caption?: string,
): Promise<StoryItem> {
  return api('/stories', { method: 'POST', json: { attachmentId, mediaType, caption, encrypted: true, keys } });
}

// W7: the caller's own wrapped content key for an encrypted story (404 if not in audience).
export async function getStoryKey(storyId: string): Promise<string | null> {
  try {
    const r = await api<{ wrappedKey: string }>(`/stories/${encodeURIComponent(storyId)}/key`);
    return r?.wrappedKey ?? null;
  } catch (e: any) {
    if (e?.status === 404 || e?.status === 410) return null;
    throw e;
  }
}

export async function listStoriesFeed(): Promise<StoryFeedEntry[]> {
  return api('/stories/feed');
}

export async function listStoryViews(storyId: string): Promise<StoryViewer[]> {
  return api(`/stories/${encodeURIComponent(storyId)}/views`);
}

export async function markStoryViewed(storyId: string): Promise<void> {
  await api(`/stories/${encodeURIComponent(storyId)}/viewed`, { method: 'POST' });
}

export async function deleteStory(storyId: string): Promise<void> {
  await api(`/stories/${encodeURIComponent(storyId)}`, { method: 'DELETE' });
}

// ─── Scheduled messages ─────────────────────────────────────────────
// Server holds the row in scheduled_messages; a worker delivers it at
// send_at. POST returns the pending row; GET lists mine (pending + sent
// in last 7 days); DELETE cancels a still-pending row.
export interface ScheduledMessageRow {
  id:         string;
  chatId:     string;
  chatName?:  string | null;
  chatType?:  'direct' | 'group';
  type:       Message['type'];
  content:    string | null;
  meta?:      any;
  replyToId:  number | null;
  sendAt:     string;
  sentAt?:    string | null;
  messageId?: number | null;
  createdAt:  string;
}

export async function listScheduledMessages(): Promise<ScheduledMessageRow[]> {
  return api<ScheduledMessageRow[]>('/user/scheduled-messages');
}

export async function scheduleMessage(opts: {
  chatId:    string;
  sendAt:    string;                 // ISO timestamp
  type?:     Message['type'];        // default 'text'
  content?:  string | null;
  meta?:     any;
  replyToId?: number | null;
}): Promise<ScheduledMessageRow> {
  return api('/user/scheduled-messages', { method: 'POST', json: opts });
}

export async function cancelScheduledMessage(id: string): Promise<void> {
  await api(`/user/scheduled-messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Ghost Mode (per-contact privacy overrides) ─────────────────────
export interface GhostMode {
  targetId:      string;
  hideOnline:    boolean;
  hideTyping:    boolean;
  hideRead:      boolean;
  hideLastSeen:  boolean;
  updatedAt?:    string;
  // Joined-from-users fields (only present in /ghost-mode list endpoint)
  name?:         string | null;
  email?:        string | null;
  photoURL?:     string | null;
}

export async function listGhostMode(): Promise<GhostMode[]> {
  return api<GhostMode[]>('/user/ghost-mode');
}

export async function getGhostMode(targetId: string): Promise<GhostMode> {
  return api<GhostMode>(`/user/ghost-mode/${encodeURIComponent(targetId)}`);
}

export async function setGhostMode(
  targetId: string,
  patch: Partial<Pick<GhostMode, 'hideOnline' | 'hideTyping' | 'hideRead' | 'hideLastSeen'>>,
): Promise<void> {
  await api(`/user/ghost-mode/${encodeURIComponent(targetId)}`, {
    method: 'PUT',
    json: patch,
  });
}

export async function clearGhostMode(targetId: string): Promise<void> {
  await api(`/user/ghost-mode/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
}

// ─── Sessions (login alerts + remote kill) ──────────────────────────
export interface SessionRow {
  id:         string;
  userAgent:  string | null;
  ip:         string | null;
  createdAt:  string;
  lastUsedAt: string | null;
  expiresAt:  string;
  isCurrent:  boolean;
}

// Pass the user's own refresh token in X-Current-Refresh so the server
// can flag which row is "current" (and so revoke-all-others can preserve
// it). We pull from SecureStore via getRefreshToken().
async function currentRefreshHeader(): Promise<Record<string, string>> {
  const { getRefreshToken } = await import('./api');
  const t = await getRefreshToken();
  return t ? { 'X-Current-Refresh': t } : {};
}

export async function listSessions(): Promise<SessionRow[]> {
  return api<SessionRow[]>('/user/sessions', {
    headers: await currentRefreshHeader(),
  });
}

export async function revokeSession(id: string): Promise<void> {
  await api(`/user/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function revokeAllOtherSessions(): Promise<{ revoked: number }> {
  return api('/user/sessions', {
    method: 'DELETE',
    headers: await currentRefreshHeader(),
  });
}

// ─── GDPR export / account delete (Day 15) ──────────────────────────
export async function deleteAccount(): Promise<void> {
  await api('/user/account', { method: 'DELETE' });
}

// Returns the export as a raw JSON string (consumer can write it to disk
// via expo-file-system + share). We return a string rather than parsed
// JSON so the on-disk artifact matches byte-for-byte what the server sent.
export async function exportMyData(): Promise<string> {
  const tok = await getAccessToken();
  const res = await fetch(`${SERVER_URL}/user/export`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Export failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.text();
}

// ─── Group admin (Day 14) ───────────────────────────────────────────
export async function updateChat(
  chatId: string,
  patch: {
    name?: string; photoURL?: string; description?: string; disappearingSeconds?: number | null;
    slowModeSeconds?: number; sendPolicy?: 'everyone' | 'admins';
    mediaPolicy?: 'everyone' | 'admins'; addMembersPolicy?: 'everyone' | 'admins';
    antiSpamLinks?: boolean; approveMembers?: boolean;
  },
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', json: patch });
}

// Convenience: set or clear the chat's disappearing-messages timer.
// Pass null/0 to turn off.
export async function setDisappearing(chatId: string, seconds: number | null): Promise<void> {
  await updateChat(chatId, { disappearingSeconds: seconds });
}

export async function addChatMembers(
  chatId: string,
  userIds: string[],
): Promise<{ added: string[] }> {
  return api(`/chats/${encodeURIComponent(chatId)}/members`, {
    method: 'POST',
    json: { userIds },
  });
}

export async function removeChatMember(chatId: string, userId: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

// Promote/demote a group member between 'admin' and 'member' (owner-gated
// for demotions). The 'owner' role can't be set through this endpoint.
export async function setMemberRole(
  chatId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    json: { role },
  });
}

// ─── Search (Day 13) ────────────────────────────────────────────────
export interface SearchChatHit {
  id:            string;
  type:          'direct' | 'group';
  name:          string | null;
  photoURL:      string | null;
  lastMessageAt: string | null;
}
export interface SearchMessageHit {
  id:        number;
  chatId:    string;
  chatName:  string | null;
  chatType:  'direct' | 'group';
  senderId:  string;
  type:      Message['type'];
  snippet:   string;
  createdAt: string;
}
export interface SearchResults {
  chats:    SearchChatHit[];
  messages: SearchMessageHit[];
}
export async function searchAll(q: string, limit = 20): Promise<SearchResults> {
  const params = new URLSearchParams({ q, limit: String(limit) }).toString();
  return api<SearchResults>(`/chats/search?${params}`);
}

// ─── Invite links ───────────────────────────────────────────────────
export interface InviteLink {
  id:        number;
  code:      string;
  chatId:    string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses:   number;
  uses:      number;
  revoked:   boolean;
}
export async function listInviteLinks(chatId: string): Promise<InviteLink[]> {
  return api<InviteLink[]>(`/chats/${encodeURIComponent(chatId)}/invite-links`);
}
export async function createInviteLink(
  chatId: string,
  opts: { expiresInHours?: number; maxUses?: number } = {},
): Promise<InviteLink> {
  return api<InviteLink>(`/chats/${encodeURIComponent(chatId)}/invite-links`, {
    method: 'POST',
    json: { expiresInHours: opts.expiresInHours ?? 0, maxUses: opts.maxUses ?? 0 },
  });
}
export async function revokeInviteLink(chatId: string, linkId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/invite-links/${linkId}`, { method: 'DELETE' });
}
// Redeem a code and join the group. Returns the chat id; `pending` is true
// when the group requires admin approval, `alreadyMember` if already joined.
export async function joinViaInvite(
  code: string,
): Promise<{ chatId: string; pending?: boolean; alreadyMember?: boolean }> {
  return api(`/chats/join/${encodeURIComponent(code)}`, { method: 'POST' });
}

// Join requests (approve-members groups; admin only).
export interface JoinRequest {
  userId:      string;
  name:        string | null;
  photoURL:    string | null;
  requestedAt: string;
}
export async function listJoinRequests(chatId: string): Promise<JoinRequest[]> {
  return api<JoinRequest[]>(`/chats/${encodeURIComponent(chatId)}/join-requests`);
}
export async function approveJoinRequest(chatId: string, userId: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/join-requests/${encodeURIComponent(userId)}/approve`, { method: 'POST' });
}
export async function rejectJoinRequest(chatId: string, userId: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/join-requests/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// In-chat message search — matches text content within a single chat.
export interface InChatMessageHit {
  id:         number;
  senderId:   string;
  senderName: string | null;
  content:    string;
  type:       Message['type'];
  createdAt:  string;
}
// ZERO-KNOWLEDGE: searches the DECRYPTED local message store, never the server
// (which only holds ciphertext). Covers the chat history cached on this device.
export async function searchInChat(chatId: string, q: string, limit = 80): Promise<InChatMessageHit[]> {
  const term = q.trim().toLowerCase();
  if (!term || !chatId) return [];

  const { getCachedMessages } = await import('./localDb');
  const [msgs, chat] = await Promise.all([
    getCachedMessages(chatId, 1000),
    getChat(chatId).catch(() => null),
  ]);

  const nameById = new Map<string, string>();
  for (const m of chat?.members ?? []) {
    if (m.userId) nameById.set(m.userId, m.name || m.email || '');
  }

  const hits: InChatMessageHit[] = [];
  for (const m of msgs) {
    if (m.type !== 'text' || m.deletedAt) continue;
    const text = await decryptFromChat(chatId, m.senderId, m.content, m.id);
    if (text && text.toLowerCase().includes(term)) {
      hits.push({
        id:         m.id,
        senderId:   m.senderId,
        senderName: nameById.get(m.senderId) || null,
        content:    text,
        type:       m.type,
        createdAt:  m.createdAt,
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

// ─── Mute (Day 11) ──────────────────────────────────────────────────
export async function muteChat(chatId: string, muted: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/mute`, {
    method: 'POST',
    json: { muted },
  });
}

// ─── Pin / Archive (P1 polish) ──────────────────────────────────────
export async function pinChat(chatId: string, pinned: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/pin`, {
    method: 'POST',
    json: { pinned },
  });
}
export async function archiveChat(chatId: string, archived: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/archive`, {
    method: 'POST',
    json: { archived },
  });
}
// Hide / unhide a chat. Hidden chats vanish from the default GET /chats
// response and the realtime list refresh; they're still reachable via
// the PIN-gated /hidden-chats screen.
export async function setHidden(chatId: string, hidden: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/hidden`, {
    method: 'PATCH',
    json: { hidden },
  });
}

// Per-chat notification sound — value is the Android channelId the client
// registered ('default' | 'chime' | 'bell'). 'default' clears the override.
export async function setChatNotifSound(chatId: string, sound: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/notif-sound`, {
    method: 'PATCH',
    json: { sound },
  });
}

// Verify the user's saved profile PIN. Returns { ok: true|false } —
// the server-side route is hash-only so we can't recover the PIN, just
// check it. Used by the hidden-chats screen as a gate.
export async function verifyPin(pin: string): Promise<boolean> {
  const r = await api<{ ok: boolean }>('/user/pin/verify', {
    method: 'POST',
    json: { pin },
  });
  return !!r?.ok;
}

// ─── Settings / Privacy (Day 11) ────────────────────────────────────
export interface UserSettings {
  discoverable:        boolean;
  lastSeenVisible:     boolean;
  readReceipts:        boolean;
  profilePhotoVisible: boolean;
  groupAddPolicy?:     'everyone' | 'contacts' | 'nobody';
  defaultDisappearingSeconds?: number;
}
export async function getSettings(): Promise<UserSettings> {
  return api<UserSettings>('/user/settings');
}
export async function updateSettings(patch: Partial<UserSettings>): Promise<void> {
  await api('/user/settings', { method: 'PUT', json: patch });
}

/** Groups both me and `userId` are in (WhatsApp "groups in common"). */
export async function getCommonGroups(userId: string): Promise<{ id: string; name: string | null; photoURL: string | null }[]> {
  try {
    const r = await api<{ groups: { id: string; name: string | null; photoURL: string | null }[] }>(`/chats/common/${encodeURIComponent(userId)}`);
    return r.groups || [];
  } catch { return []; }
}

// ─── Communities (WhatsApp) ─────────────────────────────────────────
export interface Community { id: string; name: string; description: string | null; photoURL: string | null; groupCount: number; }
export interface CommunityGroup { id: string; name: string; photoURL: string | null; isAnnouncement: boolean; members: number; }
export interface CommunityDetail { id: string; name: string; description: string | null; photoURL: string | null; isOwner: boolean; groups: CommunityGroup[]; }

export async function listCommunities(): Promise<Community[]> {
  try { const r = await api<{ communities: Community[] }>('/communities'); return r.communities || []; } catch { return []; }
}
export async function createCommunity(name: string, description?: string): Promise<{ id: string; announcementChatId: string }> {
  return api('/communities', { method: 'POST', json: { name, description } });
}
export async function getCommunity(id: string): Promise<CommunityDetail> {
  return api(`/communities/${encodeURIComponent(id)}`);
}
export async function createCommunityGroup(communityId: string, name: string): Promise<{ id: string }> {
  return api(`/communities/${encodeURIComponent(communityId)}/groups`, { method: 'POST', json: { name } });
}

// ─── Blocks (Day 11) ────────────────────────────────────────────────
export interface BlockedUser {
  userId:    string;
  name:      string | null;
  email:     string | null;
  photoURL:  string | null;
  createdAt: string;
}
export async function listBlocks(): Promise<BlockedUser[]> {
  return api<BlockedUser[]>('/user/blocks');
}
export async function blockUser(userId: string): Promise<void> {
  await api('/user/blocks', { method: 'POST', json: { userId } });
}
export async function unblockUser(userId: string): Promise<void> {
  await api(`/user/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// File an abuse report against a user (moderation queue).
export async function reportUser(
  reportedUserId: string, reason?: string, context?: string,
): Promise<void> {
  await api('/user/reports', { method: 'POST', json: { reportedUserId, reason: reason ?? null, context: context ?? null } });
}

// ─── Reactions (Day 8) ──────────────────────────────────────────────
export interface ReactionSummary { emoji: string; count: number; mine: boolean }
export interface Reactor          { emoji: string; userId: string; name: string | null; email: string | null }

export async function addReaction(chatId: string, msgId: number, emoji: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}/reactions`, {
    method: 'PUT',
    json: { emoji },
  });
}

export async function removeReaction(chatId: string, msgId: number, emoji: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}/reactions`, {
    method: 'DELETE',
    json: { emoji },
  });
}

export async function listReactors(chatId: string, msgId: number): Promise<Reactor[]> {
  return api(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}/reactions`);
}

export async function getReactionCounts(
  chatId: string, messageIds: number[],
): Promise<Record<string, ReactionSummary[]>> {
  if (messageIds.length === 0) return {};
  const ids = messageIds.join(',');
  return api(`/chats/${encodeURIComponent(chatId)}/reactions?messageIds=${ids}`);
}

// ─── Forward (Day 8) ────────────────────────────────────────────────
// Server-side it's still a normal POST /messages — we just preserve the
// original sender/chat in meta.forwardedFrom so the receiving bubble can
// render a "Forwarded" label.
export async function forwardMessage(
  source: { id: number; chatId: string; senderId: string; type: Message['type']; content: string | null; meta?: any },
  targetChatId: string,
): Promise<Message> {
  return sendMessage(targetChatId, source.content ?? '', source.type, {
    meta: {
      ...(source.meta ?? {}),
      forwardedFrom: { messageId: source.id, chatId: source.chatId, senderId: source.senderId },
    },
  });
}

// ─── WebRTC ICE config (calls) ──────────────────────────────────────
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
export interface TurnConfig {
  iceServers: IceServer[];
  ttl?: number;
}

/** Fetch ephemeral TURN credentials. Cache for ~12h on the client. */
export async function getTurnConfig(): Promise<TurnConfig> {
  return api<TurnConfig>('/user/turn');
}

// ─── Phone normalization + hash (Day 5 — must match backend) ────────
// SAME logic as vaultchat-backend/routes/chats.js:normalizePhone / hashPhone:
//   * strip non-digits
//   * if exactly 10 digits → prepend "91" (India default for unprefixed)
//   * SHA-256 of the resulting digits string, hex output
// If the two diverge, contact discovery silently returns zero matches —
// keep them in sync.

export function normalizePhoneForHash(raw: string): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = '91' + d;
  return d;
}

export async function hashPhoneForLookup(raw: string): Promise<string | null> {
  const norm = normalizePhoneForHash(raw);
  if (!norm) return null;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, norm);
}

// ─── Contact discovery (Day 5) ──────────────────────────────────────
export interface MatchedContact {
  id:        string;
  name:      string | null;
  photoURL:  string | null;
  phoneHash: string;
}

/**
 * Send a batch of phone-hashes to the server; get back the matching
 * VaultChat users. Server caps at 5000 hashes/request and rate-limits
 * the endpoint. Empty input → returns [].
 */
export async function matchContacts(phoneHashes: string[]): Promise<MatchedContact[]> {
  const clean = Array.from(new Set(phoneHashes.filter(Boolean)));
  if (clean.length === 0) return [];
  return api<MatchedContact[]>('/contacts/match', {
    method: 'POST',
    json: { phoneHashes: clean },
  });
}

// ─── Attachments (Phase 4) ──────────────────────────────────────────

export interface UploadResult {
  id:       string;
  mime:     string;
  size:     number;
  filename: string;
}

/**
 * Upload a file (image / document) and get back an attachment ID.
 * `uri` is the local file URI from expo-image-picker / expo-document-picker.
 * The returned id goes into the next message's meta.attachmentId.
 */
export async function uploadAttachment(
  uri: string,
  filename: string,
  mime: string,
  opts: { viewOnce?: boolean } = {},
): Promise<UploadResult> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');

  // Object-store path: get a presigned PUT URL and upload the bytes DIRECTLY to
  // storage (they never pass through the app server). Falls back to the multipart
  // route below when the server has no object storage configured (503) or the
  // presign path errors — so media never silently fails to send.
  try {
    let size = 0;
    try {
      const fi: any = await FileSystem.getInfoAsync(uri);
      if (fi?.exists && typeof fi.size === 'number') size = fi.size;
    } catch {}
    const presign = await api<{ id: string; uploadUrl: string }>('/uploads/presign', {
      method: 'POST',
      json: { filename, mime, size, viewOnce: !!opts.viewOnce },
    });
    if (presign?.uploadUrl) {
      const put = await FileSystem.uploadAsync(presign.uploadUrl, uri, {
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': mime },
      });
      if (put.status >= 200 && put.status < 300) {
        return { id: presign.id, mime, size, filename };
      }
      throw new Error(`object-store upload failed (HTTP ${put.status})`);
    }
  } catch (e: any) {
    if (__DEV__ && e?.status !== 503) {
      console.warn('[upload] presign path failed, using multipart:', e?.message);
    }
  }

  const form = new FormData();
  // React Native's FormData accepts {uri, name, type} objects for files
  form.append('file', { uri, name: filename, type: mime } as any);

  // viewOnce=1 tells the backend to set attachments.view_once=TRUE so the
  // first non-owner GET hard-blocks subsequent reads.
  const qs = opts.viewOnce ? '?viewOnce=1' : '';
  const res = await fetch(`${SERVER_URL}/uploads${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try { const j: any = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<UploadResult>;
}

// Mark a view-once attachment as consumed. Called by the recipient's
// client when the bubble first reveals the media. Server-side, idempotent
// — only the first call actually flips the flag.
export async function markAttachmentViewed(attachmentId: string): Promise<void> {
  await api(`/uploads/${encodeURIComponent(attachmentId)}/viewed`, { method: 'POST' });
}

/**
 * Build the authenticated URL for fetching an attachment. The fetch
 * still needs an Authorization header — that's why callers usually pass
 * this URL through an `Image` source with a `headers` option, or
 * download via `fetch` to a local cache first.
 */
export function attachmentUrl(attachmentId: string): string {
  return `${SERVER_URL}/uploads/${encodeURIComponent(attachmentId)}`;
}

export default {};
