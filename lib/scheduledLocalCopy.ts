// lib/scheduledLocalCopy.ts — the SENDER's own plaintext copy of scheduled
// messages, keyed by the server row id.
//
// Scheduled messages are E2E-encrypted before they reach the server, so the
// server (and therefore the /scheduled list) only holds ciphertext the sender
// can't self-decrypt. This local copy is what the Scheduled tray shows the
// sender as the preview. Purely local: deleted on cancel, and pruned once the
// server stops listing the row (delivered more than 7 days ago).
//
// Stored in the local DB's kv table sealed with the cache DEK (encField), the
// same way cacheBookmarkPlaintext keeps bookmark snapshots — never as a bare
// AsyncStorage string. Copies written by older builds to AsyncStorage are moved
// into the sealed store on first read, then removed.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocalDb, getMeta, setMeta } from './localDb';
import { decField, encField } from './cacheCrypto';

const LEGACY_KEY = 'scheduled_plain_v1';
const PREFIX = 'vc_sched_pt_';
const key = (id: string) => `${PREFIX}${id}`;

async function readLegacy(): Promise<Record<string, string>> {
  try { const r = await AsyncStorage.getItem(LEGACY_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
async function dropLegacy(id: string): Promise<void> {
  const m = await readLegacy();
  if (m[id] === undefined) return;
  delete m[id];
  try {
    if (Object.keys(m).length) await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify(m));
    else await AsyncStorage.removeItem(LEGACY_KEY);
  } catch {}
}

export async function putScheduledCopy(id: string, plaintext: string): Promise<void> {
  try {
    const sealed = encField(plaintext);
    if (sealed != null) await setMeta(key(id), sealed);
  } catch {}
}

export async function getScheduledCopy(id: string): Promise<string | null> {
  try {
    const hit = await getMeta(key(id));
    if (hit) return decField(hit);
  } catch {}
  const legacy = (await readLegacy())[id];
  if (legacy === undefined) return null;
  // Drop the legacy copy only once the sealed one is stored.
  try {
    const sealed = encField(legacy);
    if (sealed != null) { await setMeta(key(id), sealed); await dropLegacy(id); }
  } catch {}
  return legacy;
}

export async function deleteScheduledCopy(id: string): Promise<void> {
  try {
    const db = await getLocalDb();
    await db.runAsync(`DELETE FROM kv WHERE k = ?`, [key(id)]);
  } catch {}
  await dropLegacy(id);
}

/**
 * Deletes every local copy whose row the server no longer lists (delivered
 * more than 7 days ago, cancelled elsewhere). Call it only with a COMPLETE
 * server list: a copy missing from a truncated list would be lost.
 */
export async function pruneScheduledCopies(listedIds: string[]): Promise<void> {
  const keep = new Set(listedIds.map(key));
  try {
    const db = await getLocalDb();
    const rows = await db.getAllAsync(`SELECT k FROM kv WHERE substr(k, 1, ?) = ?`, [PREFIX.length, PREFIX]);
    for (const r of rows) {
      if (!keep.has(r.k)) await db.runAsync(`DELETE FROM kv WHERE k = ?`, [r.k]);
    }
  } catch {}
  const legacy = await readLegacy();
  const stale = Object.keys(legacy).filter(id => !keep.has(key(id)));
  for (const id of stale) await dropLegacy(id);
}

export default { putScheduledCopy, getScheduledCopy, deleteScheduledCopy, pruneScheduledCopies };
