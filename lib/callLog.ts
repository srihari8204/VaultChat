// lib/callLog.ts — on-device call history (no backend).
//
// Calls are logged locally when they end (voice/video screens) or are missed
// (incoming-call screen). This is the real device call log — like WhatsApp's,
// it lives on the phone, not the server. Capped to the most recent 300 entries.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vc_call_log_v1';
const MAX = 300;

export type CallKind = 'audio' | 'video';
export type CallDirection = 'incoming' | 'outgoing' | 'missed';

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
