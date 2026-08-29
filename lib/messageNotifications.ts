// lib/messageNotifications.ts — client-raised message notifications for devices
// WITHOUT working server push (no-GMS, e.g. Huawei P30 Pro).
//
// On a Google-Play device the backend's FCM push shows the "new message"
// notification natively (fires even from a cold start), so this stays OFF to
// avoid duplicates. On a no-GMS device there is no push at all — so when the
// app is backgrounded (kept alive by the foreground-service connection) a
// message would arrive silently. This raises the OS notification ourselves.
//
// Content-free by design — mirrors the native F2 doorbell: title = chat name
// (resolved locally from the on-device directory), body = "New message". We
// never decrypt in the background and never put plaintext in a notification.
//
// Taps reuse the existing expo-notifications handler (attachTapHandler in
// _layout routes data.chatId → /chat), so no extra tap wiring is needed.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const SEEN_KEY = 'vc_notif_seen_v1';  // chatId → highest already-notified message id
const DIR_KEY  = 'vc_chat_dir_v1';    // chatId → display name (written by chatService)

// Set true by push.ts once we successfully hold a server push token. While true
// the server delivers notifications, so we suppress ours (no duplicates).
let pushAvailable = false;
let meId: string | null = null;

export function setPushAvailable(v: boolean): void { pushAvailable = v; }
export function setSelfId(id: string | null): void { meId = id; }

// ── seen map (dedupe across socket + catch-up so we never double-notify) ──
let seen: Record<string, number> | null = null;
async function loadSeen(): Promise<Record<string, number>> {
  if (seen) return seen;
  try { seen = JSON.parse((await AsyncStorage.getItem(SEEN_KEY)) || '{}'); } catch { seen = {}; }
  return seen!;
}
let seenT: any = null;
function persistSeen(): void {
  if (seenT) return;
  seenT = setTimeout(() => { seenT = null; AsyncStorage.setItem(SEEN_KEY, JSON.stringify(seen || {})).catch(() => {}); }, 500);
}

// ── chat name directory (same source the native FCM path uses) ──
let dir: Record<string, string> | null = null;
async function chatName(chatId: string): Promise<string> {
  if (!dir) { try { dir = JSON.parse((await AsyncStorage.getItem(DIR_KEY)) || '{}'); } catch { dir = {}; } }
  return dir?.[chatId] || 'VaultChat';
}
/** Called when the directory changes so the next lookup re-reads it. */
export function invalidateDirectory(): void { dir = null; }

/**
 * Raise an OS notification for an inbound message — but only when it's actually
 * needed. Gated so it never fires on a push-capable device, never while the app
 * is in the foreground (the in-app UI handles that), never for our own echo, and
 * never twice for the same (or older) message.
 */
export async function notify(msg: { id: number | string; chatId: string; senderId?: string; meta?: any }): Promise<void> {
  if (Platform.OS === 'web') return;
  if (pushAvailable) return;                              // server push covers it
  if (AppState.currentState === 'active') return;         // app is open → in-app UI shows it
  if (!msg?.chatId) return;
  // Honour meta.silent exactly as the SERVER's push path does
  // (chatsSendMessagePush). Two independent listeners call this — app/_layout
  // and lib/backgroundConnection (armed only on no-GMS devices) — so gating
  // anywhere but here leaves one of them uncovered: that is precisely how
  // famEvent envelopes still buzzed no-GMS phones after being suppressed in
  // _layout. Checking the flag here means client and server agree, and every
  // present and future caller is covered by construction.
  if (msg.meta && (msg.meta as any).silent) return;
  const id = Number(msg.id);
  if (!Number.isFinite(id)) return;
  if (meId && msg.senderId === meId) return;              // our own message echoed back
  const s = await loadSeen();
  if ((s[msg.chatId] ?? 0) >= id) return;                 // already notified / older
  s[msg.chatId] = id; persistSeen();
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: await chatName(msg.chatId), body: 'New message', data: { chatId: msg.chatId }, sound: 'default' },
      trigger: null,   // present immediately
    });
  } catch {}
}

/** Catch-up variant: one notification per chat for the highest inbound id. */
export async function notifyBatch(chatId: string, msgs: Array<{ id: number | string; senderId?: string }>): Promise<void> {
  let top = 0; let sender: string | undefined;
  for (const m of msgs) {
    const n = Number(m.id);
    if (Number.isFinite(n) && n > top && m.senderId !== meId) { top = n; sender = m.senderId; }
  }
  if (top > 0) await notify({ id: top, chatId, senderId: sender });
}

/**
 * Record that the user has seen everything up to msgId in a chat WITHOUT
 * notifying (call when a chat is opened/read), so a later background arrival
 * for an already-read message doesn't resurface a notification.
 */
export async function markSeen(chatId: string, msgId: number): Promise<void> {
  const n = Number(msgId);
  if (!Number.isFinite(n)) return;
  const s = await loadSeen();
  if ((s[chatId] ?? 0) < n) { s[chatId] = n; persistSeen(); }
}

export default {};
