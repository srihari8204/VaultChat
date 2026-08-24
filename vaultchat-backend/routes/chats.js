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
const vault     = require('../lib/vault');
const { sendPushToTokens } = require('../push');
const callFcm   = require('../lib/callFcm');
const rateLimit = require('../rateLimit');

// Decrypt a peer's display name from the cipher columns (Stage 4) with a plaintext
// fallback. SQL can't decrypt, so joins select the cipher columns and we resolve
// the name here.
function peerName(row, prefix = 'peer_') {
  return vault.identityFromRow({
    name:              row[`${prefix}name`],
    first_name_cipher: row[`${prefix}fnc`],
    last_name_cipher:  row[`${prefix}lnc`],
    email_cipher:      row[`${prefix}ec`],
  }).name;
}

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
  // Peppered (F1): HMAC(pepper, sha256(digits)) — matches the stored index.
  const sha = crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
  return vault.discoveryHash(sha);
}

const router = express.Router();
router.use(jwtUtil.requireAuth);

// GET /chats/delta?since=<globalMsgId>&limit= — forward catch-up across ALL of
// the caller's chats. messages.id is a global BIGSERIAL, so one ordered scan past
// the client's cursor delivers everything missed while offline — including chats
// the client never knew existed (closes the offline first-contact gap). Defined
// before /:id so "delta" isn't parsed as a chat id.
// ponytail: id-cursor + a small client-side lookback absorbs the bigserial
// commit-order window; a truly gapless watermark would need a commit-ordered
// per-chat seq — unnecessary at this scale.
router.get('/delta', async (req, res) => {
  try {
    const since = Math.max(0, parseInt(req.query.since || '0', 10) || 0);
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
    const r = await db.query(
      `SELECT m.* FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1 AND cm.left_at IS NULL
        WHERE m.id > $2 AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ORDER BY m.id ASC LIMIT $3`,
      [req.user.id, since, limit]);
    const nextSince = r.rows.length ? Number(r.rows[r.rows.length - 1].id) : since;

    // Mutations: edits/deletes touch an EXISTING row in place (same id, no new
    // id), so the id-cursor above misses any that happened while the client was
    // offline. When the client passes its last-seen mutation timestamp, also
    // return old messages (id ≤ since) whose edited_at/deleted_at moved past it.
    // serverTime becomes the client's next mutatedSince cursor.
    const serverTime = (await db.query('SELECT NOW() AS now')).rows[0].now;
    let mutations = [];
    const mutatedSince = req.query.mutatedSince ? new Date(req.query.mutatedSince) : null;
    if (mutatedSince && !isNaN(mutatedSince.getTime())) {
      const mut = await db.query(
        `SELECT m.* FROM messages m
           JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1 AND cm.left_at IS NULL
          WHERE (m.edited_at > $2 OR m.deleted_at > $2) AND m.id <= $3
          ORDER BY GREATEST(COALESCE(m.edited_at, 'epoch'), COALESCE(m.deleted_at, 'epoch')) ASC
          LIMIT 500`,
        [req.user.id, mutatedSince, since]);
      mutations = mut.rows.map(publicMessage);
    }

    res.json({ messages: r.rows.map(publicMessage), nextSince, more: r.rows.length === limit, mutations, serverTime });
  } catch (e) { console.error('[chats/delta]', e.message); res.status(500).json({ error: 'delta failed' }); }
});

