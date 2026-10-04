// Chat / message REST helpers. Wraps the /chats backend routes (Phase 3a)
// and handles the encrypt/decrypt seam — currently pass-through, swap to
// double-ratchet in Phase 3b without touching call sites.

import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { api, getAccessToken, httpErrorMessage } from './api';
import { Buffer } from 'buffer';   // not a RN global — see myUserId's token fallback
import { splitMeta, wrapEnvelope, unwrapEnvelope } from './msgEnvelope';
import perf from './perf';
import { SERVER_URL } from '../constants/server';
import { E2EE_ENABLED, GROUP_E2EE, E2EE_STRICT, UPLOAD_PROGRESS } from '../constants/flags';
// Group types and permissions are defined once, in lib/groups, and mirrored
// server-side in internal/groups. Import rather than restate them.
import type { GroupType } from './groups/catalog';
import type { Permission, GroupRole } from './groups/permissions';
import { redactIds, warnOnce } from './diagLog';
import { applyLocalReadPointers } from './unreadStore';
import { normalizeMsgIds } from './msgIds';
// The ONE wire→domain boundary for startup rows. Value import, but it pulls in
// nothing heavier than lib/msgIds (its ChatSummary/Message imports are
// type-only, so the cycle back to this file is erased at compile).
import { startupChatSummary, commonGroupsFromProtobuf, type CommonGroup } from './ccwire/startupAdapter';

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
  myRole:        GroupRole;
  myLastReadId:  number | null;
  muted:         boolean;
  pinned:        boolean;
  favourite:     boolean;
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
  // Opened by code, and the two have not both saved each other yet (migration
  // 119), so peerName/peerPhotoURL above are a placeholder rather than a person.
  // Trust this flag, never the placeholder name — somebody can be called Guest.
  anonMasked?: boolean;
  // Migration 120: when this WHOLE conversation deletes itself — messages,
  // membership and thread. null means never. Distinct from disappearingSeconds,
  // which expires individual messages and leaves the chat standing.
  expiresAt?: string | null;
  // Per-user screenshot policy for this chat. Backend defaults to 'block'.
  /** MY setting: what I demand of everyone ELSE's device in this chat. */
  screenshotMode?: 'allow' | 'allow_notify' | 'block' | 'block_silent';
  /** What the OTHER members demand of THIS device. Server-computed across all
   *  other members, because in a group the requirements compose. */
  peerBlocksCapture?: boolean;
  peerWantsCaptureNotice?: boolean;
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
  /**
   * Groups & Circles added 'guest' (066) and 'moderator' (069). Widened rather
   * than mapped onto the old pair: collapsing them, as lib/family/circle.ts
   * still does for the legacy Family Space view, makes a moderator
   * indistinguishable from an admin in any screen that reads this.
   */
  role:                   'guest' | 'member' | 'moderator' | 'admin' | 'owner';
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

  // ── Groups & Circles (migration 070) ──
  // groupType is null for every group created before that migration; such a
  // group is an "untyped group" and keeps the legacy admin-only rules.
  groupType?:           GroupType | null;
  icon?:                string | null;
  color?:               string | null;
  privacy?:             'private' | 'invite_only';
  /** Server-owned cap for this group's type. Never hardcode a cap client-side. */
  maxMembers?:          number | null;
  /**
   * How many gates stand between an invitation and membership. Server-
   * normalised: an unrecognised stored value arrives as 'strict', so the client
   * never draws a looser flow than the server will actually honour.
   */
  approvalMode?:        ApprovalMode;
  /**
   * THIS USER's resolved permissions in this group. Use it to decide what to
   * DRAW — never to decide what is allowed. The server re-resolves the same
   * layers on every mutating endpoint, and that check is the real one.
   */
  permissions?:         Permission[];
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
  type:      'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'system' | 'sticker' | 'poll' | 'reaction' | 'vaultbeam' | 'group_ref' | 'game_invite';
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

/**
 * Robustly resolve a direct chat's peer id, tolerating the cold-start race where
 * `_chatPeer` (in-memory) isn't populated yet — e.g. a chat opened from a push
 * or a just-created chat, before listChats/getChat ran. Retries getChat, then
 * falls back to a full listChats (which caches every chat's peer), with backoff.
 * Returns null only if the chat is genuinely a group or truly unresolvable.
 */
async function resolvePeerId(chatId: string, attempts = 3): Promise<string | null> {
  let peerId = directPeerOf(chatId);
  if (peerId) return peerId;
  if (_chatPeer.get(chatId)?.type === 'group') return null;
  for (let i = 0; i < attempts; i++) {
    try { await getChat(chatId); } catch {}
    peerId = directPeerOf(chatId);
    if (peerId) return peerId;
    if (_chatPeer.get(chatId)?.type === 'group') return null;
    // getChat alone may not surface peerUserId for a freshly-created chat — a
    // full list reliably caches every direct chat's peer.
    try { await listChats(); } catch {}
    peerId = directPeerOf(chatId);
    if (peerId) return peerId;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 300));
  }
  return peerId;
}

/** True when this chat is a known direct (1:1) chat — i.e. media/text can be E2E
 *  encrypted to a single peer. Group chats return false (no group E2EE yet). */
export function isDirectChat(chatId: string): boolean {
  return directPeerOf(chatId) != null;
}

/**
 * Async, race-tolerant version of isDirectChat: resolves the peer (retrying
 * getChat/listChats) before answering, so the media send path can decide
 * encrypt-vs-plaintext reliably instead of silently falling to plaintext when
 * the peer just isn't cached yet. Returns false for genuine group chats.
 */
export async function ensureDirectChat(chatId: string): Promise<boolean> {
  if (_chatPeer.get(chatId)?.type === 'group') return false;
  return (await resolvePeerId(chatId)) != null;
}

export async function encryptForChat(chatId: string, plaintext: string): Promise<string> {
  if (!E2EE_ENABLED) return plaintext;
  // Group chats (W5): encrypt with the sender-key group session when enabled.
  if (_chatPeer.get(chatId)?.type === 'group') {
    if (!GROUP_E2EE) return plaintext; // groups stay plaintext until enabled
    try {
      const g = await import('../services/crypto/groupSession.rn');
      const out = await g.groupEncryptMessage(chatId, plaintext);
      // BELT AND BRACES. groupEncryptMessage has its own non-throwing exits
      // (unknown identity, and anything a future edit adds), and every one of
      // them hands back the PLAINTEXT it was given. Checking the envelope here
      // — the single funnel every group send goes through — closes all of them
      // at once instead of trusting each early-return to stay honest.
      if (!g.isGroupEnvelope(out)) throw new Error('group sender key not ready');
      return out;
    } catch (err) {
      console.warn('[e2ee] GROUP-ENCRYPT-FAILED chat=', chatId, 'err=', (err as any)?.message);
      // STRICT: never silently downgrade a group message to plaintext. A
      // sender-key failure is almost always transient (membership fetch, the
      // pairwise session carrying the SKDM mid-rekey), so this must stay ON THE
      // CLOCK rather than turn red — the wording below is what messageQueue's
      // isKeysError matches to tag the row WAITING_KEYS and retry forever.
      if (E2EE_STRICT) throw new Error("Couldn't encrypt this message — the group's encryption keys aren't available yet. It will retry.");
      return plaintext;
    }
  }
  // Resolve the peer robustly (retries getChat + listChats to beat the
  // cold-start / fresh-chat race that made media/GIF sends fail).
  const peerId = await resolvePeerId(chatId);
  if (!peerId) {
    // Still can't resolve → can't encrypt. STRICT: refuse to leak plaintext.
    console.warn('[e2ee] PEER-NOT-RESOLVED chat=', chatId, 'entry=', JSON.stringify(_chatPeer.get(chatId)));
    if (E2EE_STRICT) throw new Error('Encryption not ready — recipient not resolved yet. Retrying…');
    return plaintext;
  }
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    const out = await e2ee.e2eeEncrypt(chatId, peerId, plaintext);
    _encryptFailStreak.delete(peerId);
    return out;
  } catch (err) {
    console.warn('[e2ee] ENCRYPT-FAILED chat=', chatId, 'peer=', peerId, 'err=', (err as any)?.message, (err as any)?.stack?.slice?.(0, 200));
    // Symmetric twin of maybeAutoRecoverSession: if OUR outbound session state
    // is what's broken (corrupt ratchet, backend-migration leftovers), every
    // retry re-hits the same state and the chat is stuck on "couldn't encrypt"
    // forever — the decrypt-side healer never fires because nothing ever goes
    // out. Two consecutive failures → drop the session so the next retry
    // re-initiates X3DH from the peer's current bundle.
    const n = (_encryptFailStreak.get(peerId) ?? 0) + 1;
    _encryptFailStreak.set(peerId, n);
    if (n >= AUTO_RECOVER_AFTER) {
      _encryptFailStreak.delete(peerId);
      try {
        const e2ee = await import('../services/crypto/e2eeSession.rn');
        await e2ee.e2eeResetSession(peerId);
        (await import('./sessionEpoch')).bumpSessionEpoch(peerId);
    stat(peerId).resets++; logSessionHealth(peerId, 'reset');
        console.warn('[e2ee] AUTO-RESET outbound session for peer', peerId, '— retry re-handshakes');
      } catch {}
    }
    // STRICT: never silently send plaintext. Throwing surfaces a failed/retry
    // bubble; the retry re-fetches the peer's key bundle and almost always
    // succeeds. (Legacy graceful mode falls back to plaintext.)
    if (E2EE_STRICT) throw new Error("Couldn't encrypt this message — the recipient's encryption keys aren't available yet. It will retry.");
    return plaintext;
  }
}
const _encryptFailStreak = new Map<string, number>();

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
  (await import('./sessionEpoch')).bumpSessionEpoch(peerId);
    stat(peerId).resets++; logSessionHealth(peerId, 'reset');
}

export async function decryptFromChat(
  chatId: string,
  senderId: string,
  ciphertext: string | null,
  messageId?: number,
  edited = false,
): Promise<string> {
  if (ciphertext == null) return '';
  if (!E2EE_ENABLED) return ciphertext;
  // Group chats (W5): a group envelope (GSK1:) is decrypted via the sender-key
  // session; anything else is pre-E2EE / plaintext history and passes through.
  // Routed on the ENVELOPE, not on chat metadata.
  //
  // This used to require `_chatPeer` to say the chat was a group. That is an
  // in-memory cache: empty on a cold start, and empty when a chat is opened
  // from a push before listChats/getChat has run. A GSK1 message arriving in
  // that window fell through to the PAIRWISE path, which does not know the
  // format — logged on device as "content looks encrypted but is not a known
  // envelope — prefix: GSK1:" with an unreadable bubble and no decrypt ever
  // attempted.
  //
  // The prefix is self-describing, so routing on it needs no lookup and cannot
  // race the cache.
  const g = await import('../services/crypto/groupSession.rn');
  if (g.isGroupEnvelope(ciphertext)) {
    if (!GROUP_E2EE) return ciphertext;
    try {
      return await g.groupDecryptMessage(chatId, senderId, messageId ?? 0, ciphertext, edited);
    } catch (err) {
      // ONCE PER SENDER, NOT ONCE PER MESSAGE. This fires for every message that
      // cannot be opened, so one broken sender key produced a warn per message —
      // 12 of them in a 3-second cold boot, all saying the same thing. The
      // message itself embeds the sender's full uuid, and console.warn ships in
      // release, so each repeat printed a user id into production logcat.
      // Behaviour is unchanged: the bubble still shows the same placeholder.
      warnOnce('gdec|' + chatId + '|' + senderId,
        '[e2ee] group decrypt failed: ' + redactIds(String((err as any)?.message ?? err)));
      return '🔒 unable to decrypt';
    }
  }
  // A group chat whose content is NOT a group envelope is pre-E2EE history —
  // it must never reach the pairwise path, which has no session for it.
  if (_chatPeer.get(chatId)?.type === 'group') return ciphertext;

  const e2ee = await import('../services/crypto/e2eeSession.rn');
  if (!e2ee.isEnvelope(ciphertext)) {
    // THE BLIND SPOT. If the UI thinks this is encrypted (looksEncrypted) but
    // the decrypt gate does not recognise the envelope, we return it untouched
    // and the bubble renders "unable to decrypt" — with NOTHING logged. That is
    // exactly the state observed on device: lock icons everywhere and not one
    // [e2ee] line. Name it, with just enough of the prefix to identify the
    // format (never the payload).
    if (looksEncrypted(ciphertext)) {
      console.warn('[e2ee] content looks encrypted but is not a known envelope — prefix:',
        String(ciphertext).slice(0, 12), 'chat:', chatId, 'sender:', senderId);
    }
    return ciphertext; // pre-E2EE plaintext history
  }
  const peerId = directPeerOf(chatId) ?? senderId;     // peer = the other party
  try {
    const pt = await e2ee.e2eeDecrypt(chatId, peerId, messageId ?? 0, ciphertext);
    _decryptFailStreak.delete(peerId);                 // healthy session — clear recovery counter
    // Reading this peer again ends the breakage episode, so a LATER failure is
    // new damage and earns a fresh complaint epoch the peer will act on. This
    // is what keeps duplicate-suppression from ever becoming deafness.
    _inEpisode.delete(peerId);
    return pt;
  } catch (err) {
    const m = String((err as any)?.message || '');
    // ONLY retry the transient out-of-order case (a follow-up message can arrive
    // before the X3DH-bearing first message bootstraps the session).
    // …but only when it COULD be out-of-order. The retry waits for an X3DH
    // message still in flight, which is a live-delivery race. Replaying history
    // has no race to wait for: every message is already on disk, so the 500ms is
    // spent to reach the identical failure.
    //
    // It was the dominant cost of every launch. A device whose identity is newer
    // than its history has no session for ANY old message, so all of them took
    // this branch — serialized, because hydrateMessages awaits per message and
    // e2eeDecrypt holds a per-peer lock. That is the 36–65s of white screen
    // recorded in syncEngine.ts, and it repeated on every single boot.
    //
    // Live decrypts run at depth 0 and keep the full retry, unchanged. The
    // branch itself is deliberately left in place: falling through to the
    // else-if would hand this to maybeAutoRecoverSession, which is not what a
    // missing session during replay means.
    if (m.includes('no session and no X3DH')) {
      for (let i = 0; _bulkDecryptDepth === 0 && i < 2; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
          const pt = await e2ee.e2eeDecrypt(chatId, peerId, messageId ?? 0, ciphertext);
          _decryptFailStreak.delete(peerId);
          return pt;
        } catch {}
      }
    } else if (!m.includes('undecryptable (cached)')) {
      // PERMANENT failure (ghash / cannot-skip / wrong key) = the ratchet is
      // desynced (peer reinstalled, DB truncate, lost state) AND the message
      // carried no X3DH header to self-heal from. Silently AUTO-RECOVER: after a
      // couple of consecutive failures the session is dead → drop it so our NEXT
      // outbound message re-initiates X3DH and the peer adopts it. No user action,
      // no "reset secure session" prompt.
      await maybeAutoRecoverSession(peerId, m);
    }
    return '🔒 unable to decrypt';
  }
}

