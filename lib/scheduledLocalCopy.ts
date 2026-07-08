// lib/scheduledLocalCopy.ts — the SENDER's own plaintext copy of scheduled
// messages, keyed by the server row id.
//
// Scheduled messages are E2E-encrypted before they reach the server, so the
// server (and therefore the /scheduled list) only holds ciphertext the sender
// can't self-decrypt. This local map is what the Scheduled tray shows the sender
// as the preview. Purely local, cleaned up on cancel/delivery.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'scheduled_plain_v1';
type Copies = Record<string, string>;

async function read(): Promise<Copies> {
  try { const r = await AsyncStorage.getItem(KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
async function write(m: Copies): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

export async function putScheduledCopy(id: string, plaintext: string): Promise<void> {
  const m = await read(); m[id] = plaintext; await write(m);
}
export async function getScheduledCopy(id: string): Promise<string | null> {
  const m = await read(); return m[id] ?? null;
}
export async function deleteScheduledCopy(id: string): Promise<void> {
  const m = await read(); if (m[id] !== undefined) { delete m[id]; await write(m); }
}

export default { putScheduledCopy, getScheduledCopy, deleteScheduledCopy };
