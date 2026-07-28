// lib/resumableUpload.ts — WhatsApp-style resumable chunked media upload.
//
// A large upload goes part-by-part (S3/R2 multipart) so a mid-upload network
// drop RESUMES from the parts already on the store instead of restarting from
// byte 0. Each part is retried independently; the server's ListParts is the
// resume oracle, so a fresh call for the same source skips whatever already
// landed. Small files still use the single-PUT path in chatService — this only
// kicks in where resuming actually matters (>= MULTIPART_THRESHOLD).
//
// ponytail: within-attempt + same-source-retry resume. Cross-app-restart resume
// of a media *send* also needs the message intent persisted (a media outbox);
// this persists only the upload session so a retry resumes, cleared on complete.
// The encrypted path re-encrypts to a fresh temp on retry (new source key) — its
// resume is per-attempt (part-level), which is where drops actually happen.

import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { planParts } from './resumableUpload.plan';

export const MULTIPART_THRESHOLD = 5 * 1024 * 1024;   // >= 5 MiB → resumable multipart
const CONCURRENCY  = 3;
const PART_RETRIES = 3;
const SESS_KEY     = 'vc_mp_sessions_v1';

export interface UploadResult { id: string; mime: string; size: number; filename: string }
interface Session { id: string; uploadId: string; key: string; partSize: number; partCount: number }

async function loadSessions(): Promise<Record<string, Session>> {
  try { return JSON.parse((await AsyncStorage.getItem(SESS_KEY)) || '{}'); } catch { return {}; }
}
async function saveSession(sourceKey: string, s: Session | null): Promise<void> {
  const all = await loadSessions();
  if (s) all[sourceKey] = s; else delete all[sourceKey];
  const keys = Object.keys(all);                              // bound the map
  if (keys.length > 8) for (const k of keys.slice(0, keys.length - 8)) delete all[k];
  try { await AsyncStorage.setItem(SESS_KEY, JSON.stringify(all)); } catch {}
}
const sourceKeyOf = (uri: string, size: number) => `${uri}::${size}`;

// Bounded-concurrency map — at most `n` parts uploading at once.
async function mapPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

export async function resumableUpload(
  uri: string, filename: string, mime: string, size: number,
  opts: { viewOnce?: boolean; onProgress?: (frac: number) => void; signal?: AbortSignal } = {},
): Promise<UploadResult> {
  const sourceKey = sourceKeyOf(uri, size);
  const throwIfAborted = () => { if (opts.signal?.aborted) throw new Error('aborted'); };

  // Resume an existing session for this exact source, else start a new one.
  throwIfAborted();
  let sess = (await loadSessions())[sourceKey];
  if (!sess) {
    const init = await api<Session>('/uploads/multipart/init', {
      method: 'POST', json: { filename, mime, size, viewOnce: !!opts.viewOnce },
    });
    sess = { id: init.id, uploadId: init.uploadId, key: init.key, partSize: init.partSize, partCount: init.partCount };
    await saveSession(sourceKey, sess);
  }

  try {
    return await drive(uri, filename, mime, size, sourceKey, sess, opts, throwIfAborted);
  } catch (e) {
    // User CANCEL → abort the multipart so R2 frees the parts (no orphan billing)
    // and drop the resume record. A transient network failure (NOT aborted) is
    // left intact so the next attempt RESUMES from ListParts.
    if (opts.signal?.aborted) {
      try { await api('/uploads/multipart/abort', { method: 'POST', json: { id: sess.id, uploadId: sess.uploadId } }); } catch {}
      await saveSession(sourceKey, null);
    }
    throw e;
  }
}

async function drive(
  uri: string, filename: string, mime: string, size: number,
  sourceKey: string, sess: Session,
  opts: { viewOnce?: boolean; onProgress?: (frac: number) => void; signal?: AbortSignal },
  throwIfAborted: () => void,
): Promise<UploadResult> {

  // Which parts already landed (resume oracle).
  let uploaded = new Set<number>();
  try {
    const st = await api<{ uploaded: number[] }>(
      `/uploads/multipart/${sess.id}/parts?uploadId=${encodeURIComponent(sess.uploadId)}`);
    uploaded = new Set(st.uploaded || []);
  } catch {}

  // Plan every part's byte range (single source of the offset math), then drop
  // the ones already on the store.
  const plan = planParts(size, sess.partSize);
  const todo = plan.filter((pp) => !uploaded.has(pp.part));

  if (todo.length) {
    // Presign the URLs we still need (batched ≤1000 per request).
    const urls: Record<number, string> = {};
    const nums = todo.map((pp) => pp.part);
    for (let b = 0; b < nums.length; b += 1000) {
      const batch = nums.slice(b, b + 1000);
      const r = await api<{ urls: Record<string, string> }>('/uploads/multipart/part-urls', {
        method: 'POST', json: { id: sess.id, uploadId: sess.uploadId, partNumbers: batch },
      });
      for (const [k, v] of Object.entries(r.urls || {})) urls[Number(k)] = v as string;
    }

    let done = uploaded.size;
    await mapPool(todo, CONCURRENCY, async (pp) => {
      throwIfAborted();                       // stop promptly on user cancel
      const url = urls[pp.part];
      if (!url) throw new Error(`no presigned URL for part ${pp.part}`);
      await putPart(uri, pp.position, pp.length, filename, pp.part, url);
      done++;
      opts.onProgress?.(done / plan.length);
    });
  }

  // Assemble the object (server ListParts → CompleteMultipartUpload).
  const fin = await api<UploadResult>('/uploads/multipart/complete', {
    method: 'POST', json: { id: sess.id, uploadId: sess.uploadId },
  });
  await saveSession(sourceKey, null);   // done — drop the resume record
  return { id: fin.id, mime: fin.mime ?? mime, size: fin.size ?? size, filename: fin.filename ?? filename };
}

// Read one part's byte slice, stage it to a temp file, PUT it. Retries the part
// a few times so a transient drop doesn't fail the whole upload.
async function putPart(
  uri: string, position: number, length: number, filename: string, part: number, url: string,
): Promise<void> {
  const tmp = (FileSystem as any).cacheDirectory + `mp_${part}_${filename.replace(/[^\w.-]/g, '_')}`;
  let lastErr: any;
  for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
    try {
      const sliceB64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64', position, length } as any);
      await FileSystem.writeAsStringAsync(tmp, sliceB64, { encoding: 'base64' });
      const put = await FileSystem.uploadAsync(url, tmp, {
        httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      });
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      if (put.status >= 200 && put.status < 300) return;
      lastErr = new Error(`part ${part} HTTP ${put.status}`);
    } catch (e) {
      lastErr = e;
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
  }
  throw lastErr ?? new Error(`part ${part} failed`);
}

export default {};