// Per-peer consecutive permanent-decrypt-failure counter → silent session
// auto-recovery, so users never have to reset a session by hand.
const _decryptFailStreak = new Map<string, number>();
const AUTO_RECOVER_AFTER = 2;

/**
 * Which BREAKAGE a re-key request is about, per peer — the number that goes on
 * the wire so the peer can tell a new problem from one it has already answered.
 *
 * Deliberately NOT sessionEpoch(), which counts resets. That distinction is the
 * whole fix. A reset performed as a favour — because the PEER asked — is not
 * news about our own inbound, but a reset-counter bumps for it anyway, so our
 * next complaint looks new, so the peer resets again, so its complaint looks new
 * to us. Two devices modelling each other's helpfulness as fresh damage is
 * exactly the loop, and it survives any cooldown; the timer only sets its period.
 *
 * An EPISODE spans one continuous run of not being able to read a peer. It
 * opens when the fail streak trips and closes on the first successful decrypt
 * (see decryptOne). Repeated complaints inside one episode carry the same
 * number and are recognisably the same complaint. A genuinely new breakage —
 * necessarily after something decrypted — gets a new one and is acted on, so
 * suppressing duplicates costs no liveness.
 */
const _complaintEpoch = new Map<string, number>();
const _inEpisode = new Set<string>();
/** Complaint epoch we last self-reset for, per peer — one tear-down per breakage. */
const _selfResetEpoch = new Map<string, number>();
function beginComplaintEpisode(peerId: string): void {
  if (_inEpisode.has(peerId)) return;
  _inEpisode.add(peerId);
  _complaintEpoch.set(peerId, (_complaintEpoch.get(peerId) ?? 0) + 1);
}

// A reset must not be able to destroy the session a previous reset just built.
// Measured on device: three AUTO-RESETs for one peer inside 21ms —
//   01:13:15.926 / .931 / .947  AUTO-RESET dead session for peer cb1caeda…
// chat.tsx decrypts every visible bubble concurrently, so a screen of
// undecryptable history trips the streak several times before the first reset
// finishes. Each extra reset tears down the fresh session created moments
// earlier, so the peer's next message can't decrypt either — the "recovery"
// was manufacturing the very desync it exists to repair, and the peer's rekey
// request bounced it back for another round.
//
// One reset per peer per window. Recovery needs a round trip to be judged;
// anything faster is thrash, not healing.
const _lastAutoReset = new Map<string, number>();

// ── session diagnostics ────────────────────────────────────────────────
//
// Lifetime counters per peer, so a 30-minute validation call can be judged
// from the log alone: a healthy call prints this line ZERO times.
//
// Deliberately NOT logged: ratchet state, key versions, or anything derived
// from key material. A diagnostic that leaks key state is a worse bug than the
// one it is helping to find, and the counters below are enough to locate a
// divergence — what matters is HOW OFTEN sessions are torn down and whether
// both sides are doing it, not what the keys are.
const _sessionStats = new Map<string, { resets: number; fails: number; concurrent: number }>();

function stat(peerId: string) {
  let s = _sessionStats.get(peerId);
  if (!s) { s = { resets: 0, fails: 0, concurrent: 0 }; _sessionStats.set(peerId, s); }
  return s;
}

/** One line summarising a peer's session health. Call after any reset/failure. */
function logSessionHealth(peerId: string, event: string): void {
  const s = stat(peerId);
  console.warn(`[e2ee] session ${peerId.slice(0, 8)} ${event} — resets=${s.resets} decryptFails=${s.fails} concurrentRekeys=${s.concurrent}`);
}
const AUTO_RESET_COOLDOWN_MS = 60_000;
/**
 * Floor for a CALL-triggered forced reset. Long enough that a reset survives
 * one full ring cycle (offers repeat every 3s) and can actually be used, short
 * enough that a user retrying a failed call is not left waiting.
 */
const FORCED_RESET_FLOOR_MS = 15_000;

/**
 * Depth of an in-progress BULK decrypt (history render, search, cold sync).
 *
 * A failure while replaying history says nothing about the LIVE session, and
 * must never tear it down. Old messages are encrypted to ratchet states that
 * have long since advanced, so they are permanently undecryptable BY DESIGN —
 * two of them in a row is not evidence of a dead session, it is evidence that
 * the user scrolled up.
 *
 * Measured on device: a `[chats/delta] cold sync` at 14:28:37 replayed history
 * and, eight seconds later, destroyed all FOUR healthy sessions at exactly
 * decryptFails=2 each. The incoming call thirty seconds later then arrived on
 * a session that had just been reset and could not be decrypted — reported as
 * "calls not working", with the real cause two layers below the call stack.
 *
 * A counter rather than a boolean because hydrate can nest (a chat opening
 * while a sync is already running).
 */
let _bulkDecryptDepth = 0;

async function maybeAutoRecoverSession(peerId: string, errMsg: string): Promise<void> {
  // There is no pairwise session with YOURSELF, so a failure here says nothing
  // about any peer and there is nothing to recover.
  //
  // `peerId` is `directPeerOf(chatId) ?? senderId`, and directPeerOf returns
  // null for a group chat — so every one of OUR OWN group messages resolves the
  // "peer" to our own id. Those messages are read from the plaintext cache; when
  // the cache does not have them they are permanently unreadable (that is what
  // "own message(s) predate the plaintext cache" reports), and the decrypt
  // attempt that follows can only ever fail.
  //
  // Left uncaught, that tight failure loop reset a session against our own id
  // and fired rekey requests at ourselves. Measured on device 15:13:17–15:13:21
  // as ~14 ghash failures in four seconds, all for peer cb1caeda — the device's
  // own user — reaching decryptFails=10.
  const meId = await myUserId();
  if (peerId && peerId === meId) {
    console.warn('[e2ee] undecryptable own message — no session with self, ignoring:', errMsg);
    return;
  }
  // OWN ID UNKNOWN → THIS FAILURE PROVES NOTHING. Do not count it.
  //
  // The check above is the only thing separating "our own ciphertext, which can
  // never be opened by us" from "a genuinely dead session". With no id it
  // cannot make that distinction, and `peerId === ''` is false for every real
  // peer — so without this the guard silently stops guarding and own-message
  // failures flow straight into the reset streak.
  //
  // That is not a theoretical ordering: myUserId() reads SecureStore, which is
  // empty for a window on cold start — precisely while a chat screen hydrates
  // and decrypts. Two own-message failures inside that window were enough to
  // reset a healthy peer and push a rekey request at it (Honor, 2026-08-15).
  //
  // Declining to count is strictly the safe direction: the worst case is a real
  // dead session takes one more failure to be noticed, against a live bug where
  // a working session is destroyed by the other side's display problem.
  if (!meId) {
    console.warn('[e2ee] own id unknown — not counting decrypt failure toward reset:', errMsg);
    return;
  }
  // Replayed history is not evidence about the live session — see above.
  if (_bulkDecryptDepth > 0) {
    stat(peerId).fails++;
    console.warn('[e2ee] decrypt failed during history replay — not counted against the live session:', errMsg);
    return;
  }
  // A concurrent-re-key skip is NOT a decrypt failure. Both sides re-keyed at
  // once and we are the side keeping its session; the peer is about to adopt
  // it. Counting this toward the reset streak would tear down that session and
  // restart the collision — the loop this whole tie-break exists to end.
  if (errMsg.includes('concurrent re-key')) {
    stat(peerId).concurrent++;
    logSessionHealth(peerId, 'concurrent-rekey (held)');
    return;
  }
  stat(peerId).fails++;
  const n = (_decryptFailStreak.get(peerId) ?? 0) + 1;
  _decryptFailStreak.set(peerId, n);
  console.warn(`[e2ee] decrypt failed (${n}/${AUTO_RECOVER_AFTER}):`, errMsg);
  if (n < AUTO_RECOVER_AFTER) return;
  _decryptFailStreak.delete(peerId);
  // Open the episode BEFORE anything asks the peer for help, so the request
  // below carries the number that identifies this breakage.
  beginComplaintEpisode(peerId);

  const now = Date.now();
  const last = _lastAutoReset.get(peerId) ?? 0;
  if (now - last < AUTO_RESET_COOLDOWN_MS) {
    console.warn('[e2ee] auto-reset suppressed for', peerId, `— ${Math.round((now - last) / 1000)}s since last`);
    // Suppressing OUR reset must not also suppress asking the PEER to reset.
    //
    // Resetting our own session only fixes what we SEND. If the peer is still
    // encrypting to a session we have already dropped, nothing improves until
    // the peer resets too — and while this cooldown holds, we were doing
    // neither. Measured on device: a forced reset at 16:25:48 healed nothing,
    // and twenty seconds later the failures were still arriving with
    // "auto-reset suppressed — 20s since last" and no request going out. Both
    // sides sat until the user gave up, and the call was never decryptable.
    //
    // Asking costs nothing here: requestPeerRekey has its OWN 30s throttle, so
    // this cannot become a request storm, and the peer resetting is enough on
    // its own — their next message then carries an X3DH header we can adopt.
    requestPeerRekey(peerId);
    return;
  }

  // ONLY ONE SIDE TEARS DOWN. This is the root cause of the oscillation: both
  // devices run this identical function, so both reset, and each destroys the
  // session the other has just rebuilt. No timer fixes that — a cooldown only
  // sets the PERIOD of the flip-flop, which is why the device capture showed it
  // beating steadily at roughly the cooldown length instead of settling.
  //
  // Break the symmetry the same way the session layer breaks X3DH glare
  // (e2eeSession.ts — lower identity key yields): compare the two user ids and
  // let exactly one side be the one that resets. It does not matter which, only
  // that both devices compute the same answer from data they already have.
  //
  // Skipping our own reset costs nothing, because it was never the half that
  // healed us: a local reset only re-keys what we SEND. What fixes our INBOUND
  // is the peer re-initiating, and the request below is what asks for that. The
  // peer's X3DH header is then adopted by decryptFromPeer without us having
  // dropped anything.
  if (meId > peerId) {
    console.warn('[e2ee] not the designated re-key initiator for', peerId, '— asking instead of resetting');
    requestPeerRekey(peerId);
    return;
  }
  // ONCE PER EPISODE. A second self-reset for the same breakage cannot help:
  // dropping our ratchet re-keys what we SEND, and nobody has complained about
  // that — we are the one who cannot read. Repeating it only invalidates the
  // session the peer built in answer to our first request, which restarts the
  // very loop this is here to end.
  if (_selfResetEpoch.get(peerId) === (_complaintEpoch.get(peerId) ?? 0)) {
    console.warn('[e2ee] already re-keyed for this breakage of', peerId, '— asking again instead');
    requestPeerRekey(peerId);
    return;
  }
  _selfResetEpoch.set(peerId, _complaintEpoch.get(peerId) ?? 0);
  _lastAutoReset.set(peerId, now);

  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    await e2ee.e2eeResetSession(peerId);   // drop dead ratchet; MY next outbound re-keys → peer self-heals
    (await import('./sessionEpoch')).bumpSessionEpoch(peerId);
    stat(peerId).resets++; logSessionHealth(peerId, 'reset');
    console.warn('[e2ee] AUTO-RESET dead session for peer', peerId, '— re-handshakes on next message');
    // Stage 2: I'm a PASSIVE reader that can't decrypt this peer — resetting my
    // own session only fixes my OUTbound. Ask the peer to reset too, so its next
    // message re-runs X3DH and I can finally decrypt (bidirectional heal without
    // requiring me to send anything). Rate-limited by the fail-streak threshold.
    requestPeerRekey(peerId);
  } catch {}
}

