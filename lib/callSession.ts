// lib/callSession.ts — the server-side call record (Go /calls/*, migration 066).
//
// WHAT THIS BUYS
// --------------
// Until now a call had no identity. `callId` was the chatId, so a chat could
// only ever have had one call, and history lived only in AsyncStorage on the
// handset that made it — capped at 300 entries, gone on reinstall, never on a
// second device. A session row gives the call a real id, a roster, and a role.
//
// THE ONE RULE IN THIS FILE
// -------------------------
// Nothing here may ever delay, block or fail a call.
//
// A call is real-time and its media path does not need the server's permission
// to exist: signalling is a socket, media is peer-to-peer. So every function
// below is best-effort. A 404 (server not migrated yet), a timeout, an offline
// device, a 403 — all resolve to "this call has no server id", and the call
// proceeds exactly as it does today, logging locally.
//
// That is why these return null instead of throwing, why nothing awaits them on
// the setup path, and why the flag defaults off.

import { api } from './api';
import { CALL_SESSIONS } from '../constants/flags';

export type CallRole = 'host' | 'cohost' | 'speaker' | 'audience';
export type CallMode = 'meeting' | 'webinar' | 'broadcast';

export interface CallSessionParticipant {
  userId: string;
  name: string;
  photoUrl: string | null;
  role: CallRole;
  joinedAt: string;
  leftAt: string | null;
  handRaisedAt: string | null;
}

