// lib/vaultlens/store.ts — VaultLens reactive state.
//
// Holds live generation state (queued→processing→done/failed) keyed by ULID,
// persists finished results to op-sqlite for the History tab, mirrors quota for
// instant UI, listens for the server's `vaultlens:ready`/`vaultlens:failed`
// socket events, and auto-retries anything queued while offline once the socket
// reconnects. Components subscribe per-id via useGen() / useQuota() (no polling).

import { useSyncExternalStore } from 'react';
import { addPersistentListener, getSocket } from '../socket';
import { getLocalDb } from '../localDb';
import { ulid, generate as apiGenerate, getResult, type VLQuota } from './api';

export type VLStatus = 'queued' | 'processing' | 'done' | 'failed';
export interface VLGen {
  id: string; styleId: string; styleName: string; packId: string;
  status: VLStatus; url: string | null; width: number; createdAt: number;
  pending?: boolean; // enqueue POST didn't reach the server yet (offline)
}

// ── external store ──────────────────────────────────────────────────
const gens = new Map<string, VLGen>();
const subs = new Map<string, Set<() => void>>();
function notify(id: string) {
  const s = subs.get(id); if (s) for (const cb of s) { try { cb(); } catch {} }
}
function put(g: VLGen) { gens.set(g.id, g); notify(g.id); }
function patch(id: string, p: Partial<VLGen>) { const g = gens.get(id); if (g) put({ ...g, ...p }); }

function subscribe(key: string, cb: () => void): () => void {
  let set = subs.get(key); if (!set) { set = new Set(); subs.set(key, set); }
  set.add(cb); return () => { subs.get(key)?.delete(cb); };
}
export function useGen(id: string | undefined): VLGen | undefined {
  return useSyncExternalStore(
    (cb) => (id ? subscribe(id, cb) : () => {}),
    () => (id ? gens.get(id) : undefined),
    () => (id ? gens.get(id) : undefined),
  );
}
export function getGen(id: string): VLGen | undefined { return gens.get(id); }

// ── quota mirror ────────────────────────────────────────────────────
let quota: VLQuota | null = null;
const quotaSubs = new Set<() => void>();
export function setQuota(q: VLQuota | null) { quota = q; for (const cb of quotaSubs) { try { cb(); } catch {} } }
export function useQuota(): VLQuota | null {
  return useSyncExternalStore((cb) => { quotaSubs.add(cb); return () => quotaSubs.delete(cb); }, () => quota, () => quota);
}

// ── op-sqlite history ───────────────────────────────────────────────
let _tableReady: Promise<void> | null = null;
async function ensureTable() {
  if (!_tableReady) _tableReady = (async () => {
    const db = await getLocalDb();
    await db.execAsync(`CREATE TABLE IF NOT EXISTS vaultlens_history (
      id TEXT PRIMARY KEY, style_id TEXT, style_name TEXT, pack_id TEXT,
      status TEXT, url TEXT, width INTEGER, created_at INTEGER)`);
  })();
  return _tableReady;
}
async function persist(g: VLGen) {
  try {
    await ensureTable();
    const db = await getLocalDb();
    await db.runAsync(
      `INSERT INTO vaultlens_history (id, style_id, style_name, pack_id, status, url, width, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, url=excluded.url`,
      [g.id, g.styleId, g.styleName, g.packId, g.status, g.url, g.width, g.createdAt]);
  } catch {}
}
export async function getHistory(limit = 60): Promise<VLGen[]> {
  try {
    await ensureTable();
    const db = await getLocalDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM vaultlens_history WHERE status='done' ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map((r: any) => ({
      id: r.id, styleId: r.style_id, styleName: r.style_name, packId: r.pack_id,
      status: r.status, url: r.url, width: r.width, createdAt: r.created_at,
    }));
  } catch { return []; }
}

// ── socket wiring (once) ────────────────────────────────────────────
let _armed = false;
export function ensureListeners() {
  if (_armed) return;
  _armed = true;
  addPersistentListener('vaultlens:ready', (d: any) => {
    if (!d?.id) return;
    patch(d.id, { status: 'done', url: d.url || null });
    const g = gens.get(d.id); if (g) persist(g);
    refreshQuota();
  });
  addPersistentListener('vaultlens:failed', (d: any) => {
    if (!d?.id) return;
    patch(d.id, { status: 'failed', pending: false });
    refreshQuota(); // quota auto-refunded server-side
  });
  // Auto-fire anything queued while offline once we reconnect.
  getSocket().then((s) => { try { s.on('connect', () => { retryPending(); }); } catch {} }).catch(() => {});
}

// ── actions ─────────────────────────────────────────────────────────
export async function refreshQuota() {
  try { const { getQuota } = await import('./api'); setQuota(await getQuota()); } catch {}
}

// Start a generation. Returns the ULID immediately; the card is optimistic.
export async function startGeneration(style: { id: string; name: string; pack: string }): Promise<string> {
  ensureListeners();
  const id = ulid();
  put({ id, styleId: style.id, styleName: style.name, packId: style.pack, status: 'queued', url: null, width: 512, createdAt: Date.now() });
  await fire(id, style.id);
  return id;
}

// Regenerate / retry: reuse the SAME card id? No — a fresh generation gets a new
// ULID (new quota unit), but retrying a FAILED one reuses its slot (quota was
// refunded). `retry` reuses the id; `regenerate` mints a new one.
export async function retryGeneration(id: string): Promise<void> {
  const g = gens.get(id); if (!g) return;
  put({ ...g, status: 'queued', url: null, pending: false });
  await fire(id, g.styleId);
}

async function fire(id: string, styleId: string) {
  try {
    const r = await apiGenerate(id, styleId);
    if (r?.quota) setQuota(r.quota);
    if ((r as any)?.code === 'quota_exhausted') { patch(id, { status: 'failed' }); return; }
    // success → wait for the socket event; status stays 'queued'/'processing'.
    patch(id, { pending: false });
  } catch (e: any) {
    // Offline / transient → keep it queued + pending; retryPending() re-fires on reconnect.
    patch(id, { pending: true });
  }
}

let _retrying = false;
export async function retryPending() {
  if (_retrying) return; _retrying = true;
  try {
    for (const g of gens.values()) {
      if (g.pending && (g.status === 'queued')) await fire(g.id, g.styleId);
    }
  } finally { _retrying = false; }
}

// Recover a history item whose R2 URL expired (re-sign on demand).
export async function freshUrl(id: string): Promise<string | null> {
  try { const r = await getResult(id); return r.status === 'done' ? r.url : null; } catch { return null; }
}

export default {};