// ── Stage-2 auto-recovery: peer re-key request over the socket ──────
let _lastRekeyReq = new Map<string, number>();
/**
 * @param force Bypass both cooldowns — the local send limit and the peer's
 *   receive limit. Reserved for CALL SETUP failure, which is a different
 *   problem from a background decrypt failure: it is triggered by a person
 *   tapping "call", so it cannot storm, and suppressing it does not delay a
 *   heal — it prevents the call outright. Observed on device as four failed
 *   attempts over 40s with the heal refused each time ("rekey request ignored
 *   — reset 43s ago"), both phones waiting on the other.
 */
export async function requestPeerRekey(peerId: string, force = false): Promise<void> {
  const now = Date.now();
  const since = now - (_lastRekeyReq.get(peerId) ?? 0);
  // A failed call reports through more than one path (the ring repeat and the
  // offer handler), so an unlimited forced request fires in bursts. The floor
  // collapses a burst into one request without delaying a genuine retry.
  if (since < (force ? FORCED_RESET_FLOOR_MS : 30_000)) return;
  _lastRekeyReq.set(peerId, now);
  try {
    const { getSocket } = await import('./socket');
    const s = await getSocket();
    // The epoch names WHICH breakage we are complaining about, so the peer can
    // tell a fresh problem from one it has already answered. Without it every
    // request looks identical and the only possible defence is a blind timer —
    // which is what let the two sides alternate resets forever, each destroying
    // the session the other had just built.
    //
    // The server relays the whole payload verbatim (realtime/handlers.go
    // copyMap), so adding a field needs no backend change and an older peer
    // that ignores it simply falls back to the timer.
    s.emit('e2ee_rekey', { to: peerId, force, epoch: _complaintEpoch.get(peerId) ?? 0 });
  } catch {}
}

/**
 * Highest re-key epoch already acted on per peer.
 *
 * Compared with `!==` rather than `<=` on purpose. The epoch lives in memory
 * and restarts at 0 with the app, so a peer that reinstalls or is force-stopped
 * would send epochs BELOW what we have recorded — and a `<=` rule would ignore
 * that peer's requests for as long as both processes lived. Any change of
 * epoch, in either direction, means the peer is telling us something new.
 */
const _handledRekeyEpoch = new Map<string, number>();

/** Handle an inbound peer re-key request: drop my session with that peer so my
 *  next message to them re-initiates X3DH (they were stuck decrypting me).
 *  Wired once as a persistent socket listener in app/_layout.tsx. */
export async function handleRekeyRequest(fromPeerId: string, force = false, peerEpoch?: number): Promise<void> {
  if (!E2EE_ENABLED || !fromPeerId) return;
  // A forced request comes from a peer whose CALL could not be set up. It jumps
  // the 60s window below — a person who just failed to place a call will not
  // quietly wait a minute — but it does NOT get to reset without limit.
  //
  // Bypassing the window entirely was worse than the problem: both sides began
  // forcing resets at each other, each destroying the session the other had just
  // rebuilt, so no session ever survived long enough to be used. Measured on
  // device as EIGHT resets in 22 seconds with the call never connecting.
  //
  // A short floor keeps both properties: a real call failure heals in seconds,
  // and a reset storm is impossible because each side can only act once per
  // window no matter how many requests arrive. The peer re-requests on its next
  // attempt if it is still broken, so nothing is lost by ignoring a duplicate —
  // and duplicates are the norm, since both the ring and the offer path report
  // the same failure.
  if (force) {
    const now = Date.now();
    const since = now - (_lastAutoReset.get(fromPeerId) ?? 0);
    if (since < FORCED_RESET_FLOOR_MS) {
      console.warn('[e2ee] forced re-key ignored for', fromPeerId, `— reset ${Math.round(since / 1000)}s ago`);
      return;
    }
    _lastAutoReset.set(fromPeerId, now);
    try {
      const e2ee = await import('../services/crypto/e2eeSession.rn');
      await e2ee.e2eeResetSession(fromPeerId);
      (await import('./sessionEpoch')).bumpSessionEpoch(fromPeerId);
      stat(fromPeerId).resets++; logSessionHealth(fromPeerId, 'reset');
      console.warn('[e2ee] FORCED re-key (peer call setup failed) — reset session for', fromPeerId);
    } catch {}
    return;
  }
  // Same cooldown as the local auto-reset, and deliberately sharing its map:
  // the two halves form one loop. A peer stuck on undecryptable history sends a
  // rekey request every time it gives up, and honouring each one destroys the
  // session we just rebuilt — so the peer's next message fails, and it asks
  // again. Observed on device as repeated "peer requested re-key" seconds after
  // our own reset. Ignoring a request inside the window is safe: if the peer
  // still cannot decrypt after it, it will ask again once the window closes.
  // ONE reset per distinct complaint.
  //
  // A peer that still cannot read us keeps asking — its fail streak re-arms
  // every few seconds — and every one of those asks is about the SAME breakage.
  // Honouring each of them tore down the session we had just rebuilt, so the
  // peer's next message failed and it asked again: the loop, measured on device
  // as resets alternating between the two phones roughly every 113 seconds.
  //
  // The epoch settles it without a clock. While the peer is merely waiting for
  // our re-handshake its epoch does not move, so a repeat carries the same
  // number and is recognisably the same complaint. It changes only when the
  // peer genuinely re-keys again, which is exactly when we should act.
  //
  // Forced (call-setup) requests deliberately skip this: a person retrying a
  // call has not re-keyed, so their epoch is unchanged, and suppressing the
  // retry would fail the call outright. FORCED_RESET_FLOOR_MS above is what
  // bounds those.
  if (typeof peerEpoch === 'number' && _handledRekeyEpoch.get(fromPeerId) === peerEpoch) {
    console.warn('[e2ee] rekey request ignored for', fromPeerId, `— already handled epoch ${peerEpoch}`);
    return;
  }
  const now = Date.now();
  const last = _lastAutoReset.get(fromPeerId) ?? 0;
  if (now - last < AUTO_RESET_COOLDOWN_MS) {
    console.warn('[e2ee] rekey request ignored for', fromPeerId, `— reset ${Math.round((now - last) / 1000)}s ago`);
    return;
  }
  _lastAutoReset.set(fromPeerId, now);
  if (typeof peerEpoch === 'number') _handledRekeyEpoch.set(fromPeerId, peerEpoch);
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    await e2ee.e2eeResetSession(fromPeerId);
    (await import('./sessionEpoch')).bumpSessionEpoch(fromPeerId);
      stat(fromPeerId).resets++; logSessionHealth(fromPeerId, 'reset');
    console.warn('[e2ee] peer requested re-key; reset session for', fromPeerId);
  } catch {}
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
  opts?: { live?: boolean },
): Promise<Message[]> {
  // Everything decrypted below is HISTORY. Mark it so a failure cannot be
  // mistaken for a dead live session and trigger a reset — the fault that made
  // an incoming call undecryptable moments after a cold sync.
  //
  // …unless the caller says otherwise. The chat screen also routes a message
  // that JUST ARRIVED through here, and that one is live by definition: it is
  // the out-of-order case the decrypt retry exists for, so it must keep it.
  // Left implicit, "history" and "a batch of one that just landed" are
  // indistinguishable from in here. A live message therefore keeps BOTH the
  // retry and its session auto-recovery, which is the behaviour it always had.
  const bulk = !opts?.live;
  if (bulk) _bulkDecryptDepth++;
  try {
  const out = msgs.slice();
  // F5: a decrypted payload may be a wrapped {text + link preview} envelope
  // (sender-generated previews ride INSIDE the E2EE content). Unwrap so the
  // UI sees plain text + meta.linkPreview — local-only, never sent anywhere.
  // The E2EE layer stores a TOMBSTONE under a message id to mean "permanently
  // undecryptable, stop retrying". It is a marker, never text — but it lives in
  // the same cache as real plaintext and reached the UI through several paths
  // (own-message cache, knownPlain map, the NUL-prefixed straggler branch),
  // printing "__e2ee_undecryptable__" inside the user's own bubble on device.
  // Guarding the one funnel every render path goes through covers all of them.
  const TOMBSTONE = '\u0000__e2ee_undecryptable__';
  const finish = (m: Message, plain: string): Message => {
    if (plain === TOMBSTONE) return m;   // leave the envelope → bubble shows its locked state
    const { text, pm } = unwrapEnvelope(plain);
    // The server's copy is the routing subset; the private half travelled
    // inside the ciphertext. Merging here — the single funnel every render path
    // goes through — is what makes the split invisible to the UI: bubbles read
    // meta.thumb / meta.filename / meta.linkPreview exactly as they always did.
    // Private wins on a key collision: it is the sender's original value, where
    // the public copy may be a server-derived summary (optionCount).
    return pm ? { ...m, content: text, meta: { ...(m.meta ?? {}), ...pm } }
              : { ...m, content: plain };
  };
  // Own messages sent BEFORE the plaintext cache existed have no local copy and
  // never will — a Double Ratchet ciphertext cannot be opened by its sender. It
  // is expected, not a fault, so it is counted and reported once per batch
  // instead of once per message. Opening a chat used to print dozens of these,
  // which is how a genuine one-line failure goes unnoticed in a call log.
  let ownMisses = 0;
  for (let i = out.length - 1; i >= 0; i--) {   // msgs arrive newest-first → iterate oldest-first
    const m = out[i];
    // deletedAt is authoritative even if best-effort server body cleanup left
    // ciphertext attached to the row. Never decrypt or retain deleted content.
    if (m.deletedAt) {
      out[i] = { ...m, type: 'system', content: null, replyToId: null, meta: null };
      continue;
    }
    const c = m.content;
    if (!looksEncrypted(c)) {                    // already plaintext (cache / pre-E2EE history)
      if (c && c.startsWith('\u0000')) out[i] = finish(m, c);   // wrapped plaintext straggler
      continue;
    }
    const cached = knownPlain?.get(m.id);
    if (!m.editedAt && cached != null && !looksEncrypted(cached)) { out[i] = finish(m, cached); continue; }

    // NEVER attempt to decrypt our OWN message.
    //
    // A Double Ratchet ciphertext cannot be opened by the party that produced
    // it — the sending and receiving chains are different keys. So this was
    // guaranteed to fail whenever the own-plaintext cache missed (reinstall,
    // cleared cache, or the server echoing the message back before the cache
    // write landed), and the sender saw "unable to decrypt" on their own text.
    //
    // Worse, that guaranteed failure fed the auto-recovery streak, which after
    // two of them RESET a perfectly healthy session with the peer — so a
    // sender-side display bug could break the receiver's decryption. Skipping
    // is both the correct render and the fix for that cascade.
    // OWNERSHIP IS DECIDED BY EVIDENCE, NOT BY ID ALONE.
    //
    // The id comparison is the fast path, but it has two ways to answer "not
    // mine" about our own message — a missing senderId on the payload, and a
    // stale cached id after an account switch — and BOTH end in a decrypt that
    // is guaranteed to fail. Holding our own plaintext for a message id is
    // proof of authorship that needs no id at all, so consult it whenever the
    // comparison does not already say yes. One extra cache read on the path
    // that was about to throw anyway.
    const senderId = (m as any).senderId ?? '';
    const meId = await myUserId();
    const idSaysMine = !!senderId && senderId === meId;
    const own = (idSaysMine || !senderId || !meId)
      ? await readOwnPlaintext(chatId, m.id, m.createdAt)
      : null;
    if (idSaysMine || own != null) {
      if (own != null) {
        out[i] = finish(m, own);
        // LAZY MIGRATION to the single-record model (see messageQueue.postOnce).
        //
        // Messages sent before that change have messages.content = NULL and
        // their only readable copy in the old KV cache. Promote it into the
        // canonical row the first time it is read, so the next open renders
        // from the same path as everything else and this lookup stops being
        // needed. Read-through, never a mass rewrite: only rows actually
        // displayed are touched, and the old cache is left in place as the
        // fallback until the migration has soaked.
        try {
          const { cacheMessages } = await import('./localDb');
          await cacheMessages(chatId, [{ ...out[i] } as Message]);
        } catch { /* best-effort: the message already renders from `out` */ }
      } else {
        ownMisses++;
        // NULL, NOT THE ENVELOPE — and this line is the whole bug.
        //
        // The intent below was always right: our own message with no cached
        // plaintext should render "can't be shown on this device". But that
        // bubble state keys off `content == null`, and MessageBubble tests
        // `looksEncrypted(content)` FIRST. Leaving the envelope in place
        // therefore matched the wrong branch and rendered
        // "🔒 unable to decrypt" — telling the sender their own message failed
        // to decrypt when no decrypt was ever attempted.
        //
        // Measured on the Honor: three SENT bubbles reading "unable to decrypt"
        // with ghash failures = 0 and zero own-message decrypt attempts in the
        // same capture. The string was pure render-side; every session-level
        // fix before this one was aimed at a decrypt that never happened.
        //
        // Nulling here also matches what cacheMessages already stores for these
        // rows, so the first render and every render after a cache round-trip
        // finally agree.
        out[i] = { ...m, content: null } as Message;
      }
      continue;
    }

    const plain = await decryptFromChat(chatId, senderId, c, m.id, !!m.editedAt);
    if (plain && !looksEncrypted(plain) && plain !== '🔒 unable to decrypt') {
      out[i] = finish(m, plain);
    }
  }
  if (ownMisses) console.warn(`[e2ee] ${ownMisses} own message(s) predate the plaintext cache in chat ${chatId} — shown as unavailable`);
  return out;
  } finally {
    if (bulk) _bulkDecryptDepth--;
  }
}

