// vaultchat-backend/routes/stories.js
//
// Stories — 24-hour ephemeral posts (Phase 3a MVP).
//
// Endpoints (all Bearer-authed):
//   POST   /stories                       { attachmentId, mediaType, caption? }
//   GET    /stories/feed                  → grouped by author, freshest first
//   GET    /stories/:id/views             → author-only; list of viewers
//   POST   /stories/:id/viewed            → caller marks consumed (idempotent)
//   DELETE /stories/:id                   → author can delete own story
//
// Visibility model: a story is visible to anyone who shares an active
// chat_members row with the author AND hasn't been blocked by them.
// Author is always considered a viewer of their own story.

const express = require('express');
const db      = require('../db');
const jwtUtil = require('../jwt');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const MAX_CAPTION = 200;

function publicStory(row) {
  return {
    id:           String(row.id),
    userId:       row.user_id,
    attachmentId: row.attachment_id,
    mediaType:    row.media_type,
    caption:      row.caption,
    encrypted:    !!row.encrypted,
    createdAt:    row.created_at,
    expiresAt:    row.expires_at,
  };
}

// The set of users who may view the caller's stories: anyone sharing an active
// chat, minus blocks, minus self. Used by the client to wrap an encrypted
// story's content key once per authorized viewer at post time.
async function audienceIds(userId) {
  const r = await db.query(
    `SELECT DISTINCT cm_them.user_id AS id
       FROM chat_members cm_me
       JOIN chat_members cm_them ON cm_them.chat_id = cm_me.chat_id
      WHERE cm_me.user_id   = $1 AND cm_me.left_at   IS NULL
        AND cm_them.user_id <> $1 AND cm_them.left_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
           WHERE (ub.blocker_id = $1 AND ub.blocked_id = cm_them.user_id)
              OR (ub.blocker_id = cm_them.user_id AND ub.blocked_id = $1)
        )`,
    [userId]
  );
  return r.rows.map(x => x.id);
}

// GET /stories/audience — viewer ids the caller should wrap an encrypted story
// for. Returned BEFORE posting so the client can fetch each one's key bundle and
// wrap the content key per viewer.
router.get('/audience', async (req, res) => {
  try {
    res.json({ viewerIds: await audienceIds(req.user.id) });
  } catch (err) {
    console.error('[stories audience GET]', err.message);
    res.status(500).json({ error: 'Failed to load audience' });
  }
});

// POST /stories — create a new story.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const attachmentId = (b.attachmentId || '').toString();
    const mediaType    = (b.mediaType    || '').toString();
    const caption      = b.caption != null ? String(b.caption).slice(0, MAX_CAPTION) : null;
    const encrypted    = b.encrypted === true;
    // For encrypted stories: per-viewer wrapped content keys
    // [{ viewerId, wrappedKey }]. The server stores them opaquely.
    const keys = Array.isArray(b.keys) ? b.keys : [];

    if (!attachmentId) return res.status(400).json({ error: 'attachmentId required' });
    if (!['image','video'].includes(mediaType)) {
      return res.status(400).json({ error: 'mediaType must be image or video' });
    }

    // Verify the attachment exists and belongs to this user. (Stories
    // are reposts of an already-uploaded attachment — the upload happens
    // through the regular /uploads route.)
    const a = await db.query(
      `SELECT id, owner_user_id FROM attachments WHERE id = $1 LIMIT 1`,
      [attachmentId]
    );
    if (!a.rows[0]) return res.status(404).json({ error: 'attachment not found' });
    if (a.rows[0].owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'attachment not owned by caller' });
    }

    const r = await db.query(
      `INSERT INTO stories (user_id, attachment_id, media_type, caption, encrypted)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, attachmentId, mediaType, caption, encrypted]
    );
    const story = r.rows[0];

    // Persist the per-viewer wrapped keys for an encrypted story. Restricted to
    // the caller's real audience so keys can't be planted for arbitrary users.
    if (encrypted && keys.length) {
      const allowed = new Set(await audienceIds(req.user.id));
      for (const k of keys) {
        const viewerId   = k && k.viewerId   ? String(k.viewerId)   : '';
        const wrappedKey = k && k.wrappedKey ? String(k.wrappedKey) : '';
        if (!viewerId || !wrappedKey || !allowed.has(viewerId)) continue;
        await db.query(
          `INSERT INTO story_keys (story_id, viewer_id, wrapped_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (story_id, viewer_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key`,
          [story.id, viewerId, wrappedKey]
        );
      }
    }
    res.json(publicStory(story));
  } catch (err) {
    console.error('[stories POST]', err.message);
    res.status(500).json({ error: 'Failed to post story' });
  }
});

// GET /stories/feed — grouped by author. Returns one entry per author
// whose set of unexpired stories the caller may view: array of stories
// (newest last so the viewer auto-advances chronologically) plus a
// `seenAll` flag computed against the caller's story_views rows.
router.get('/feed', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.id, s.user_id, s.attachment_id, s.media_type, s.caption, s.encrypted,
              s.created_at, s.expires_at,
              u.name, u.email, u.photo_url,
              EXISTS (SELECT 1 FROM story_views sv
                       WHERE sv.story_id = s.id AND sv.viewer_id = $1) AS seen
         FROM stories s
         JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > NOW()
          -- visibility: author is self, OR caller shares an active chat
          -- with the author AND author hasn't blocked caller AND caller
          -- hasn't blocked author
          AND (
            s.user_id = $1
            OR (
              EXISTS (
                SELECT 1 FROM chat_members cm_me
                 JOIN chat_members cm_them ON cm_them.chat_id = cm_me.chat_id
                 WHERE cm_me.user_id   = $1 AND cm_me.left_at   IS NULL
                   AND cm_them.user_id = s.user_id AND cm_them.left_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks ub
                 WHERE (ub.blocker_id = s.user_id AND ub.blocked_id = $1)
                    OR (ub.blocker_id = $1        AND ub.blocked_id = s.user_id)
              )
            )
          )
        ORDER BY s.user_id, s.created_at ASC`,
      [req.user.id]
    );

    // Group by author for the row-per-user UI.
    const byUser = new Map();
    for (const row of r.rows) {
      let bucket = byUser.get(row.user_id);
      if (!bucket) {
        bucket = {
          userId:    row.user_id,
          name:      row.name,
          email:     row.email,
          photoURL:  row.photo_url,
          isMine:    row.user_id === req.user.id,
          stories:   [],
          seenAll:   true,   // assume seen until we find one we haven't
          latestAt:  row.created_at,
        };
        byUser.set(row.user_id, bucket);
      }
      bucket.stories.push({
        id:           String(row.id),
        attachmentId: row.attachment_id,
        mediaType:    row.media_type,
        caption:      row.caption,
        encrypted:    !!row.encrypted,
        createdAt:    row.created_at,
        expiresAt:    row.expires_at,
        seen:         !!row.seen,
      });
      if (!row.seen) bucket.seenAll = false;
      if (row.created_at > bucket.latestAt) bucket.latestAt = row.created_at;
    }
    // Sort: my own first, then unseen authors, then by latest activity.
    const list = Array.from(byUser.values()).sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      if (a.seenAll !== b.seenAll) return a.seenAll ? 1 : -1;
      return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
    });
    res.json(list);
  } catch (err) {
    console.error('[stories feed GET]', err.message);
    res.status(500).json({ error: 'Failed to load story feed' });
  }
});

