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

const { Worker } = require('bullmq');
const { QUEUE_NAME, makeConnection } = require('../lib/vaultlensQueue');
const db        = require('../db');
const store     = require('../lib/storage');
const modelslab = require('../lib/modelslab');
const vl        = require('../routes/vaultlens'); // promptFor / presignFace / outputKey

const concurrency = Number(process.env.VAULTLENS_CONCURRENCY || 2);

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