// Our own user id, cached. hydrateMessages asks per message, so this must not
// hit storage every time; the value cannot change without a re-login, which
// clears the module anyway.
let _meId: string | null = null;
/**
 * This device's user id — the input to EVERY "is this my own message" decision.
 *
 * IT MUST NOT SILENTLY RETURN EMPTY. Both ownership guards compare against it
 * (`senderId === myUserId()` in hydrateMessages, `peerId === myUserId()` in
 * maybeAutoRecoverSession), and `x === ''` is false for every real id — so an
 * empty answer does not make the guards cautious, it makes them FAIL OPEN.
 *
 * Measured on the Honor 2026-08-15: own sent messages rendered
 * "🔒 unable to decrypt" (the decrypt path, not the own-plaintext path), each
 * guaranteed-failed decrypt counted toward the auto-reset streak, and at two
 * failures the device reset a HEALTHY peer session and sent it a rekey request.
 * The peer logged `decryptFails=0` and destroyed a working session anyway. A
 * sender-side display bug propagating into the receiver's crypto state.
 *
 * SecureStore alone is not enough: `getCachedUser()` returns null whenever the
 * user blob is absent, unparseable, or simply not written yet on a cold start,
 * and that window is exactly when a chat screen is hydrating. The access token
 * is present whenever the user is logged in at all, and its `sub` claim is the
 * same id (see httpx.go:126), so it is the natural second source rather than a
 * new one to keep in sync.
 *
 * An empty result is NOT memoised — `if (_meId)` is falsy for '' — so a later
 * call retries once the cache is populated.
 */
export function resetMyUserIdCache(): void { _meId = null; }

/** The access token's `sub`, or '' — read-only decode, never a trust decision. */
function subOfToken(tok: string | null): string {
  try {
    const body = tok?.split('.')[1];
    if (!body) return '';
    const json = JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return String(json?.sub ?? '');
  } catch { return ''; }
}

async function myUserId(): Promise<string> {
  if (_meId) return _meId;
  try {
    // PRIMARY: the access token's subject.
    //
    // `senderId` on every message is stamped by the SERVER from this exact
    // claim (`sub`, httpx.go:126). The token is therefore the only value
    // guaranteed to equal it for the CURRENT session — which is precisely what
    // the ownership guards compare.
    //
    // The cached user blob is a COPY, written at login and never re-checked. It
    // outlives an account switch, so after signing in as someone else it still
    // names the previous account: a non-empty, plausible, WRONG id. Every guard
    // then answers "not mine" for our own messages, and they fall through to a
    // decrypt that cannot succeed. That failure mode is invisible — nothing is
    // empty, nothing throws — which is why it survived the previous fix that
    // only handled the empty case.
    _meId = subOfToken(await getAccessToken());
    if (!_meId) {
      const { getCachedUser } = await import('./api');
      _meId = String((await getCachedUser())?.id ?? '');
      if (_meId) console.warn('[e2ee] own id from user cache — token had no sub');
    }
  } catch { _meId = ''; }
  return _meId;
}

// A just-sent message is READ before its plaintext is WRITTEN. Measured on
// device, every message showing the same shape:
//   01:52:48.063  no cached plaintext — id 214     (socket echo → hydrate)
//   01:52:48.128  no cached plaintext — id 214
//   01:52:48.161  cached own plaintext — id 214    (POST returned the id)
// The server echoes the message back over the socket before the POST response
// carrying its id has landed, so the cache cannot possibly be populated yet.
// Whichever bubbles never re-rendered afterwards stayed stuck reading
// "unable to decrypt" — which is why messages sent seconds apart differed.
//
// One short retry covers the gap. Bounded to messages sent in the last minute:
// applying it to old history would add this delay to every genuinely-missing
// message (83 of them on this device) and turn chat opening into a crawl.
const OWN_PT_RETRY_MS = 300;
const OWN_PT_RETRY_WINDOW_MS = 60_000;

/** Plaintext of an own-sent message from the local store, or null. */
async function readOwnPlaintext(chatId: string, messageId: number, createdAt?: string): Promise<string | null> {
  if (!E2EE_ENABLED || !messageId || messageId <= 0) return null;
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    let v = await e2ee.e2eeGetCached(chatId, messageId);
    if (v == null && createdAt) {
      const age = Date.now() - new Date(createdAt).getTime();
      if (age >= 0 && age < OWN_PT_RETRY_WINDOW_MS) {
        await new Promise(r => setTimeout(r, OWN_PT_RETRY_MS));
        v = await e2ee.e2eeGetCached(chatId, messageId);
      }
    }
    // The store also holds a TOMBSTONE ("permanently undecryptable, stop
    // retrying") under the same key. It is a marker, not text — returning it
    // rendered the literal string "__e2ee_undecryptable__" inside the user's
    // own chat bubble (seen on device). Treat it as "no plaintext held", which
    // gives the bubble's proper "can't be shown on this device" state.
    if (v === e2ee.E2EE_UNDECRYPTABLE) return null;

    // THE OTHER STORE — and on the sender's own device usually the first one
    // written. messageQueue.postOnce puts the plaintext straight into the
    // canonical `messages` row (the single-record model); this KV cache is a
    // SEPARATE write that can lag it, fail on its own, or be evicted. Reading
    // only the KV therefore reported "not available on this device" for
    // messages whose text was sitting in the row the whole time — measured on
    // the Honor as three own messages sent minutes earlier, unreadable on the
    // sender while the recipient displayed them normally.
    //
    // Checked only after the KV misses, so the common path costs nothing.
    if (v == null) {
      try {
        const { getCachedMessagesByIds } = await import('./localDb');
        const rows = await getCachedMessagesByIds(chatId, [messageId]);
        const c = rows?.[0]?.content;
        if (c != null && !looksEncrypted(c) && c !== e2ee.E2EE_UNDECRYPTABLE) return c;
      } catch { /* cache unavailable → fall through to "not held" */ }
    }
    return v;
  } catch { return null; }
}

// Cache an own-sent message's plaintext once the server assigns its id, so the
// sender renders it from the local store (server content is ciphertext).
export async function cacheOwnPlaintext(chatId: string, messageId: number | undefined, plaintext: string): Promise<void> {
  // This is the ONLY copy of an own-sent message's text — a Double Ratchet
  // ciphertext cannot be opened by the sender. Every early-return and every
  // swallowed throw below is a message the user permanently cannot read, so
  // each one says so rather than failing silently, which is how this went
  // undiagnosed: bubbles sent seconds apart, some readable, some not.
  if (!E2EE_ENABLED) return;
  if (!messageId || messageId <= 0) {
    console.warn('[e2ee] cacheOwnPlaintext SKIPPED — no server id yet; chat:', chatId, 'id:', messageId);
    return;
  }
  try {
    const e2ee = await import('../services/crypto/e2eeSession.rn');
    await e2ee.e2eeCachePlaintext(chatId, messageId, plaintext);
    // warn, NOT log: babel.config.js strips console.log from release builds
    // (transform-remove-console, excluding warn/error), so a console.log here
    // is invisible in exactly the build being debugged.
    console.warn('[e2ee] cached own plaintext — id:', messageId, 'len:', plaintext?.length ?? 0);
  } catch (err) {
    console.warn('[e2ee] cacheOwnPlaintext FAILED — id:', messageId, '—', (err as any)?.message ?? err);
  }
}

/**
 * Fill in chat-list previews for OWN messages.
 *
 * The messages table stores what went on the wire, which for an own message is
 * ciphertext — so the preview builder saw an envelope, nulled it, and every row
 * whose last message was mine read "Tap to open chat" instead of its text. Very
 * visible offline, where no server round-trip papers over it (seen on device).
 *
 * The plaintext is already on disk in the own-message store, keyed by the same
 * message id the preview carries; this just looks it up. Peer messages are left
 * alone — theirs decrypt through the normal path.
 */
export async function hydrateOwnPreviews(
  map: Map<string, { content: string | null; type: string | null; senderId: string | null; id: number }>,
): Promise<Map<string, { content: string | null; type: string | null; senderId: string | null; id: number }>> {
  if (!E2EE_ENABLED || !map?.size) return map;
  try {
    const me = await myUserId();
    if (!me) return map;
    for (const [chatId, row] of map) {
      if (row.senderId !== me) continue;
      if (row.content != null && !looksEncrypted(row.content)) continue;
      const pt = await readOwnPlaintext(chatId, row.id);   // no retry: a list row is not worth stalling on
      if (pt != null) map.set(chatId, { ...row, content: unwrapEnvelope(pt).text });
    }
  } catch { /* previews are best-effort — never block the chat list */ }
  return map;
}

// ─── REST ───────────────────────────────────────────────────────────

/**
 * What to call a chat in a list. A direct chat's `name` is often null — the
 * peer's name is the thing a person recognises — and falling back to the raw
 * id shows someone a hex string where a name belongs.
 *
 * Exported rather than written per screen: app/search.tsx had the only copy,
 * and every new picker that needs it would otherwise grow its own.
 */
export function chatTitle(c: ChatSummary): string {
  return c.type === 'direct'
    ? (c.peerName || c.name || 'Direct chat')
    : (c.name || 'Group chat');
}

/**
 * GET /chats, binary (protobuf-migration batch C, client half).
 *
 * Reached ONLY from api()'s response path, and only when the server actually
 * answered `application/protobuf`. That placement is the whole point of the
 * dynamic import: import() does NOT defer evaluation — metro's asyncRequire is
 * a synchronous require in an already-resolved promise (lib/socket.ts:127-129)
 * — it only RELOCATES it, so @bufbuild/protobuf is evaluated the first time a
 * protobuf chat list comes back, never on the module graph of anything that
 * loads at startup. Same shape as lib/appVersionPolicy.ts gateFromProtobuf.
 *
 * NO `.js` SUFFIX on the specifier: metro appends its sourceExts to the full
 * requested path, so `…_pb.js` is probed as `_pb.js`, `_pb.js.ts`, … none of
 * which exist (the generated file is `_pb.ts`). tsc does not catch it.
 *
 * WHAT THE MAPPING IS FOR. `startupChatSummary` owns the id asymmetry; this
 * function owns only the two differences between the GENERATED message and the
 * JSON row, both of which would otherwise reach cacheChats:
 *   · `photoUrl`/`peerPhotoUrl` — protoc lowercases the acronym; the JSON
 *     contract (and every cached row ever written) says `photoURL`.
 *   · absence. proto3 optional decodes to `undefined`, and `JSON.stringify`
 *     DROPS an undefined value — the key would vanish from the cached row,
 *     where the Go struct has no `omitempty` and always writes an explicit
 *     `null`. So every nullable field is `?? null` here, and the four id
 *     fields are handed to the adapter as '' (its documented "absent"), which
 *     it turns into the same explicit nulls.
 * `unreadCount` is int64 → bigint; the JSON path has a number.
 *
 * Proved field-for-field against the JSON path by lib/chatsProto.selftest.ts
 * and lib/chatsCacheRollback.selftest.ts (the rollback gate).
 */
