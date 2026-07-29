// routes/vaultlens.js — VaultLens AI-avatar mini-app control plane (Express).
//
// The ModelsLab key is server-only (lib/modelslab). The client: uploads a
// cropped selfie once (POST /face), then fires POST /generate {ULID, styleId}
// → we enqueue a BullMQ job and return immediately. The worker renders + stores
// the image in private R2; the API's QueueEvents listener (server.js) emits
// `vaultlens:ready` to the user's socket with a signed URL. Quota (free 3/day,
// IST) is DERIVED from vaultlens_generation (a 'failed' row auto-refunds).

const express   = require('express');
const multer    = require('multer');
const jwtUtil   = require('../jwt');
const db        = require('../db');
const store     = require('../lib/storage');
const rateLimit = require('../rateLimit');
const modelslab = require('../lib/modelslab');
const { queue } = require('../lib/vaultlensQueue');
const catalog   = require('../vaultlens-catalog.json');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const FREE_DAILY   = 3;
const FREE_WIDTH   = 512;
const FACE_TTL     = 3600; // presigned face URL lifetime handed to ModelsLab
const RESULT_TTL   = 3600; // presigned output URL lifetime handed to the client
const faceKey      = (uid) => `vaultlens/faces/${uid}.jpg`;
// Outputs live under their own prefix so the R2 1-day lifecycle rule can be
// scoped to vaultlens/out/ WITHOUT sweeping the face cache (vaultlens/faces/)
// or the style previews (vaultlens/previews/) — prefix rules can't exclude.
const outputKey    = (uid, id) => `vaultlens/out/${uid}/${id}.jpg`;
const previewKey   = (styleId) => `vaultlens/previews/${styleId}.jpg`;

// Flatten catalog → styleId → { style, packId } for O(1) validation + prompts.
const STYLE_BY_ID = new Map();
for (const pack of catalog.packs || []) for (const s of pack.styles || []) STYLE_BY_ID.set(s.id, { ...s, packId: pack.id });

// Full ModelsLab prompt for a style (server-only — never sent to the client).
function promptFor(styleId) {
  const s = STYLE_BY_ID.get(styleId);
  if (!s) return null;
  const neg = [s.negative, catalog.negativeBase].filter(Boolean).join(', ');
  return {
    prompt: s.prompt,
    negativePrompt: neg,
    params: { ...(catalog.defaults || {}), ...(s.params || {}) },
  };
}

// Next IST (Asia/Kolkata) midnight as an ISO string (client shows "resets in…").
function nextIstMidnightISO() {
  const now = Date.now();
  const IST = 5.5 * 3600 * 1000;
  const istNow = now + IST;
  const dayMs = 86400_000;
  const nextIstMidnight = Math.ceil(istNow / dayMs) * dayMs; // next IST 00:00 in "IST epoch"
  return new Date(nextIstMidnight - IST).toISOString();
}

async function usedToday(userId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM vaultlens_generation
      WHERE user_id = $1 AND status <> 'failed'
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [userId]);
  return r.rows[0]?.n ?? 0;
}
async function quotaOf(userId) {
  const used = await usedToday(userId);
  return { used, limit: FREE_DAILY, remaining: Math.max(0, FREE_DAILY - used), resetAt: nextIstMidnightISO(), tier: 'free' };
}

// ── PUBLIC: style preview thumbnails (sample faces — non-sensitive) ──
// Streamed (not redirected) so an <Image> needs no auth header. Mounted BEFORE
// requireAuth so previews render on first paint without a token round-trip.
router.get('/preview/:styleId', async (req, res) => {
  try {
    if (!STYLE_BY_ID.has(req.params.styleId)) return res.status(404).end();
    const obj = await store.getObjectStream(previewKey(req.params.styleId));
    if (!obj) return res.status(404).end();
    res.setHeader('Content-Type', obj.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    obj.body.on('error', () => { try { res.destroy(); } catch {} });
    obj.body.pipe(res);
  } catch { res.status(500).end(); }
});

router.use(jwtUtil.requireAuth);

// ── GET /vaultlens/catalog — client-safe projection (NO prompts) ────
router.get('/catalog', (req, res) => {
  const packs = (catalog.packs || []).map((p) => ({
    id: p.id, name: p.name, emoji: p.emoji,
    styles: (p.styles || []).map((s) => ({ id: s.id, pack: p.id, name: s.name, thumbnail: `/vaultlens/preview/${s.id}` })),
  }));
  res.json({ version: catalog.version, packs });
});

// ── GET /vaultlens/quota ────────────────────────────────────────────
router.get('/quota', async (req, res) => {
  try { res.json(await quotaOf(req.user.id)); }
  catch (e) { console.error('[vl/quota]', e.message); res.status(500).json({ error: 'quota failed' }); }
});

// ── POST /vaultlens/face — cache/replace the face reference ─────────
// multipart 'file' = the client-cropped, compressed selfie (≤1024, q80).
router.post('/face', upload.single('file'), async (req, res) => {
  try {
    if (!store.enabled()) return res.status(503).json({ error: 'storage unavailable' });
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'file required' });
    if (req.file.buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'too large' });
    await store.putObject(faceKey(req.user.id), req.file.buffer, 'image/jpeg');
    await db.query(
      `INSERT INTO vaultlens_face (user_id, storage_key, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET storage_key = EXCLUDED.storage_key, updated_at = NOW()`,
      [req.user.id, faceKey(req.user.id)]);
    res.json({ ok: true });
  } catch (e) { console.error('[vl/face]', e.message); res.status(500).json({ error: 'face upload failed' }); }
});

