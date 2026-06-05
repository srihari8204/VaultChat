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
    expiresAt: row.expires_at ?? null,
    vanishAfterRead: !!row.vanish_after_read,
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
    // ?includeHidden=1 from the hidden-chats screen returns hidden rows
    // ONLY. Default behaviour excludes them so the main chat list stays
    // clean. (We don't union both because the user has already crossed
    // the PIN gate to see hidden ones, and showing them mixed in would
    // defeat the point.)
    const wantHidden = req.query?.includeHidden === '1' || req.query?.includeHidden === 'true';

    // For direct chats, also fetch the other member's name + photo so the
    // chat list can render avatars without one round-trip per row. Done
    // via a LATERAL subquery to keep this single-pass.
    const r = await req.dbQuery(
      `SELECT
         c.id, c.type, c.name, c.photo_url, c.created_by, c.created_at,
         c.last_message_id, c.last_message_at, c.updated_at,
         cm.role, cm.last_read_message_id, cm.muted, cm.joined_at,
         cm.pinned, cm.pinned_at, cm.archived, cm.hidden,
         cm.screenshot_mode, cm.vanish_mode,
         peer.user_id   AS peer_user_id,
         peer.peer_name AS peer_name,
         peer.peer_photo AS peer_photo,
         peer.peer_online AS peer_online,
         peer.peer_last_seen AS peer_last_seen,
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
                -- Last-seen visibility: global toggle AND no ghost-mode
                -- override from the peer toward me.
                CASE
                  WHEN u.last_seen_visible
                   AND NOT COALESCE((
                     SELECT g.hide_last_seen FROM ghost_mode g
                      WHERE g.owner_id = u.id AND g.target_id = $1
                   ), FALSE)
                  THEN u.last_seen_at
                  ELSE NULL
                END AS peer_last_seen
           FROM chat_members cm2
           JOIN users u ON u.id = cm2.user_id
          WHERE cm2.chat_id = c.id
            AND cm2.user_id <> $1
            AND cm2.left_at IS NULL
            AND c.type = 'direct'
          LIMIT 1
       ) peer ON TRUE
       WHERE cm.left_at IS NULL
         AND cm.hidden = $2
       ORDER BY cm.pinned DESC,
                cm.pinned_at DESC NULLS LAST,
                COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT 200`,
      [req.user.id, wantHidden]
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
      pinned:          !!row.pinned,
      archived:        !!row.archived,
      hidden:          !!row.hidden,
      screenshotMode:  row.screenshot_mode ?? 'block',
      vanishMode:      !!row.vanish_mode,
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
      id:                   chat.id,
      type:                 chat.type,
      name:                 chat.name,
      photoURL:             chat.photo_url,
      createdBy:            chat.created_by,
      createdAt:            chat.created_at,
      updatedAt:            chat.updated_at,
      lastMessageId:        chat.last_message_id,
      lastMessageAt:        chat.last_message_at,
      disappearingSeconds:  chat.disappearing_seconds ?? null,
      members:              membersR.rows.map(publicMember),
      myRole:               mem.role,
      myLastReadId:         mem.last_read_message_id,
      hidden:               !!mem.hidden,
      screenshotMode:       mem.screenshot_mode ?? 'block',
      vanishMode:           !!mem.vanish_mode,
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

    if (!['text','image','video','audio','file','location','system','sticker','poll'].includes(type)) {
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
    } else if (type === 'sticker') {
      // Sticker messages carry the emoji/asset id in `content`. Cap length
      // so a stray "sticker" isn't a 1 MB blob.
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content (sticker id) required' });
      }
      if (content.length > 64) {
        return res.status(400).json({ error: 'sticker id too long' });
      }
    } else if (type === 'poll') {
      // content = the poll question; meta.options = string[] of 2..10
      // choice labels. meta.allowMultiple optional (default single-vote).
      // Votes live in poll_votes keyed by (message_id, user_id, option_index).
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content (poll question) required' });
      }
      if (content.length > 200) {
        return res.status(400).json({ error: 'poll question too long (max 200)' });
      }
      const opts = meta?.options;
      if (!Array.isArray(opts) || opts.length < 2 || opts.length > 10) {
        return res.status(400).json({ error: 'meta.options must be an array of 2-10 strings' });
      }
      for (const o of opts) {
        if (typeof o !== 'string' || o.length === 0 || o.length > 100) {
          return res.status(400).json({ error: 'each option must be a non-empty string ≤ 100 chars' });
        }
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
      // Look up the chat's disappearing-messages timer + sender's vanish
      // mode and stamp both on the new row. Single statement to keep
      // the round-trip count flat.
      const m = await client.query(
        `INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id, expires_at, vanish_after_read)
         SELECT $1, $2, $3, $4, $5, $6,
                CASE WHEN c.disappearing_seconds IS NOT NULL
                     THEN NOW() + (c.disappearing_seconds || ' seconds')::INTERVAL
                     ELSE NULL END,
                COALESCE(cm.vanish_mode, FALSE)
           FROM chats c
           LEFT JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
          WHERE c.id = $1
         RETURNING *`,
        [req.params.id, req.user.id, type, content, meta, replyTo]
      );
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
    // Filter expired ephemeral messages on the lazy path (cleanup loop
    // hard-deletes them every 5 min; this catches the gap).
    let where = `chat_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`;
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

      // Vanish-Mode trigger: any vanish_after_read messages in this chat
      // that have NO non-sender members lagging behind get expires_at =
      // NOW(). The existing 5-minute sweep loop hard-deletes them on its
      // next pass; the lazy filter in GET /messages hides them in the
      // meantime so the now-fully-read recipient stops seeing them too.
      //
      // The NOT EXISTS subquery is the load-bearing clause: "no non-sender
      // active member has last_read_message_id less than this message id".
      await req.dbQuery(
        `UPDATE messages m SET expires_at = NOW()
          WHERE m.chat_id = $1
            AND m.vanish_after_read = TRUE
            AND m.expires_at IS NULL
            AND m.id <= $2
            AND NOT EXISTS (
              SELECT 1 FROM chat_members cm2
               WHERE cm2.chat_id = m.chat_id
                 AND cm2.user_id <> m.sender_id
                 AND cm2.left_at IS NULL
                 AND COALESCE(cm2.last_read_message_id, 0) < m.id
            )`,
        [req.params.id, lastReadMessageId]
      );
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

// PATCH /chats/:id  { name?, photoURL?, disappearingSeconds? }
// name / photoURL: group-admin only. disappearingSeconds: any member.
// Direct chats may only set disappearingSeconds.
router.patch('/:id', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });

    const b = req.body || {};
    const isAdmin = mem.role === 'admin' || mem.role === 'owner';
    const sets = [];
    const params = [req.params.id];

    // Group-admin-only fields
    if (typeof b.name === 'string') {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Direct chats cannot be renamed' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const n = b.name.trim().slice(0, 100);
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(n);
      sets.push(`name = $${params.length}`);
    }
    if (typeof b.photoURL === 'string') {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Direct chats use peer photo' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const p = b.photoURL.trim().slice(0, 1024);
      params.push(p || null);
      sets.push(`photo_url = $${params.length}`);
    }

    // Disappearing-messages timer: any member can set/clear it. Null/0
    // turns it off; otherwise must be a positive integer (seconds).
    if (b.disappearingSeconds !== undefined) {
      let s = b.disappearingSeconds;
      if (s === null || s === 0) {
        params.push(null);
      } else if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
        return res.status(400).json({ error: 'disappearingSeconds must be a non-negative number or null' });
      } else {
        // Cap at 1 year so a typo doesn't create permanent "ephemeral" messages
        params.push(Math.min(Math.round(s), 365 * 24 * 60 * 60));
      }
      sets.push(`disappearing_seconds = $${params.length}`);
    }

    if (sets.length === 0) return res.json({ ok: true, noop: true });
    await req.dbQuery(`UPDATE chats SET ${sets.join(', ')} WHERE id = $1`, params);
    broadcastChatEvent(req.params.id, 'chat_updated', {
      chatId: req.params.id,
      name: b.name,
      photoURL: b.photoURL,
      disappearingSeconds: b.disappearingSeconds,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[chats PATCH]', err.message);
    res.status(500).json({ error: 'Failed to update chat' });
  }
});

