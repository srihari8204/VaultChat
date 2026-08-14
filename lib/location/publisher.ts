// lib/location/publisher.ts — batched server ingest for the all-space
// location platform (backend: spaces_locations.go, migration 103).
//
// ONE publisher for every space type. Space policy decides WHO may read
// (server-side); this module only decides WHAT leaves the device and WHEN:
//   - points are queued locally (survives offline + process restart),
//   - deduplicated by fix timestamp,
//   - uploaded in order, in batches, on a slow pulse,
//   - failures keep the queue; the next pulse retries.
//
// Privacy: callers pass the point AFTER their space's privacy reduction —
// this module never sees a more precise fix than the space is entitled to,
// and it publishes nothing unless a caller feeds it (feeding = sharing).
//
// Pure queue logic is exported and self-checked:  npx tsx lib/location/publisher.ts

export interface UploadPoint {
  lat: number;
  lng: number;
  ts: number;          // epoch ms of the FIX — the dedupe key
  acc?: number;
  alt?: number;
  spd?: number;
  hdg?: number;
  bat?: number;
  src?: 'gps' | 'network' | 'fused' | 'manual';
}

export const QUEUE_MAX = 600;        // ~2.5h at 15s cadence; older points age out first
export const BATCH_MAX = 100;        // server caps at 120; stay under it
export const FLUSH_MS = 15_000;

// ── pure queue logic ──────────────────────────────────────────────────

/** Append one point: dedupe by ts, keep chronological order, cap the queue
 *  by dropping the OLDEST (history already lives in the store server-side;
 *  the freshest points are the ones a live map needs). */
export function pushPoint(queue: UploadPoint[], p: UploadPoint): UploadPoint[] {
  if (!isFinite(p.lat) || !isFinite(p.lng) || !isFinite(p.ts) || p.ts <= 0) return queue;
  if (queue.some((q) => q.ts === p.ts)) return queue;
  const next = [...queue, p].sort((a, b) => a.ts - b.ts);
  return next.length > QUEUE_MAX ? next.slice(next.length - QUEUE_MAX) : next;
}

/** The next batch to upload — oldest first, so the server sees time move
 *  forwards and an interrupted upload resumes without gaps. */
export function takeBatch(queue: UploadPoint[], max = BATCH_MAX): UploadPoint[] {
  return queue.slice(0, max);
}

/** Remove exactly the points that were accepted (by ts). */
export function dropSent(queue: UploadPoint[], sent: UploadPoint[]): UploadPoint[] {
  const gone = new Set(sent.map((p) => p.ts));
  return queue.filter((p) => !gone.has(p.ts));
}

// ── the runtime half (thin; no logic beyond plumbing) ─────────────────

// Lazy requires keep the pure half tsx-runnable — same pattern as
// lib/nav/routing.ts and lib/family/fixPipeline.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const api = () => require('../api').api as (path: string, opts?: any) => Promise<any>;

const kQueue = (chatId: string) => `vc_locq_${chatId}`;

const queues = new Map<string, UploadPoint[]>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

async function loadQueue(chatId: string): Promise<UploadPoint[]> {
  const inMem = queues.get(chatId);
  if (inMem) return inMem;
  try {
    const raw = await storage().getItem(kQueue(chatId));
    const arr = raw ? (JSON.parse(raw) as UploadPoint[]) : [];
    queues.set(chatId, Array.isArray(arr) ? arr : []);
  } catch { queues.set(chatId, []); }
  return queues.get(chatId)!;
}

async function saveQueue(chatId: string): Promise<void> {
  try { await storage().setItem(kQueue(chatId), JSON.stringify(queues.get(chatId) ?? [])); } catch {}
}

/** Queue one (privacy-reduced) point for a space. Starts the flush pulse. */
export async function publishPoint(chatId: string, p: UploadPoint): Promise<void> {
  const q = await loadQueue(chatId);
  queues.set(chatId, pushPoint(q, p));
  await saveQueue(chatId);
  if (!timer) timer = setInterval(() => { flushAll().catch(() => {}); }, FLUSH_MS);
}

/** Upload every queue, oldest first; failures keep their points for retry. */
export async function flushAll(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const [chatId, q] of [...queues]) {
      if (!q.length) continue;
      const batch = takeBatch(q);
      try {
        await api()(`/chats/${encodeURIComponent(chatId)}/locations`, {
          method: 'POST', json: { points: batch },
        });
        queues.set(chatId, dropSent(queues.get(chatId) ?? [], batch));
        await saveQueue(chatId);
      } catch { /* offline or 5xx — the queue holds; next pulse retries */ }
    }
  } finally { flushing = false; }
}

/** Tell the space this member (re-)enabled sharing. The server clears its
 *  explicit-stop flag so the ingest guard admits uploads again; viewers stay
 *  on last-known until a FRESH fix arrives. */
export async function publishStart(chatId: string): Promise<void> {
  try { await api()(`/chats/${encodeURIComponent(chatId)}/locations/start`, { method: 'POST', json: {} }); } catch {}
}

/** Tell the space this member stopped sharing (content-free), then go quiet.
 *  The server keeps the last-known point and refuses further uploads. */
export async function publishStop(chatId: string): Promise<void> {
  try { await api()(`/chats/${encodeURIComponent(chatId)}/locations/stop`, { method: 'POST', json: {} }); } catch {}
}

/** Stop the pulse (logout / all sharing off). Queues stay persisted. */
export function stopPublisher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── self-check ────────────────────────────────────────────────────────
if (require.main === module) {
  const fail = (m: string) => { throw new Error(m); };
  const P = (ts: number): UploadPoint => ({ lat: 10 + ts / 1e6, lng: 70, ts });

  // dedupe by ts, order kept
  let q: UploadPoint[] = [];
  q = pushPoint(q, P(3)); q = pushPoint(q, P(1)); q = pushPoint(q, P(2)); q = pushPoint(q, P(2));
  if (q.length !== 3) fail(`dedupe failed: ${q.length}`);
  if (q.map((p) => p.ts).join(',') !== '1,2,3') fail('order not chronological');

  // invalid points are refused
  if (pushPoint(q, { lat: NaN, lng: 0, ts: 9 }).length !== 3) fail('NaN accepted');
  if (pushPoint(q, { lat: 1, lng: 1, ts: 0 }).length !== 3) fail('ts=0 accepted');

  // cap drops the OLDEST
  let big: UploadPoint[] = [];
  for (let i = 1; i <= QUEUE_MAX + 50; i++) big = pushPoint(big, P(i));
  if (big.length !== QUEUE_MAX) fail(`cap failed: ${big.length}`);
  if (big[0].ts !== 51) fail(`oldest not dropped: ${big[0].ts}`);

  // batch is oldest-first and dropSent removes exactly the batch
  const batch = takeBatch(big, 10);
  if (batch[0].ts !== 51 || batch.length !== 10) fail('batch wrong');
  const rest = dropSent(big, batch);
  if (rest.length !== QUEUE_MAX - 10 || rest[0].ts !== 61) fail('dropSent wrong');
  // an interrupted upload retried later must not duplicate: dropSent is
  // idempotent for points already gone
  if (dropSent(rest, batch).length !== rest.length) fail('dropSent not idempotent');

  console.log('location/publisher self-check OK');
}