// ── DELETE /vaultlens/face — wipe face reference + ALL outputs ──────
router.delete('/face', async (req, res) => {
  try {
    await store.deletePrefix(`vaultlens/faces/${req.user.id}`);
    await store.deletePrefix(`vaultlens/${req.user.id}/`);
    await db.query(`DELETE FROM vaultlens_generation WHERE user_id = $1`, [req.user.id]);
    await db.query(`DELETE FROM vaultlens_face WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error('[vl/face-del]', e.message); res.status(500).json({ error: 'delete failed' }); }
});

// ── POST /vaultlens/generate — enqueue a generation ─────────────────
router.post('/generate', async (req, res) => {
  try {
    if (!store.enabled() || !modelslab.enabled()) return res.status(503).json({ error: 'VaultLens is warming up — try again shortly.', code: 'not_configured' });

    const id      = String(req.body?.id || '').trim();
    const styleId = String(req.body?.styleId || '').trim();
    if (!/^[0-9A-Za-z]{20,32}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    const style = STYLE_BY_ID.get(styleId);
    if (!style) return res.status(400).json({ error: 'unknown style' });

    const rl = await rateLimit.consume(`vlgen:${req.user.id}`, 12, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too fast — give it a moment.', retryAfter: rl.resetInSec });

    const face = await db.query(`SELECT storage_key FROM vaultlens_face WHERE user_id = $1`, [req.user.id]);
    if (!face.rows[0]) return res.status(400).json({ error: 'Add your photo first', code: 'no_face' });

    const q = await quotaOf(req.user.id);
    if (q.remaining <= 0) return res.status(429).json({ error: 'Daily limit reached', code: 'quota_exhausted', quota: q });

    // Idempotent insert (client retry with same ULID is a no-op).
    const ins = await db.query(
      `INSERT INTO vaultlens_generation (id, user_id, style_id, pack_id, status, width)
       VALUES ($1, $2, $3, $4, 'queued', $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, req.user.id, styleId, style.packId, FREE_WIDTH]);
    if (!ins.rows[0]) return res.json({ id, status: 'queued', duplicate: true, quota: q }); // already enqueued

    await queue().add('generate', { generationId: id, userId: req.user.id, styleId, width: FREE_WIDTH },
      { jobId: id, attempts: 2, backoff: { type: 'fixed', delay: 3000 }, removeOnComplete: 50, removeOnFail: 50 });

    res.json({ id, status: 'queued', quota: await quotaOf(req.user.id) });
  } catch (e) { console.error('[vl/generate]', e.message); res.status(500).json({ error: 'generate failed' }); }
});

// ── GET /vaultlens/result/:id — status + fresh signed URL ───────────
// History recovery: an expired R2 URL is re-signed on demand.
router.get('/result/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, style_id, pack_id, status, storage_key, width, error, created_at, completed_at
         FROM vaultlens_generation WHERE id = $1 AND user_id = $2`,
      [String(req.params.id), req.user.id]);
    const g = r.rows[0];
    if (!g) return res.status(404).json({ error: 'not found' });
    const url = g.status === 'done' && g.storage_key ? await store.presignGet(g.storage_key, RESULT_TTL) : null;
    res.json({
      id: g.id, styleId: g.style_id, packId: g.pack_id, status: g.status, width: g.width,
      url, error: g.error, createdAt: g.created_at, completedAt: g.completed_at,
    });
  } catch (e) { console.error('[vl/result]', e.message); res.status(500).json({ error: 'result failed' }); }
});

// Presign the face reference for the worker (called by the worker via a small
// export, not an HTTP route). Kept here so the key convention lives in one place.
async function presignFace(userId) { return store.presignGet(faceKey(userId), FACE_TTL); }

module.exports = router;
module.exports.promptFor = promptFor;
module.exports.presignFace = presignFace;
module.exports.outputKey = outputKey;
module.exports.quotaOf = quotaOf;