export interface CallSessionInfo {
  id: string;
  chatId: string;
  startedBy: string;
  kind: 'audio' | 'video';
  transport: 'mesh' | 'sfu';
  mode: CallMode;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface ServerCallEntry {
  callId: string;
  chatId: string;
  kind: 'audio' | 'video';
  mode: CallMode;
  role: CallRole;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  joinedAt: string;
  leftAt: string | null;
  /** Seconds THIS user was on the call — not the call's total length. */
  durationSec: number;
}

/**
 * Start the chat's call, or join the one already running.
 *
 * One call for both, matching the server: which happens depends on a race the
 * client cannot see, so it does not have to choose. `created` says which it was.
 */
/**
 * The LiveKit join credential, when the server hands it back with the session.
 *
 * Saves a whole round trip: the client used to await this call and THEN await
 * POST /calls/{id}/sfu-token before it could open the WebSocket. Measured on
 * device (Hyderabad -> Hetzner) those two hops cost 615 ms + 313 ms of a 3.6 s
 * tap-to-audio. Optional, because an older server does not send it.
 */
export interface SfuCredential {
  token: string; url: string; room: string; identity: string; role: CallRole;
}

export async function openCallSession(
  chatId: string, kind: 'audio' | 'video', mode: CallMode = 'meeting',
): Promise<{ call: CallSessionInfo; participants: CallSessionParticipant[]; created: boolean; sfu?: SfuCredential } | null> {
  if (!CALL_SESSIONS || !chatId) return null;
  try {
    return await api('/calls', { method: 'POST', json: { chatId, kind, mode } });
  } catch (e: any) {
    // ONE failure here is not like the others.
    //
    // Everything else this call can hit — a 404 on an unmigrated server, a
    // timeout, an offline device — must cost the call nothing: it falls back to
    // a call with no server-side id, which is the behaviour that predates call
    // sessions. Swallowing is right for those.
    //
    // 409 is the server saying the call is FULL, and that is a fact about the
    // world that the person needs to read. Swallowed, it became "Call failed"
    // via the generic setup error — a message that invites them to retry
    // forever against a call that has no seat. Rethrown, engine.failSetup
    // dispatches the server's own words and the screen shows them.
    if (e?.status === 409) throw e;
    return null;
  }
}

/**
 * Ring a group into a call — the server does the fan-out, over the socket AND
 * over FCM.
 *
 * The push is the point. `call_incoming` alone reaches only devices holding a
 * live socket, so a group call rang the handful of people who happened to be
 * awake; a 1:1 call has always also POSTed /call/initiate for the high-priority
 * push the native full-screen ringer listens for. This is that, for a group.
 *
 * `userIds` narrows it to named people (the in-call invite). Omitted, it rings
 * the chat's members up to the seat count.
 *
 * Returns how many were rung, 'rate_limited' (429) or 'ended' (409: the call
 * is over), or NULL when the server could not do it — an older binary with no
 * such route, or a network failure. Null means "fall back and ring the old
 * way", and the caller must, or nobody's phone rings at all.
 */
export type RingOutcome = number | 'rate_limited' | 'ended';

export async function ringCallGroup(callId: string, userIds?: string[]): Promise<RingOutcome | null> {
  if (!CALL_SESSIONS || !callId) return null;
  try {
    const res: any = await api(`/calls/${callId}/ring`, {
      method: 'POST', json: userIds?.length ? { userIds } : {},
    });
    return typeof res?.rang === 'number' ? res.rang : 0;
  } catch (e: any) {
    // 429 and 409 are answers, not "this server cannot do it", and neither may
    // fall back to the socket loop. 429: the loop would spend 63 more units of
    // the very budget that just refused one, and ring everyone anyway. 409: the
    // call has ended, so ringing would wake phones for a call nobody can join.
    // Every other failure is "this server cannot do it", which the loop can.
    if (e?.status === 429) return 'rate_limited';
    if (e?.status === 409) return 'ended';
    return null;
  }
}

/** Leave a call. Idempotent server-side; safe from any teardown path. */
export async function leaveCallSession(callId: string): Promise<void> {
  if (!CALL_SESSIONS || !callId) return;
  try { await api(`/calls/${callId}/leave`, { method: 'POST' }); } catch {}
}

/** End the call for everyone. Host only — a non-host gets a 403 and is ignored. */
export async function endCallSession(callId: string): Promise<void> {
  if (!CALL_SESSIONS || !callId) return;
  try { await api(`/calls/${callId}/end`, { method: 'POST' }); } catch {}
}

/** Promote or demote a participant. Host/cohost only. Returns success. */
export async function setCallRole(callId: string, userId: string, role: CallRole): Promise<boolean> {
  if (!CALL_SESSIONS || !callId || !userId) return false;
  try {
    await api(`/calls/${callId}/role`, { method: 'POST', json: { userId, role } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Raise or lower a hand. Omit `userId` for your own.
 *
 * Only a host or cohost may lower someone ELSE's, and nobody may raise another
 * person's — that would be putting words in their mouth. Both rules are the
 * server's; this just carries the request.
 */
export async function setHandRaised(callId: string, raised: boolean, userId?: string): Promise<boolean> {
  if (!CALL_SESSIONS || !callId) return false;
  try {
    await api(`/calls/${callId}/hand`, {
      method: 'POST',
      json: userId ? { raised, userId } : { raised },
    });
    return true;
  } catch {
    return false;
  }
}

/** The current roster, for a mid-call refresh. */
export async function getCallSession(
  callId: string,
): Promise<{ call: CallSessionInfo; participants: CallSessionParticipant[] } | null> {
  if (!CALL_SESSIONS || !callId) return null;
  try {
    return await api(`/calls/${callId}`);
  } catch {
    return null;
  }
}

/**
 * This user's call history from the server — every device, surviving reinstall.
 *
 * Returns [] rather than throwing on any failure, so a caller can always treat
 * the result as "what the server could tell me right now" and fall back to the
 * device's own log without a branch.
 */
export async function fetchCallHistory(limit = 200): Promise<ServerCallEntry[]> {
  if (!CALL_SESSIONS) return [];
  try {
    const res = await api(`/calls/history?limit=${Math.max(1, Math.min(500, limit))}`);
    return Array.isArray(res?.calls) ? res.calls : [];
  } catch {
    return [];
  }
}

export default {};