const EDIT_WINDOW_MS  = 15 * 60 * 1000;
// Delete-for-everyone window (WhatsApp parity: 2 days 12 hours). Server is the
// authority; the client hides the option past this as a UX hint only.
const REVOKE_WINDOW_MS = 60 * 60 * 60 * 1000;
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
    // Joined-from-users fields (only present when we LEFT JOIN users) — Stage 4:
    // decrypt cipher columns when present, else fall back to legacy plaintext.
    email:                   vault.identityFromRow(row).email,
    name:                    vault.identityFromRow(row).name,
    photoURL:                row.photo_url,
    online:                  row.online ?? false,
    lastSeenAt,
    status:                  row.status ?? null,   // "About" text (WhatsApp)
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
    `SELECT cm.*, c.type AS chat_type, c.send_policy, c.slow_mode_seconds,
            c.media_policy, c.add_members_policy, c.anti_spam_links, c.approve_members
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
    // Silent send (W15): the sender chose not to ring anyone for this message.
    if (msg.meta && msg.meta.silent) return;
    // Recipients = chat members minus the sender; not blocking the sender; and
    // not muting the chat — EXCEPT @mentioned members, who are notified even when
    // muted (W15).
    const mentionedIds = Array.isArray(msg.meta?.mentions)
      ? msg.meta.mentions.map(m => m && m.userId).filter(Boolean)
      : [];
    const memR = await db.query(
      `SELECT cm.user_id FROM chat_members cm
        WHERE cm.chat_id = $1
          AND cm.user_id <> $2
          AND cm.left_at IS NULL
          AND (cm.muted = FALSE OR cm.user_id = ANY($3::uuid[]))
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
             WHERE ub.blocker_id = cm.user_id AND ub.blocked_id = $2
          )`,
      [chatId, senderId, mentionedIds]
    );
    if (memR.rows.length === 0) return;
    const recipientIds = memR.rows.map(r => r.user_id);

    // Pull each recipient's tokens alongside their per-chat notification sound
    // (the Android channelId) so everyone hears the sound they picked.
    const tokR = await db.query(
      `SELECT d.push_token, d.fcm_token, cm.notif_sound
         FROM devices d
         JOIN chat_members cm ON cm.user_id = d.user_id AND cm.chat_id = $2
        WHERE d.user_id = ANY($1::uuid[]) AND cm.left_at IS NULL`,
      [recipientIds, chatId]
    );
    if (tokR.rows.length === 0) return;

    // ── Content-free doorbell (F2, WhatsApp model) ────────────────────
    // NOTHING readable rides in any push: no sender name, no group name, no
    // message type, no body, no message id. Two transports:
    //   • Devices WITH a native fcm_token (new builds): DATA-ONLY high-priority
    //     FCM { type:'message', chatId, channelId }. The native service renders
    //     the notification LOCALLY — the sender/chat name comes from the
    //     on-device chat directory, so it never transits Google/Expo.
    //   • Devices WITHOUT one (old builds / iOS): the legacy Expo push, but
    //     with a generic title/body — they lose the rich name until upgrade,
    //     the leak is closed for them regardless.
    const fcmByChannel  = new Map();   // channelId -> Set<fcm_token>
    const expoByChannel = new Map();   // channelId -> tokens[]
    for (const row of tokR.rows) {
      const ch = row.notif_sound || 'default';
      if (row.fcm_token) {
        if (!fcmByChannel.has(ch)) fcmByChannel.set(ch, new Set());
        fcmByChannel.get(ch).add(row.fcm_token);
      } else if (row.push_token) {
        if (!expoByChannel.has(ch)) expoByChannel.set(ch, []);
        expoByChannel.get(ch).push(row.push_token);
      }
    }
    for (const [channelId, tokens] of fcmByChannel) {
      const r = await callFcm.sendCallMessage(
        Array.from(tokens),
        { type: 'message', chatId, channelId },
        60_000,
      );
      if (r.dead && r.dead.length) {
        db.query(`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, [r.dead])
          .catch(() => {});
      }
    }
    const data = { chatId, type: 'message' };
    for (const [channelId, tokens] of expoByChannel) {
      await sendPushToTokens(tokens, { title: 'VaultChat', body: 'New message', data, channelId });
    }
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
         peer.peer_fnc  AS peer_fnc,
         peer.peer_lnc  AS peer_lnc,
         peer.peer_ec   AS peer_ec,
         peer.peer_photo AS peer_photo,
         peer.peer_online AS peer_online,
         peer.peer_last_seen AS peer_last_seen,
         peer.peer_last_read AS peer_last_read,
         peer.peer_last_delivered AS peer_last_delivered,
         cm.unread_count AS unread_count
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
       LEFT JOIN LATERAL (
         SELECT u.id AS user_id,
                u.name AS peer_name,
                u.first_name_cipher AS peer_fnc,
                u.last_name_cipher  AS peer_lnc,
                u.email_cipher      AS peer_ec,
                u.photo_url AS peer_photo,
                u.online   AS peer_online,
                -- Read-receipt reciprocity: expose the peer's read pointer only
                -- when BOTH sides keep read receipts ON (u = peer, $1 = me).
                -- Delivered pointer is never gated (grey tick always shows).
                CASE WHEN u.read_receipts
                      AND (SELECT read_receipts FROM users WHERE id = $1)
                     THEN cm2.last_read_message_id ELSE NULL END AS peer_last_read,
                cm2.last_delivered_message_id AS peer_last_delivered,
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
      peerName:        row.peer_user_id ? peerName(row) : null,
      peerPhotoURL:    row.peer_photo   ?? null,
      peerOnline:      row.peer_online  ?? false,
      peerLastSeenAt:  row.peer_last_seen ?? null,
      peerLastReadMessageId:      row.peer_last_read != null ? Number(row.peer_last_read) : null,
      peerLastDeliveredMessageId: row.peer_last_delivered != null ? Number(row.peer_last_delivered) : null,
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

      // Apply the creator's default disappearing-messages timer (WhatsApp) to
      // chats they start.
      const ddR = await req.dbQuery(`SELECT default_disappearing_seconds FROM users WHERE id = $1`, [req.user.id]);
      const defDis = ddR.rows[0]?.default_disappearing_seconds || 0;

      const chat = await req.dbTx(async (client) => {
        const ins = await client.query(
          `INSERT INTO chats (type, created_by, disappearing_seconds) VALUES ('direct', $1, $2) RETURNING *`,
          [req.user.id, defDis > 0 ? defDis : null]
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

      // A Family Circle is created solo and filled via invite links, so it may
      // start with no other members. Normal group creation still requires one.
      if (resolvedIds.length === 0 && b.allowEmpty !== true) {
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

// ─── Invite links ──────────────────────────────────────────────────
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function genInviteCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return s;
}
function publicInvite(row) {
  return {
    id:        row.id,
    code:      row.code,
    chatId:    row.chat_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses:   row.max_uses,
    uses:      row.uses,
    revoked:   row.revoked,
  };
}

// POST /chats/join/:code — redeem an invite link and join the group.
// Declared above GET /:id so 'join' is never mistaken for a chat id.
router.post('/join/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code required' });

    // Peek the link + chat to decide auto-join vs. approval request.
    const lr = await db.query(
      `SELECT il.chat_id, il.revoked, il.expires_at, il.max_uses, il.uses, c.approve_members
         FROM invite_links il JOIN chats c ON c.id = il.chat_id
        WHERE il.code = $1 LIMIT 1`,
      [code]
    );
    const link = lr.rows[0];
    if (!link || link.revoked) return res.status(410).json({ error: 'Invalid or revoked link' });
    if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link has expired' });
    if (link.max_uses > 0 && link.uses >= link.max_uses) return res.status(410).json({ error: 'Link has reached its use limit' });

    const already = await db.query(
      `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [link.chat_id, req.user.id]
    );
    if (already.rows[0]) return res.json({ chatId: link.chat_id, alreadyMember: true });

    // Approval required → queue a join request instead of joining.
    if (link.approve_members) {
      await db.query(
        `INSERT INTO chat_join_requests (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [link.chat_id, req.user.id]
      );
      broadcastChatEvent(link.chat_id, 'join_requested', { userId: req.user.id });
      return res.json({ chatId: link.chat_id, pending: true });
    }

    // Auto-join via the SECURITY DEFINER helper (atomic uses++ + membership).
    const r = await db.query(`SELECT chat_id, status FROM vc_redeem_invite($1, $2)`, [code, req.user.id]);
    const row = r.rows[0];
    if (!row || row.status !== 'ok') {
      const map = { invalid: 'Invalid or revoked link', expired: 'Link has expired', used: 'Link has reached its use limit' };
      return res.status(410).json({ error: map[row?.status] || 'Invalid link' });
    }
    broadcastChatEvent(row.chat_id, 'members_added', { added: [req.user.id], by: req.user.id });
    res.json({ chatId: row.chat_id });
  } catch (err) {
    console.error('[chats join]', err.message);
    res.status(500).json({ error: 'Failed to join via link' });
  }
});

