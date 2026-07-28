// routes/vaultbeam.js — VaultBeam Tier-3 (Cloudflare R2) relay control plane.
//
// The relay never sees plaintext: senders upload AES-256-GCM ciphertext blocks
// DIRECTLY to R2 via presigned PUTs (bytes never touch this Node process), the
// recipient pulls them via presigned GETs, and this server only tracks opaque
// routing + per-block upload state. Filename/mime/key K_t ride the E2EE channel.
//
// Objects live under vault_relay/<transferId>/<blockIndex>. A bucket lifecycle
// rule auto-deletes vault_relay/* after 24h; on confirmed download (or abort) we
// actively purge the prefix (queue-only retention).
//
// Canonical sizing (client MUST use the same constants):
//   CHUNK = 512 KiB (logical unit: AES-GCM + hash + resume bitmask)
//   BLOCK = 4 MiB   (8 chunks; the R2 relay object granularity)

const express   = require('express');
const jwtUtil   = require('../jwt');
const db        = require('../db');
const store     = require('../lib/storage');
const rateLimit = require('../rateLimit');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const CHUNK_BYTES = 512 * 1024;
const BLOCK_BYTES = 4 * 1024 * 1024;
const MAX_BYTES   = 12 * 1024 * 1024 * 1024; // 12 GiB hard cap (v1 scope)
const PUT_TTL     = 900;   // 15 min presigned PUT
const GET_TTL     = 3600;  // 1 h presigned GET
const MAX_URLS    = 64;    // presigned URLs per batch call (cuts round-trips vs 3000 blocks)

const relayKey = (transferId, blockIndex) => `vault_relay/${transferId}/${blockIndex}`;
const ceilDiv  = (a, b) => Math.ceil(a / b);

// ── BYTEA bitmask helpers (uploaded relay blocks) ───────────────────
const testBit  = (buf, i) => (buf[i >> 3] >> (i & 7)) & 1;
const setBit   = (buf, i) => { buf[i >> 3] |= (1 << (i & 7)); };
function countSet(buf, n) { let c = 0; for (let i = 0; i < n; i++) if (testBit(buf, i)) c++; return c; }

// Load a transfer and authorize the caller as sender or recipient.
async function loadTransfer(transferId, userId) {
  const r = await db.query(`SELECT * FROM vb_transfer WHERE transfer_id = $1`, [transferId]);
  const t = r.rows[0];
  if (!t) return { err: 404 };
  if (t.sender_id !== userId && t.recipient_id !== userId) return { err: 403 };
  return { t };
}

// Broadcaster injected by server.js (emitToUid) so we can ring the recipient live.
let emitToUid = () => {};
function setBroadcasters(funcs) { if (funcs.emitToUid) emitToUid = funcs.emitToUid; }

