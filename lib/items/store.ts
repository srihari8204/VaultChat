// lib/items/store.ts — the paired item registry.
//
// Device-local and sealed with the same DEK as the rest of the cache. Nothing
// here is uploaded: an item's identity is a BLE address, and where it was last
// seen is a coordinate — exactly the two things this app refuses to hand to a
// server without a reason. Family sharing of items can be added later on the
// existing sealed relay; it is not needed to find your own keys.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { encField, decField } from '../cacheCrypto';

const KEY = 'vc_items_v1';

export interface TrackedItem {
  /** BLE peripheral id (MAC on Android). The pairing identity. */
  id: string;
  name: string;
  /** Ionicons glyph chosen at pairing — keys, wallet, bag… */
  icon: string;
  addedAt: number;
  /** Last time this device heard the tag. */
  lastSeenAt?: number;
  /** Where the PHONE was when it last heard the tag — the "last seen" answer. */
  lastSeenLat?: number;
  lastSeenLng?: number;
  /** Saved Place the phone was inside then, when it was inside one. */
  lastSeenPlace?: string | null;
  /** Alert me if I walk away from a Place without this. */
  leftBehindAlerts?: boolean;
}

export async function listItems(): Promise<TrackedItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const json = raw ? decField(raw) : null;
    const parsed = json ? JSON.parse(json) : null;
    return Array.isArray(parsed?.i) ? (parsed.i as TrackedItem[]) : [];
  } catch { return []; }
}

async function save(items: TrackedItem[]): Promise<void> {
  try {
    const sealed = encField(JSON.stringify({ v: 1, i: items }));
    if (sealed != null) await AsyncStorage.setItem(KEY, sealed);
  } catch { /* best-effort, same as the rest of the local cache */ }
}

export async function addItem(item: TrackedItem): Promise<TrackedItem[]> {
  const all = await listItems();
  const next = [item, ...all.filter((x) => x.id !== item.id)];
  await save(next);
  return next;
}

export async function removeItem(id: string): Promise<TrackedItem[]> {
  const next = (await listItems()).filter((x) => x.id !== id);
  await save(next);
  return next;
}

/** Merge a patch into one item. Used by the scanner to record sightings. */
export async function patchItem(id: string, patch: Partial<TrackedItem>): Promise<TrackedItem[]> {
  const all = await listItems();
  const next = all.map((x) => (x.id === id ? { ...x, ...patch } : x));
  await save(next);
  return next;
}

export default {};
