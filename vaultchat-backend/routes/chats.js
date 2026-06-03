// Chat / message routes (Phase 3a).
//
// All routes require Bearer JWT. Membership is checked on every read+write.
// Content is opaque (encrypted by client) — server stores and forwards
// the bytes without inspection. Multi-device fan-out happens in the
// Socket.IO layer (server.js) which emits a `new_message` event to
// every connected socket of every chat member after a successful write.
//
// Endpoints:
//   GET    /chats                                — list current user's chats
//   POST   /chats                                — create direct (by email) or group
//   GET    /chats/:id                            — chat + members
//   POST   /chats/:id/messages                   — send a message
//   GET    /chats/:id/messages?before=:id&limit  — keyset paginated history
//   PATCH  /chats/:id/messages/:msgId            — edit (sender, 15-min window)
//   DELETE /chats/:id/messages/:msgId            — soft delete (sender)
//   POST   /chats/:id/read                       — { lastReadMessageId }
//   POST   /chats/:id/members                    — add (group admin/owner only)
//   DELETE /chats/:id/members/:userId            — remove (admin) or leave (self)

const express   = require('express');
const crypto    = require('crypto');
const jwtUtil   = require('../jwt');
const db        = require('../db');
const { sendPushToTokens } = require('../push');

// Normalize a phone number for hashing.
// Strips non-digits; if exactly 10 digits remain, assumes India and
// prepends 91 so it matches the +91 form. Otherwise returns digits as-is
// (caller is expected to have included a country code).
// Same function is used in routes/user.js when storing phones — both
// must stay in sync.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = '91' + d;
  return d;
}
function hashPhone(raw) {
  const norm = normalizePhone(raw);
  if (!norm) return null;
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

const router = express.Router();
router.use(jwtUtil.requireAuth);

const EDIT_WINDOW_MS  = 15 * 60 * 1000;
const MAX_GROUP_SIZE  = 256;
const DEFAULT_PAGE    = 50;
const MAX_PAGE        = 200;

// ─── helpers ────────────────────────────────────────────────────────

function publicMember(row) {
  // Honor the user's privacy: when last_seen_visible = FALSE we still
  // expose online (binary), just blank lastSeenAt.
  const lastSeenAt = (row.last_seen_visible === false) ? null : (row.last_seen_at ?? null);
  return {
    userId:                  row.user_id,
    role:                    row.role,
    joinedAt:                row.joined_at,
    lastReadMessageId:       row.last_read_message_id,
    lastDeliveredMessageId:  row.last_delivered_message_id,
    muted:                   row.muted,
    leftAt:                  row.left_at,
    // Joined-from-users fields (only present when we LEFT JOIN users)
    email:                   row.email,
    name:                    row.name,
    photoURL:                row.photo_url,
    online:                  row.online ?? false,
    lastSeenAt,
  };
}

function publicMessage(row) {
  return {
    id:        row.id,
    chatId:    row.chat_id,
    senderId:  row.sender_id,
    type:      row.type,
    content:   row.content,             // opaque bytes
    meta:      row.meta,
    replyToId: row.reply_to_id,
    editedAt:  row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

async function loadChatMembership(req, chatId) {
  const r = await req.dbQuery(
    `SELECT cm.*, c.type AS chat_type
     FROM chat_members cm
     JOIN chats c ON c.id = cm.chat_id
     WHERE cm.chat_id = $1 AND cm.user_id = $2`,
    [chatId, req.user.id]
  );
  return r.rows[0] || null;
}

// Push-notification helper for new messages. System-level query that
// reads other users' device tokens, so uses db.query (not req.dbQuery).
// The devices + users + chats tables either don't have RLS (devices) or
// are read via SECURITY DEFINER (chat_members via vc_chat_member_ids
// when needed) — here we just fetch devices for known member uids.
async function sendChatMessagePush(chatId, senderId, msg, chatType) {
  try {
    // Recipients = chat members minus the sender; AND who haven't muted
    // this chat; AND who haven't blocked the sender.
    const memR = await db.query(
      `SELECT cm.user_id FROM chat_members cm
        WHERE cm.chat_id = $1
          AND cm.user_id <> $2
          AND cm.left_at IS NULL
          AND cm.muted = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
             WHERE ub.blocker_id = cm.user_id AND ub.blocked_id = $2
          )`,
      [chatId, senderId]
    );
    if (memR.rows.length === 0) return;
    const recipientIds = memR.rows.map(r => r.user_id);

    const tokR = await db.query(
      `SELECT push_token FROM devices WHERE user_id = ANY($1::uuid[])`,
      [recipientIds]
    );
    if (tokR.rows.length === 0) return;

    // Sender display name + chat name (for group context)
    const meta = await db.query(
      `SELECT
         (SELECT COALESCE(NULLIF(name, ''), email) FROM users WHERE id = $1) AS sender_name,
         (SELECT name FROM chats WHERE id = $2) AS chat_name`,
      [senderId, chatId]
    );
    const senderName = meta.rows[0]?.sender_name || 'New message';
    const chatName   = meta.rows[0]?.chat_name;

    // Phase 3a stores content as opaque (currently plaintext). For privacy
    // we don't put the content in the notification body — show "<sender>
    // sent a message" instead. After Phase 3b real E2EE this becomes a
    // hard requirement (we couldn't decrypt anyway).
    const title = chatType === 'group' && chatName ? `${senderName} in ${chatName}` : senderName;
    const body  = msg.type === 'image' ? '📷 Photo'
                : msg.type === 'video' ? '🎥 Video'
                : msg.type === 'audio' ? '🎙️ Voice message'
                : msg.type === 'file'  ? '📎 File'
                : 'New message';

    await sendPushToTokens(
      tokR.rows.map(r => r.push_token),
      {
        title,
        body,
        data: { chatId, messageId: msg.id, type: 'message' },
      }
    );
  } catch (err) {
    console.error('[sendChatMessagePush]', err.message);
  }
}

// Broadcast helper — set by server.js at boot via setBroadcaster().
let broadcastNewMessage = (_chatId, _payload) => {};
let broadcastChatEvent  = (_chatId, _event, _payload) => {};

function setBroadcasters(funcs) {
  if (funcs.newMessage) broadcastNewMessage = funcs.newMessage;
  if (funcs.chatEvent)  broadcastChatEvent  = funcs.chatEvent;
}

// ─── routes ─────────────────────────────────────────────────────────

// GET /chats — list current user's chats, newest activity first
router.get('/', async (req, res) => {
  try {
    // For direct chats, also fetch the other member's name + photo so the
    // chat list can render avatars without one round-trip per row. Done
    // via a LATERAL subquery to keep this single-pass.
    const r = await req.dbQuery(
      `SELECT
         c.id, c.type, c.name, c.photo_url, c.created_by, c.created_at,
         c.last_message_id, c.last_message_at, c.updated_at,
         cm.role, cm.last_read_message_id, cm.muted, cm.joined_at,
         peer.user_id   AS peer_user_id,
         peer.peer_name AS peer_name,
         peer.peer_photo AS peer_photo,
         (SELECT COUNT(*) FROM messages m
            WHERE m.chat_id = c.id
              AND m.id > COALESCE(cm.last_read_message_id, 0)
              AND m.sender_id <> $1
              AND m.deleted_at IS NULL
         ) AS unread_count
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT u.id AS user_id,
                u.name AS peer_name,
                u.photo_url AS peer_photo,
                u.online   AS peer_online,
                CASE WHEN u.last_seen_visible THEN u.last_seen_at ELSE NULL END AS peer_last_seen
           FROM chat_members cm2
           JOIN users u ON u.id = cm2.user_id
          WHERE cm2.chat_id = c.id
            AND cm2.user_id <> $1
            AND cm2.left_at IS NULL
            AND c.type = 'direct'
          LIMIT 1
       ) peer ON TRUE
       WHERE cm.left_at IS NULL
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT 200`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      id:              row.id,
      type:            row.type,
      name:            row.name,
      photoURL:        row.photo_url,
      createdBy:       row.created_by,
      createdAt:       row.created_at,
      updatedAt:       row.updated_at,
      lastMessageId:   row.last_message_id,
      lastMessageAt:   row.last_message_at,
      myRole:          row.role,
      myLastReadId:    row.last_read_message_id,
      muted:           row.muted,
      unreadCount:     parseInt(row.unread_count, 10) || 0,
      // direct-chat peer info (null for groups)
      peerUserId:      row.peer_user_id ?? null,
      peerName:        row.peer_name    ?? null,
      peerPhotoURL:    row.peer_photo   ?? null,
      peerOnline:      row.peer_online  ?? false,
      peerLastSeenAt:  row.peer_last_seen ?? null,
    })));
  } catch (err) {
    console.error('[chats GET]', err.message);
    res.status(500).json({ error: 'Failed to list chats' });
  }
});