// ── POST /vaultbeam/relay/init ──────────────────────────────────────
// Sender opens a relay transfer. Server computes canonical block/chunk counts
// from total_bytes (never trusts client counts → no key/index mismatch), rings
// the recipient with an opaque invite. The filename/mime/K_t are delivered
// SEPARATELY over E2EE by the client — not here.
router.post('/relay/init', async (req, res) => {
  try {
    if (!store.enabled()) return res.status(503).json({ error: 'relay storage unavailable' });
    const rl = await rateLimit.consume(`vbinit:${req.user.id}`, 20, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many transfers', retryAfter: rl.resetInSec });

    const transferId  = String(req.body?.transferId || '').trim();
    const recipientId = String(req.body?.recipientId || '').trim();
    const totalBytes  = Number(req.body?.totalBytes);
    const chatId      = req.body?.chatId ? String(req.body.chatId) : null;

    if (!/^[A-Za-z0-9]{16,64}$/.test(transferId)) return res.status(400).json({ error: 'invalid transferId' });
    if (!recipientId) return res.status(400).json({ error: 'recipientId required' });
    if (recipientId === req.user.id) return res.status(400).json({ error: 'cannot send to self' });
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return res.status(400).json({ error: 'invalid totalBytes' });
    if (totalBytes > MAX_BYTES) return res.status(413).json({ error: 'exceeds 12GB cap' });

    // Recipient must exist and not have blocked the sender.
    const rec = await db.query(
      `SELECT 1 FROM users WHERE id = $1 AND is_deleted = FALSE
         AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = $1 AND ub.blocked_id = $2)`,
      [recipientId, req.user.id]);
    if (!rec.rows[0]) return res.status(403).json({ error: 'recipient unavailable' });

    const chunkCount = ceilDiv(totalBytes, CHUNK_BYTES);
    // Segmented geometry (R3): with adaptive per-segment sizes the block count is
    // client-chosen and no longer derivable from totalBytes. Accept it — it's
    // content-free (the server only sizes the per-block bitmask + validates block
    // indices) — with a sanity cap so a bad value can't allocate a huge mask.
    // Omitted ⇒ legacy uniform count (byte-identical to before).
    const MIN_BLK = 256 * 1024;                        // smallest block size we'd ever use
    const capBlocks = ceilDiv(totalBytes, MIN_BLK);
    const clientBlocks = Number(req.body?.blockCount);
    // v2 (adaptive): the sender may init with 0 blocks and GROW the plan as it
    // measures throughput (see /relay/grow). v1: an exact count. Neither ⇒ legacy.
    const blockCount = (Number.isInteger(clientBlocks) && clientBlocks >= 0 && clientBlocks <= capBlocks)
      ? clientBlocks
      : ceilDiv(totalBytes, BLOCK_BYTES);
    const plan = typeof req.body?.plan === 'string' ? req.body.plan.slice(0, 200000) : null;
    const mask = Buffer.alloc(ceilDiv(blockCount, 8)); // all-zero: nothing uploaded yet

    // Idempotent: re-init by the same sender resets an in-flight transfer of the
    // same id (client retry). ON CONFLICT keeps ownership stable.
    const ins = await db.query(
      `INSERT INTO vb_transfer
         (transfer_id, sender_id, recipient_id, chat_id, total_bytes, block_count, chunk_count, uploaded_mask, state, plan)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
       ON CONFLICT (transfer_id) DO UPDATE
         SET total_bytes = EXCLUDED.total_bytes, block_count = EXCLUDED.block_count,
             chunk_count = EXCLUDED.chunk_count, plan = EXCLUDED.plan
         WHERE vb_transfer.sender_id = $2 AND vb_transfer.state IN ('pending','ready')
       RETURNING transfer_id, expires_at`,
      [transferId, req.user.id, recipientId, chatId, totalBytes, blockCount, chunkCount, mask, plan]);
    if (!ins.rows[0]) return res.status(409).json({ error: 'transferId already used' });

    // Opaque doorbell — name/type arrive over E2EE, not here.
    emitToUid(recipientId, 'vb_invite', {
      transferId, senderId: req.user.id, totalBytes, blockCount, chunkCount, chatId,
    });

    res.json({ transferId, blockCount, chunkCount, chunkBytes: CHUNK_BYTES, blockBytes: BLOCK_BYTES,
      expiresAt: ins.rows[0].expires_at });
  } catch (e) { console.error('[vb/init]', e.message); res.status(500).json({ error: 'init failed' }); }
});

// ── POST /vaultbeam/relay/block-url ─────────────────────────────────
// Batch-presign relay-block URLs. op:'put' → sender only; op:'get' → recipient
// only, and each requested block must already be uploaded (bit set), else it's
// omitted so the caller retries later (resume-safe).
router.post('/relay/block-url', async (req, res) => {
  try {
    const { transferId } = req.body || {};
    const op = req.body?.op === 'get' ? 'get' : 'put';
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    if (!transferId || !blocks.length) return res.status(400).json({ error: 'transferId + blocks[] required' });
    if (blocks.length > MAX_URLS) return res.status(413).json({ error: `max ${MAX_URLS} blocks per call` });

    const { t, err } = await loadTransfer(String(transferId), req.user.id);
    if (err) return res.status(err).json({ error: err === 404 ? 'not found' : 'forbidden' });
    if (op === 'put' && t.sender_id !== req.user.id) return res.status(403).json({ error: 'sender only' });
    if (op === 'get' && t.recipient_id !== req.user.id) return res.status(403).json({ error: 'recipient only' });
    if (t.state === 'complete' || t.state === 'aborted') return res.status(410).json({ error: `transfer ${t.state}` });

    const mask = t.uploaded_mask;
    const urls = [];
    for (const raw of blocks) {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= t.block_count) continue;
      if (op === 'get' && !testBit(mask, i)) continue; // not uploaded yet — skip
      const url = op === 'put'
        ? await store.presignPut(relayKey(transferId, i), 'application/octet-stream', PUT_TTL)
        : await store.presignGet(relayKey(transferId, i), GET_TTL);
      if (url) urls.push({ blockIndex: i, url });
    }
    res.json({ op, ttl: op === 'put' ? PUT_TTL : GET_TTL, urls });
  } catch (e) { console.error('[vb/block-url]', e.message); res.status(500).json({ error: 'presign failed' }); }
});