// POST /chats/:id/pin     { pinned: boolean }    — per-user pin (P1 polish)
router.post('/:id/pin', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const pinned = !!req.body?.pinned;
    await req.dbQuery(
      `UPDATE chat_members
          SET pinned = $1,
              pinned_at = CASE WHEN $1 THEN NOW() ELSE NULL END
        WHERE chat_id = $2 AND user_id = $3`,
      [pinned, req.params.id, req.user.id]
    );
    res.json({ ok: true, pinned });
  } catch (err) {
    console.error('[chats pin]', err.message);
    res.status(500).json({ error: 'Failed to pin chat' });
  }
});

// POST /chats/:id/archive { archived: boolean }  — per-user archive
router.post('/:id/archive', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const archived = !!req.body?.archived;
    await req.dbQuery(
      `UPDATE chat_members SET archived = $1
        WHERE chat_id = $2 AND user_id = $3`,
      [archived, req.params.id, req.user.id]
    );
    res.json({ ok: true, archived });
  } catch (err) {
    console.error('[chats archive]', err.message);
    res.status(500).json({ error: 'Failed to archive chat' });
  }
});

// PATCH /chats/:id/hidden  { hidden: boolean }  — per-user
//
// Hiding a chat removes it from the default GET /chats result and the
// realtime list refresh. The user can still receive messages + push;
// they reach the chat again via /hidden-chats (PIN-gated).
router.patch('/:id/hidden', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const hidden = !!req.body?.hidden;
    await req.dbQuery(
      `UPDATE chat_members SET hidden = $1 WHERE chat_id = $2 AND user_id = $3`,
      [hidden, req.params.id, req.user.id]
    );
    res.json({ ok: true, hidden });
  } catch (err) {
    console.error('[chats hidden]', err.message);
    res.status(500).json({ error: 'Failed to update hidden state' });
  }
});