// ─── Join requests (approve-members groups) ─────────────────────────
// GET /chats/:id/join-requests — admin lists pending requests
router.get('/:id/join-requests', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });
    const r = await db.query(
      `SELECT jr.user_id, jr.created_at, u.name, u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.photo_url
         FROM chat_join_requests jr JOIN users u ON u.id = jr.user_id
        WHERE jr.chat_id = $1 ORDER BY jr.created_at`,
      [req.params.id]
    );
    res.json(r.rows.map(row => ({
      userId: row.user_id, name: vault.identityFromRow(row).name, photoURL: row.photo_url, requestedAt: row.created_at,
    })));
  } catch (err) {
    console.error('[join-requests GET]', err.message);
    res.status(500).json({ error: 'Failed to load join requests' });
  }
});

// POST /chats/:id/join-requests/:userId/approve — admin approves
router.post('/:id/join-requests/:userId/approve', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });
    const target = req.params.userId;
    const jr = await db.query(
      `SELECT 1 FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2`, [req.params.id, target]
    );
    if (!jr.rows[0]) return res.status(404).json({ error: 'Request not found' });
    // Admin context → RLS allows the membership insert.
    await req.dbQuery(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
      [req.params.id, target]
    );
    await db.query(`DELETE FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2`, [req.params.id, target]);
    broadcastChatEvent(req.params.id, 'members_added', { added: [target], by: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[join-requests approve]', err.message);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

// DELETE /chats/:id/join-requests/:userId — admin rejects
router.delete('/:id/join-requests/:userId', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });
    await db.query(
      `DELETE FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[join-requests reject]', err.message);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// ─── Search (Day 13) ──────────────────────────────────────────────
// GET /chats/search?q=...&limit=20
//   - matches chat names + message content + member names
//   - membership-scoped: only chats this user is a member of
//
// MUST stay above GET /:id so Express doesn't treat 'search' as a chat id.
//
// ZERO-KNOWLEDGE: message *content* is NOT searched server-side (the server
// only holds ciphertext under real E2EE). This returns chat + member-name
// matches only; message-content search runs on-device (lib/chatService
// .searchInChat over the local store).
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

    res.json({
      chats: chatsR.rows.map(r => ({
        id:            r.id,
        type:          r.type,
        name:          r.name,
        photoURL:      r.photo_url,
        lastMessageAt: r.last_message_at,
      })),
      // Message-content search is on-device (zero-knowledge) — the server never
      // reads message bodies. searchInChat decrypts + matches the local store.
      messages: [],
    });
  } catch (err) {
    console.error('[chats search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /chats/common/:userId — groups that both the caller and :userId are in
// (WhatsApp "groups in common"). Declared above GET /:id so 'common' isn't a chat id.
router.get('/common/:userId', async (req, res) => {
  try {
    const peer = req.params.userId;
    const r = await req.dbQuery(
      `SELECT c.id, c.name, c.photo_url
         FROM chats c
         JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1 AND a.left_at IS NULL
         JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2 AND b.left_at IS NULL
        WHERE c.type = 'group'
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 50`,
      [req.user.id, peer]
    );
    res.json({ groups: r.rows.map(g => ({ id: g.id, name: g.name, photoURL: g.photo_url })) });
  } catch (err) {
    console.error('[chats common]', err.message);
    res.status(500).json({ error: 'Failed' });
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
      `SELECT cm.*, u.email, u.name, u.first_name_cipher, u.last_name_cipher, u.email_cipher,
              u.photo_url, u.online, u.last_seen_at, u.last_seen_visible, u.status, u.read_receipts
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1
       ORDER BY cm.joined_at`,
      [req.params.id]
    );

    // Read-receipt reciprocity: in a DIRECT chat, only expose a peer's read
    // pointer when EVERY active participant keeps read receipts ON. Groups are
    // exempt. My own pointer and everyone's delivered pointer are untouched —
    // only the peer's blue-tick (read) pointer is hidden (matches WhatsApp).
    const receiptsMutual =
      chat.type !== 'direct' ||
      membersR.rows.every(m => m.left_at != null || m.read_receipts !== false);
    const members = membersR.rows.map(publicMember).map(m =>
      (!receiptsMutual && m.userId !== req.user.id)
        ? { ...m, lastReadMessageId: null }
        : m
    );

    res.json({
      id:                   chat.id,
      type:                 chat.type,
      name:                 chat.name,
      description:          chat.description ?? null,
      photoURL:             chat.photo_url,
      createdBy:            chat.created_by,
      createdAt:            chat.created_at,
      updatedAt:            chat.updated_at,
      lastMessageId:        chat.last_message_id,
      lastMessageAt:        chat.last_message_at,
      pinnedMessageId:      chat.pinned_message_id != null ? String(chat.pinned_message_id) : null,
      disappearingSeconds:  chat.disappearing_seconds ?? null,
      slowModeSeconds:      chat.slow_mode_seconds ?? 0,
      sendPolicy:           chat.send_policy ?? 'everyone',
      mediaPolicy:          chat.media_policy ?? 'everyone',
      addMembersPolicy:     chat.add_members_policy ?? 'admins',
      antiSpamLinks:        !!chat.anti_spam_links,
      approveMembers:       !!chat.approve_members,
      members:              members,
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
    // Per-sender ceiling on the highest-volume write in the product. Set well
    // above anything a person can type — this is not a UX throttle, it is the
    // stop on a compromised or scripted account fanning out to every chat it can
    // reach, which costs a push notification and a row per message.
    //
    // Deliberately keyed on the USER, not the chat: a per-chat key would let one
    // account spray N chats at the limit each. Not keyed on IP either — a
    // college or office NAT would share one bucket.
    const rl = await rateLimit.consume(`msg:${req.user.id}`, 600, 60); // 600/min
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Sending too fast. Try again shortly.', retryAfter: rl.resetInSec });
    }

    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member of this chat' });

    // Group admin controls — enforced for non-admins only.
    const memberIsAdmin = mem.role === 'admin' || mem.role === 'owner';
    if (!memberIsAdmin) {
      const bb = req.body || {};
      const bType = (bb.type || 'text').toString();
      const bContent = typeof bb.content === 'string' ? bb.content : '';

      if (mem.send_policy === 'admins') {
        return res.status(403).json({ error: 'Only admins can send messages in this group' });
      }
      if (mem.media_policy === 'admins' && ['image', 'video', 'file'].includes(bType)) {
        return res.status(403).json({ error: 'Only admins can send media in this group' });
      }
      if (mem.anti_spam_links) {
        const joinedMs = mem.joined_at ? new Date(mem.joined_at).getTime() : 0;
        const newish = Date.now() - joinedMs < 24 * 60 * 60 * 1000;
        if (newish && /https?:\/\//i.test(bContent)) {
          return res.status(403).json({ error: 'New members can’t post links yet (anti-spam)' });
        }
      }
      const slow = parseInt(mem.slow_mode_seconds, 10) || 0;
      if (slow > 0) {
        const last = await req.dbQuery(
          `SELECT created_at FROM messages
            WHERE chat_id = $1 AND sender_id = $2 AND deleted_at IS NULL
            ORDER BY id DESC LIMIT 1`,
          [req.params.id, req.user.id]
        );
        if (last.rows[0]) {
          const elapsed = (Date.now() - new Date(last.rows[0].created_at).getTime()) / 1000;
          if (elapsed < slow) {
            return res.status(429).json({ error: 'Slow mode is on', retryAfter: Math.ceil(slow - elapsed) });
          }
        }
      }
    }

    const b = req.body || {};
    let   content   = b.content;
    const type      = (b.type || 'text').toString();
    const replyTo   = b.replyToId ? parseInt(b.replyToId, 10) : null;
    const meta      = b.meta && typeof b.meta === 'object' ? b.meta : null;
    // Idempotency key (F7): a stable client-generated UUID, identical across every
    // retry of the SAME logical send. Scoped to (chat_id, sender_id) — sender_id
    // comes from the JWT, so it can't collide with or forge another user's rows.
    // Null for legacy clients that don't send it (they fall back to plain insert).
    const clientId  = (typeof b.clientId === 'string' && b.clientId.length > 0 && b.clientId.length <= 128) ? b.clientId : null;

    if (!['text','image','video','audio','file','location','system','sticker','poll','reaction','vaultbeam'].includes(type)) {
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
    } else if (type === 'reaction') {
      // E2EE reaction reference-message (F4): content = the E2E-encrypted
      // {reactsTo, op, emoji} payload. The server can't read it — it only
      // relays + stores ciphertext. Cap sized for the encrypted envelope.
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content (encrypted reaction) required' });
      }
      if (content.length > 4096) {
        return res.status(400).json({ error: 'reaction payload too long' });
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
      // External GIFs (type 'image' from the GIF picker) carry a remote URL in
      // meta.gifUrl instead of an uploaded attachment — exempt them.
      const isExternalGif = type === 'image' && meta && typeof meta.gifUrl === 'string'
        && /^https:\/\/\S+$/.test(meta.gifUrl) && meta.gifUrl.length <= 2048;
      if (!isExternalGif && (!meta || !meta.attachmentId)) {
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
      // the round-trip count flat. ON CONFLICT dedups a retried send (F7):
      // the partial unique index ux_messages_client_dedup(chat_id,sender_id,
      // client_id) makes a repeat POST of the same clientId a no-op insert.
      const m = await client.query(
        `INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id, client_id, expires_at, vanish_after_read)
         SELECT $1, $2, $3, $4, $5, $6, $7,
                CASE WHEN c.disappearing_seconds IS NOT NULL
                     THEN NOW() + (c.disappearing_seconds || ' seconds')::INTERVAL
                     ELSE NULL END,
                COALESCE(cm.vanish_mode, FALSE)
           FROM chats c
           LEFT JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
          WHERE c.id = $1
         ON CONFLICT (chat_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [req.params.id, req.user.id, type, content, meta, replyTo, clientId]
      );
      if (m.rows.length === 0 && clientId) {
        // DO NOTHING returned no row → this clientId already exists (a retry).
        // Return the ORIGINAL row so the client reconciles onto the same id.
        const ex = await client.query(
          `SELECT * FROM messages WHERE chat_id = $1 AND sender_id = $2 AND client_id = $3`,
          [req.params.id, req.user.id, clientId]
        );
        if (!ex.rows[0]) throw new Error('dedup lookup miss'); // READ COMMITTED: fresh snapshot per statement
        return { row: ex.rows[0], duplicate: true };
      }
      // Reactions (F4) are metadata riders, not conversation activity: they must
      // NOT become the chat's "last message", reorder the chat list, or
      // resurrect a chat a member hid/deleted.
      if (type !== 'reaction') {
        await client.query(
          `UPDATE chats SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
          [m.rows[0].id, m.rows[0].created_at, req.params.id]
        );
        // Resurface the chat for any recipient who had hidden/deleted it — a new
        // message must bring it back into their list, otherwise they never see it.
        await client.query(
          `UPDATE chat_members SET hidden = FALSE WHERE chat_id = $1 AND user_id <> $2 AND hidden = TRUE`,
          [req.params.id, req.user.id]
        );
      }
      return { row: m.rows[0], duplicate: false };
    });

    const msg = publicMessage(inserted.row);
    // Re-broadcast even on a duplicate: broadcastNewMessage is id-idempotent
    // (recipients dedup by id), so this recovers the "server committed then the
    // ack was lost" case where the first attempt never reached the recipient.
    broadcastNewMessage(req.params.id, msg);
    res.json(msg);

    if (!inserted.duplicate && type !== 'reaction') {
      // Non-idempotent side effects run ONCE — only for a genuinely new row.
      // Reactions (F4) never bump unread counts or ring the recipient's phone
      // (WhatsApp behaviour) — they still fan out live via broadcastNewMessage.
      // Bump the denormalized unread counter for every other member.
      db.query('SELECT vc_bump_unread($1, $2)', [req.params.id, req.user.id])
        .catch(e => console.error('[unread bump]', e.message));
      // Fire-and-forget push. Skipped on a duplicate to avoid a double OS banner
      // (the first attempt already pushed); the rare crash-before-push case
      // trades a missed push for never double-notifying.
      sendChatMessagePush(req.params.id, req.user.id, msg, mem.chat_type).catch(err => {
        console.error('[push hook]', err.message);
      });
    }
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
    // ?after=<id> → local-first delta sync: only messages newer than the
    // client's cursor, oldest-first so the client can page forward.
    const after  = req.query.after ? parseInt(req.query.after, 10) : null;
    const limit  = Math.min(parseInt(req.query.limit || DEFAULT_PAGE, 10), MAX_PAGE);

    const params = [req.params.id];
    // Filter expired ephemeral messages on the lazy path (cleanup loop
    // hard-deletes them every 5 min; this catches the gap).
    let where = `chat_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`;
    if (after && Number.isFinite(after)) {
      params.push(after);
      where += ` AND id > $${params.length}`;
    } else if (before && Number.isFinite(before)) {
      params.push(before);
      where += ` AND id < $${params.length}`;
    }
    params.push(limit);
    const order = (after && Number.isFinite(after)) ? 'ASC' : 'DESC';
    const r = await req.dbQuery(
      `SELECT * FROM messages WHERE ${where} ORDER BY id ${order} LIMIT $${params.length}`,
      params
    );
    res.json(r.rows.map(publicMessage));
  } catch (err) {
    console.error('[messages GET]', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// GET /chats/:id/messages/search?q=...&limit=50 — in-chat message search.
//
// Membership-scoped (must be a member to search). Matches text-message
// content (case-insensitive) within this single chat, newest first, and
// joins the sender's display name so the result list can render it without
// a second round-trip.
//
// MUST be declared before PATCH/DELETE '/:id/messages/:msgId' is irrelevant
// (those are not GET), but it is declared after GET '/:id/messages' — Express
// matches the longer, more specific path here because the extra '/search'
// segment makes it distinct from '/:id/messages'.
//
// In-chat message search is now ON-DEVICE (zero-knowledge): the server only
// holds ciphertext, so it cannot match message content. The client
// (lib/chatService.searchInChat) searches the decrypted local store. This
// endpoint stays membership-gated and intentionally returns no content matches.
router.get('/:id/messages/search', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member of this chat' });
    res.json({ messages: [] });
  } catch (err) {
    console.error('[in-chat search]', err.message);
    res.status(500).json({ error: 'Search failed' });
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
         AND created_at > NOW() - INTERVAL '${REVOKE_WINDOW_MS} milliseconds'
       RETURNING id, chat_id, deleted_at`,
      [req.params.msgId, req.params.id, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Message not found, not yours, or the delete window has expired' });

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
       SET last_read_message_id = $1,
           unread_count = (
             SELECT COUNT(*) FROM messages m
              WHERE m.chat_id = $2 AND m.id > $1
                AND m.sender_id <> $3 AND m.deleted_at IS NULL
                AND m.type <> 'reaction'
           )
       WHERE chat_id = $2 AND user_id = $3
         AND (last_read_message_id IS NULL OR last_read_message_id < $1)
       RETURNING last_read_message_id,
         (SELECT c.type FROM chats c WHERE c.id = $2) AS chat_type,
         (SELECT bool_and(u.read_receipts)
            FROM chat_members cm2 JOIN users u ON u.id = cm2.user_id
           WHERE cm2.chat_id = $2 AND cm2.left_at IS NULL) AS receipts_mutual`,
      [lastReadMessageId, req.params.id, req.user.id]
    );
    if (r.rows[0]) {
      // Read-receipt reciprocity (WhatsApp): in a DIRECT chat only surface the
      // read pointer to the peer when BOTH participants keep read receipts ON.
      // Groups are exempt. This is enforced SERVER-SIDE (a client toggle can't
      // stop the peer's device from receiving the pointer). The vanish sweep
      // below stays UNCONDITIONAL — it's independent of receipt visibility.
      const suppressReceipt =
        r.rows[0].chat_type === 'direct' && r.rows[0].receipts_mutual === false;
      if (!suppressReceipt) {
        broadcastChatEvent(req.params.id, 'message_read', {
          userId: req.user.id,
          lastReadMessageId: r.rows[0].last_read_message_id,
        });
      }

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
    const canAdd = mem.role === 'admin' || mem.role === 'owner' || mem.add_members_policy === 'everyone';
    if (!canAdd) return res.status(403).json({ error: 'Only admins can add members' });

    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(x => typeof x === 'string') : [];
    if (!ids.length) return res.status(400).json({ error: 'userIds required' });

    const sizeR = await req.dbQuery(
      `SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
      [req.params.id]
    );
    if (sizeR.rows[0].n + ids.length > MAX_GROUP_SIZE) {
      return res.status(400).json({ error: `Group would exceed cap of ${MAX_GROUP_SIZE}` });
    }

    // Honor each invitee's "who can add me to groups" privacy (WhatsApp).
    const polR = await req.dbQuery(
      `SELECT id, group_add_policy FROM users WHERE id = ANY($1::uuid[])`, [ids]
    );
    const policy = new Map(polR.rows.map(r => [r.id, r.group_add_policy || 'everyone']));
    const contactReq = ids.filter(uid => policy.get(uid) === 'contacts');
    let known = new Set();
    if (contactReq.length) {
      const dc = await req.dbQuery(
        `SELECT DISTINCT m2.user_id FROM chat_members m1
           JOIN chats c ON c.id = m1.chat_id AND c.type = 'direct'
           JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id <> $1
          WHERE m1.user_id = $1 AND m2.user_id = ANY($2::uuid[])`,
        [req.user.id, contactReq]
      );
      known = new Set(dc.rows.map(r => r.user_id));
    }
    const allowed = ids.filter(uid => {
      const p = policy.get(uid) || 'everyone';
      if (p === 'nobody') return false;
      if (p === 'contacts') return known.has(uid);
      return true;
    });
    const blocked = ids.filter(uid => !allowed.includes(uid));
    if (!allowed.length) return res.status(403).json({ error: "Those users don't allow being added to groups by you" });

    for (const uid of allowed) {
      await req.dbQuery(
        `INSERT INTO chat_members (chat_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
        [req.params.id, uid]
      );
    }
    broadcastChatEvent(req.params.id, 'members_added', { added: allowed, by: req.user.id });
    res.json({ added: allowed, blocked });
  } catch (err) {
    console.error('[members POST]', err.message);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// PATCH /chats/:id/members/:userId/role  { role: 'admin' | 'member' }
//
// Promote/demote a group member between 'admin' and 'member'. The 'owner'
// role is immutable here (ownership transfer is a separate, deliberate flow).
// Rules:
//   - caller must be admin or owner of a group chat
//   - cannot change your own role
//   - cannot touch the owner's row
//   - only the owner may demote an existing admin → member (an admin can
//     promote members but can't demote a peer admin)
router.patch('/:id/members/:userId/role', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Only group chats have roles' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });

    const role = (req.body?.role || '').toString();
    if (role !== 'admin' && role !== 'member') {
      return res.status(400).json({ error: "role must be 'admin' or 'member'" });
    }
    const target = req.params.userId;
    if (target === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });

    const tr = await req.dbQuery(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [req.params.id, target]
    );
    if (!tr.rows[0]) return res.status(404).json({ error: 'Member not found' });
    if (tr.rows[0].role === 'owner') return res.status(403).json({ error: 'Cannot change the owner role' });
    if (tr.rows[0].role === 'admin' && role === 'member' && mem.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can demote an admin' });
    }

    await req.dbQuery(
      `UPDATE chat_members SET role = $1 WHERE chat_id = $2 AND user_id = $3 AND left_at IS NULL`,
      [role, req.params.id, target]
    );
    broadcastChatEvent(req.params.id, 'member_role_changed', { userId: target, role, by: req.user.id });
    res.json({ ok: true, userId: target, role });
  } catch (err) {
    console.error('[member role PATCH]', err.message);
    res.status(500).json({ error: 'Failed to change role' });
  }
});

// POST /chats/:id/invite-links  { expiresInHours?, maxUses? }  — admin only
router.post('/:id/invite-links', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Only group chats have invite links' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });

    const hours = parseInt(req.body?.expiresInHours, 10);
    const expiresAt = (Number.isFinite(hours) && hours > 0)
      ? new Date(Date.now() + Math.min(hours, 24 * 365) * 3600000) : null;
    let maxUses = parseInt(req.body?.maxUses, 10);
    if (!Number.isFinite(maxUses) || maxUses < 0) maxUses = 0;

    for (let i = 0; i < 5; i++) {
      try {
        const r = await req.dbQuery(
          `INSERT INTO invite_links (code, chat_id, created_by, expires_at, max_uses)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [genInviteCode(), req.params.id, req.user.id, expiresAt, maxUses]
        );
        return res.json(publicInvite(r.rows[0]));
      } catch (e) {
        if (i === 4) throw e; // exhausted retries on the unique-code collision
      }
    }
  } catch (err) {
    console.error('[invite-links POST]', err.message);
    res.status(500).json({ error: 'Failed to create invite link' });
  }
});

