// lib/broadcast.ts — client for the broadcast API (migration 079 + routes/broadcasts.go).
//
// THE ONE THING THIS MODULE MUST NOT GET WRONG
// --------------------------------------------
// Broadcast is the only crazzychat mode that is NOT end-to-end encrypted: the
// audience is unbounded and receives HLS from a CDN, so there is no key
// exchange that could reach them. The server returns `e2ee` on every session
// and the UI renders it from that value — never from an assumption about the
// mode. In an app called crazzychat, a padlock shown over a stream that has none
// is worse than any crash.

import { api } from './api';

export type BroadcastStatus = 'starting' | 'live' | 'ended' | 'failed';

/**
 * Who may watch.
 *
 * `public`  anyone signed in; the stream appears in the Live Now list.
 * `private` the host and people the host invited. Private streams are NOT in
 *           the listing and the server refuses both a join token and a playback
 *           ticket to anyone else — the client does not enforce this, it only
 *           renders it.
 */
export type BroadcastVisibility = 'public' | 'private';

export interface Broadcast {
  id: string;
  hostId: string;
  chatId?: string;
  title: string;
  status: BroadcastStatus;
  /** Optional. Shown under the title on the player; the listing shows the title. */
  description: string;
  /** Read it; never assume it from what this client asked for. */
  visibility: BroadcastVisibility;
  /**
   * THIS caller's place in the broadcast, decided by the server.
   *
   *   host      the owner — publishes, and may end it
   *   speaker   an invited co-host who accepted — publishes
   *   audience  everyone else — watches HLS, unbounded in number
   *
   * Only `GET /broadcasts/{id}` populates it, so it is absent from listings.
   *
   * It decides whether this device JOINS the LiveKit room or just plays the
   * HLS stream, which is the difference between a seat on the 20-person stage
   * and being one of unlimited viewers. Advertised only — the token endpoint
   * recomputes it, so claiming a role here gains nothing: the grant would still
   * be audience and the media server would refuse the camera.
   */
  myRole?: 'host' | 'speaker' | 'cohost' | 'audience';
  /**
   * Playback URL, ticket included. Absent until egress has produced a playlist
   * — and ALSO absent when the server has decided this viewer may not watch a
   * private stream, which is what makes the ticket the real gate.
   */
  hlsUrl?: string;
  room: string;
  /** Always false today. Read it; do not assume it. */
  e2ee: boolean;
  viewerCount: number;
  peakViewers: number;
  /**
   * THE SHAPE OF THE SCREEN SHARE RUNNING RIGHT NOW — absent when none is
   * (server migration 116, written from LiveKit's track_published).
   *
   * Absent is meaningful and must not be replaced with a default. A viewer on
   * the low-latency path never needs these: they subscribe to the publisher's
   * own track and the SFU hands them the same numbers directly. A viewer on HLS
   * has nothing else — the composite they receive is a fixed LANDSCAPE canvas
   * whatever the host is doing, so it cannot tell a shared landscape game from a
   * shared portrait phone, and those want opposite treatment on a phone.
   *
   * This is what makes PUBG watchable on a public live: the client learns the
   * content is landscape and turns the panel, instead of showing a strip.
   */
  shareWidth?: number;
  shareHeight?: number;
  startedAt: string;
  endedAt?: string;
}

/**
 * Go live.
 *
 * Fails with 409 if this account already has a stream running, and with 503 if
 * the deployment has no Go Live LiveKit configured — the server refuses rather
 * than falling back to the calling cluster, so that 503 is a real answer and not
 * a bug to route around.
 *
 * `visibility` defaults to public server-side when omitted, which is what an
 * older build of this app sends.
 */
export async function startBroadcast(
  title: string,
  chatId?: string,
  visibility: BroadcastVisibility = 'public',
  description = '',
  /**
   * Optional Zoom-style passcode. Only meaningful on a private live — the
   * server drops it on a public one, where the stream is in everyone's listing
   * by definition. Sent as plaintext over TLS and bcrypt-hashed server-side;
   * never readable back, so the host's own copy is the only one there is.
   */
  passcode = '',
): Promise<Broadcast> {
  return api('/broadcasts', {
    method: 'POST', json: { title, description, chatId, visibility, passcode },
  }) as Promise<Broadcast>;
}

/** Everything live right now. */
export async function listLive(): Promise<Broadcast[]> {
  const res: any = await api('/broadcasts/live');
  return Array.isArray(res?.broadcasts) ? res.broadcasts : [];
}

export async function getBroadcast(id: string): Promise<Broadcast> {
  return api(`/broadcasts/${encodeURIComponent(id)}`) as Promise<Broadcast>;
}

