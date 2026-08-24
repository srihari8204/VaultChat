// File upload / download (Phase 4 attachments).
//
//   POST /uploads        (multipart "file") → { id, mime, size, filename }
//   GET  /uploads/:id                       → streams the file with auth
//
// Auth model:
//   * Upload: any signed-in user; row tagged with owner_user_id
//   * Download: owner OR member of any chat where this attachment is
//               referenced via messages.meta->>'attachmentId'
//
// Storage:
//   On-disk under UPLOAD_DIR (default: <CWD>/uploads/), sharded by date.
//   Filename in DB; UUID + original extension on disk so name collisions
//   are impossible.
//
// Encryption:
//   MVP stores plaintext bytes. Phase 4b will wrap in client-side encryption
//   before upload; backend code path is unchanged (still opaque to us).

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');

const jwtUtil = require('../jwt');
const objectStore = require('../lib/storage');
const vault   = require('../lib/vault');
const rateLimit = require('../rateLimit');

/**
 * Ceiling on the endpoints that MINT STORAGE — a direct upload, a presigned PUT,
 * or a multipart session. Each one turns an authenticated request into object
 * storage we pay for and bandwidth we pay for, and unlike a message there is no
 * natural bound on how fast a client can ask for more.
 *
 * Applied only to the minting routes. The GETs below are cheap reads and
 * throttling those would break legitimate media-heavy scroll-back.
 *
 * 120/min is roughly four times the fastest an album send has ever produced, so
 * it should never be reached by a person using the app.
 */
async function limitUploads(req, res, next) {
  try {
    const rl = await rateLimit.consume(`upl:${req.user.id}`, 120, 60);
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many uploads. Try again shortly.', retryAfter: rl.resetInSec });
    }
  } catch { /* limiter is best-effort, same fail-open contract as everywhere else */ }
  next();
}

const router = express.Router();

// Broadcast helper — set by server.js at boot via setBroadcasters(), same shape
// as the chats router. No-op until wired, so revoke still works (stamp + byte
// delete) even when the socket layer isn't up.
let broadcastChatEvent = (_chatId, _event, _payload) => {};
function setBroadcasters(funcs) {
  if (funcs.chatEvent) broadcastChatEvent = funcs.chatEvent;
}

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
// 50 MB default so a ~30 second 1080p clip fits without bumping env.
// Override via env in production once we know real distribution.
const MAX_BYTES  = parseInt(process.env.UPLOAD_MAX_BYTES || (50 * 1024 * 1024).toString(), 10);
// Resumable multipart path: larger ceiling (WhatsApp-scale video) + fixed part
// size. S3/R2 requires ≥5 MiB parts (except the last) and ≤10000 parts, so 8 MiB
// parts cover files up to 80 GiB with good resume granularity.
const MULTIPART_MAX_BYTES = parseInt(process.env.MULTIPART_MAX_BYTES || (2 * 1024 * 1024 * 1024).toString(), 10);
const PART_SIZE  = 8 * 1024 * 1024;

// Ensure base dir exists at module load
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

function shardPath(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return path.join(String(y), m, d);
}

