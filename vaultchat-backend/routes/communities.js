// routes/communities.js — WhatsApp-style Communities.
//
// A community is an umbrella over several group chats. Creating one also creates
// an "Announcements" group (admins-only posting). You're a member of a community
// if you're a member of any of its chats. All routes require a Bearer JWT.

const express = require('express');
const jwtUtil = require('../jwt');

const router = express.Router();
router.use(jwtUtil.requireAuth);

// POST /communities  { name, description? }  → create community + announcement group
router.post('/', async (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim().slice(0, 100);
    const description = ((req.body?.description || '').toString().trim().slice(0, 512)) || null;
    if (!name) return res.status(400).json({ error: 'name required' });

    const out = await req.dbTx(async (client) => {
      const c = await client.query(
        `INSERT INTO communities (name, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [name, description, req.user.id]
      );
      const community = c.rows[0];
      const g = await client.query(
        `INSERT INTO chats (type, name, created_by, community_id, is_announcement, send_policy)
         VALUES ('group', $1, $2, $3, TRUE, 'admins') RETURNING id`,
        [`${name} Announcements`, req.user.id, community.id]
      );
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [g.rows[0].id, req.user.id]
      );
      return { community, announcementChatId: g.rows[0].id };
    });

    res.json({
      id: out.community.id, name: out.community.name, description: out.community.description,
      photoURL: out.community.photo_url, announcementChatId: out.announcementChatId,
    });
  } catch (err) {
    console.error('[communities POST]', err.message);
    res.status(500).json({ error: 'Failed to create community' });
  }
});

// GET /communities  → communities I'm a member of (via any of their chats)
router.get('/', async (req, res) => {
  try {
    const r = await req.dbQuery(
      `SELECT DISTINCT co.id, co.name, co.description, co.photo_url, co.created_at,
              (SELECT COUNT(*) FROM chats ch WHERE ch.community_id = co.id) AS group_count
         FROM communities co
         JOIN chats c       ON c.community_id = co.id
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
        ORDER BY co.created_at DESC`,
      [req.user.id]
    );
    res.json({ communities: r.rows.map(x => ({
      id: x.id, name: x.name, description: x.description, photoURL: x.photo_url, groupCount: Number(x.group_count),
    })) });
  } catch (err) {
    console.error('[communities GET]', err.message);
    res.status(500).json({ error: 'Failed to load communities' });
  }
});

// GET /communities/:id  → community + the groups in it that I'm a member of
router.get('/:id', async (req, res) => {
  try {
    const co = await req.dbQuery(`SELECT * FROM communities WHERE id = $1`, [req.params.id]);
    const community = co.rows[0];
    if (!community) return res.status(404).json({ error: 'Community not found' });

    const groups = await req.dbQuery(
      `SELECT c.id, c.name, c.photo_url, c.is_announcement,
              (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id AND m.left_at IS NULL) AS members
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
        WHERE c.community_id = $2
        ORDER BY c.is_announcement DESC, c.created_at`,
      [req.user.id, req.params.id]
    );
    if (!groups.rows.length) return res.status(403).json({ error: 'Not a community member' });

    res.json({
      id: community.id, name: community.name, description: community.description, photoURL: community.photo_url,
      isOwner: community.created_by === req.user.id,
      groups: groups.rows.map(g => ({
        id: g.id, name: g.name, photoURL: g.photo_url, isAnnouncement: g.is_announcement, members: Number(g.members),
      })),
    });
  } catch (err) {
    console.error('[communities GET/:id]', err.message);
    res.status(500).json({ error: 'Failed to load community' });
  }
});

// POST /communities/:id/groups  { name }  → create a sub-group in the community
router.post('/:id/groups', async (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'name required' });

    const mem = await req.dbQuery(
      `SELECT 1 FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
        WHERE c.community_id = $2 LIMIT 1`,
      [req.user.id, req.params.id]
    );
    if (!mem.rows[0]) return res.status(403).json({ error: 'Not a community member' });

    const id = await req.dbTx(async (client) => {
      const ins = await client.query(
        `INSERT INTO chats (type, name, created_by, community_id) VALUES ('group', $1, $2, $3) RETURNING id`,
        [name, req.user.id, req.params.id]
      );
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [ins.rows[0].id, req.user.id]
      );
      return ins.rows[0].id;
    });
    res.json({ id, name });
  } catch (err) {
    console.error('[communities groups POST]', err.message);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

module.exports = router;
