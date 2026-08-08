// lib/scheduledQueue.ts — on-device encrypted queue for scheduled messages (#73).
//
// The pending message NEVER leaves the device: it lives in app-private storage,
// content sealed at rest with the same cache DEK the rest of the app uses
// (encField/decField — sealed when the vault key is present, plaintext-in-sandbox
// otherwise, exactly like localDb). It is encrypted for the recipient only at
// SEND time (chatService.encryptForChat), so forward secrecy is preserved.

import { encField, decField } from './cacheCrypto';
import { queueList, queueReplace, queueMigrate } from './localDb';

const LEGACY_KEY = 'scheduled_queue_v1';   // pre-SQLite AsyncStorage array
const READ_CAP   = 10_000;                 // writeAll replaces what readAll returned

export type ScheduledItem = {
  id: string;
  chatId: string;
  peerName?: string;
  content: string;      // plaintext in memory; sealed at rest
  type: string;         // 'text'
  sendAt: number;       // epoch ms
  createdAt: number;
  meta?: any;
};

type StoredItem = Omit<ScheduledItem, 'content'> & { content: string | null };

// Rows live in localDb's `queues` table. Content is sealed twice over — once by
// toStored/fromStored below (unchanged), once by the queue row itself — which
// costs nothing worth measuring at these volumes and keeps one storage path.
let migrated: Promise<unknown> | null = null;
async function readAll(): Promise<StoredItem[]> {
  migrated ??= queueMigrate('sched', LEGACY_KEY, (s: StoredItem) => s.id,
    (s: StoredItem) => s.createdAt, (s: StoredItem) => s.chatId).catch(() => 0);
  await migrated;
  try { return await queueList<StoredItem>('sched', READ_CAP); } catch { return []; }
}
async function writeAll(items: StoredItem[]): Promise<void> {
  try { await queueReplace('sched', items.map(s => ({ id: s.id, item: s, createdAt: s.createdAt, tag: s.chatId }))); } catch {}
}
const toStored = (it: ScheduledItem): StoredItem => ({ ...it, content: encField(it.content) });
const fromStored = (s: StoredItem): ScheduledItem => ({ ...s, content: decField(s.content) ?? '' });

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueScheduled(input: Omit<ScheduledItem, 'id' | 'createdAt'>): Promise<ScheduledItem> {
  const item: ScheduledItem = { ...input, id: newId(), createdAt: Date.now() };
  const all = await readAll();
  all.push(toStored(item));
  await writeAll(all);
  return item;
}

export async function listScheduled(): Promise<ScheduledItem[]> {
  return (await readAll()).map(fromStored).sort((a, b) => a.sendAt - b.sendAt);
}

export async function getScheduled(id: string): Promise<ScheduledItem | null> {
  const s = (await readAll()).find(x => x.id === id);
  return s ? fromStored(s) : null;
}

export async function updateScheduled(id: string, patch: Partial<Pick<ScheduledItem, 'content' | 'sendAt'>>): Promise<void> {
  const all = await readAll();
  const i = all.findIndex(x => x.id === id);
  if (i < 0) return;
  all[i] = toStored({ ...fromStored(all[i]), ...patch });
  await writeAll(all);
}

export async function cancelScheduled(id: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter(x => x.id !== id));
}

/** Items whose send time has passed (by the supplied clock). */
export async function dueScheduled(nowMs: number): Promise<ScheduledItem[]> {
  return (await readAll()).map(fromStored).filter(x => x.sendAt <= nowMs);
}

export async function countScheduled(): Promise<number> {
  return (await readAll()).length;
}

export default {
  enqueueScheduled, listScheduled, getScheduled, updateScheduled,
  cancelScheduled, dueScheduled, countScheduled,
};