function safeExt(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  // Only allow common extensions through unmodified. Anything weird → no ext.
  if (!/^\.[a-z0-9]{1,6}$/.test(ext)) return '';
  return ext;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(UPLOAD_DIR, shardPath());
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    cb(null, `${id}${safeExt(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
});

// ── POST /uploads ────────────────────────────────────────────
//   ?viewOnce=1  marks the attachment view-once (first non-owner GET
//                triggers a one-way flip of viewed_at; subsequent GETs
//                from non-owners get 410 Gone).
router.post('/', jwtUtil.requireAuth, limitUploads, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file (multipart) required' });
    const relPath = path.relative(UPLOAD_DIR, req.file.path);
    const viewOnce = req.query?.viewOnce === '1' || req.query?.viewOnce === 'true';

    const r = await req.dbQuery(
      `INSERT INTO attachments (owner_user_id, filename, mime_type, size_bytes, storage_path, view_once)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, mime_type, size_bytes, filename, view_once`,
      [
        req.user.id,
        (req.file.originalname || '').slice(0, 255),
        (req.file.mimetype    || 'application/octet-stream').slice(0, 100),
        req.file.size,
        relPath,
        viewOnce,
      ]
    );

    const row = r.rows[0];
    res.json({
      id:       row.id,
      mime:     row.mime_type,
      size:     row.size_bytes,
      filename: row.filename,
      viewOnce: !!row.view_once,
    });
  } catch (err) {
    console.error('[uploads POST]', err.message);
    // If we wrote a file to disk but DB insert failed, best-effort cleanup
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large (max ${MAX_BYTES} bytes)` });
    }
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── POST /uploads/presign ────────────────────────────────────
// Object-store path: client asks for a presigned PUT URL, uploads the bytes
// DIRECTLY to the store, then references the returned id in its message — the
// bytes never pass through this process. Falls back to the multipart POST /
// above when object storage isn't configured.
//   Body: { filename, mime, size?, viewOnce? } → { id, uploadUrl, key }
router.post('/presign', jwtUtil.requireAuth, limitUploads, async (req, res) => {
  try {
    if (!objectStore.enabled()) {
      return res.status(503).json({ error: 'Object storage not configured' });
    }
    const filename = (req.body?.filename || 'file').toString().slice(0, 255);
    const mime     = (req.body?.mime || 'application/octet-stream').toString().slice(0, 100);
    const size     = parseInt(req.body?.size || '0', 10) || 0;
    if (size > MAX_BYTES) {
      return res.status(413).json({ error: `File too large (max ${MAX_BYTES} bytes)` });
    }
    const viewOnce = req.body?.viewOnce === true || req.body?.viewOnce === 1 || req.body?.viewOnce === '1';

    const id  = crypto.randomUUID();
    const key = `att/${id}${safeExt(filename)}`;

    await req.dbQuery(
      `INSERT INTO attachments
         (id, owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, storage_backend)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 's3')`,
      [id, req.user.id, filename, mime, size, key, viewOnce]
    );

    const uploadUrl = await objectStore.presignPut(key, mime);
    res.json({ id, uploadUrl, key });
  } catch (err) {
    console.error('[uploads presign]', err.message);
    res.status(500).json({ error: 'Presign failed' });
  }
});

// ── Resumable multipart upload ───────────────────────────────
// Large media uploads a part at a time so an interrupted upload RESUMES (the
// parts already on R2 are skipped) instead of restarting from byte 0. The
// object is finalised into a normal `attachments` row served by GET /uploads/:id.
//
//   POST /uploads/multipart/init      { filename, mime, size, viewOnce? }
//                                      → { id, uploadId, key, partSize, partCount }
//   POST /uploads/multipart/part-urls { id, uploadId, partNumbers:[…] } → { urls:{n:url} }
//   GET  /uploads/multipart/:id/parts?uploadId=…  → { uploaded:[n…], partSize }
//   POST /uploads/multipart/complete  { id, uploadId } → { id, mime, size, filename }
//   POST /uploads/multipart/abort     { id, uploadId } → { ok:true }

// Load an attachment row and assert the caller owns it (only the uploader may
// drive their own multipart session). Returns the row or sends the error.
async function ownedAttachment(req, res, id) {
  const r = await req.dbQuery(
    `SELECT id, owner_user_id, filename, mime_type, size_bytes, storage_path
       FROM attachments WHERE id = $1 LIMIT 1`, [id]);
  const att = r.rows[0];
  if (!att) { res.status(404).json({ error: 'Not found' }); return null; }
  if (att.owner_user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return att;
}

router.post('/multipart/init', jwtUtil.requireAuth, limitUploads, async (req, res) => {
  try {
    if (!objectStore.enabled()) return res.status(503).json({ error: 'Object storage not configured' });
    const filename = (req.body?.filename || 'file').toString().slice(0, 255);
    const mime     = (req.body?.mime || 'application/octet-stream').toString().slice(0, 100);
    const size     = parseInt(req.body?.size || '0', 10) || 0;
    if (size <= 0)                 return res.status(400).json({ error: 'size required' });
    if (size > MULTIPART_MAX_BYTES) return res.status(413).json({ error: `File too large (max ${MULTIPART_MAX_BYTES} bytes)` });
    const viewOnce = req.body?.viewOnce === true || req.body?.viewOnce === 1 || req.body?.viewOnce === '1';

    const id  = crypto.randomUUID();
    const key = `att/${id}${safeExt(filename)}`;
    const uploadId = await objectStore.createMultipart(key, mime);
    if (!uploadId) return res.status(500).json({ error: 'Could not start upload' });

    await req.dbQuery(
      `INSERT INTO attachments
         (id, owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, storage_backend)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 's3')`,
      [id, req.user.id, filename, mime, size, key, viewOnce]);

    res.json({ id, uploadId, key, partSize: PART_SIZE, partCount: Math.ceil(size / PART_SIZE) });
  } catch (err) {
    console.error('[uploads multipart/init]', err.message);
    res.status(500).json({ error: 'Init failed' });
  }
});

router.post('/multipart/part-urls', jwtUtil.requireAuth, limitUploads, async (req, res) => {
  try {
    const att = await ownedAttachment(req, res, req.body?.id);
    if (!att) return;
    const uploadId = (req.body?.uploadId || '').toString();
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    const nums = Array.isArray(req.body?.partNumbers) ? req.body.partNumbers : [];
    if (!nums.length || nums.length > 1000) return res.status(400).json({ error: 'partNumbers: 1..1000' });

    const urls = {};
    for (const raw of nums) {
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1 || n > 10000) continue;   // S3 part-number range
      urls[n] = await objectStore.presignUploadPart(att.storage_path, uploadId, n);
    }
    res.json({ urls });
  } catch (err) {
    console.error('[uploads multipart/part-urls]', err.message);
    res.status(500).json({ error: 'Presign failed' });
  }
});

