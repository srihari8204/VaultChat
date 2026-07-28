// lib/vaultlens/api.ts — VaultLens client API + ULID.
//
// Talks to the Express /vaultlens routes. The ModelsLab key never touches the
// client. Generation is fire-and-enqueue: POST /generate returns immediately and
// the result arrives over the socket (see store.ts). Style-preview thumbnails
// are a PUBLIC streamed endpoint, so <Image> loads them with no auth header.

import { randomBytes } from '@noble/hashes/utils.js';
import { api, getAccessToken } from '../api';
import { SERVER_URL } from '../../constants/server';

// ── Client ULID (26-char, time-sortable, matches server ^[0-9A-Za-z]{20,32}$) ──
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now: number = Date.now()): string {
  let ts = now, time = '';
  for (let i = 0; i < 10; i++) { time = ENC[ts % 32] + time; ts = Math.floor(ts / 32); }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENC[r[i] % 32];
  return (time + rand).slice(0, 26);
}

// ── Types ───────────────────────────────────────────────────────────
export interface VLStyle { id: string; pack: string; name: string; thumbnail: string }
export interface VLPack  { id: string; name: string; emoji: string; styles: VLStyle[] }
export interface VLCatalog { version: number; packs: VLPack[] }
export interface VLQuota { used: number; limit: number; remaining: number; resetAt: string; tier: string }
export interface VLResult { id: string; styleId: string; packId: string; status: 'queued' | 'processing' | 'done' | 'failed'; width: number; url: string | null; error?: string; createdAt: string; completedAt?: string }

// Public style-preview URL (no auth header needed — streamed sample face).
export function previewUrl(styleId: string): string {
  return `${SERVER_URL}/vaultlens/preview/${encodeURIComponent(styleId)}`;
}

export const getCatalog = () => api<VLCatalog>('/vaultlens/catalog');
export const getQuota   = () => api<VLQuota>('/vaultlens/quota');
export const getResult  = (id: string) => api<VLResult>(`/vaultlens/result/${encodeURIComponent(id)}`);

export const generate = (id: string, styleId: string) =>
  api<{ id: string; status: string; duplicate?: boolean; quota: VLQuota; code?: string; error?: string }>(
    '/vaultlens/generate', { method: 'POST', json: { id, styleId } });

export const deleteFaceData = () => api<{ ok: boolean }>('/vaultlens/face', { method: 'DELETE' });

// Upload the cropped+compressed selfie (multipart). Returns ok.
export async function uploadFace(localUri: string): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');
  const form = new FormData();
  form.append('file', { uri: localUri, name: 'face.jpg', type: 'image/jpeg' } as any);
  const res = await fetch(`${SERVER_URL}/vaultlens/face`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j: any = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return true;
}
