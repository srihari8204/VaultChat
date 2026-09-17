// Durable monotonic receipts are owned by the authenticated account, not install.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markRead, markDelivered } from './chatService';
import { getAccessToken } from './api';
import { tokenSubject } from './tokenIdentity';
import { SessionEndedError } from './sessionEnded';
import { onConnectionState } from './socket';

interface Ptr { read: number; delivered: number; ackedRead: number; ackedDelivered: number }
interface Session {
  owner: string; state: Map<string, Ptr>; loading: Promise<void> | null;
  saving: Promise<void> | null; pending: string | null;
  timer: ReturnType<typeof setTimeout> | null; flushing: boolean; again: boolean;
}
let active: Session | null = null;
let selecting: Promise<unknown> = Promise.resolve();
const key = (s: Session) => `vc_receipts_v2:${s.owner}`;
async function session(expectedUserId?: string): Promise<Session> {
  const owner = tokenSubject(await getAccessToken());
  if (!owner || (expectedUserId && owner !== expectedUserId)) throw new SessionEndedError();
  // Finish any old disk write before another session can hydrate the same key.
  // Network requests never hold this lock; their completion may only save the
  // still-active session. At most one account map remains retained when idle.
  const selected = selecting.then(async () => {
    if (active?.owner !== owner) {
      if (active?.timer) clearTimeout(active.timer);
      await active?.saving?.catch(() => {});
      active = { owner, state: new Map(), loading: null, saving: null, pending: null,
        timer: null, flushing: false, again: false };
    }
    return active!;
  });
  selecting = selected.catch(() => {});
  const s = await selected;
  await load(s);
  await assertOwner(s);
  return s;
}
async function assertOwner(s: Session): Promise<void> {
  if (tokenSubject(await getAccessToken()) !== s.owner || active !== s) throw new SessionEndedError();
}
function load(s: Session): Promise<void> {
  return s.loading ??= (async () => {
    // An I/O failure must propagate: treating it as an empty snapshot loses data.
    const raw = await AsyncStorage.getItem(key(s));
    let entries: Record<string, Ptr> = {};
    try { entries = raw ? JSON.parse(raw) : {}; } catch { /* corrupt local snapshot */ }
    for (const [id, value] of Object.entries(entries ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const p = { read: 0, delivered: 0, ackedRead: 0, ackedDelivered: 0 };
      for (const field of Object.keys(p) as (keyof Ptr)[]) {
        if (Number.isSafeInteger(value[field]) && value[field] >= 0) p[field] = value[field];
      }
      p.ackedRead = Math.min(p.ackedRead, p.read);
      p.ackedDelivered = Math.min(p.ackedDelivered, p.delivered);
      s.state.set(id, p);
    }
  })().catch(error => { s.loading = null; throw error; });
}
function persist(s: Session): Promise<void> {
  s.pending = JSON.stringify(Object.fromEntries(s.state));
  // One writer plus one coalesced snapshot, including while storage is slow.
  if (!s.saving) s.saving = (async () => {
    while (s.pending !== null) {
      const snapshot = s.pending; s.pending = null;
      await AsyncStorage.setItem(key(s), snapshot);
    }
  })().finally(() => { s.saving = null; });
  return s.saving;
}
function persistSoon(s: Session) { if (active === s) void persist(s).catch(() => {}); }
function flushSoon(s: Session) {
  if (s.timer || active !== s) return;
  s.timer = setTimeout(() => { s.timer = null; void flushSession(s).catch(() => {}); }, 300);
}
async function mark(chatId: string, msgId: number, field: 'read' | 'delivered', expectedUserId?: string) {
  if (!chatId || !Number.isSafeInteger(msgId) || msgId <= 0) return;
  const s = await session(expectedUserId);
  let p = s.state.get(chatId);
  if (!p) { p = { read: 0, delivered: 0, ackedRead: 0, ackedDelivered: 0 }; s.state.set(chatId, p); }
  p[field] = Math.max(p[field], msgId);
  await persist(s);
  if (p[field] > p[field === 'read' ? 'ackedRead' : 'ackedDelivered']) flushSoon(s);
}
/** Persists local intent; server acknowledgement is retried separately. */
export function markReadDurable(chatId: string, msgId: number, expectedUserId?: string): Promise<void> {
  return mark(chatId, msgId, 'read', expectedUserId);
}
export function markDeliveredDurable(chatId: string, msgId: number, expectedUserId?: string): Promise<void> {
  return mark(chatId, msgId, 'delivered', expectedUserId);
}
/**
 * MY read watermark per chat, as this device recorded it — chatId → message id.
 *
 * Read intent is durable here BEFORE the server hears about it (mark() persists,
 * then flushSoon posts), so this map is the earliest correct answer to "have I
 * read this chat". lib/chatService.listChats uses it to correct the server's
 * denormalized unread_count; see applyLocalReadPointers in lib/unreadStore.
 */
export async function readPointers(): Promise<Record<string, number>> {
  const s = await session();
  const out: Record<string, number> = {};
  for (const [chatId, p] of s.state) if (p.read > 0) out[chatId] = p.read;
  return out;
}

async function flushSession(s: Session): Promise<void> {
  await assertOwner(s);
  if (s.flushing) { s.again = true; return; }
  s.flushing = true;
  try {
    for (const [chatId, p] of s.state) {
      for (const field of ['delivered', 'read'] as const) {
        const ack = field === 'read' ? 'ackedRead' : 'ackedDelivered';
        if (p[field] <= p[ack]) continue;
        await assertOwner(s);
        const sent = p[field];
        try {
          await (field === 'read' ? markRead : markDelivered)(chatId, sent, s.owner);
          p[ack] = sent;
          persistSoon(s);
        } catch (error: any) {
          // Invalid monotonic cursors must not wedge future genuine receipts.
          // Offline/5xx keep the pointer; concurrent newer intent is never reset.
          if (error?.status === 400 && p[field] === sent) { p[field] = p[ack]; persistSoon(s); }
        }
      }
    }
  } finally {
    s.flushing = false;
    if (s.again) { s.again = false; flushSoon(s); }
  }
}
export async function flush(): Promise<void> { await flushSession(await session()); }
let armed = false;
export function initReceipts(): void {
  if (armed) return; armed = true;
  onConnectionState(s => { if (s === 'ONLINE') void flush().catch(() => {}); });
}
export default {};