router.get('/multipart/:id/parts', jwtUtil.requireAuth, async (req, res) => {
  try {
    const att = await ownedAttachment(req, res, req.params.id);
    if (!att) return;
    const uploadId = (req.query?.uploadId || '').toString();
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    const parts = await objectStore.listParts(att.storage_path, uploadId);
    res.json({ uploaded: parts.map(p => p.PartNumber), partSize: PART_SIZE });
  } catch (err) {
    console.error('[uploads multipart/parts]', err.message);
    res.status(500).json({ error: 'List failed' });
  }
});

router.post('/multipart/complete', jwtUtil.requireAuth, async (req, res) => {
  try {
    const att = await ownedAttachment(req, res, req.body?.id);
    if (!att) return;
    const uploadId = (req.body?.uploadId || '').toString();
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });

    // Server-authoritative: assemble from what actually landed (resume-safe —
    // the client never has to track ETags).
    const parts = (await objectStore.listParts(att.storage_path, uploadId))
      .sort((a, b) => a.PartNumber - b.PartNumber)
      .map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
    if (!parts.length) return res.status(400).json({ error: 'No parts uploaded' });

    await objectStore.completeMultipart(att.storage_path, uploadId, parts);
    res.json({ id: att.id, mime: att.mime_type, size: att.size_bytes, filename: att.filename });
  } catch (err) {
    console.error('[uploads multipart/complete]', err.message);
    res.status(500).json({ error: 'Complete failed' });
  }
});