// PATCH /chats/:id/screenshot-mode  { mode: 'allow'|'allow_notify'|'block'|'block_silent' }
// Per-user (each side picks their own posture).
const SCREENSHOT_MODES = ['allow', 'allow_notify', 'block', 'block_silent'];
router.patch('/:id/screenshot-mode', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const mode = (req.body?.mode || '').toString();
    if (!SCREENSHOT_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of ${SCREENSHOT_MODES.join(', ')}` });
    }
    await req.dbQuery(
      `UPDATE chat_members SET screenshot_mode = $1 WHERE chat_id = $2 AND user_id = $3`,
      [mode, req.params.id, req.user.id]
    );
    res.json({ ok: true, mode });
  } catch (err) {
    console.error('[chats screenshot-mode]', err.message);
    res.status(500).json({ error: 'Failed to update screenshot mode' });
  }
});

// POST /chats/:id/screenshot-captured  — client tells server a screenshot
// just happened; server broadcasts a 'screenshot_captured' socket event
// to other members so their UI can flash a banner. We do NOT persist this
// as a chat message (the spec's "show captured image" idea is infeasible
// — the OS doesn't expose screenshot bytes to apps).
router.post('/:id/screenshot-captured', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    broadcastChatEvent(req.params.id, 'screenshot_captured', {
      chatId:     req.params.id,
      capturedBy: req.user.id,
      capturedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[chats screenshot-captured]', err.message);
    res.status(500).json({ error: 'Failed to report screenshot' });
  }
});

// PATCH /chats/:id/vanish-mode  { enabled: boolean }
// Per-user toggle. While ON, every new message you send in this chat
// gets messages.vanish_after_read = TRUE — meaning the message is
// hard-deleted as soon as every non-sender member has read it.
router.patch('/:id/vanish-mode', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const enabled = !!req.body?.enabled;
    await req.dbQuery(
      `UPDATE chat_members SET vanish_mode = $1 WHERE chat_id = $2 AND user_id = $3`,
      [enabled, req.params.id, req.user.id]
    );
    res.json({ ok: true, enabled });
  } catch (err) {
    console.error('[chats vanish-mode]', err.message);
    res.status(500).json({ error: 'Failed to update vanish mode' });
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

// ─── Polls (in-chat voting) ────────────────────────────────────────
// Voting is a separate endpoint from message edit because the message
// itself stays immutable — votes accumulate in poll_votes and the chat
// bubble queries counts at render time (via the bulk endpoint below).
//
// POST   /chats/:id/messages/:msgId/vote    { optionIndex }       → toggle
// DELETE /chats/:id/messages/:msgId/vote/:optionIndex              → un-vote
// GET    /chats/:id/messages/:msgId/votes                          → counts
// GET    /chats/:id/poll-votes?messageIds=1,2,3                    → bulk

router.post('/:id/messages/:msgId/vote', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const msgId        = parseInt(req.params.msgId, 10);
    const optionIndex  = parseInt(req.body?.optionIndex, 10);
    if (!Number.isFinite(msgId))        return res.status(400).json({ error: 'invalid msgId' });
    if (!Number.isFinite(optionIndex) || optionIndex < 0) {
      return res.status(400).json({ error: 'optionIndex must be a non-negative integer' });
    }

    // Load the poll message to know its option count + allowMultiple flag.
    const mr = await req.dbQuery(
      `SELECT type, meta FROM messages WHERE id = $1 AND chat_id = $2 LIMIT 1`,
      [msgId, req.params.id]
    );
    const m = mr.rows[0];
    if (!m) return res.status(404).json({ error: 'Poll not found' });
    if (m.type !== 'poll') return res.status(400).json({ error: 'Not a poll message' });
    const options = Array.isArray(m.meta?.options) ? m.meta.options : [];
    if (optionIndex >= options.length) {
      return res.status(400).json({ error: 'optionIndex out of range' });
    }
    const allowMultiple = !!m.meta?.allowMultiple;

    // Single-vote polls: clear any other votes from this user before adding.
    // Multi-vote: just upsert this option (idempotent via PK).
    await req.dbQuery(
      allowMultiple
        ? `INSERT INTO poll_votes (message_id, user_id, option_index)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`
        : `WITH cleared AS (
             DELETE FROM poll_votes
              WHERE message_id = $1 AND user_id = $2 AND option_index <> $3
           )
           INSERT INTO poll_votes (message_id, user_id, option_index)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
      [msgId, req.user.id, optionIndex]
    );

    broadcastChatEvent(req.params.id, 'poll_voted', {
      chatId: req.params.id, messageId: msgId, userId: req.user.id, optionIndex,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[poll vote POST]', err.message);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

router.delete('/:id/messages/:msgId/vote/:optionIndex', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const msgId       = parseInt(req.params.msgId, 10);
    const optionIndex = parseInt(req.params.optionIndex, 10);
    if (!Number.isFinite(msgId) || !Number.isFinite(optionIndex)) {
      return res.status(400).json({ error: 'invalid id or optionIndex' });
    }
    await req.dbQuery(
      `DELETE FROM poll_votes
        WHERE message_id = $1 AND user_id = $2 AND option_index = $3`,
      [msgId, req.user.id, optionIndex]
    );
    broadcastChatEvent(req.params.id, 'poll_unvoted', {
      chatId: req.params.id, messageId: msgId, userId: req.user.id, optionIndex,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[poll vote DELETE]', err.message);
    res.status(500).json({ error: 'Failed to un-vote' });
  }
});

// Vote breakdown for a single poll: counts per option + which options
// the caller themselves voted for (for the radio/check UI state).
router.get('/:id/messages/:msgId/votes', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isFinite(msgId)) return res.status(400).json({ error: 'invalid msgId' });

    const r = await req.dbQuery(
      `SELECT option_index, user_id FROM poll_votes WHERE message_id = $1`,
      [msgId]
    );
    const counts = {};
    const mine = [];
    for (const row of r.rows) {
      const k = String(row.option_index);
      counts[k] = (counts[k] || 0) + 1;
      if (row.user_id === req.user.id) mine.push(row.option_index);
    }
    res.json({ counts, mine, total: r.rows.length });
  } catch (err) {
    console.error('[poll votes GET]', err.message);
    res.status(500).json({ error: 'Failed to load votes' });
  }
});

// Bulk variant — hydrate every visible poll in one round-trip after a
// message page load. Same shape as the reactions bulk endpoint.
router.get('/:id/poll-votes', async (req, res) => {
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
      `SELECT pv.message_id, pv.option_index, pv.user_id
         FROM poll_votes pv
         JOIN messages m ON m.id = pv.message_id
        WHERE m.chat_id = $1 AND pv.message_id = ANY($2::bigint[])`,
      [req.params.id, ids]
    );
    const out = {};
    for (const row of r.rows) {
      const k = String(row.message_id);
      if (!out[k]) out[k] = { counts: {}, mine: [], total: 0 };
      const bucket = out[k];
      const okey = String(row.option_index);
      bucket.counts[okey] = (bucket.counts[okey] || 0) + 1;
      bucket.total += 1;
      if (row.user_id === req.user.id) bucket.mine.push(row.option_index);
    }
    res.json(out);
  } catch (err) {
    console.error('[poll votes bulk]', err.message);
    res.status(500).json({ error: 'Failed to load votes' });
  }
});

module.exports = router;
module.exports.setBroadcasters = setBroadcasters;
