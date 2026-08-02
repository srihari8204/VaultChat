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
export async function openCallSession(
  chatId: string, kind: 'audio' | 'video', mode: CallMode = 'meeting',
): Promise<{ call: CallSessionInfo; participants: CallSessionParticipant[]; created: boolean } | null> {
  if (!CALL_SESSIONS || !chatId) return null;
  try {
    return await api('/calls', { method: 'POST', json: { chatId, kind, mode } });
  } catch {
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