// GET /chats/:id/invite-links  — admin only
router.get('/:id/invite-links', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });
    const r = await req.dbQuery(
      `SELECT * FROM invite_links WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(r.rows.map(publicInvite));
  } catch (err) {
    console.error('[invite-links GET]', err.message);
    res.status(500).json({ error: 'Failed to list invite links' });
  }
});

// DELETE /chats/:id/invite-links/:linkId  — revoke (admin only)
router.delete('/:id/invite-links/:linkId', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    if (mem.role !== 'admin' && mem.role !== 'owner') return res.status(403).json({ error: 'Admin only' });
    const linkId = parseInt(req.params.linkId, 10);
    if (!Number.isFinite(linkId)) return res.status(400).json({ error: 'invalid linkId' });
    await req.dbQuery(
      `UPDATE invite_links SET revoked = TRUE WHERE id = $1 AND chat_id = $2`,
      [linkId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[invite-links DELETE]', err.message);
    res.status(500).json({ error: 'Failed to revoke invite link' });
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
    if (typeof b.description === 'string') {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Direct chats have no description' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const d = b.description.trim().slice(0, 512);
      params.push(d || null);
      sets.push(`description = $${params.length}`);
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

    // Slow mode (group admin only): seconds between non-admin messages.
    if (b.slowModeSeconds !== undefined) {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Slow mode is group-only' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      let sm = parseInt(b.slowModeSeconds, 10);
      if (!Number.isFinite(sm) || sm < 0) sm = 0;
      params.push(Math.min(sm, 24 * 60 * 60));
      sets.push(`slow_mode_seconds = $${params.length}`);
    }
    // Send policy (group admin only): 'everyone' | 'admins'.
    if (typeof b.sendPolicy === 'string') {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Send policy is group-only' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      params.push(b.sendPolicy === 'admins' ? 'admins' : 'everyone');
      sets.push(`send_policy = $${params.length}`);
    }
    if (typeof b.mediaPolicy === 'string') {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Media policy is group-only' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      params.push(b.mediaPolicy === 'admins' ? 'admins' : 'everyone');
      sets.push(`media_policy = $${params.length}`);
    }
    if (typeof b.addMembersPolicy === 'string') {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Add-members policy is group-only' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      params.push(b.addMembersPolicy === 'everyone' ? 'everyone' : 'admins');
      sets.push(`add_members_policy = $${params.length}`);
    }
    if (b.antiSpamLinks !== undefined) {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Anti-spam is group-only' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      params.push(!!b.antiSpamLinks);
      sets.push(`anti_spam_links = $${params.length}`);
    }
    if (b.approveMembers !== undefined) {
      if (mem.chat_type !== 'group') return res.status(400).json({ error: 'Approve-members is group-only' });
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      params.push(!!b.approveMembers);
      sets.push(`approve_members = $${params.length}`);
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

// PATCH /chats/:id/notif-sound  { sound }  — per-chat notification sound (the
// Android channelId the client registered, e.g. 'default' | 'chime' | 'bell').
router.patch('/:id/notif-sound', async (req, res) => {
  try {
    const mem = await loadChatMembership(req, req.params.id);
    if (!mem || mem.left_at) return res.status(403).json({ error: 'Not a member' });
    const raw = (req.body?.sound ?? '').toString();
    // Whitelist + cap length; 'default' (or empty) clears the override.
    const allowed = ['default', 'chime', 'bell'];
    const sound = allowed.includes(raw) && raw !== 'default' ? raw : null;
    await req.dbQuery(
      `UPDATE chat_members SET notif_sound = $1 WHERE chat_id = $2 AND user_id = $3`,
      [sound, req.params.id, req.user.id]
    );
    res.json({ ok: true, sound: sound || 'default' });
  } catch (err) {
    console.error('[chats notif-sound]', err.message);
    res.status(500).json({ error: 'Failed to update notification sound' });
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
// ─── Reactions ─────────────────────────────────────────────────────
// The legacy plaintext reaction endpoints (PUT/DELETE/GET .../reactions) were
// REMOVED (F4): reactions are now E2EE reference-messages (type='reaction',
// {reactsTo,op,emoji} sealed inside the message content), so the server never
// sees the emoji and clients aggregate counts themselves. The plaintext
// `message_reactions` table is dropped in migration 056.

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

// POST /chats/:id/pin-message — pin a message chat-wide, or clear it (messageId: null).
// Any member can pin (matches WhatsApp). Broadcasts so open chats update live.
// NOTE: distinct path from POST /:id/pin (per-user pin-chat-to-top); a shared path
// let the chat-pin handler shadow this one, silently breaking message pinning.
router.post('/:id/pin-message', async (req, res) => {
  try {
    const chatId = req.params.id;
    const me = await loadChatMembership(req, chatId);
    if (!me || me.left_at) return res.status(403).json({ error: 'not a member' });

    const messageId = req.body?.messageId == null ? null : parseInt(req.body.messageId, 10);
    if (messageId !== null) {
      // Verify the message belongs to this chat (and isn't deleted).
      const m = await req.dbQuery(
        `SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [messageId, chatId]);
      if (!m.rowCount) return res.status(404).json({ error: 'message not found' });
    }
    await req.dbQuery(`UPDATE chats SET pinned_message_id = $1 WHERE id = $2`, [messageId, chatId]);
    broadcastChatEvent(chatId, 'message_pinned', { messageId: messageId != null ? String(messageId) : null });
    res.json({ ok: true, pinnedMessageId: messageId != null ? String(messageId) : null });
  } catch (err) {
    console.error('[chats pin]', err.message);
    res.status(500).json({ error: 'Failed to pin' });
  }
});