router.post('/multipart/abort', jwtUtil.requireAuth, async (req, res) => {
  try {
    const att = await ownedAttachment(req, res, req.body?.id);
    if (!att) return;
    const uploadId = (req.body?.uploadId || '').toString();
    if (uploadId) await objectStore.abortMultipart(att.storage_path, uploadId);
    await req.dbQuery(`DELETE FROM attachments WHERE id = $1`, [att.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[uploads multipart/abort]', err.message);
    res.status(500).json({ error: 'Abort failed' });
  }
});

// ── GET /uploads/:id ─────────────────────────────────────────
router.get('/:id', jwtUtil.requireAuth, async (req, res) => {
  try {
    const r = await req.dbQuery(
      `SELECT id, owner_user_id, filename, mime_type, size_bytes, storage_path,
              view_once, viewed_at, revoked_at, storage_backend
       FROM attachments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    const att = r.rows[0];
    if (!att) return res.status(404).json({ error: 'Not found' });

    // Revoked media is gone for EVERYONE — sender included. Checked before the
    // membership work below so a revoked attachment never touches storage, and
    // ahead of the view-once gate because revoke is the stronger signal: the
    // client wipes its local key + plaintext when it sees `revoked: true`.
    if (att.revoked_at) {
      return res.status(410).json({ error: 'This media was revoked by the sender.', revoked: true });
    }

    // Permission: owner, OR member of any chat that references this attachment in messages.meta,
    // OR any signed-in user when this attachment is currently used as someone's profile photo.
    if (att.owner_user_id !== req.user.id) {
      const inChat = await req.dbQuery(
        `SELECT 1
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id
         WHERE cm.user_id = $2
           AND cm.left_at IS NULL
           AND m.meta->>'attachmentId' = $1
         LIMIT 1`,
        [String(att.id), req.user.id]
      );
      if (!inChat.rows[0]) {
        const asPhoto = await req.dbQuery(
          `SELECT 1 FROM users WHERE photo_url = $1 LIMIT 1`,
          [String(att.id)]
        );
        if (!asPhoto.rows[0]) {
          // Story media: viewable when the attachment backs an UNEXPIRED story
          // whose author shares an active chat with the caller and neither has
          // blocked the other — the exact GET /stories/feed visibility rule.
          // Stories reference attachments directly (not via messages.meta), so
          // without this clause every OTHER user's status media 403'd.
          const asStory = await db.query(
            `SELECT 1 FROM stories s
              WHERE s.attachment_id = $1
                AND s.expires_at > NOW()
                AND EXISTS (
                  SELECT 1 FROM chat_members cm_me
                   JOIN chat_members cm_them ON cm_them.chat_id = cm_me.chat_id
                   WHERE cm_me.user_id   = $2 AND cm_me.left_at   IS NULL
                     AND cm_them.user_id = s.user_id AND cm_them.left_at IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM user_blocks ub
                   WHERE (ub.blocker_id = s.user_id AND ub.blocked_id = $2)
                      OR (ub.blocker_id = $2        AND ub.blocked_id = s.user_id)
                )
              LIMIT 1`,
            [String(att.id), req.user.id]
          );
          if (!asStory.rows[0]) return res.status(403).json({ error: 'Forbidden' });
        }
      }

      // Record delivery (a recipient is fetching the bytes) so the retention
      // sweeper can purge the media once everyone in the chat has downloaded it.
      if (inChat.rows[0]) {
        req.dbQuery(
          `INSERT INTO attachment_deliveries (attachment_id, user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [String(att.id), req.user.id],
        ).catch(() => {});
      }

      // View-once gate: non-owner after consumption gets 410 Gone.
      // Owners can always re-fetch (so the sender can review their send).
      if (att.view_once && att.viewed_at) {
        return res.status(410).json({ error: 'This media has already been viewed and is no longer available.' });
      }
    }

    // Encrypted avatar: if this attachment is in use as a profile photo that was
    // uploaded encrypted, stream-decrypt it here (the bytes are ciphertext in the
    // store; the per-photo key is wrapped under the master key). Falls through to
    // the normal path if anything is missing — never serves a broken image.
    const keyRow = await req.dbQuery(
      `SELECT photo_key_cipher FROM users WHERE photo_url = $1 AND photo_key_cipher IS NOT NULL LIMIT 1`,
      [String(att.id)],
    );
    if (keyRow.rows[0]?.photo_key_cipher) {
      try {
        const cipherBytes = att.storage_backend === 's3'
          ? await objectStore.getObject(att.storage_path)
          : require('fs').readFileSync(path.join(UPLOAD_DIR, att.storage_path));
        const dekHex = vault.decrypt(keyRow.rows[0].photo_key_cipher);
        const plain  = vault.decryptWithKey(cipherBytes, dekHex);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return res.end(plain);
      } catch (e) {
        console.error('[uploads avatar-decrypt]', e.message);
        // fall through to normal serving below
      }
    }

    // Object-store backed: STREAM the bytes through this process (after the
    // access checks above). We used to 302-redirect to a presigned URL, but
    // R2/S3 rejects requests carrying BOTH the presigned query signature AND an
    // Authorization header — and RN's fetch/downloadAsync/Image forward our
    // Bearer header across redirects → 400 → black media. MinIO tolerated the
    // double auth, which is why this only surfaced at the R2 cutover.
    if (att.storage_backend === 's3') {
      const obj = await objectStore.getObjectStream(att.storage_path);
      if (!obj) return res.status(404).json({ error: 'File missing in storage' });
      res.setHeader('Content-Type', att.mime_type || obj.contentType || 'application/octet-stream');
      if (obj.contentLength != null) res.setHeader('Content-Length', String(obj.contentLength));
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.filename)}"`);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      obj.body.on('error', (e) => { console.error('[uploads GET s3-stream]', e.message); try { res.destroy(); } catch {} });
      obj.body.pipe(res);
      return;
    }

    const absPath = path.join(UPLOAD_DIR, att.storage_path);
    // Defence-in-depth: ensure resolved path is still under UPLOAD_DIR
    if (!absPath.startsWith(UPLOAD_DIR + path.sep) && absPath !== UPLOAD_DIR) {
      return res.status(500).json({ error: 'Storage path corrupt' });
    }
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File missing on disk' });

    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Length', String(att.size_bytes));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    console.error('[uploads GET]', err.message);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ── POST /uploads/:id/viewed ─────────────────────────────────
// Recipient client calls this when the view-once bubble reveals the media.
// Idempotent: only the first call (non-owner, view_once=TRUE, not yet
// viewed) actually flips viewed_at. After that the row is "consumed" and
// subsequent GETs from non-owners get 410.
router.post('/:id/viewed', jwtUtil.requireAuth, async (req, res) => {
  try {
    const r = await req.dbQuery(
      `SELECT id, owner_user_id, view_once, viewed_at FROM attachments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    const att = r.rows[0];
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (!att.view_once) return res.json({ ok: true, noop: true });
    // Owners don't "consume" their own uploads.
    if (att.owner_user_id === req.user.id) return res.json({ ok: true, noop: true });
    if (att.viewed_at) return res.json({ ok: true, alreadyViewed: true });

    await req.dbQuery(
      `UPDATE attachments SET viewed_at = NOW()
        WHERE id = $1 AND view_once = TRUE AND viewed_at IS NULL`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[uploads viewed]', err.message);
    res.status(500).json({ error: 'Failed to mark viewed' });
  }
});

// ── POST /uploads/:id/revoke ─────────────────────────────────
// VaultView remote revoke. OWNER ONLY. One-way and irreversible:
//   1. stamp revoked_at            → every later GET 410s, including the owner's
//   2. delete the stored bytes     → the server no longer holds a copy at all
//   3. broadcast 'media_revoked'   → online recipients destroy their per-file
//                                    media key and any decrypted plaintext
//
// Offline recipients converge without the socket event: their next fetch 410s,
// and the client wipes local key + plaintext on that signal. With MEDIA_E2EE on,
// destroying the key is what makes it irreversible — ciphertext already sitting
// on their device becomes permanently undecryptable.
//
// Deliberately NOT gated on view_once: any attachment the sender owns can be
// pulled back.
router.post('/:id/revoke', jwtUtil.requireAuth, async (req, res) => {
  try {
    const r = await req.dbQuery(
      `SELECT id, owner_user_id, storage_path, storage_backend, revoked_at
         FROM attachments WHERE id = $1 LIMIT 1`,
      [req.params.id],
    );
    const att = r.rows[0];
    if (!att) return res.status(404).json({ error: 'Not found' });
    // Only the sender can revoke. A recipient calling this would be destroying
    // someone else's media.
    if (att.owner_user_id !== req.user.id) return res.status(403).json({ error: 'Only the sender can revoke this media' });
    if (att.revoked_at) return res.json({ ok: true, alreadyRevoked: true });

    await req.dbQuery(`UPDATE attachments SET revoked_at = NOW() WHERE id = $1`, [att.id]);

    // Destroy the bytes. Best-effort per backend — the revoked_at stamp above is
    // the authoritative gate, so a storage hiccup can't leave the media
    // reachable even if the delete fails.
    try {
      if (att.storage_backend === 's3') {
        await objectStore.deleteObject(att.storage_path);
      } else {
        const abs = path.join(UPLOAD_DIR, att.storage_path);
        if (abs.startsWith(UPLOAD_DIR + path.sep)) fs.promises.unlink(abs).catch(() => {});
      }
    } catch (e) {
      console.warn('[uploads revoke] byte delete failed (row still revoked):', e.message);
    }

    // Tell every chat that references this attachment, so recipients wipe now
    // rather than at next fetch.
    const chats = await req.dbQuery(
      `SELECT DISTINCT m.chat_id, m.id AS message_id
         FROM messages m
        WHERE m.meta->>'attachmentId' = $1`,
      [String(att.id)],
    );
    for (const row of chats.rows) {
      broadcastChatEvent(row.chat_id, 'media_revoked', {
        chatId:       row.chat_id,
        messageId:    row.message_id,
        attachmentId: String(att.id),
        revokedBy:    req.user.id,
        revokedAt:    new Date().toISOString(),
      });
    }

    res.json({ ok: true, chats: chats.rows.length });
  } catch (err) {
    console.error('[uploads revoke]', err.message);
    res.status(500).json({ error: 'Failed to revoke media' });
  }
});

module.exports = router;
module.exports.setBroadcasters = setBroadcasters;