/**
 * End the stream. Deliberately never throws: the caller is a user pressing
 * "End" on a flaky connection, and a rejected promise there strands the UI on
 * "ending…" while the stream is, in fact, already ended. The server treats a
 * repeat as success for the same reason.
 */
export async function endBroadcast(
  id: string, viewerCount = 0, peakViewers = 0,
): Promise<void> {
  try {
    await api(`/broadcasts/${encodeURIComponent(id)}/end`, {
      method: 'POST', json: { viewerCount, peakViewers },
    });
  } catch { /* already ended, or offline — the sweep closes it either way */ }
}

/**
 * Poll a starting broadcast until egress publishes its playlist.
 *
 * A stream is created as `starting` and only becomes `live` when there is
 * something to play. Showing the player before then gives the viewer a broken
 * video element and no explanation, which reads as "the app is broken" rather
 * than "the stream has not started".
 *
 * Gives up rather than polling forever: egress that never produces a playlist
 * is a server-side failure, and the UI must be able to say so.
 */
export async function waitForPlaylist(
  id: string, timeoutMs = 60_000, everyMs = 2_000,
): Promise<Broadcast | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const b = await getBroadcast(id);
      if (b?.status === 'live' && b.hlsUrl) return b;
      if (b?.status === 'ended' || b?.status === 'failed') return null;
    } catch { /* transient — keep waiting until the deadline */ }
    await new Promise(r => setTimeout(r, everyMs));
  }
  return null;
}

// ── live chat + viewer presence ───────────────────────────────────────

export interface BroadcastMessage {
  id: number;
  userId: string;
  name: string;
  message: string;
  createdAt: string;
}

/**
 * Announce (and re-announce) that we are watching; returns the live count.
 *
 * Must be called on a HEARTBEAT, not once: the server holds viewers in a Redis
 * sorted set scored by expiry, so a viewer who backgrounds or loses signal ages
 * out instead of inflating the number forever. A counter that only ever went up
 * would be worse than showing nothing.
 */
export async function watchBroadcast(id: string): Promise<number> {
  try {
    const res: any = await api(`/broadcasts/${encodeURIComponent(id)}/watch`, { method: 'POST' });
    return Number(res?.viewerCount) || 0;
  } catch { return 0; }
}

export async function unwatchBroadcast(id: string): Promise<void> {
  try { await api(`/broadcasts/${encodeURIComponent(id)}/unwatch`, { method: 'POST' }); } catch {}
}

/**
 * Messages newer than `after`. Cursor, not offset: a live chat grows while it
 * is being read, and OFFSET would skip or repeat lines as rows shift beneath
 * the query.
 */
export async function listBroadcastChat(id: string, after = 0): Promise<BroadcastMessage[]> {
  try {
    const res: any = await api(`/broadcasts/${encodeURIComponent(id)}/chat?after=${after}`);
    return Array.isArray(res?.messages) ? res.messages : [];
  } catch { return []; }
}

export async function sendBroadcastChat(id: string, message: string): Promise<BroadcastMessage | null> {
  try {
    return await api(`/broadcasts/${encodeURIComponent(id)}/chat`, {
      method: 'POST', json: { message },
    }) as BroadcastMessage;
  } catch { return null; }
}

export default {
  startBroadcast, listLive, getBroadcast, endBroadcast, waitForPlaylist,
  watchBroadcast, unwatchBroadcast, listBroadcastChat, sendBroadcastChat,
  createPoll, listPolls, votePoll, closePoll,
  createInviteLink, getInviteLink, revokeInviteLink, redeemInviteLink, inviteCodeFrom,
};

// ── polls ─────────────────────────────────────────────────────────────
//
// The one thing the UNBOUNDED audience writes to. The stage is capped at 20;
// answering a poll is deliberately not limited to it — unlimited viewers voting
// is the whole point. Live tallies come from Redis server-side, so a result that
// moves on ten thousand screens costs a set cardinality, not an aggregate.

export interface BroadcastPoll {
  id: number;
  question: string;
  options: string[];
  /** Votes per option, positionally aligned with `options`. */
  counts: number[];
  total: number;
  /** This viewer's own choice, or -1 if they have not voted. */
  myVote: number;
  closed: boolean;
  createdAt: string;
}

/** Host only. 2..10 options; the server trims and rejects anything outside that. */
export async function createPoll(
  broadcastId: string, question: string, options: string[],
): Promise<BroadcastPoll | null> {
  try {
    return await api(`/broadcasts/${encodeURIComponent(broadcastId)}/polls`, {
      method: 'POST', json: { question, options },
    }) as BroadcastPoll;
  } catch { return null; }
}