// POST /chats — create a chat
//   direct: { type: 'direct', otherEmail }                 (returns existing direct chat if one exists)
//   group:  { type: 'group',  name, memberIds: [...] }     (creator becomes 'owner')
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.type === 'direct') {
      const otherEmail  = (b.otherEmail  || '').toString().trim().toLowerCase();
      const otherPhone  = (b.otherPhone  || '').toString().trim();
      const otherUserId = (b.otherUserId || '').toString().trim();
      if (!otherEmail && !otherPhone && !otherUserId) {
        return res.status(400).json({ error: 'otherEmail, otherPhone, or otherUserId required' });
      }

      let otherId = null;
      if (otherUserId) {
        // Resolved from a /contacts/match — just verify the user still exists.
        const u = await req.dbQuery(
          `SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
          [otherUserId]
        );
        otherId = u.rows[0]?.id ?? null;
      } else if (otherEmail) {
        const u = await req.dbQuery(
          `SELECT id FROM users WHERE email = $1 AND is_deleted = FALSE LIMIT 1`,
          [otherEmail]
        );
        otherId = u.rows[0]?.id ?? null;
      } else {
        const ph = hashPhone(otherPhone);
        if (!ph) return res.status(400).json({ error: 'Invalid phone number' });
        const u = await req.dbQuery(
          `SELECT id FROM users WHERE phone_hash = $1 AND is_deleted = FALSE LIMIT 1`,
          [ph]
        );
        otherId = u.rows[0]?.id ?? null;
      }
      if (!otherId) return res.status(404).json({ error: 'User not found' });
      if (otherId === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself' });

      // Block check — either side blocking the other prevents a new direct chat.
      const blk = await db.query(
        `SELECT 1 FROM user_blocks
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)
           LIMIT 1`,
        [req.user.id, otherId]
      );
      if (blk.rows[0]) return res.status(403).json({ error: 'Blocked' });

      // Find existing direct chat between the two users
      const existing = await req.dbQuery(
        `SELECT c.id FROM chats c
         WHERE c.type = 'direct'
           AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $1 AND left_at IS NULL)
           AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $2 AND left_at IS NULL)
         LIMIT 1`,
        [req.user.id, otherId]
      );
      if (existing.rows[0]) {
        return res.json({ id: existing.rows[0].id, type: 'direct', existing: true });
      }

      const chat = await req.dbTx(async (client) => {
        const ins = await client.query(
          `INSERT INTO chats (type, created_by) VALUES ('direct', $1) RETURNING *`,
          [req.user.id]
        );
        const chatId = ins.rows[0].id;
        // Insert creator FIRST as 'owner' so the bootstrap RLS clause allows it;
        // then the other party as 'member' — by then the creator is owner so
        // vc_is_chat_admin() returns true.
        await client.query(
          `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [chatId, req.user.id]
        );
        await client.query(
          `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')`,
          [chatId, otherId]
        );
        return ins.rows[0];
      });
      return res.json({ id: chat.id, type: 'direct', existing: false });
    }

    if (b.type === 'group') {
      const name = (b.name || '').toString().trim().slice(0, 100);
      const memberIds    = Array.isArray(b.memberIds)    ? b.memberIds.filter(x => typeof x === 'string')    : [];
      const memberEmails = Array.isArray(b.memberEmails) ? b.memberEmails
                            .filter(x => typeof x === 'string')
                            .map(s => s.trim().toLowerCase())
                            .filter(Boolean) : [];

      if (!name) return res.status(400).json({ error: 'Group name required' });

      // Resolve emails → uuids (if any). Errors out if any email isn't a registered user.
      let resolvedIds = [...memberIds];
      if (memberEmails.length) {
        const r = await req.dbQuery(
          `SELECT id, email FROM users WHERE email = ANY($1::citext[]) AND is_deleted = FALSE`,
          [memberEmails]
        );
        if (r.rows.length !== memberEmails.length) {
          const found = new Set(r.rows.map(x => String(x.email).toLowerCase()));
          const missing = memberEmails.filter(e => !found.has(e));
          return res.status(400).json({ error: `Unknown emails: ${missing.join(', ')}` });
        }
        resolvedIds.push(...r.rows.map(x => x.id));
      }

      if (resolvedIds.length === 0) {
        return res.status(400).json({ error: 'Group needs at least one other member' });
      }
      if (resolvedIds.length >= MAX_GROUP_SIZE) {
        return res.status(400).json({ error: `Group capped at ${MAX_GROUP_SIZE} members` });
      }

      // Verify all UUIDs exist
      const all = Array.from(new Set([req.user.id, ...resolvedIds]));
      const found = await req.dbQuery(
        `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_deleted = FALSE`,
        [all]
      );
      if (found.rows.length !== all.length) return res.status(400).json({ error: 'One or more memberIds invalid' });

      const chat = await req.dbTx(async (client) => {
        const ins = await client.query(
          `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING *`,
          [name, req.user.id]
        );
        const chatId = ins.rows[0].id;
        // Insert all members; creator is owner
        for (const uid of all) {
          await client.query(
            `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)`,
            [chatId, uid, uid === req.user.id ? 'owner' : 'member']
          );
        }
        return ins.rows[0];
      });
      return res.json({ id: chat.id, type: 'group', name });
    }

    return res.status(400).json({ error: 'type must be direct or group' });
  } catch (err) {
    console.error('[chats POST]', err.message);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// ─── Search (Day 13) ──────────────────────────────────────────────
// GET /chats/search?q=...&limit=20
//   - matches chat names + message content + member names
//   - membership-scoped: only chats this user is a member of
//
// MUST stay above GET /:id so Express doesn't treat 'search' as a chat id.
//
// TEMPORARY: works because Phase 3a stores content as plaintext. When real
// E2EE ships (Phase 3b) the message-content search will need to move
// client-side; this endpoint will then only return chat / member matches.
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ chats: [], messages: [] });
    if (q.length > 200) return res.status(400).json({ error: 'query too long' });
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;

    const chatsR = await req.dbQuery(
      `SELECT DISTINCT c.id, c.type, c.name, c.photo_url, c.last_message_at
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
         LEFT JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id <> $1 AND cm2.left_at IS NULL
         LEFT JOIN users u ON u.id = cm2.user_id
        WHERE (c.name ILIKE $2 OR u.name ILIKE $2 OR u.email ILIKE $2)
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $3`,
      [req.user.id, like, limit]
    );

    const msgsR = await req.dbQuery(
      `SELECT m.id, m.chat_id, m.sender_id, m.content, m.created_at, m.type,
              c.type AS chat_type, c.name AS chat_name
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1 AND cm.left_at IS NULL
         JOIN chats c ON c.id = m.chat_id
        WHERE m.deleted_at IS NULL
          AND m.content ILIKE $2
        ORDER BY m.id DESC
        LIMIT $3`,
      [req.user.id, like, limit]
    );

    res.json({
      chats: chatsR.rows.map(r => ({
        id:            r.id,
        type:          r.type,
        name:          r.name,
        photoURL:      r.photo_url,
        lastMessageAt: r.last_message_at,
      })),
      messages: msgsR.rows.map(r => ({
        id:        r.id,
        chatId:    r.chat_id,
        chatName:  r.chat_name,
        chatType:  r.chat_type,
        senderId:  r.sender_id,
        type:      r.type,
        snippet:   (r.content || '').slice(0, 240),
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[chats search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /chats/:id — chat + members (no messages, that's a separate call)
router.get('/:id', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(404).json({ error: 'Chat not found' });

    const chatR = await req.dbQuery(`SELECT * FROM chats WHERE id = $1`, [req.params.id]);
    const chat = chatR.rows[0];
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const membersR = await req.dbQuery(
      `SELECT cm.*, u.email, u.name, u.photo_url, u.online, u.last_seen_at, u.last_seen_visible
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1
       ORDER BY cm.joined_at`,
      [req.params.id]
    );

    res.json({
      id:              chat.id,
      type:            chat.type,
      name:            chat.name,
      photoURL:        chat.photo_url,
      createdBy:       chat.created_by,
      createdAt:       chat.created_at,
      updatedAt:       chat.updated_at,
      lastMessageId:   chat.last_message_id,
      lastMessageAt:   chat.last_message_at,
      members:         membersR.rows.map(publicMember),
      myRole:          mem.role,
      myLastReadId:    mem.last_read_message_id,
    });
  } catch (err) {
    console.error('[chats GET/:id]', err.message);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// POST /chats/:id/messages — send a message
router.post('/:id/messages', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member of this chat' });

    const b = req.body || {};
    let   content   = b.content;
    const type      = (b.type || 'text').toString();
    const replyTo   = b.replyToId ? parseInt(b.replyToId, 10) : null;
    const meta      = b.meta && typeof b.meta === 'object' ? b.meta : null;

    if (!['text','image','video','audio','file','location','system'].includes(type)) {
      return res.status(400).json({ error: 'invalid type' });
    }

    // Text-only messages need non-empty content. Media types carry their
    // data via the attachment row referenced from meta.attachmentId — the
    // text `content` is optional (caption).
    const isMedia = type === 'image' || type === 'video' || type === 'audio' || type === 'file';
    if (type === 'text') {
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content required for text messages' });
      }
    } else if (isMedia) {
      if (!meta || !meta.attachmentId) {
        return res.status(400).json({ error: 'meta.attachmentId required for media messages' });
      }
      // Allow empty content for media — treat as null in DB so the bubble
      // renders without a caption row.
      if (content !== undefined && content !== null && typeof content !== 'string') {
        return res.status(400).json({ error: 'content must be a string if provided' });
      }
      if (typeof content === 'string' && content === '') content = null;
    } else if (content !== undefined && content !== null && typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string if provided' });
    }

    if (typeof content === 'string' && content.length > 1_000_000) {
      return res.status(413).json({ error: 'content too large (max 1 MB)' });
    }

    const inserted = await req.dbTx(async (client) => {
      const m = await client.query(
        `INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, req.user.id, type, content, meta, replyTo]
      );
      // Update chat's last_message pointers (denormalized for chat list sort)
      await client.query(
        `UPDATE chats SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
        [m.rows[0].id, m.rows[0].created_at, req.params.id]
      );
      return m.rows[0];
    });

    const msg = publicMessage(inserted);
    broadcastNewMessage(req.params.id, msg);
    res.json(msg);

    // Fire-and-forget push to other members' devices. Doesn't block
    // the response. Failures are logged but don't surface to the sender.
    sendChatMessagePush(req.params.id, req.user.id, msg, mem.chat_type).catch(err => {
      console.error('[push hook]', err.message);
    });
  } catch (err) {
    console.error('[messages POST]', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /chats/:id/messages?before=:id&limit=50 — keyset paginated history (newest first)
router.get('/:id/messages', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member of this chat' });

    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const limit  = Math.min(parseInt(req.query.limit || DEFAULT_PAGE, 10), MAX_PAGE);

    const params = [req.params.id];
    let where = `chat_id = $1`;
    if (before && Number.isFinite(before)) {
      params.push(before);
      where += ` AND id < $${params.length}`;
    }
    params.push(limit);
    const r = await req.dbQuery(
      `SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    res.json(r.rows.map(publicMessage));
  } catch (err) {
    console.error('[messages GET]', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// PATCH /chats/:id/messages/:msgId — edit content (sender, within EDIT_WINDOW_MS)
router.patch('/:id/messages/:msgId', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const content = req.body?.content;
    if (typeof content !== 'string' || !content) return res.status(400).json({ error: 'content required' });

    const r = await req.dbQuery(
      `UPDATE messages
       SET content = $1, edited_at = NOW()
       WHERE id = $2 AND chat_id = $3 AND sender_id = $4 AND deleted_at IS NULL
         AND created_at > NOW() - INTERVAL '${EDIT_WINDOW_MS} milliseconds'
       RETURNING *`,
      [content, req.params.msgId, req.params.id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Message not found, not yours, or edit window expired' });

    const msg = publicMessage(r.rows[0]);
    broadcastChatEvent(req.params.id, 'message_edited', { id: msg.id, content: msg.content, editedAt: msg.editedAt });
    res.json(msg);
  } catch (err) {
    console.error('[messages PATCH]', err.message);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE /chats/:id/messages/:msgId — soft delete (sender; clears content)
router.delete('/:id/messages/:msgId', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const r = await req.dbQuery(
      `UPDATE messages
       SET deleted_at = NOW(), content = NULL, meta = NULL, type = 'system'
       WHERE id = $1 AND chat_id = $2 AND sender_id = $3 AND deleted_at IS NULL
       RETURNING id, chat_id, deleted_at`,
      [req.params.msgId, req.params.id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Message not found or not yours' });

    broadcastChatEvent(req.params.id, 'message_deleted', { id: r.rows[0].id, deletedAt: r.rows[0].deleted_at });
    res.json({ id: r.rows[0].id, deletedAt: r.rows[0].deleted_at });
  } catch (err) {
    console.error('[messages DELETE]', err.message);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// POST /chats/:id/delivered — update per-user delivery pointer
// Fired by the recipient client as soon as a new_message socket event
// arrives (whether or not the chat is open). Broadcasts back so the
// sender's UI can flip the bubble from "sent" (single tick) to
// "delivered" (double tick).
router.post('/:id/delivered', async (req, res) => {
  try {
    const lastDeliveredMessageId = req.body?.lastDeliveredMessageId
      ? parseInt(req.body.lastDeliveredMessageId, 10) : null;
    if (!lastDeliveredMessageId || !Number.isFinite(lastDeliveredMessageId)) {
      return res.status(400).json({ error: 'lastDeliveredMessageId required' });
    }
    const r = await req.dbQuery(
      `UPDATE chat_members
       SET last_delivered_message_id = $1
       WHERE chat_id = $2 AND user_id = $3
         AND (last_delivered_message_id IS NULL OR last_delivered_message_id < $1)
       RETURNING last_delivered_message_id`,
      [lastDeliveredMessageId, req.params.id, req.user.id]
    );
    if (r.rows[0]) {
      broadcastChatEvent(req.params.id, 'message_delivered', {
        userId: req.user.id,
        lastDeliveredMessageId: r.rows[0].last_delivered_message_id,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[delivered POST]', err.message);
    res.status(500).json({ error: 'Failed to mark delivered' });
  }
});

// POST /chats/:id/read — update read pointer
router.post('/:id/read', async (req, res) => {
  try {
    const lastReadMessageId = req.body?.lastReadMessageId
      ? parseInt(req.body.lastReadMessageId, 10) : null;
    if (!lastReadMessageId || !Number.isFinite(lastReadMessageId)) {
      return res.status(400).json({ error: 'lastReadMessageId required' });
    }
    // Only advance forward; don't accept a regression.
    const r = await req.dbQuery(
      `UPDATE chat_members
       SET last_read_message_id = $1
       WHERE chat_id = $2 AND user_id = $3
         AND (last_read_message_id IS NULL OR last_read_message_id < $1)
       RETURNING last_read_message_id`,
      [lastReadMessageId, req.params.id, req.user.id]
    );
    if (r.rows[0]) {
      broadcastChatEvent(req.params.id, 'message_read', {
        userId: req.user.id,
        lastReadMessageId: r.rows[0].last_read_message_id,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[read POST]', err.message);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// POST /chats/:id/members — add (group admin/owner only)
router.post('/:id/members', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Only group chats support add' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });

    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(x => typeof x === 'string') : [];
    if (!ids.length) return res.status(400).json({ error: 'userIds required' });

    const sizeR = await req.dbQuery(
      `SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
      [req.params.id]
    );
    if (sizeR.rows[0].n + ids.length > MAX_GROUP_SIZE) {
      return res.status(400).json({ error: `Group would exceed cap of ${MAX_GROUP_SIZE}` });
    }

    for (const uid of ids) {
      await req.dbQuery(
        `INSERT INTO chat_members (chat_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
        [req.params.id, uid]
      );
    }
    broadcastChatEvent(req.params.id, 'members_added', { added: ids, by: req.user.id });
    res.json({ added: ids });
  } catch (err) {
    console.error('[members POST]', err.message);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// PATCH /chats/:id  { name?, photoURL? }  — group rename / re-photo (Day 14)
// Admin/owner only. Direct chats can't be renamed.
router.patch('/:id', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Only group chats can be edited' });
    if (mem.role !== 'admin' && mem.role !== 'owner') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const b = req.body || {};
    const sets = [];
    const params = [req.params.id];
    if (typeof b.name === 'string') {
      const n = b.name.trim().slice(0, 100);
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(n);
      sets.push(`name = $${params.length}`);
    }
    if (typeof b.photoURL === 'string') {
      const p = b.photoURL.trim().slice(0, 1024);
      params.push(p || null);
      sets.push(`photo_url = $${params.length}`);
    }
    if (sets.length === 0) return res.json({ ok: true, noop: true });
    await req.dbQuery(`UPDATE chats SET ${sets.join(', ')} WHERE id = $1`, params);
    broadcastChatEvent(req.params.id, 'chat_updated', {
      chatId: req.params.id, name: b.name, photoURL: b.photoURL,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[chats PATCH]', err.message);
    res.status(500).json({ error: 'Failed to update chat' });
  }
});

// POST /chats/:id/mute  { muted: boolean }  — per-user toggle (Day 11)
router.post('/:id/mute', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const muted = !!req.body?.muted;
    await req.dbQuery(
      `UPDATE chat_members SET muted = $1
        WHERE chat_id = $2 AND user_id = $3`,
      [muted, req.params.id, req.user.id]
    );
    res.json({ ok: true, muted });
  } catch (err) {
    console.error('[chats mute]', err.message);
    res.status(500).json({ error: 'Failed to update mute' });
  }
});

// DELETE /chats/:id/members/:userId — remove (admin) or leave (self)
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const target = req.params.userId;
    const isSelf = target === req.user.id;
    if (!isSelf && mem.role !== 'admin' && mem.role !== 'owner') {
      return res.status(403).json({ error: 'Admin only' });
    }

    await req.dbQuery(
      `UPDATE chat_members SET left_at = NOW()
       WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [req.params.id, target]
    );
    broadcastChatEvent(req.params.id, isSelf ? 'member_left' : 'member_removed', {
      userId: target, by: req.user.id,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[members DELETE]', err.message);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// ─── Search (Day 13) ──────────────────────────────────────────────
//
// GET /chats/search?q=...&limit=20
//   - matches chat names + message content + member names
//   - groups by chat, returns most-recent match per chat first
//   - membership-scoped (RLS enforces this; we also guard via JOIN)
//
// TEMPORARY: works because Phase 3a stores content as plaintext. When
// Phase 3b ships real E2EE this endpoint will return only chat-name and
// member-name hits; message content search will need to move client-side.
// ─── Reactions (Day 8) ─────────────────────────────────────────────
// One row per (message, user, emoji). Toggling the same emoji removes it;
// stacking different emojis is allowed.
//
// PUT    /chats/:id/messages/:msgId/reactions   { emoji }  → upsert (toggle on)
// DELETE /chats/:id/messages/:msgId/reactions   { emoji }  → remove
// GET    /chats/:id/messages/:msgId/reactions             → list reactors
// GET    /chats/:id/reactions?messageIds=1,2,3            → bulk counts

const MAX_EMOJI_BYTES = 16;

router.put('/:id/messages/:msgId/reactions', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const emoji = (req.body?.emoji || '').toString();
    if (!emoji || emoji.length === 0 || Buffer.byteLength(emoji, 'utf8') > MAX_EMOJI_BYTES) {
      return res.status(400).json({ error: 'emoji required (1–16 bytes)' });
    }
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isFinite(msgId)) return res.status(400).json({ error: 'invalid msgId' });

    // Verify the message belongs to this chat (RLS will also enforce, but
    // a 404 is friendlier than a 500 from a write that filters nothing).
    const mr = await req.dbQuery(
      `SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2`,
      [msgId, req.params.id]
    );
    if (mr.rowCount === 0) return res.status(404).json({ error: 'Message not found' });

    await req.dbQuery(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      [msgId, req.user.id, emoji]
    );
    broadcastChatEvent(req.params.id, 'reaction_added', {
      chatId: req.params.id, messageId: msgId, userId: req.user.id, emoji,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[reactions PUT]', err.message);
    res.status(500).json({ error: 'Failed to react' });
  }
});

router.delete('/:id/messages/:msgId/reactions', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const emoji = (req.body?.emoji || req.query?.emoji || '').toString();
    if (!emoji) return res.status(400).json({ error: 'emoji required' });

    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isFinite(msgId)) return res.status(400).json({ error: 'invalid msgId' });

    await req.dbQuery(
      `DELETE FROM message_reactions
        WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [msgId, req.user.id, emoji]
    );
    broadcastChatEvent(req.params.id, 'reaction_removed', {
      chatId: req.params.id, messageId: msgId, userId: req.user.id, emoji,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[reactions DELETE]', err.message);
    res.status(500).json({ error: 'Failed to un-react' });
  }
});

// GET reactors for a single message (used by the long-press details sheet)
router.get('/:id/messages/:msgId/reactions', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isFinite(msgId)) return res.status(400).json({ error: 'invalid msgId' });

    const r = await req.dbQuery(
      `SELECT mr.emoji, mr.user_id, u.name, u.email
         FROM message_reactions mr
         JOIN users u ON u.id = mr.user_id
        WHERE mr.message_id = $1
        ORDER BY mr.created_at ASC`,
      [msgId]
    );
    res.json(r.rows.map(row => ({
      emoji:  row.emoji,
      userId: row.user_id,
      name:   row.name,
      email:  row.email,
    })));
  } catch (err) {
    console.error('[reactions GET]', err.message);
    res.status(500).json({ error: 'Failed to load reactions' });
  }
});

// GET bulk reaction counts for a list of message ids — used after loading
// a message page to hydrate the bubbles with their reaction state in a
// single round-trip.
router.get('/:id/reactions', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const ids = String(req.query.messageIds || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n))
      .slice(0, 500);
    if (ids.length === 0) return res.json({});

    const r = await req.dbQuery(
      `SELECT mr.message_id, mr.emoji, mr.user_id
         FROM message_reactions mr
         JOIN messages m ON m.id = mr.message_id
        WHERE m.chat_id = $1 AND mr.message_id = ANY($2::bigint[])`,
      [req.params.id, ids]
    );
    // Shape: { messageId: [{emoji, count, mine}] }
    const byMsg = Object.create(null);
    for (const row of r.rows) {
      const k = String(row.message_id);
      if (!byMsg[k]) byMsg[k] = {};
      if (!byMsg[k][row.emoji]) byMsg[k][row.emoji] = { count: 0, mine: false };
      byMsg[k][row.emoji].count += 1;
      if (row.user_id === req.user.id) byMsg[k][row.emoji].mine = true;
    }
    // Flatten emoji map → array per message
    const out = {};
    for (const [k, m] of Object.entries(byMsg)) {
      out[k] = Object.entries(m).map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine }));
    }
    res.json(out);
  } catch (err) {
    console.error('[reactions GET bulk]', err.message);
    res.status(500).json({ error: 'Failed to load reactions' });
  }
});

module.exports = router;
module.exports.setBroadcasters = setBroadcasters;