// GET /stories/:id/views — author-only; list viewers in reverse-chrono.
router.get('/:id/views', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const owner = await db.query(
      `SELECT user_id FROM stories WHERE id = $1`,
      [id]
    );
    if (!owner.rows[0]) return res.status(404).json({ error: 'story not found' });
    if (owner.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'author only' });

    const r = await db.query(
      `SELECT sv.viewer_id, sv.viewed_at, u.name, u.email, u.photo_url
         FROM story_views sv
         JOIN users u ON u.id = sv.viewer_id
        WHERE sv.story_id = $1
        ORDER BY sv.viewed_at DESC`,
      [id]
    );
    res.json(r.rows.map(row => ({
      userId:   row.viewer_id,
      name:     row.name,
      email:    row.email,
      photoURL: row.photo_url,
      viewedAt: row.viewed_at,
    })));
  } catch (err) {
    console.error('[stories views GET]', err.message);
    res.status(500).json({ error: 'Failed to load views' });
  }
});

// POST /stories/:id/viewed — viewer marks consumed. Idempotent.
router.post('/:id/viewed', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const s = await db.query(
      `SELECT id, user_id, expires_at FROM stories WHERE id = $1`,
      [id]
    );
    if (!s.rows[0]) return res.status(404).json({ error: 'story not found' });
    if (s.rows[0].user_id === req.user.id) {
      // Author "viewing" own story is a no-op so they don't appear in
      // their own viewer list.
      return res.json({ ok: true, noop: true });
    }
    if (new Date(s.rows[0].expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'story expired' });
    }
    await db.query(
      `INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[stories viewed POST]', err.message);
    res.status(500).json({ error: 'Failed to mark viewed' });
  }
});

// GET /stories/:id/key — the caller's own wrapped content key for an encrypted
// story. Returns 404 if the caller wasn't in the audience (no key was wrapped
// for them) or the story expired. The key is opaque to the server.
router.get('/:id/key', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const s = await db.query(
      `SELECT expires_at FROM stories WHERE id = $1`, [id]
    );
    if (!s.rows[0]) return res.status(404).json({ error: 'story not found' });
    if (new Date(s.rows[0].expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'story expired' });
    }
    const k = await db.query(
      `SELECT wrapped_key FROM story_keys WHERE story_id = $1 AND viewer_id = $2`,
      [id, req.user.id]
    );
    if (!k.rows[0]) return res.status(404).json({ error: 'no key for viewer' });
    res.json({ wrappedKey: k.rows[0].wrapped_key });
  } catch (err) {
    console.error('[stories key GET]', err.message);
    res.status(500).json({ error: 'Failed to load key' });
  }
});

// DELETE /stories/:id — author can delete own story before expiry.
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const r = await db.query(
      `DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found or not author' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[stories DELETE]', err.message);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

module.exports = router;