export async function listPolls(broadcastId: string): Promise<BroadcastPoll[]> {
  try {
    const res: any = await api(`/broadcasts/${encodeURIComponent(broadcastId)}/polls`);
    return Array.isArray(res?.polls) ? res.polls : [];
  } catch { return []; }
}

/**
 * Answer a poll. A vote is FINAL — the server refuses a second one with 409,
 * which is why the UI must not offer a way to change it.
 *
 * Returns null on refusal (already voted, poll closed, not allowed to watch) so
 * the caller can simply re-read rather than interpret a status code.
 */
export async function votePoll(
  broadcastId: string, pollId: number, option: number,
): Promise<{ counts: number[]; total: number; myVote: number } | null> {
  try {
    return await api(
      `/broadcasts/${encodeURIComponent(broadcastId)}/polls/${pollId}/vote`,
      { method: 'POST', json: { option } },
    ) as { counts: number[]; total: number; myVote: number };
  } catch { return null; }
}

/** Host only. Idempotent: closing a closed poll is success, not an error. */
export async function closePoll(broadcastId: string, pollId: number): Promise<void> {
  try {
    await api(`/broadcasts/${encodeURIComponent(broadcastId)}/polls/${pollId}/close`,
      { method: 'POST', json: {} });
  } catch { /* already closed, or offline */ }
}

// ── private invitations ───────────────────────────────────────────────
//
// THE LINK IS THE ACCESS MECHANISM. The host does not pick invitees up front:
// they start a Private Live, get one link, and send it wherever they like.
//
// The link carries an opaque 32-byte code and nothing else — no LiveKit key, no
// room name, no infrastructure detail. Redeeming it grants VIEWING only; a seat
// on the 20-person stage still requires the host to promote you.

export interface InviteLink {
  /** Plaintext code. Returned ONLY when created — the server stores a hash. */
  code?: string;
  /** Ready-to-share URL built from the deployment's public origin. */
  url?: string;
  createdAt: string;
  expiresAt?: string;
  active: boolean;
}

/** Host only. Rotating revokes the previous link in the same transaction. */
export async function createInviteLink(broadcastId: string): Promise<InviteLink | null> {
  try {
    return await api(`/broadcasts/${encodeURIComponent(broadcastId)}/invite-link`,
      { method: 'POST', json: {} }) as InviteLink;
  } catch { return null; }
}

/**
 * Host only. Reports whether a link exists and is still valid — but NEVER the
 * code, because only its hash is stored. A host who lost the link rotates.
 */
export async function getInviteLink(broadcastId: string): Promise<InviteLink | null> {
  try { return await api(`/broadcasts/${encodeURIComponent(broadcastId)}/invite-link`) as InviteLink; }
  catch { return null; }
}

export async function revokeInviteLink(broadcastId: string): Promise<void> {
  try {
    await api(`/broadcasts/${encodeURIComponent(broadcastId)}/invite-link`, { method: 'DELETE' });
  } catch { /* already revoked, or offline */ }
}

/**
 * The outcome of redeeming a code.
 *
 * 'passcode' is its own case rather than another flavour of failure because the
 * screen has to react differently: re-prompt for the passcode while keeping the
 * code, instead of telling the user their link is dead. The server only reveals
 * this to a caller who already proved they hold a valid code (403 vs 404), so it
 * is not an oracle for which codes exist.
 */
export type RedeemResult =
  | { ok: true; broadcastId: string; reason?: undefined }
  | { ok: false; broadcastId?: undefined; reason: 'passcode' | 'invalid' };

/**
 * Redeem a code and get the broadcast it unlocks.
 *
 * 'invalid' covers unknown, revoked, expired, and ended alike — the server
 * deliberately does not distinguish them, so neither can this.
 */
export async function redeemInviteLink(
  code: string,
  opts?: { passcode?: string; displayName?: string },
): Promise<RedeemResult> {
  try {
    const res: any = await api(`/golive/invite/${encodeURIComponent(code)}`, {
      method: 'POST',
      json: {
        passcode: opts?.passcode ?? '',
        displayName: (opts?.displayName ?? '').trim(),
      },
    });
    return typeof res?.broadcastId === 'string'
      ? { ok: true, broadcastId: res.broadcastId }
      : { ok: false, reason: 'invalid' };
  } catch (e: any) {
    // 403 is the passcode gate: the code resolved, the passcode did not. Read
    // from whichever shape the api() helper surfaces.
    const status = e?.status ?? e?.response?.status ?? e?.statusCode;
    if (status === 403) return { ok: false, reason: 'passcode' };
    return { ok: false, reason: 'invalid' };
  }
}

/** Pull the code out of a pasted link, or accept a bare code. */
export function inviteCodeFrom(input: string): string {
  const t = input.trim();
  const m = t.match(/\/live\/join\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : t;
}