// ─── Group E2EE sender-key distribution (W5) ────────────────────────────────
// Members publish their Sender Key Distribution Messages (SKDMs) — each already
// encrypted with the pairwise Double Ratchet, so OPAQUE to the server — and fetch
// the ones addressed to them. The server only relays blobs; it can never read
// group messages.

// POST /chats/:id/sender-keys  { distributions: [{ recipientId, skdm }] }
// The caller (sender) publishes their SKDM to one or more recipients. Upserts so
// a rotation overwrites the previous key. Recipients are validated to be active
// members of the chat.
router.post('/:id/sender-keys', async (req, res) => {
  try {
    const chatId = req.params.id;
    const me = await loadChatMembership(req, chatId);
    if (!me || me.left_at) return res.status(403).json({ error: 'not a member' });

    const dists = Array.isArray(req.body?.distributions) ? req.body.distributions : [];
    if (!dists.length) return res.json({ ok: true, stored: 0 });

    // Set of active members to validate recipients against.
    const mem = await req.dbQuery(
      `SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`, [chatId]);
    const active = new Set(mem.rows.map(r => r.user_id));

    let stored = 0;
    for (const d of dists) {
      const recipientId = d && d.recipientId ? String(d.recipientId) : '';
      const skdm        = d && d.skdm        ? String(d.skdm)        : '';
      if (!recipientId || !skdm || recipientId === req.user.id || !active.has(recipientId)) continue;
      await req.dbQuery(
        `INSERT INTO group_sender_keys (chat_id, sender_id, recipient_id, skdm)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chat_id, sender_id, recipient_id)
           DO UPDATE SET skdm = EXCLUDED.skdm, updated_at = NOW()`,
        [chatId, req.user.id, recipientId, skdm]);
      stored++;
    }
    res.json({ ok: true, stored });
  } catch (err) {
    console.error('[sender-keys POST]', err.message);
    res.status(500).json({ error: 'Failed to publish sender keys' });
  }
});

// GET /chats/:id/sender-keys → SKDMs addressed to the caller: [{ senderId, skdm }].
router.get('/:id/sender-keys', async (req, res) => {
  try {
    const chatId = req.params.id;
    const me = await loadChatMembership(req, chatId);
    if (!me || me.left_at) return res.status(403).json({ error: 'not a member' });

    const r = await req.dbQuery(
      `SELECT sender_id, skdm FROM group_sender_keys
        WHERE chat_id = $1 AND recipient_id = $2`,
      [chatId, req.user.id]);
    res.json(r.rows.map(row => ({ senderId: row.sender_id, skdm: row.skdm })));
  } catch (err) {
    console.error('[sender-keys GET]', err.message);
    res.status(500).json({ error: 'Failed to load sender keys' });
  }
});

module.exports = router;
module.exports.setBroadcasters = setBroadcasters;
