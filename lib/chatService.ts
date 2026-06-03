// Chat / message REST helpers. Wraps the /chats backend routes (Phase 3a)
// and handles the encrypt/decrypt seam — currently pass-through, swap to
// double-ratchet in Phase 3b without touching call sites.

import * as Crypto from 'expo-crypto';
import { api, getAccessToken } from './api';
import { SERVER_URL } from '../constants/server';

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
  unreadCount:   number;
  // Direct-chat only — the other user's profile snapshot (null for groups)
  peerUserId?:     string | null;
  peerName?:       string | null;
  peerPhotoURL?:   string | null;
  peerOnline?:     boolean;
  peerLastSeenAt?: string | null;
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
}

export interface ChatDetail extends ChatSummary {
  members: ChatMember[];
}

export interface Message {
  id:        number;
  chatId:    string;
  senderId:  string;
  type:      'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'system';
  content:   string | null;        // opaque ciphertext (currently plaintext during Phase 3a)
  meta?:     any;
  replyToId: number | null;
  editedAt:  string | null;
  deletedAt: string | null;
  createdAt: string;
}

// ─── Encryption seam (Phase 3b: replace these with real crypto) ──────
// For now content goes over the wire as plaintext. The server stores it
// opaque either way — no schema change when we swap to real ciphertext.

export async function encryptForChat(_chatId: string, plaintext: string): Promise<string> {
  // TODO Phase 3b: encrypt with the chat's group key / double-ratchet session.
  return plaintext;
}

export async function decryptFromChat(_chatId: string, _senderId: string, ciphertext: string | null): Promise<string> {
  // TODO Phase 3b: decrypt with the sender's session keys.
  return ciphertext ?? '';
}

// ─── REST ───────────────────────────────────────────────────────────

export async function listChats(): Promise<ChatSummary[]> {
  return api<ChatSummary[]>('/chats');
}

export async function getChat(chatId: string): Promise<ChatDetail> {
  return api<ChatDetail>(`/chats/${encodeURIComponent(chatId)}`);
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
  return api<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    json: { content, type, replyToId: opts.replyToId ?? null, meta: opts.meta ?? null },
  });
}

export async function editMessage(chatId: string, msgId: number, plaintext: string): Promise<Message> {
  const content = await encryptForChat(chatId, plaintext);
  return api<Message>(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}`, {
    method: 'PATCH',
    json: { content },
  });
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
  patch: { name?: string; photoURL?: string },
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', json: patch });
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

// ─── Mute (Day 11) ──────────────────────────────────────────────────
export async function muteChat(chatId: string, muted: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/mute`, {
    method: 'POST',
    json: { muted },
  });
}

// ─── Settings / Privacy (Day 11) ────────────────────────────────────
export interface UserSettings {
  discoverable:        boolean;
  lastSeenVisible:     boolean;
  readReceipts:        boolean;
  profilePhotoVisible: boolean;
}
export async function getSettings(): Promise<UserSettings> {
  return api<UserSettings>('/user/settings');
}
export async function updateSettings(patch: Partial<UserSettings>): Promise<void> {
  await api('/user/settings', { method: 'PUT', json: patch });
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
): Promise<UploadResult> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');

  const form = new FormData();
  // React Native's FormData accepts {uri, name, type} objects for files
  form.append('file', { uri, name: filename, type: mime } as any);

  const res = await fetch(`${SERVER_URL}/uploads`, {
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
