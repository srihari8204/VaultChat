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

const router = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
// 50 MB default so a ~30 second 1080p clip fits without bumping env.
// Override via env in production once we know real distribution.
const MAX_BYTES  = parseInt(process.env.UPLOAD_MAX_BYTES || (50 * 1024 * 1024).toString(), 10);

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
router.post('/', jwtUtil.requireAuth, upload.single('file'), async (req, res) => {
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
router.post('/presign', jwtUtil.requireAuth, async (req, res) => {
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

// ── GET /uploads/:id ─────────────────────────────────────────
router.get('/:id', jwtUtil.requireAuth, async (req, res) => {
  try {
    const r = await req.dbQuery(
      `SELECT id, owner_user_id, filename, mime_type, size_bytes, storage_path,
              view_once, viewed_at, storage_backend
       FROM attachments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    const att = r.rows[0];
    if (!att) return res.status(404).json({ error: 'Not found' });

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
        if (!asPhoto.rows[0]) return res.status(403).json({ error: 'Forbidden' });
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

    // Object-store backed: hand out a short-lived presigned URL (issued only
    // after the access checks above) and redirect — the bytes are served by the
    // store/CDN, never streamed through this process.
    if (att.storage_backend === 's3') {
      const url = await objectStore.presignGet(att.storage_path);
      if (!url) return res.status(500).json({ error: 'Storage unavailable' });
      return res.redirect(302, url);
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

module.exports = router;
