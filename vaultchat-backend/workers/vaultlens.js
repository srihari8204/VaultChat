// workers/vaultlens.js — VaultLens BullMQ worker (own process).
//
// Pulls a generation job → marks it 'processing' → applies the style prompt to
// the user's cached face via ModelsLab (img2img) → re-hosts the output in our
// private R2 → marks it 'done'. The API process (QueueEvents in server.js) is
// what emits `vaultlens:ready` to the socket, so this worker stays stateless
// about connections. A thrown error → BullMQ retries; the final failure is
// turned into 'failed' (quota auto-refund) + `vaultlens:failed` by the API.
//
// Run:  node workers/vaultlens.js   (docker-compose service: vaultlens-worker)

const { Worker, QueueEvents } = require('bullmq');
const { QUEUE_NAME, makeConnection } = require('../lib/vaultlensQueue');
const db        = require('../db');
const store     = require('../lib/storage');
const modelslab = require('../lib/modelslab');
const vl        = require('../routes/vaultlens'); // promptFor / presignFace / outputKey

const concurrency = Number(process.env.VAULTLENS_CONCURRENCY || 2);

// ── Socket notification (Go-first prod) ─────────────────────────────────
// Historically the Node API process owned Socket.IO and its QueueEvents
// listener (server.js) emitted vaultlens:ready/failed. In the Go-first prod
// there is NO Node API process — Go owns sockets — so THIS worker hosts the
// listener and pushes the emits into Go's key-guarded internal bridge.
// Enabled by GO_INTERNAL_URL (+ INTERNAL_EMIT_KEY); without it the old
// server.js listener keeps doing the job and this block stays dormant.
const GO_INTERNAL_URL = (process.env.GO_INTERNAL_URL || '').replace(/\/$/, '');
async function emitToUserViaGo(uid, event, payload) {
  try {
    await fetch(`${GO_INTERNAL_URL}/internal/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_EMIT_KEY || '' },
      body: JSON.stringify({ userIds: [uid], event, payload }),
    });
  } catch (e) { console.error('[vaultlens emit→go]', e.message); }
}
if (GO_INTERNAL_URL) {
  const qe = new QueueEvents(QUEUE_NAME, { connection: makeConnection() });
  qe.on('completed', async ({ returnvalue }) => {
    try {
      const rv = typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue;
      if (!rv?.userId || !rv?.storageKey) return;
      const url = await store.presignGet(rv.storageKey, 3600);
      await emitToUserViaGo(rv.userId, 'vaultlens:ready', { id: rv.generationId, url, styleId: rv.styleId });
    } catch (e) { console.error('[vaultlens completed]', e.message); }
  });
  qe.on('failed', async ({ jobId }) => {
    try {
      // Terminal failure → mark 'failed' (auto-refunds quota) + flip the card.
      const r = await db.query(
        `UPDATE vaultlens_generation SET status = 'failed', completed_at = NOW()
           WHERE id = $1 AND status <> 'done' RETURNING user_id`, [jobId]);
      const uid = r.rows[0]?.user_id;
      if (uid) await emitToUserViaGo(uid, 'vaultlens:failed', { id: jobId });
    } catch (e) { console.error('[vaultlens failed]', e.message); }
  });
  console.log('[vaultlens] QueueEvents listener active (→ Go bridge)');
}

const worker = new Worker(QUEUE_NAME, async (job) => {
  const { generationId, userId, styleId, width = 512 } = job.data || {};
  if (!generationId || !userId || !styleId) throw new Error('bad job payload');

  await db.query(`UPDATE vaultlens_generation SET status = 'processing' WHERE id = $1 AND status = 'queued'`, [generationId]);

  const p = vl.promptFor(styleId);
  if (!p) throw new Error(`unknown style ${styleId}`);

  const initImage = await vl.presignFace(userId);
  if (!initImage) throw new Error('no face reference');

  const urls = await modelslab.generate({
    prompt: p.prompt, negativePrompt: p.negativePrompt, initImage,
    width, height: width, params: p.params,
  });
  const buf = await modelslab.download(urls[0]);
  const key = vl.outputKey(userId, generationId);
  await store.putObject(key, buf, 'image/jpeg');

  await db.query(
    `UPDATE vaultlens_generation SET status = 'done', storage_key = $2, completed_at = NOW() WHERE id = $1`,
    [generationId, key]);

  // Returned to the API's QueueEvents 'completed' → emits vaultlens:ready.
  return { generationId, userId, styleId, storageKey: key };
}, { connection: makeConnection(), concurrency });

worker.on('completed', (job) => console.log('[vaultlens] done', job?.id));
worker.on('failed', (job, err) => console.error('[vaultlens] failed', job?.id, err?.message));
worker.on('error', (err) => console.error('[vaultlens] worker error', err?.message));
console.log(`[vaultlens] worker started (concurrency ${concurrency}, modelslab ${modelslab.enabled() ? 'ON' : 'OFF — set MODELSLAB_API_KEY'})`);
