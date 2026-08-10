// lib/call/sfuToken.ts — fetch a scoped LiveKit join credential.
//
// The server side has existed since B2 (POST /calls/{id}/sfu-token) and nothing
// has ever called it. This is the client half, deliberately split from the
// LiveKit SDK wiring so it can land — and be reasoned about — without adding a
// native dependency to a build that is still being validated for 1:1 calls.
//
// WHAT THE SERVER GUARANTEES (routes/call_sessions.go)
//   • the role is read FRESH from call_participants on every mint, so a token
//     cannot outlive a demotion; an audience member gets canPublish=false
//     enforced BY THE SFU, not hidden by our UI
//   • tokens are short-lived, so they must be fetched at join time and on
//     reconnect — never cached across a call
//   • 503 when no cluster is provisioned, rather than a token nothing accepts
//
// It therefore does NOT cache. lib/iceConfig caches TURN credentials because
// those are per-user and long-lived; this is per-call, per-role and revocable,
// and caching it would reintroduce exactly the demotion hole the server closes.

import { api } from '../api';

export type SfuRole = 'host' | 'cohost' | 'speaker' | 'audience';

export interface SfuCredential {
  /** Signed JWT for the LiveKit room. Short-lived. */
  token: string;
  /** wss:// URL of the LiveKit server. */
  url: string;
  /** Room name, derived server-side from the call id. */
  room: string;
  /** Our own participant identity (the user id). */
  identity: string;
  /** Role as the SERVER sees it right now — may differ from what we believed. */
  role: SfuRole;
}

/** Raised when the deployment has no SFU configured (server answers 503). */
export class SfuUnavailable extends Error {
  constructor(reason: string) {
    super(reason || 'Group calling is not available on this server');
    this.name = 'SfuUnavailable';
  }
}

/**
 * Mint a join credential for an OPEN call session.
 *
 * `callId` is the server-side calls.id — the value openCallSession() returns,
 * not the chat id. A call that never opened a server session has no id and
 * cannot use the SFU; that is a real constraint, not an oversight: the SFU
 * derives permissions from call_participants, which only exists once the
 * session is open.
 */
export async function getSfuToken(callId: string): Promise<SfuCredential> {
  if (!callId) throw new Error('sfu: no server call id — the session never opened');

  const res: any = await api(`/calls/${encodeURIComponent(callId)}/sfu-token`, { method: 'POST' });

  // 503 carries a reason; surface it as its own type so the caller can fall
  // back to mesh (or tell the user plainly) instead of treating a deliberately
  // unconfigured deployment as a bug.
  if (res?.error || res?.reason) throw new SfuUnavailable(String(res.reason ?? res.error));
  if (!res?.token || !res?.url) throw new SfuUnavailable('server returned no SFU credential');

  return {
    token: String(res.token),
    url: String(res.url),
    room: String(res.room ?? ''),
    identity: String(res.identity ?? ''),
    // Trust the SERVER's role over anything we thought locally — the whole
    // point of it being echoed back.
    role: (res.role as SfuRole) ?? 'audience',
  };
}

/**
 * Whether this credential may publish media. Mirrors the server's rule so the
 * UI can hide controls it would otherwise offer and then have refused — but the
 * refusal itself lives in the token, so a client that ignores this gains
 * nothing.
 */
export function canPublish(role: SfuRole): boolean {
  return role !== 'audience';
}

/**
 * Credential for a BROADCAST room.
 *
 * A broadcast is not a call: it has no row in call_participants, so
 * /calls/{id}/sfu-token cannot resolve a role for it and would 403. The server
 * derives publish rights from broadcast_sessions.host_id instead, read fresh on
 * every mint — a viewer cannot obtain a token that lets them speak over
 * someone's stream.
 *
 * Always unencrypted (`e2ee: false`): egress has to read the frames in order to
 * transcode them to HLS.
 */
export async function getBroadcastToken(broadcastId: string): Promise<SfuCredential> {
  if (!broadcastId) throw new Error('sfu: no broadcast id');
  const res: any = await api(`/broadcasts/${encodeURIComponent(broadcastId)}/token`, { method: 'POST' });
  if (!res?.token || !res?.url) throw new SfuUnavailable(String(res?.reason ?? res?.error ?? 'no credential'));
  return {
    token: String(res.token),
    url: String(res.url),
    room: String(res.room ?? ''),
    identity: String(res.identity ?? ''),
    role: (res.role as SfuRole) ?? 'audience',
  };
}

export default { getSfuToken, canPublish };
