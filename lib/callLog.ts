// lib/callLog.ts — on-device call history (no backend).
//
// Calls are logged locally when they end (voice/video screens) or are missed
// (incoming-call screen). This is the real device call log — like WhatsApp's,
// it lives on the phone, not the server. Capped to the most recent 300 entries.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vc_call_log_v1';
const MAX = 300;

export type CallKind = 'audio' | 'video';
// 'declined' is separate from 'missed' on purpose. A missed call is one you
// never saw; a declined call is one you saw and refused. app/incoming-call.tsx
// logged both as 'missed', so the calls tab showed a call you deliberately
// turned down in red, as something you had failed to answer (2026-09-17).
export type CallDirection = 'incoming' | 'outgoing' | 'missed' | 'declined';

export interface CallLogEntry {
  id: string;
  chatId: string;
  peerUid: string;
  peerName: string;
  peerPhoto?: string | null;
  kind: CallKind;
  direction: CallDirection;
  at: number;        // epoch ms
  durationSec: number;
  /**
   * A group (mesh) call. There is no single peer, so `peerUid` is '' and
   * `peerName` holds the group's name.
   *
   * Optional on purpose: entries written before group calls were logged have no
   * such field, and `undefined` is falsy, so every existing log entry keeps
   * behaving exactly as it did — grouped by peer, redialled 1:1.
   */
  group?: boolean;
  /**
   * The server-side call id (`calls.id`), when this call opened a session.
   *
   * This is what lets the same call be recognised in both places: the device's
   * own log and the synced server history both carry it, so merging them is an
   * id match rather than a guess about timestamps. Entries written before
   * CALL_SESSIONS — and any call whose session request failed, went offline, or
   * hit an unmigrated server — simply have none, and stay local-only. That is
   * the graceful case, not an error.
   */
  callId?: string;
}

/**
 * What an entry is grouped and redialled by. A 1:1 call belongs to a person; a
 * group call belongs to a chat, because its `peerUid` is empty and every group
 * call would otherwise collapse into one indistinguishable row.
 */
export const callLogKey = (e: Pick<CallLogEntry, 'peerUid' | 'chatId' | 'group'>): string =>
  e.group ? `g:${e.chatId}` : e.peerUid;

export async function getCallLog(): Promise<CallLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CallLogEntry[]) : [];
  } catch { return []; }
}

export async function addCallLog(e: Omit<CallLogEntry, 'id'>): Promise<void> {
  try {
    const list = await getCallLog();
    const key = callLogKey(e);
    const entry: CallLogEntry = { ...e, id: `${e.at}-${Math.round(e.durationSec)}-${key}` };
    // De-dupe a rapid double-log of the same call (same peer/group within 3s).
    const dup = list[0] && callLogKey(list[0]) === key && Math.abs(list[0].at - e.at) < 3000;
    const next = (dup ? list.slice(1) : list);
    next.unshift(entry);
    await AsyncStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX)));
  } catch {}
}

export async function removeCallLog(ids: string[]): Promise<void> {
  try {
    const set = new Set(ids);
    const list = await getCallLog();
    await AsyncStorage.setItem(KEY, JSON.stringify(list.filter(e => !set.has(e.id))));
  } catch {}
}

export async function clearCallLog(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}

// ── dismissed server calls ────────────────────────────────────────────
//
// A call that only the SERVER knows about (made on another device) has no row
// in the log above, so "remove from log" cannot delete it — it would vanish
// from the list and reappear on the next sync. Instead the id is remembered
// here and filtered out of the merge.
//
// Device-local on purpose. Hiding a call on this phone must not delete it from
// the account: another device may be the only place that history now exists,
// and a tidy-up gesture should not be able to destroy it everywhere. Which is
// also why "Clear call log" still says "from this device" and still means it.
const HIDDEN_KEY = 'vc_call_log_hidden_v1';
const HIDDEN_MAX = 1000;

export async function getHiddenServerCalls(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(HIDDEN_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

export async function hideServerCalls(callIds: string[]): Promise<void> {
  const ids = callIds.filter(Boolean);
  if (!ids.length) return;
  try {
    const set = await getHiddenServerCalls();
    for (const id of ids) set.add(id);
    // Bounded like the log itself: the newest dismissals win if it ever grows.
    await AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify([...set].slice(-HIDDEN_MAX)));
  } catch {}
}