async function decodeChatList(bytes: Uint8Array): Promise<ChatSummary[]> {
  const { ChatListReply } = await import('./ccwire/gen/ccwire/v1/chats_list_pb');
  return ChatListReply.fromBinary(bytes).chats
    .map((c): ChatSummary => {
      const row = startupChatSummary({
        id:            c.id,
        type:          c.type as ChatSummary['type'],
        name:          c.name ?? null,
        photoURL:      c.photoUrl ?? null,
        createdBy:     c.createdBy ?? null,
        createdAt:     c.createdAt,
        updatedAt:     c.updatedAt,
        lastMessageId: c.lastMessageId,
        lastMessageAt: c.lastMessageAt ?? null,
        myRole:        c.myRole as ChatSummary['myRole'],
        myLastReadId:  c.myLastReadId,
        muted:         c.muted,
        pinned:        c.pinned,
        favourite:     c.favourite,
        archived:      c.archived,
        hidden:        c.hidden,
        screenshotMode: c.screenshotMode as ChatSummary['screenshotMode'],
        vanishMode:    c.vanishMode,
        unreadCount:   Number(c.unreadCount),
        peerUserId:    c.peerUserId ?? null,
        peerName:      c.peerName ?? null,
        peerPhotoURL:  c.peerPhotoUrl ?? null,
        peerOnline:    c.peerOnline,
        peerLastSeenAt: c.peerLastSeenAt ?? null,
        peerLastReadMessageId:      c.peerLastReadMessageId ?? '',
        peerLastDeliveredMessageId: c.peerLastDeliveredMessageId ?? '',
        anonMasked:    c.anonMasked,
        expiresAt:     c.expiresAt ?? null,
      });
      // A partial list would make cacheChats prune valid offline chats.
      if (!row) throw new Error('Chat list contains a row without an id');
      return row;
    });
}

export async function listChats(opts: { includeHidden?: boolean } = {}): Promise<ChatSummary[]> {
  const qs = opts.includeHidden ? '?includeHidden=1' : '';
  // Passing a decoder only OFFERS protobuf. A server that answers JSON — every
  // deployed one until the Go half ships — is parsed by the unchanged path in
  // api(), with no second request.
  //
  // A DECODE FAILURE REJECTS, IT DOES NOT RETURN []. The bytes are spent by
  // then, so there is no JSON to fall back to without re-issuing the GET; and
  // `[]` would be far worse than an error, because cacheChats() PRUNES rows
  // missing from the list it is given (app/(tabs)/chats.tsx:165) — a garbled
  // response would wipe the offline chat list. Rejecting makes a bad body look
  // exactly like a failed fetch, which every caller already handles by keeping
  // what it has painted from the cache.
  const rows = await api<ChatSummary[]>(`/chats${qs}`, { proto: decodeChatList });
  for (const r of rows) rememberChatPeer(r);
  publishChatDirectory(rows);
  // Correct the server's denormalized unread_count against what THIS device has
  // already read (2026-09-18). The whole reason it lives here and not in the
  // Chats screen: every list surface — app/(tabs)/chats.tsx, app/search.tsx,
  // app/hidden-chats.tsx — reads unreadCount off these same rows, and the
  // reported symptom was "all the application screens". One guard on the shared
  // fetch beats the same patch in three callers. Lazy import because
  // lib/receipts imports markRead from this file.
  //
  // Best-effort: readPointers throws SessionEndedError when the token is gone,
  // and a missing correction must never fail the list.
  try {
    const { readPointers } = await import('./receipts');
    applyLocalReadPointers(rows, await readPointers());
  } catch { /* no session / unreadable snapshot — the server's count stands */ }
  return rows;
}

// F2 content-free push: keep an on-device chatId → display-name directory in
// native SharedPreferences so the native FCM service can title the "new
// message" notification LOCALLY — the name never rides inside a push payload.
function publishChatDirectory(rows: ChatSummary[]): void {
  try {
    if (Platform.OS !== 'android') return;
    const dir: Record<string, string> = {};
    for (const c of rows) {
      const name = c.type === 'direct' ? (c.peerName ?? c.name) : c.name;
      if (name) dir[c.id] = name;
    }
    const json = JSON.stringify(dir);
    // Native FCM path (GMS devices) titles its notification from here…
    const { NativeModules } = require('react-native');
    NativeModules?.VaultCalls?.setChatDirectory?.(json);
    // …and the JS client-notification path (no-GMS) reads the same map from
    // AsyncStorage, so both title notifications with the local name.
    require('@react-native-async-storage/async-storage').default.setItem('vc_chat_dir_v1', json).catch(() => {});
    require('./messageNotifications').invalidateDirectory();
  } catch { /* directory is best-effort — notification falls back to "crazzychat" */ }
}