// ── POST /vaultbeam/relay/uploaded ──────────────────────────────────
// Sender reports blocks it finished PUTting. We HEAD-verify each (so a lying
// client can't mark a missing block "ready"), set the bits, and when every block
// is present flip state→'ready' and ring the recipient.
router.post('/relay/uploaded', async (req, res) => {
  try {
    const { transferId } = req.body || {};
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    if (!transferId || !blocks.length) return res.status(400).json({ error: 'transferId + blocks[] required' });

    const { t, err } = await loadTransfer(String(transferId), req.user.id);
    if (err) return res.status(err).json({ error: err === 404 ? 'not found' : 'forbidden' });
    if (t.sender_id !== req.user.id) return res.status(403).json({ error: 'sender only' });

    const mask = Buffer.from(t.uploaded_mask); // mutable copy
    for (const raw of blocks.slice(0, MAX_URLS)) {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= t.block_count || testBit(mask, i)) continue;
      if (await store.objectExists(relayKey(transferId, i))) setBit(mask, i);
    }
    const done  = countSet(mask, t.block_count);
    const ready = done === t.block_count;
    await db.query(
      `UPDATE vb_transfer SET uploaded_mask = $1, state = CASE WHEN $2 THEN 'ready' ELSE state END
         WHERE transfer_id = $3`,
      [mask, ready, transferId]);
    if (ready) emitToUid(t.recipient_id, 'vb_ready', { transferId });
    res.json({ uploaded: done, blockCount: t.block_count, ready });
  } catch (e) { console.error('[vb/uploaded]', e.message); res.status(500).json({ error: 'mark failed' }); }
});

// ── POST /vaultbeam/relay/grow ──────────────────────────────────────
// v2 adaptive geometry: the sender GROWS the transfer mid-flight — it appends a
// segment (chosen from live throughput), extends the block count + bitmask, and
// posts the updated content-free plan the recipient reads to decrypt. block_count
// may only increase; growing resets a transiently-'ready' state back to pending.
router.post('/relay/grow', async (req, res) => {
  try {
    const transferId = String(req.body?.transferId || '');
    const newCount = Number(req.body?.blockCount);
    const plan = typeof req.body?.plan === 'string' ? req.body.plan.slice(0, 200000) : null;
    if (!transferId) return res.status(400).json({ error: 'transferId required' });

    const { t, err } = await loadTransfer(transferId, req.user.id);
    if (err) return res.status(err).json({ error: err === 404 ? 'not found' : 'forbidden' });
    if (t.sender_id !== req.user.id) return res.status(403).json({ error: 'sender only' });
    if (t.state === 'complete' || t.state === 'aborted') return res.status(410).json({ error: `transfer ${t.state}` });

    const capBlocks = ceilDiv(Number(t.total_bytes), 256 * 1024);
    if (!Number.isInteger(newCount) || newCount < t.block_count || newCount > capBlocks) {
      return res.status(400).json({ error: 'blockCount must grow within cap' });
    }
    // Extend the bitmask to the new width (append zero bytes — new blocks unset).
    const need = ceilDiv(newCount, 8);
    const mask = Buffer.concat([Buffer.from(t.uploaded_mask), Buffer.alloc(Math.max(0, need - t.uploaded_mask.length))]);
    await db.query(
      `UPDATE vb_transfer SET block_count = $1, uploaded_mask = $2, plan = COALESCE($3, plan),
              state = CASE WHEN state = 'ready' THEN 'pending' ELSE state END
         WHERE transfer_id = $4`,
      [newCount, mask, plan, transferId]);
    res.json({ blockCount: newCount });
  } catch (e) { console.error('[vb/grow]', e.message); res.status(500).json({ error: 'grow failed' }); }
});

