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

const router = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
const MAX_BYTES  = parseInt(process.env.UPLOAD_MAX_BYTES || (20 * 1024 * 1024).toString(), 10);

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
router.post('/', jwtUtil.requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file (multipart) required' });
    const relPath = path.relative(UPLOAD_DIR, req.file.path);

    const r = await req.dbQuery(
      `INSERT INTO attachments (owner_user_id, filename, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, mime_type, size_bytes, filename`,
      [
        req.user.id,
        (req.file.originalname || '').slice(0, 255),
        (req.file.mimetype    || 'application/octet-stream').slice(0, 100),
        req.file.size,
        relPath,
      ]
    );

    const row = r.rows[0];
    res.json({
      id:       row.id,
      mime:     row.mime_type,
      size:     row.size_bytes,
      filename: row.filename,
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

// ── GET /uploads/:id ─────────────────────────────────────────
router.get('/:id', jwtUtil.requireAuth, async (req, res) => {
  try {
    const r = await req.dbQuery(
      `SELECT id, owner_user_id, filename, mime_type, size_bytes, storage_path
       FROM attachments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    const att = r.rows[0];
    if (!att) return res.status(404).json({ error: 'Not found' });

    // Permission: owner, OR member of any chat that references this attachment in messages.meta
    if (att.owner_user_id !== req.user.id) {
      const ok = await req.dbQuery(
        `SELECT 1
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id
         WHERE cm.user_id = $2
           AND cm.left_at IS NULL
           AND m.meta->>'attachmentId' = $1
         LIMIT 1`,
        [String(att.id), req.user.id]
      );
      if (!ok.rows[0]) return res.status(403).json({ error: 'Forbidden' });
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

module.exports = router;