export async function getChat(chatId: string): Promise<ChatDetail> {
  const c = await api<ChatDetail>(`/chats/${encodeURIComponent(chatId)}`);
  rememberChatPeer(c);
  // Local-first: persist the detail so the chat header (name/peer/members)
  // renders instantly + offline. Lazy require avoids an import cycle.
  try { require('./localDb').cacheChatDetail(chatId, c); } catch {}
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

export interface GroupMeta {
  groupType?:   GroupType;
  icon?:        string;
  color?:       string;
  description?: string;
  privacy?:     'private' | 'invite_only';
}

export async function createGroupChat(
  name: string,
  members: { ids?: string[]; emails?: string[]; allowEmpty?: boolean } = {},
  meta: GroupMeta = {},
): Promise<{ id: string; type: 'group'; name: string; groupType?: GroupType | null }> {
  return api(`/chats`, {
    method: 'POST',
    json: {
      type: 'group', name,
      memberIds:    members.ids    ?? [],
      memberEmails: members.emails ?? [],
      allowEmpty:   members.allowEmpty === true,
      // Omitted keys leave the group untyped, which is a valid state.
      ...meta,
    },
  });
}

// Gaming: removed from the app — games ship as a separate WebView deployment.
// The backend /games surface stays dormant until that integration.

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
  /** Written server-side, not yet deployed (fixes/R4BE C4): absent on today's server. */
  channelId?: string;
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
/** Leave (unsubscribe). 409 for the channel's own admin. New route (R4BE C6). */
export async function leaveChannel(channelId: string): Promise<void> {
  await api(`/channels/${encodeURIComponent(channelId)}/leave`, { method: 'POST' });
}
/** Admin only: delete one post. New route (R4BE C5). */
export async function deleteChannelPost(channelId: string, postId: number): Promise<void> {
  await api(`/channels/${encodeURIComponent(channelId)}/posts/${postId}`, { method: 'DELETE' });
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

// Wire ids are strings; the device is number-keyed. The normalizer lives in
// its own import-free module so its selftest can run under tsx. Re-exported
// here because this is where every caller already looks for message helpers.
export { normalizeMsgIds };

export async function getMessages(chatId: string, opts: { before?: number; limit?: number } = {}): Promise<Message[]> {
  const params: string[] = [];
  if (opts.before) params.push(`before=${opts.before}`);
  if (opts.limit) params.push(`limit=${opts.limit}`);
  const qs = params.length ? `?${params.join('&')}` : '';
  const rows = await api<Message[]>(`/chats/${encodeURIComponent(chatId)}/messages${qs}`);
  return Array.isArray(rows) ? rows.map(normalizeMsgIds) : rows;
}

export async function sendMessage(
  chatId: string,
  plaintext: string,
  type: Message['type'] = 'text',
  opts: { replyToId?: number | null; meta?: any; clientId?: string } = {},
): Promise<Message> {
  // ── Task 1 perf instrumentation ──────────────────────────────────
  // Split the timing into E2EE-encrypt vs. canonical server result so we see
  // which stage dominates across HTTP and optional protobuf submissions.
  // F7: a stable idempotency key generated ONCE per call so an internal api()
  // retry (e.g. token refresh) reuses the same key and the server dedups. Media/
  // poll/sticker/GIF/location all route through here, so they're covered too.
  const clientId = opts.clientId ?? Crypto.randomUUID();
  const _t0 = Date.now();
  // Same split the outbox applies (lib/msgEnvelope): the server gets the
  // routing subset of meta, everything else rides inside the ciphertext. This
  // is the MEDIA send path — sendMediaMessage routes through here — so it is
  // the one carrying meta.thumb, the base64 preview of the photo. Missing it
  // here would have left the leak open for exactly the messages that leak most.
  const { pub: serverMeta, priv } = splitMeta(opts.meta);
  const wire = wrapEnvelope(plaintext, priv);
  let content = await encryptForChat(chatId, wire);
  if (content === wire && wire !== plaintext) content = plaintext;  // never ship the wrapper unencrypted
  const _tEnc = Date.now();
  perf.mark('send_encrypt_done', { chatId, ms: _tEnc - _t0, encrypted: content !== plaintext });
  let usedTransport = 'http';
  try {
    const payload = { content, type, replyToId: opts.replyToId ?? null, meta: serverMeta, clientId };
    const transportModule: typeof import('./ccwire/transport') = await import('./ccwire/transport').catch(() => null);
    const result = transportModule
      ? await transportModule.submitCCWireMessage<Message>(chatId, payload, api)
      : { message: await api<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, { method: 'POST', json: payload }), transport: 'http' };
    const msg = result.message;
    usedTransport = result.transport;
    // The server emits `id` as a STRING on EVERY path — chatsPublicMsg is
    // `ID string` (fmt.Sprintf("%d")), used by the POST ack, GET and the
    // socket alike. An earlier version of this comment claimed GET/socket
    // delivered a number; they do not, and a caller that trusted that (the
    // root new_message listener) silently passed `undefined` as a message id
    // into the decrypt path. Normalize here so UI dedup and the local-cache
    // upsert (number-id only) work.
    normalizeMsgIds(msg);
    const _tAck = Date.now();
    perf.mark('send_ack', { chatId, id: msg?.id, ms: _tAck - _tEnc, transport: usedTransport });
    perf.recordSend({
      id: String(msg?.id ?? chatId),
      tapToEncrypt: _tEnc - _t0,
      encryptToAck: _tAck - _tEnc,
      totalMs: _tAck - _t0,
      transport: usedTransport,
      at: _tAck,
    });
    // Cache the WRAPPED form, so re-reading the sender's own message recovers
    // the private meta too — hydrateMessages unwraps it on the way out. Caching
    // bare `plaintext` here would give the sender a photo bubble with no
    // thumbnail after a restart, while every recipient still had one.
    if (content !== plaintext) await cacheOwnPlaintext(chatId, msg?.id, wire);
    // The ack echoes the routing subset we sent; the sender's own row keeps
    // everything (same reason as the outbox path in messageQueue.postOnce).
    if (msg && opts.meta) (msg as any).meta = opts.meta;
    return msg;
  } catch (err) {
    perf.recordSend({
      id: String(chatId), tapToEncrypt: _tEnc - _t0,
      totalMs: Date.now() - _t0, transport: usedTransport,
      failed: true, at: Date.now(),
    });
    throw err;
  }
}

// Schedule a message via the SERVER (reliable — fires even if the app is killed/
// swiped away), but E2E-ENCRYPTED: the content is sealed for the chat BEFORE it
// leaves the device, so the server only ever holds ciphertext it can't read, and
// simply delivers that ciphertext at send time (the recipient decrypts as usual).
// Returns the created row; its id keys a local plaintext copy for the sender's tray.
export async function scheduleEncryptedMessage(
  chatId: string,
  plaintext: string,
  sendAtIso: string,
  opts: { replyToId?: number | null; meta?: any } = {},
): Promise<ScheduledMessageRow> {
  // Same meta split sendMessage applies (lib/msgEnvelope): the server gets the
  // ROUTING subset only, everything else rides inside the ciphertext. Passing
  // opts.meta straight through — as this did — would hand the server the
  // private half (thumb, filename, linkPreview) in the clear, which is the one
  // leak class msgEnvelope exists to close. Harmless while the only caller
  // (app/schedule-message.tsx) sends no meta; a plaintext-thumbnail leak the
  // day somebody schedules a photo.
  const { pub: serverMeta, priv } = splitMeta(opts.meta);
  const wire = wrapEnvelope(plaintext, priv);
  let content = await encryptForChat(chatId, wire);
  if (content === wire && wire !== plaintext) content = plaintext;  // never ship the wrapper unencrypted
  return api<ScheduledMessageRow>('/user/scheduled-messages', {
    method: 'POST',
    json: { chatId, sendAt: sendAtIso, type: 'text', content, replyToId: opts.replyToId ?? null, meta: serverMeta },
  });
}

export async function editMessage(chatId: string, msgId: number, plaintext: string): Promise<Message> {
  const content = await encryptForChat(chatId, plaintext);
  const msg = await api<Message>(`/chats/${encodeURIComponent(chatId)}/messages/${msgId}`, {
    method: 'PATCH',
    json: { content },
  });
  // PATCH returns `id` (and `replyToId`) as STRINGS. Normalize so the queue's
  // temp→real dedup and the number-id-only cache upsert both work.
  normalizeMsgIds(msg);
  // Cache the edited plaintext so the sender can read their own edited message
  // (the server now holds ciphertext we can't self-decrypt).
  if (content !== plaintext) await cacheOwnPlaintext(chatId, msgId, plaintext);
  return msg;
}

export async function deleteMessage(chatId: string, msgId: number): Promise<{ id: number; deletedAt: string }> {
  const deleted = await api<{ id: number; deletedAt: string }>(
    `/chats/${encodeURIComponent(chatId)}/messages/${msgId}`, { method: 'DELETE' },
  );
  normalizeMsgIds(deleted as any);
  await persistMessageDeletion(chatId, msgId, deleted.deletedAt);
  return deleted;
}

/** Persist a server-authoritative delete in both local plaintext stores. */
export async function persistMessageDeletion(chatId: string, msgId: number, deletedAt: string): Promise<void> {
  const writes: Promise<unknown>[] = [
    import('./localDb').then(m => m.cacheRemoteDeletion(chatId, msgId, deletedAt)),
  ];
  if (E2EE_ENABLED) {
    writes.push(import('../services/crypto/e2eeSession.rn')
      .then(m => m.e2eeDeleteCached(chatId, msgId)));
  }
  await Promise.allSettled(writes);
}

export async function markRead(chatId: string, lastReadMessageId: number, expectedUserId?: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/read`, {
    method: 'POST',
    json: { lastReadMessageId },
    expectedUserId,
  });
}

export async function markDelivered(chatId: string, lastDeliveredMessageId: number, expectedUserId?: string): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/delivered`, {
    method: 'POST',
    json: { lastDeliveredMessageId },
    expectedUserId,
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

// A bookmark's local snapshot, keyed by message id.
//
// Bookmarking is the one action whose whole point is "keep this" — and the
// server can no longer honour that: a bookmarked message's ciphertext is
// reclaimed on delivery like any other, and exempting it would turn bookmarks
// into exactly the permanent server archive this design removes.
//
// So the client keeps its own copy at bookmark time. It is stored through the
// SAME sealed store as own-message plaintext (SQLite, sealed with the cache DEK
// when VAULT_CACHE_ENCRYPTED is on), never in a new plaintext location.
//
// It is also the reason a bookmark survives cache pruning: pruneMessageCache
// trims the `messages` table by age and per-chat count, and a message
// bookmarked months ago would eventually be evicted from it. This copy lives in
// the kv store, which that sweep does not touch.
const bookmarkKey = (messageId: number) => `vc_bookmark_pt_${messageId}`;

/** Snapshot a bookmarked message's plaintext locally. Best-effort. */
export async function cacheBookmarkPlaintext(messageId: number, plaintext: string): Promise<void> {
  if (!messageId || messageId <= 0 || !plaintext) return;
  try {
    const { setMeta } = await import('./localDb');
    const { encField } = await import('./cacheCrypto');
    const sealed = encField(plaintext);
    if (sealed != null) await setMeta(bookmarkKey(messageId), sealed);
  } catch (err) {
    console.warn('[bookmark] local snapshot failed — id:', messageId, (err as any)?.message);
  }
}

/** The local snapshot for a bookmarked message, or null. */
export async function getBookmarkPlaintext(messageId: number): Promise<string | null> {
  if (!messageId || messageId <= 0) return null;
  try {
    const { getMeta } = await import('./localDb');
    const { decField } = await import('./cacheCrypto');
    const hit = await getMeta(bookmarkKey(messageId));
    return hit ? decField(hit) : null;
  } catch { return null; }
}

/**
 * Bookmark a message. `plaintext` is the decrypted body as currently rendered;
 * pass it so the bookmark stays readable after the server body expires.
 */
export async function addBookmark(
  messageId: number, note?: string | null, plaintext?: string | null,
): Promise<{ id: string }> {
  const res = await api<{ id: string }>('/user/bookmarks', {
    method: 'POST', json: { messageId, note: note ?? null },
  });
  // After the server call: a failed bookmark should not leave a local snapshot
  // of something the user did not manage to save.
  if (plaintext) await cacheBookmarkPlaintext(messageId, plaintext);
  return res;
}

/**
 * Remove a bookmark. Pass the bookmarked message's id so its sealed local
 * snapshot (cacheBookmarkPlaintext) goes too — otherwise an un-bookmarked
 * message's plaintext would outlive the bookmark on this device.
 */
export async function removeBookmark(id: string, messageId?: number | null): Promise<void> {
  await api(`/user/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  // Best-effort: the server bookmark is already gone.
  if (messageId) await dropBookmarkPlaintext(messageId).catch(() => {});
}

/**
 * Delete a bookmark's sealed local snapshot, keeping the bookmark. Used for
 * view-once / Invisible Ink messages bookmarked before Star stopped
 * snapshotting them: their copy must not outlive the bubble.
 */
export async function dropBookmarkPlaintext(messageId: number): Promise<void> {
  if (!messageId || messageId <= 0) return;
  const { getLocalDb } = await import('./localDb');
  const db = await getLocalDb();
  await db.runAsync(`DELETE FROM kv WHERE k = ?`, [bookmarkKey(messageId)]);
}

// ─── Stories (24-hour ephemeral posts) ──────────────────────────────
/** What a viewer must do before the media reveals (migration 117). */
export interface StoryGate {
  /** 'puzzle' is an engagement gate; 'question' actually withholds the key. */
  kind: 'puzzle' | 'question';
  /** puzzle only: 3..9, matching lib/status/gate.ts. */
  grid?: number;
  /** question only: shown to the viewer. */
  prompt?: string;
  /** question only: the scrypt salt. Public — useless without the answer. */
  salt?: string;
}

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
  // Absent on an ordinary status, which is what every pre-existing row is.
  gateKind?:    'puzzle' | 'question' | null;
  gateGrid?:    number | null;
  gatePrompt?:  string | null;
  gateSalt?:    string | null;
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
  gate?: StoryGate,
): Promise<StoryItem> {
  return api('/stories', { method: 'POST', json: { attachmentId, mediaType, caption, gate } });
}

/** Post a WhatsApp-style text status (no attachment — just text + a bg color). */
export async function postTextStory(text: string, bgColor: string): Promise<any> {
  return api('/stories', { method: 'POST', json: { mediaType: 'text', text, bgColor } });
}

export type StatusPrivacyMode = 'contacts' | 'except' | 'only';
// Throws on failure: a default here would read as the user's real choice, and
// the next save would overwrite their server list (app/status-privacy.tsx).
export async function getStatusPrivacy(): Promise<{ mode: StatusPrivacyMode; userIds: string[] }> {
  const r = await api<{ mode?: StatusPrivacyMode; userIds?: string[] }>('/stories/privacy');
  if (!r || (r.mode !== 'contacts' && r.mode !== 'except' && r.mode !== 'only')) {
    throw new Error('Status privacy came back in an unexpected form');
  }
  return { mode: r.mode, userIds: Array.isArray(r.userIds) ? r.userIds : [] };
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
  gate?: StoryGate,
): Promise<StoryItem> {
  return api('/stories', { method: 'POST', json: { attachmentId, mediaType, caption, encrypted: true, keys, gate } });
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
// `reason` is the optional "why are you leaving" answer, same as WhatsApp's.
// The server logs it as product feedback and stores nothing keyed to the
// account it is about to erase.
// The server re-authenticates the delete itself: the MPIN rides in the body
// (400 mpin_required, 403 invalid_mpin, 423 locked + retryAfter), sharing the
// /auth/mpin/verify attempt budget.
export async function deleteAccount(mpin: string, reason?: string): Promise<void> {
  await api('/user/account', { method: 'DELETE', json: reason ? { mpin, reason } : { mpin } });
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
    // Groups & Circles. Stamping groupType is how an existing Family Space
    // circle becomes a typed group — the server cannot identify circles itself.
    groupType?: GroupType; icon?: string; color?: string;
    privacy?: 'private' | 'invite_only';
  },
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', json: patch });
}

// Convenience: set or clear the chat's disappearing-messages timer.
// Pass null/0 to turn off.
export async function setDisappearing(chatId: string, seconds: number | null): Promise<void> {
  await updateChat(chatId, { disappearingSeconds: seconds });
}

// ─── Chat codes (start a chat without exchanging numbers) ───────────
// Migration 118 + routes/chat_codes.go. Six digits, SINGLE USE, dead two
// minutes after it is made. You hold one at a time; making a new one revokes
// the old. The short life is deliberate and is what makes six digits safe —
// see the migration before treating it as a UI knob.
export interface ChatCode {
  // The six digits. Readable back from the server for as long as the code is
  // live, so leaving the screen and returning shows the same code rather than
  // silently minting another.
  code?:       string;
  // Disappearing timer stamped on the chat this code opens; null = messages
  // stay until somebody deletes them.
  ttlSeconds:  number | null;
  // "Save this contact" — the person who redeems is treated as an ordinary
  // contact instead of a stranger, so the automatic Ghost Mode defaults
  // (hidden online/typing/read/last-seen) are skipped.
  keepContact: boolean;
  expiresAt?:  string;
  active:      boolean;
}

export async function createChatCode(
  opts: { ttlSeconds: number | null; keepContact?: boolean },
): Promise<ChatCode> {
  return api<ChatCode>('/chat-codes', {
    method: 'POST',
    json: { ttlSeconds: opts.ttlSeconds ?? 0, keepContact: !!opts.keepContact },
  });
}

export async function getChatCode(): Promise<ChatCode> {
  return api<ChatCode>('/chat-codes');
}

/** "Stop" — anyone still holding the code gets nothing. */
export async function revokeChatCode(): Promise<void> {
  await api('/chat-codes', { method: 'DELETE' });
}

/**
 * "I want to keep this person" on a chat opened by code.
 *
 * The reveal is MUTUAL: this call alone changes nothing visible unless the
 * other side has already saved too. `revealed` says whether that just happened,
 * so the screen can say "you can see each other now" rather than appearing to
 * do nothing.
 */
export async function saveContact(chatId: string): Promise<{ saved: boolean; revealed: boolean }> {
  return api(`/chats/${encodeURIComponent(chatId)}/save-contact`, { method: 'POST' });
}

/** Redeem someone else's code. Returns the direct chat it opened. */
export async function joinChatCode(code: string): Promise<{
  chatId: string; existing: boolean; ttlSeconds: number | null; keepContact: boolean;
}> {
  return api(`/chat-codes/${encodeURIComponent(code.trim())}/join`, { method: 'POST' });
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

/**
 * Change a member's role.
 *
 * 'owner' is deliberately not accepted: handing the group over is a separate,
 * irreversible operation with its own endpoint (transferOwnership), so it
 * cannot happen as a side effect of editing somebody's role. 'moderator' and
 * 'guest' apply to typed groups only — the server refuses them on a legacy
 * untyped group, which has no semantics for either.
 */
export async function setMemberRole(
  chatId: string,
  userId: string,
  role: 'admin' | 'moderator' | 'member' | 'guest',
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

// What an invite code points at, without joining (GET /chats/join/:code/preview).
// Revoked, expired, used-up and unknown codes all answer 410.
export async function previewInvite(
  code: string,
): Promise<{ name: string; memberCount: number; requiresApproval: boolean }> {
  return api(`/chats/join/${encodeURIComponent(code)}/preview`);
}

// ─── Announcements (Groups & Circles) ───────────────────────────────
//
// An announcement is an ordinary encrypted message carrying `meta.announcement`.
// The flag lives in meta because the SERVER must be able to enforce the
// send_announcements permission, and meta is the only part of a message it can
// read. It discloses that a message is an announcement, never what it says.

export const ANNOUNCEMENT_META = { announcement: true } as const;

/** Post an announcement. Rejected server-side without send_announcements. */
export async function sendAnnouncement(chatId: string, text: string): Promise<Message> {
  return sendMessage(chatId, text, 'text', { meta: { announcement: true } });
}

/** Is this message an announcement? Reads meta, so no decryption is needed. */
export function isAnnouncement(m: Pick<Message, 'meta'>): boolean {
  return !!m.meta && (m.meta as any).announcement === true;
}

// ─── Shared group calendar (Groups & Circles) ───────────────────────
//
// `payload` is CIPHERTEXT the caller seals and opens itself — title, notes,
// location, exact time, duration and recurrence all live inside it. The server
// only ever sees the month bucket it filters on. See migration 072.

export interface GroupEventRow {
  id:          number;
  createdBy:   string | null;
  /** 'YYYY-MM', or null for a recurring event (always returned). */
  monthKey:    string | null;
  payload:     string;
  repeatUntil: string | null;
  createdAt:   string;
  updatedAt:   string;
}

/** Fetch the given month buckets plus every still-live recurring event. */
export async function listGroupEvents(chatId: string, months: string[]): Promise<GroupEventRow[]> {
  const qs = months.length ? `?months=${encodeURIComponent(months.join(','))}` : '';
  return api(`/chats/${encodeURIComponent(chatId)}/events${qs}`);
}

export async function createGroupEvent(
  chatId: string,
  e: { payload: string; monthKey?: string | null; repeatUntil?: string | null },
): Promise<{ id: number }> {
  return api(`/chats/${encodeURIComponent(chatId)}/events`, { method: 'POST', json: e });
}

export async function updateGroupEvent(
  chatId: string,
  eventId: number,
  e: { payload: string; monthKey?: string | null; repeatUntil?: string | null },
): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/events/${eventId}`, { method: 'PATCH', json: e });
}

export async function deleteGroupEvent(chatId: string, eventId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/events/${eventId}`, { method: 'DELETE' });
}

// ─── In-app membership (Groups & Circles, membership v2) ────────────
//
// EVERYTHING HAPPENS INSIDE CRAZZYCHAT. There is no link to share, no QR to
// scan, no SMS and no WhatsApp hand-off. An invitation names a crazzychat
// account and is acted on by being signed in as that account.
//
// Three steps, not two, and which ones apply depends on the group's mode:
//
//   strict (default)  invite → the invitee ACCEPTS → an owner APPROVES → joined
//   user_approval     invite → the invitee accepts → joined
//   admin_approval    the user REQUESTS → an owner approves → joined
//
// So `accepted` is NOT membership: it means the invitee said yes and is waiting
// on an owner. `joined` is membership. Anywhere this file names both, the
// difference is load-bearing.

export type InvitationStatus =
  | 'pending' | 'accepted' | 'joined' | 'rejected' | 'cancelled' | 'expired' | 'revoked';

/**
 * How an invitation was delivered. `app` is the only value new invitations
 * carry; the rest exist so invitations created before membership v2 still
 * render rather than falling off the list.
 */
export type InvitationChannel = 'app' | 'sms' | 'whatsapp' | 'email' | 'qr' | 'link';

export type ApprovalMode = 'strict' | 'user_approval' | 'admin_approval';

export interface Invitation {
  id:            number;
  inviteeUserId: string | null;
  kind:          'user' | 'phone' | 'email' | 'link';
  /** The email an invitee was addressed at. Never populated for phone — that is stored only as a hash. */
  ref?:          string | null;
  name:          string | null;
  channel:       InvitationChannel;
  status:        InvitationStatus;
  /**
   * True when the CALLER sent this one. Withdrawing your own invitation and
   * revoking someone else's are different acts landing in different statuses,
   * so the UI has to know which to offer.
   */
  mine:          boolean;
  expiresAt:     string;
  respondedAt:   string | null;
  createdAt:     string;
}

/** An invitation waiting for ME — either unanswered, or accepted and awaiting an owner. */
export interface MyInvitation {
  id:          number;
  chatId:      string;
  name:        string | null;
  groupType:   string | null;
  icon:        string | null;
  color:       string | null;
  status:      InvitationStatus;
  inviterName: string | null;
  /** Preview before deciding: how big the group is. Never the member list. */
  memberCount:   number;
  approvalMode:  ApprovalMode;
  /** True when this row is my own request to join rather than someone's invitation. */
  requested:     boolean;
  /** Whether accepting admits me outright, or only starts the wait for an owner. */
  joinsOnAccept: boolean;
  canAccept:     boolean;
  canDecline:    boolean;
  expiresAt:   string;
  createdAt:   string;
}

/** Someone part-way in: they accepted an invitation, or they asked to join. */
export interface PendingMember {
  id:          number;
  userId:      string | null;
  name:        string | null;
  photoURL:    string | null;
  status:      InvitationStatus;
  /** True when they asked to join; false when they were invited. */
  requested:   boolean;
  inviterName: string | null;
  createdAt:   string;
  acceptedAt:  string | null;
  canApprove:  boolean;
  canReject:   boolean;
}

/** Somebody who could be invited, and why they can or cannot be. */
export interface InviteCandidate {
  id:       string;
  name:     string | null;
  photoURL: string | null;
  /** `invitable`, or the reason there is no button: already in, already invited, or recently removed. */
  state:    'invitable' | 'member' | 'invited' | 'cooldown';
  cooldownUntil?: string;
}

export interface NewInvitation {
  id:            number;
  inviteeUserId: string;
  status:        InvitationStatus;
  expiresAt:     string;
  channel:       InvitationChannel;
}

/**
 * Invite one person. They must already be on crazzychat: address them by
 * userId, or by an email/phone that resolves to an account. A handle that
 * matches nobody is refused — there is no off-platform invitation to fall
 * back to.
 */
export async function createInvitation(
  chatId: string,
  who: { userId?: string; phone?: string; email?: string },
  opts: { expiresInHours?: number } = {},
): Promise<NewInvitation> {
  return api(`/chats/${encodeURIComponent(chatId)}/invitations`, {
    method: 'POST',
    json: { ...who, ...opts },
  });
}

export async function listInvitations(chatId: string): Promise<Invitation[]> {
  return api(`/chats/${encodeURIComponent(chatId)}/invitations`);
}

/** Give an invitation a fresh expiry and pull it back out of `expired`. */
export async function resendInvitation(chatId: string, invitationId: number): Promise<NewInvitation> {
  return api(`/chats/${encodeURIComponent(chatId)}/invitations/${invitationId}/resend`, { method: 'POST' });
}

export async function revokeInvitation(chatId: string, invitationId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/invitations/${invitationId}`, { method: 'DELETE' });
}

/**
 * Withdraw an invitation you personally sent. Distinct from revoking, which is
 * an administrative act on someone else's — they land in different statuses so
 * the group's history still says who ended it.
 */
export async function cancelInvitation(chatId: string, invitationId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/invitations/${invitationId}/cancel`, { method: 'POST' });
}

/** Invitations addressed to me that are still live — pending, or accepted and waiting. */
export async function myInvitations(): Promise<MyInvitation[]> {
  return api(`/invitations`);
}

/**
 * Say yes. Whether this admits you or only starts the wait is the GROUP's
 * decision, read server-side — `joined` in the response is the answer, and
 * `joinsOnAccept` on the invitation is the advance warning to show first.
 */
export async function acceptInvitation(
  invitationId: number,
): Promise<{ id: number; chatId: string; status: InvitationStatus; joined: boolean }> {
  return api(`/invitations/${invitationId}/accept`, { method: 'POST' });
}

export async function rejectInvitation(invitationId: number): Promise<void> {
  await api(`/invitations/${invitationId}/reject`, { method: 'POST' });
}

/**
 * LEGACY. Redeems a signed token from a link minted before membership v2.
 *
 * Nothing in the app produces one any more — kept only so that a link already
 * sitting in somebody's messages still works. Do not build on it: an
 * invitation reached this way is a forwardable credential, which is exactly
 * what the in-app flow above replaced.
 */
export async function redeemInvitation(token: string): Promise<{ chatId: string; ok: boolean }> {
  return api(`/invitations/redeem`, { method: 'POST', json: { token } });
}

/** The owner's queue: everyone part-way in, invited and self-requested alike. */
export async function pendingMembers(chatId: string): Promise<PendingMember[]> {
  return api(`/chats/${encodeURIComponent(chatId)}/membership/pending`);
}

/** Admit someone who has accepted. Only ever legal from `accepted`. */
export async function approveMember(chatId: string, invitationId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/invitations/${invitationId}/approve`, { method: 'POST' });
}

/** Turn someone down. Same terminal status as their own decline, different actor. */
export async function rejectMember(chatId: string, invitationId: number): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/invitations/${invitationId}/reject`, { method: 'POST' });
}

/**
 * Who can be invited. Search by exact email or phone, or by name among people
 * you already share a chat with. Deliberately not a user directory: you cannot
 * find a stranger here, because you cannot invite one.
 */
export async function inviteCandidates(chatId: string, q: string): Promise<InviteCandidate[]> {
  if (q.trim().length < 2) return [];
  return api(`/chats/${encodeURIComponent(chatId)}/membership/candidates?q=${encodeURIComponent(q.trim())}`);
}

/** Ask to join a group that admits people by request. */
export async function requestToJoin(chatId: string): Promise<{ id: number; chatId: string; pending: boolean }> {
  return api(`/chats/${encodeURIComponent(chatId)}/membership/request`, { method: 'POST' });
}

/** The card a group_ref message carries. Server-written — see below. */
export interface GroupRef {
  groupId:    string;
  name:       string | null;
  groupType:  GroupType | null;
  icon:       string | null;
  color:      string | null;
}

/**
 * Post a card into `toChatId` saying a group exists and may be asked to join.
 *
 * The in-app replacement for an invite link, and deliberately much weaker than
 * one: the card carries NO token and admits nobody. Tapping it opens a request
 * that an admin still has to approve.
 *
 * The server refuses this unless the group is in `admin_approval` mode and you
 * hold `invite_members` there — the same authority that could have invited the
 * person directly. It also OVERWRITES the name and presentation from the
 * database, so a card cannot be made to say something the group does not.
 * Nothing passed here beyond the id is trusted.
 */
export async function shareGroup(toChatId: string, groupId: string): Promise<void> {
  await sendMessage(toChatId, '', 'group_ref', { meta: { groupId } });
}

/** Read the card off a message, or null when it is malformed. */
export function groupRefOf(meta: unknown): GroupRef | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const groupId = typeof m.groupId === 'string' ? m.groupId : '';
  if (!groupId) return null;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    groupId,
    name: str(m.name),
    groupType: str(m.groupType) as GroupType | null,
    icon: str(m.icon),
    color: str(m.color),
  };
}

/**
 * Hand the group to another member. Irreversible: you become an admin and they
 * become the owner, so `confirm` is required rather than inferred from the tap.
 */
export async function transferOwnership(
  chatId: string,
  userId: string,
): Promise<{ ownerId: string; yourRole: string }> {
  return api(`/chats/${encodeURIComponent(chatId)}/membership/transfer`, {
    method: 'POST',
    json: { userId, confirm: true },
  });
}

/** Owner-only: change how many gates stand between an invitation and membership. */
export async function setApprovalMode(chatId: string, mode: ApprovalMode): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/membership/approval-mode`, {
    method: 'PATCH',
    json: { mode },
  });
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

  const { searchCachedMessagesInChat, getCachedChat } = await import('./localDb');
  const [hits, chat] = await Promise.all([
    searchCachedMessagesInChat(chatId, term, limit),
    getCachedChat(chatId).catch(() => null),
  ]);

  const nameById = new Map<string, string>();
  for (const m of chat?.members ?? []) {
    if (m.userId) nameById.set(m.userId, m.name || m.email || '');
  }

  // localDb decrypts only the at-rest cache field. It must not replay historical
  // plaintext through the live Double Ratchet, which can advance/reset sessions.
  return hits.map(m => ({
    id: m.id,
    senderId: m.senderId,
    senderName: nameById.get(m.senderId) || null,
    content: m.content,
    type: m.type,
    createdAt: m.createdAt,
  }));
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
export async function setFavourite(chatId: string, favourite: boolean): Promise<void> {
  await api(`/chats/${encodeURIComponent(chatId)}/favourite`, {
    method: 'POST',
    json: { favourite },
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
export async function getCommonGroups(userId: string): Promise<CommonGroup[]> {
  try {
    // Opted in to binary protobuf. The Go handler has had a typed branch since
    // the Wave 4.2 enabling step, but the caller never asked for it — so the
    // typed path was unreachable from the app and the endpoint was "migrated"
    // only in a selftest. An unused proto option is not completion.
    //
    // The decoder is `commonGroupsFromProtobuf` in lib/ccwire/startupAdapter,
    // NOT a lambda here. It was a lambda, and the consequence was that the
    // negotiation selftest — which cannot import this module, react-native
    // being what it is — tested a hand-written COPY of it and left the shipped
    // one with no coverage whatsoever. The adapter module is react-native-free
    // on purpose, so the selftest now drives the real function. It still pulls
    // @bufbuild/protobuf in through a dynamic import, reached only after a
    // server has actually answered in binary.
    const r = await api<{ groups: CommonGroup[] }>(
      `/chats/common/${encodeURIComponent(userId)}`,
      { proto: commonGroupsFromProtobuf },
    );
    return r.groups || [];
  } catch { return []; }
}

// ─── Communities (WhatsApp) ─────────────────────────────────────────
export interface Community { id: string; name: string; description: string | null; photoURL: string | null; groupCount: number; }
export interface CommunityGroup { id: string; name: string; photoURL: string | null; isAnnouncement: boolean; members: number; }
export interface CommunityDetail { id: string; name: string; description: string | null; photoURL: string | null; isOwner: boolean; groups: CommunityGroup[]; }

// Throws on failure (no `catch { return [] }`): the only caller keeps its
// cached list on error, and an empty array here would overwrite that cache.
export async function listCommunities(): Promise<Community[]> {
  const r = await api<{ communities: Community[] }>('/communities');
  return r.communities || [];
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

// E2EE reactions (F4, VC-031 / WhatsApp model): a reaction is a tiny REFERENCE
// MESSAGE whose entire payload {reactsTo, op, emoji} rides INSIDE the E2E
// content — the server stores only ciphertext and can no longer read which
// emoji anyone placed. Add/remove are enqueued via messageQueue.enqueueReaction
// (durable offline), flowing through the normal 'send' path; clients aggregate
// counts themselves — one reaction per user per message.


import { nextForwardScore } from './forwardPolicy';

// ─── Forward (Day 8) ────────────────────────────────────────────────
// Server-side it's still a normal POST /messages — we just preserve the
// original sender/chat in meta.forwardedFrom so the receiving bubble can
// render a "Forwarded" label.
export async function forwardMessage(
  source: { id: number; chatId: string; senderId: string; type: Message['type']; content: string | null; meta?: any },
  targetChatId: string,
): Promise<Message> {
  // View-once / invisible-ink content is never forwarded. Stripping only the
  // flag would re-send the protected body as an ordinary, permanent message,
  // so refuse outright (the UI hides Forward for these; this is the backstop).
  if (source.meta?.viewOnce || source.meta?.invisibleInk) {
    throw new Error('View-once and invisible-ink messages cannot be forwarded.');
  }
  // A sender-local file path means nothing on another device; never send it.
  const { localUri: _localUri, viewOnce: _viewOnce, invisibleInk: _invisibleInk, ...meta } = source.meta ?? {};
  return sendMessage(targetChatId, source.content ?? '', source.type, {
    meta: {
      ...meta,
      forwardedFrom: { messageId: source.id, chatId: source.chatId, senderId: source.senderId },
      // AUDIT F10. How many hops this has made. Read from the SOURCE message's
      // meta, so a chain keeps counting instead of resetting to 1 at every
      // relay — which is the only thing that separates "a friend sent me this"
      // from a message on its fiftieth pass. See lib/forwardPolicy.ts for why
      // this is signalling and not a control.
      forwardScore: nextForwardScore(source.meta),
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
// This is the CLIENT HALF of a two-stage peppered discovery hash. It is
// deliberately not the final value:
//
//   client  →  h  = sha256(digits)                         (this file)
//   server  →  H  = HMAC-SHA256(PEPPER, h)                 (vault.DiscoveryHash)
//              users.phone_hash stores H; /contacts/match peppers each
//              submitted h and compares, then echoes the client's ORIGINAL h
//              back so the app can key its address book by it.
//
// The pepper is a server-only env secret and never reaches the client, which
// is the whole point: a stolen users-table dump is not rainbow-tableable over
// the ~10^10 mobile keyspace without it. The client cannot compute H, and must
// not be able to.
//
// Normalization (must be byte-identical on both sides, or discovery silently
// returns zero matches — there is no error, just an empty list):
//   * strip non-digits (note: no '+', the plus is stripped)
//   * if exactly 10 digits → prepend "91" (India default for unprefixed)
//   * SHA-256 of the resulting digits string, lowercase hex
// Server mirrors: vaultchat-backend-go/internal/routes/auth.go
// authNormalizePhone / authHashPhone / authDiscoveryPhoneHash. A selftest
// pins the agreement: internal/routes/contacts_discovery_test.go.
//
// NOT stretched with a slow KDF, on purpose. A sync hashes up to 5000 numbers,
// which caps the per-number budget at ~1 ms; measured PBKDF2-SHA256 cost is
// ~12 ms/hash at only 1k iterations under @noble (pure JS, the Expo Go path)
// and ~7 ms at 4k natively — i.e. a 60-360 s blocking sync for a work factor a
// GPU still clears in hours. Client-side stretching cannot win this trade at
// 5000x; the pepper (which an attacker cannot parallelise around at all) and
// the per-account hash quota on /contacts/match are what actually bound the
// exposure. See SECRETS.md and contacts.go:matchHashesPerDay.

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
 * crazzychat users. Server caps at 5000 hashes/request and rate-limits
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
/**
 * What a stored object is FOR. Retention is per class, so this is the thing
 * that decides whether an object is reclaimed in three hours, when its story
 * expires, or never:
 *
 *   chat      chat media — the 3-hour / delivered-to-everyone rules
 *   profile   a user avatar — kept until the user changes or deletes it
 *   group     a group photo — kept until changed or deleted
 *   story     status media — kept until the story itself expires (24h)
 *   mini_app  owned by a mini-app's own lifecycle
 *
 * Anything undeclared is stored as 'unknown' server-side and never
 * automatically deleted.
 */
export type AttachmentPurpose = 'chat' | 'profile' | 'group' | 'story' | 'mini_app';

export async function uploadAttachment(
  uri: string,
  filename: string,
  mime: string,
  opts: {
    viewOnce?: boolean; signal?: AbortSignal; purpose?: AttachmentPurpose;
    /** 0→1 as the bytes go up. See postWithProgress for why this isn't fetch. */
    onProgress?: (frac: number) => void;
  } = {},
): Promise<UploadResult> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');

  let size = 0;
  try {
    const fi: any = await FileSystem.getInfoAsync(uri);
    if (fi?.exists && typeof fi.size === 'number') size = fi.size;
  } catch {}

  // Genuinely huge files → resumable chunked (multipart) upload so a mid-upload
  // network drop resumes from the parts already stored. Threshold is the server
  // relay's cap (100 MB, uploads.go upMaxBytes); anything at/under it takes the
  // reliable server-relay path below instead.
  if (size >= 100 * 1024 * 1024) {   // > server-relay cap
    try {
      const { resumableUpload } = require('./resumableUpload');
      // Multipart already computes an accurate fraction from parts landed
      // (including ones a resume skipped) — just forward it.
      return await resumableUpload(uri, filename, mime, size, {
        viewOnce: opts.viewOnce, signal: opts.signal,
        onProgress: UPLOAD_PROGRESS ? opts.onProgress : undefined,
      });
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;   // user cancelled — don't silently re-upload
      if (__DEV__) console.warn('[upload] resumable failed:', e?.message);
      throw e;
    }
  }

  // Server-relay: POST the bytes to our API, which stores them in R2 itself
  // (uploads.go uploadsPost). This replaced the presigned DIRECT-to-R2 PUT,
  // which failed on some device networks — the phone got a 200-looking result
  // but the bytes never reached R2, leaving orphan attachment rows (blank
  // media). Here the row is written only AFTER the server confirms the object
  // is in R2, so a sent image always has bytes behind it. The phone only ever
  // talks to api.corefinite.com, which it can always reach.
  // ponytail: routes media bytes through the box instead of direct-to-R2; fine
  // at current scale. Restore presigned-direct as an optimization once the
  // device-side PUT failure is understood.
  const form = new FormData();
  form.append('file', { uri, name: filename, type: mime } as any);   // RN FormData file object
  // Declare what this object is FOR. The server stores it on the attachment
  // row and every retention rule keys off it (migration 100). Omitting it is
  // not fatal — the server defaults to 'unknown', which is never auto-deleted —
  // but an unclassified object is one nobody can ever reclaim, so every call
  // site should say.
  const params = [
    ...(opts.viewOnce ? ['viewOnce=1'] : []),
    ...(opts.purpose ? [`purpose=${encodeURIComponent(opts.purpose)}`] : []),
  ];
  const qs = params.length ? `?${params.join('&')}` : '';
  const url = `${SERVER_URL}/uploads${qs}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Progress wanted → XHR (same request, plus upload events). Otherwise the
  // original fetch, byte-for-byte.
  if (UPLOAD_PROGRESS && opts.onProgress) {
    return postWithProgress(url, form, headers, opts.onProgress, opts.signal);
  }

  // protobuf-migration 4.6: the no-progress path goes through the funnel.
  // api() already special-cases a FormData body — it passes it through
  // untouched (so RN still sets multipart/form-data + boundary itself) and
  // deliberately skips the 30s abort backstop for it, which is exactly what
  // this call site did by hand. What it gains is the part that was missing:
  // the 401 refresh-and-retry, the X-Device-Id header, and `err.status` on a
  // rejection (the XHR path above has always set it; this one never did, so
  // mediaOutbox's isPermanent() saw `undefined` and burned all 8 transient
  // retries on a 413).
  //
  // The manual Bearer above is still needed by postWithProgress, and the
  // `!token` guard still short-circuits before any bytes are read.
  return api<UploadResult>(`/uploads${qs}`, {
    method: 'POST',
    body: form,
    signal: opts.signal,
  });
}

/**
 * POST a FormData with upload progress.
 *
 * WHY NOT fetch: React Native's fetch reports no upload progress at all — it is
 * a polyfill over this very XMLHttpRequest, which does expose
 * `upload.onprogress`. So this is the SAME networking module and the SAME
 * multipart body, only with the progress events surfaced.
 *
 * WHY NOT FileSystem.createUploadTask: it derives the multipart filename from
 * the file's basename on disk, and the server stores `part.FileName()` as the
 * attachment's filename (uploads.go uploadsPost) and returns it — which the
 * caller feeds to storeSentCopy. Uploading the encrypted temp
 * (`enc_1712…_photo.jpg`) or the outbox copy (`m_<uuid>_photo.jpg`) would have
 * silently renamed every attachment. RN's FormData sends the explicit `name`
 * below, so the filename is unchanged.
 *
 * Preserved deliberately: the Authorization header, the ?purpose= / ?viewOnce=
 * query string, the 'file' field name, and abort semantics.
 */
function postWithProgress(
  url: string, form: FormData, headers: Record<string, string>,
  onProgress: (frac: number) => void, signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    // Mirrors AbortSignal → xhr.abort(). Registered before send so an
    // already-aborted signal cancels immediately rather than uploading first.
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      signal.addEventListener('abort', onAbort);
    }
    const done = () => signal?.removeEventListener('abort', onAbort);

    if (xhr.upload) {
      xhr.upload.onprogress = (e: any) => {
        // RN's XMLHttpRequest hardcodes lengthComputable:true and subscribes to
        // 'didSendNetworkData' unconditionally in send(), so this does fire.
        // The total>0 guard is only there so a zero-byte total can never
        // produce NaN and paint a broken ring.
        if (e?.total > 0) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      done();
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        // A 2xx with no parseable body is not a success we can use: the caller
        // reads .id off this and would fail later with a confusing TypeError,
        // after the outbox had already deleted its durable copy. Fail here
        // instead, where it is still a retryable send.
        if (!body?.id) { reject(new Error('Upload succeeded but returned no attachment')); return; }
        // The bytes are on the server; nothing is left to send.
        onProgress(1);
        resolve(body as UploadResult);
      } else {
        // Same fallback as the fetch path (lib/api.ts httpErrorMessage), for the
        // same reason: whatever lands here is read by a person in a dialog, and
        // "HTTP 413" tells them nothing they can act on. A server-supplied
        // body.error still wins, exactly as before.
        const err: any = new Error(body?.error || httpErrorMessage(xhr.status));
        // mediaOutbox keys permanent-vs-transient off this (isPermanent), and
        // fetch's path threw plain Errors with no status — supplying it here
        // makes a 413 stop retrying instead of burning all 8 attempts.
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => { done(); reject(new Error('Network request failed')); };
    xhr.onabort = () => { done(); reject(new Error('aborted')); };
    xhr.send(form as any);
  });
}

// Mark a view-once attachment as consumed. Called by the recipient's
// client when the bubble first reveals the media. Server-side, idempotent
// — only the first call actually flips the flag.
export async function markAttachmentViewed(attachmentId: string): Promise<void> {
  await api(`/uploads/${encodeURIComponent(attachmentId)}/viewed`, { method: 'POST' });
}

/**
 * VaultView remote revoke — sender-only, irreversible. The server stamps
 * revoked_at, deletes the stored bytes, and broadcasts 'media_revoked' so
 * recipients destroy their per-file key and any decrypted plaintext. Recipients
 * who were offline converge on their next fetch (410 + { revoked: true }).
 *
 * The caller is responsible for wiping the SENDER's own local copies —
 * lib/protectedMedia.wipeRevokedMedia() — since the sender never receives the
 * broadcast for their own action.
 */
export async function revokeAttachment(attachmentId: string): Promise<void> {
  await api(`/uploads/${encodeURIComponent(attachmentId)}/revoke`, { method: 'POST' });
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
