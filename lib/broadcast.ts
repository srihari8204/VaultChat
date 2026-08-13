// lib/broadcast.ts — client for the broadcast API (migration 079 + routes/broadcasts.go).
//
// THE ONE THING THIS MODULE MUST NOT GET WRONG
// --------------------------------------------
// Broadcast is the only VaultChat mode that is NOT end-to-end encrypted: the
// audience is unbounded and receives HLS from a CDN, so there is no key
// exchange that could reach them. The server returns `e2ee` on every session
// and the UI renders it from that value — never from an assumption about the
// mode. In an app called VaultChat, a padlock shown over a stream that has none
// is worse than any crash.

import { api } from './api';

export type BroadcastStatus = 'starting' | 'live' | 'ended' | 'failed';

export interface Broadcast {
  id: string;
  hostId: string;
  chatId?: string;
  title: string;
  status: BroadcastStatus;
  /** Playback URL. Absent until egress has produced a playlist. */
  hlsUrl?: string;
  room: string;
  /** Always false today. Read it; do not assume it. */
  e2ee: boolean;
  viewerCount: number;
  peakViewers: number;
  startedAt: string;
  endedAt?: string;
}

/** Go live. Fails with 409 if this account already has a stream running. */
export async function startBroadcast(title: string, chatId?: string): Promise<Broadcast> {
  return api('/broadcasts', { method: 'POST', json: { title, chatId } }) as Promise<Broadcast>;
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
};
