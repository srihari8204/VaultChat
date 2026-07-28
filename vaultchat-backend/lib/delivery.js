// lib/delivery.js — chat-event fan-out, bound to a Socket.IO server.
//
// Resolves chat members, applies block-list + ghost-mode suppression, and emits
// via Socket.IO rooms (which reach clients on ANY node when the Redis adapter is
// enabled). Used by the Kafka fan-out worker (workers/fanout.js).
//
// NOTE: this mirrors the in-process fanOutToChat in server.js (the synchronous
// path used when EVENT_BUS != kafka). They are intentionally identical; once the
// Kafka path is validated in prod, server.js should require() this module so
// there is a single implementation. Keep the two in sync until then.

const db = require('../db');

const GHOST_COLS = ['hide_online', 'hide_typing', 'hide_read', 'hide_last_seen'];

const EVENT_TO_GHOST_COL = {
  typing_start: 'hide_typing',
  typing_stop:  'hide_typing',
  message_read: 'hide_read',
};

function senderOfEvent(event, data) {
  if (!data) return null;
  if (event === 'typing_start' || event === 'typing_stop') return data.uid ?? null;
  if (event === 'message_read') return data.userId ?? null;
  return null;
}

async function loadGhostTargets(senderId, column) {
  if (!senderId || !GHOST_COLS.includes(column)) return new Set();
  try {
    const r = await db.query(
      `SELECT target_id FROM ghost_mode WHERE owner_id = $1 AND ${column} = TRUE`,
      [senderId],
    );
    return new Set(r.rows.map((row) => row.target_id));
  } catch (err) {
    console.error('[loadGhostTargets]', err.message);
    return new Set();
  }
}

// Bind the fan-out to a Socket.IO server. The worker passes an `io` that shares
// the Redis adapter, so its emits reach clients connected to the gateway nodes.
function createDelivery(io) {
  function emitToUid(uid, event, data) {
    io.to(`user:${uid}`).emit(event, data);
    return true;
  }

  async function fanOutToChat(chatId, event, data, senderId = null) {
    try {
      const ghostCol = EVENT_TO_GHOST_COL[event] || null;
      const effectiveSender = senderId || senderOfEvent(event, data);
      const filtered = !!senderId || !!ghostCol;

      // Room emit only when filter-free — otherwise route per-recipient so the
      // block-list / ghost-mode skips actually apply.
      if (!filtered) {
        io.to(`chat:${chatId}`).emit(event, data);
      }

      const r = await db.query(`SELECT * FROM vc_chat_member_ids($1)`, [chatId]);
      const memberIds = r.rows.map((row) => row.vc_chat_member_ids).filter(Boolean);

      let blockerSet = new Set();
      if (senderId && memberIds.length) {
        const blk = await db.query(
          `SELECT blocker_id FROM user_blocks
            WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])`,
          [senderId, memberIds],
        );
        blockerSet = new Set(blk.rows.map((b) => b.blocker_id));
      }

      let ghostedSet = new Set();
      if (ghostCol && effectiveSender) {
        ghostedSet = await loadGhostTargets(effectiveSender, ghostCol);
      }

      for (const uid of memberIds) {
        if (blockerSet.has(uid)) continue;
        if (ghostedSet.has(uid)) continue;
        emitToUid(uid, event, data);
      }
    } catch (err) {
      console.error('[fanOutToChat]', err.message);
    }
  }

  return { emitToUid, fanOutToChat };
}

module.exports = { createDelivery };