// ── GET /vaultbeam/relay/:transferId ────────────────────────────────
// Either party polls state + the uploaded-block bitmap (recipient uses it to
// know which GETs are fetchable — drives resume; only the 0-bits remain) + the
// growing content-free plan (v2 geometry).
router.get('/relay/:transferId', async (req, res) => {
  try {
    const { t, err } = await loadTransfer(String(req.params.transferId), req.user.id);
    if (err) return res.status(err).json({ error: err === 404 ? 'not found' : 'forbidden' });
    res.json({
      transferId: t.transfer_id, state: t.state, totalBytes: Number(t.total_bytes),
      blockCount: t.block_count, chunkCount: t.chunk_count,
      chunkBytes: CHUNK_BYTES, blockBytes: BLOCK_BYTES, plan: t.plan ?? null,
      uploadedMask: Buffer.from(t.uploaded_mask).toString('base64'),
      uploaded: countSet(t.uploaded_mask, t.block_count),
      isSender: t.sender_id === req.user.id, expiresAt: t.expires_at,
    });
  } catch (e) { console.error('[vb/state]', e.message); res.status(500).json({ error: 'state failed' }); }
});

// ── POST /vaultbeam/relay/complete ──────────────────────────────────
// Recipient confirms full download + whole-file verify → actively purge the R2
// prefix (queue-only retention) and mark complete.
router.post('/relay/complete', async (req, res) => {
  try {
    const { t, err } = await loadTransfer(String(req.body?.transferId), req.user.id);
    if (err) return res.status(err).json({ error: err === 404 ? 'not found' : 'forbidden' });
    if (t.recipient_id !== req.user.id) return res.status(403).json({ error: 'recipient only' });
    await store.deletePrefix(`vault_relay/${t.transfer_id}/`);
    await db.query(`UPDATE vb_transfer SET state = 'complete', uploaded_mask = '\\x' WHERE transfer_id = $1`, [t.transfer_id]);
    emitToUid(t.sender_id, 'vb_complete', { transferId: t.transfer_id });
    res.json({ ok: true });
  } catch (e) { console.error('[vb/complete]', e.message); res.status(500).json({ error: 'complete failed' }); }
});

// ── POST /vaultbeam/relay/abort ─────────────────────────────────────
// Either party cancels → purge R2 objects + mark aborted.
router.post('/relay/abort', async (req, res) => {
  try {
    const { t, err } = await loadTransfer(String(req.body?.transferId), req.user.id);
    if (err) return res.status(err).json({ error: err === 404 ? 'not found' : 'forbidden' });
    await store.deletePrefix(`vault_relay/${t.transfer_id}/`);
    await db.query(`UPDATE vb_transfer SET state = 'aborted', uploaded_mask = '\\x' WHERE transfer_id = $1`, [t.transfer_id]);
    const other = t.sender_id === req.user.id ? t.recipient_id : t.sender_id;
    emitToUid(other, 'vb_abort', { transferId: t.transfer_id });
    res.json({ ok: true });
  } catch (e) { console.error('[vb/abort]', e.message); res.status(500).json({ error: 'abort failed' }); }
});

// Periodic stale-row reaper (objects are auto-purged by the 24h R2 lifecycle
// rule; this reaps DB rows). Call from a server.js setInterval.
async function sweepExpired() {
  try {
    const r = await db.query(`DELETE FROM vb_transfer WHERE expires_at < NOW() RETURNING transfer_id`);
    return r.rowCount || 0;
  } catch (e) { console.warn('[vb/sweep]', e.message); return 0; }
}

module.exports = router;
module.exports.setBroadcasters = setBroadcasters;
module.exports.sweepExpired = sweepExpired;
