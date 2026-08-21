// lib/items/api.ts — the shared half of the item finder (migration 114).
//
// A tag is only findable by a phone in radio range, and that phone is often
// not the owner's. Pooling sightings inside the space is what turns "my keys
// are somewhere" into "your keys are with Mother, last heard at Home".
//
// EVERY CALL DEGRADES TO LOCAL-ONLY. A 404 means a server that predates this
// migration; anything else means offline or a bad moment. In both cases the
// device-local finder keeps working exactly as it does today — sharing is an
// enhancement to it, never a dependency of it.

import { api } from '../api';

export interface SharedItem {
  id: number;
  bleId: string;
  name: string;
  icon: string;
  ownerId: string;
  lastSeenAt: number | null;
  lastSeenBy: string | null;
  lat: number | null;
  lng: number | null;
  placeName: string | null;
}

/** True when the space's server supports shared items at all. */
let supported: boolean | null = null;
export function itemsSharingSupported(): boolean { return supported !== false; }

async function call<T>(path: string, opts?: any): Promise<T | null> {
  try {
    const r = await api<T>(path, opts);
    supported = true;
    return r;
  } catch (e: any) {
    if (e?.status === 404) supported = false;
    return null;
  }
}

/** Every item the space knows about, newest sighting first. */
export async function fetchSharedItems(chatId: string): Promise<SharedItem[]> {
  const r = await call<{ items: SharedItem[] }>(`/chats/${encodeURIComponent(chatId)}/items`);
  return Array.isArray(r?.items) ? r!.items : [];
}

/** Register (or rename) a tag for the whole space. */
export async function registerSharedItem(
  chatId: string, bleId: string, name: string, icon: string,
): Promise<boolean> {
  const r = await call<{ ok: boolean }>(`/chats/${encodeURIComponent(chatId)}/items`, {
    method: 'POST', json: { bleId, name, icon },
  });
  return !!r?.ok;
}

/**
 * "I heard this tag, here." The server keeps only the newest sighting, so an
 * out-of-order report from a second phone cannot move the answer backwards.
 *
 * `placeName` is the FINDER's own saved-place name — the coordinate of that
 * place never travels, matching the family reference-distance doctrine.
 */
export async function reportSighting(
  chatId: string, bleId: string,
  pos: { lat: number; lng: number } | null,
  placeName: string | null,
  ts: number = Date.now(),
): Promise<void> {
  await call(`/chats/${encodeURIComponent(chatId)}/items/sighting`, {
    method: 'POST',
    json: { bleId, ts, lat: pos?.lat ?? null, lng: pos?.lng ?? null, placeName },
  });
}

/** Owner-only removal from the shared registry. */
export async function forgetSharedItem(chatId: string, bleId: string): Promise<void> {
  await call(`/chats/${encodeURIComponent(chatId)}/items/forget`, {
    method: 'POST', json: { bleId },
  });
}

export default {};
