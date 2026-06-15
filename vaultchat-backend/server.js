// VaultChat backend — Phase 1 (Postgres + custom JWT, no Firebase Admin).
// Keeps the working Socket.IO relays for chat real-time / WebRTC / Walkie / Games
// (those don't touch Firebase). Per-feature routes that previously used the
// Firestore Admin SDK have been removed and will be reintroduced backed by
// Postgres in subsequent phases.
//
// The pre-cleanup version is preserved at server.js.legacy for reference.

require('dotenv').config();

// Sentry first — must be imported before any other module so the
// auto-instrumentation can wrap http/express/pg before they load.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    sendDefaultPii: false,
  });
  console.log('[sentry] initialised');
} else {
  console.log('[sentry] SENTRY_DSN not set — error tracking disabled');
}

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const crypto     = require('crypto');

// Constant-time admin-key comparison (mirrors routes/admin.js).
function safeKeyEqual(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const db      = require('./db');
const gameStore = require('./gameStore');
const redis   = require('./redis');
const jwtUtil = require('./jwt');
const kafka   = require('./lib/kafka');

// With EVENT_BUS=kafka (and KAFKA_BROKERS set), new-message delivery is produced
// to Kafka for the fan-out worker instead of fanning out in this process. Off by
// default → in-process synchronous fan-out, unchanged.
const EVENT_BUS_KAFKA = process.env.EVENT_BUS === 'kafka' && kafka.enabled();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  5000,
  maxHttpBufferSize: 2 * 1024 * 1024,  // 2 MB — accommodates encrypted media metadata
});

// Horizontal scaling: with REDIS_ADAPTER=1, Socket.IO shares room + emit state
// across processes via Redis pub/sub, so `io.to(room).emit(...)` reaches sockets
// connected to ANY node (and lets the Kafka fan-out worker deliver too). Off by
// default → single-node in-memory behaviour, unchanged.
if (process.env.REDIS_ADAPTER === '1') {
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const Redis = require('ioredis');
    const redisOpts = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASS || undefined,
    };
    const pubClient = new Redis(redisOpts);
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[socket] Redis adapter enabled — multi-node fan-out active');
  } catch (e) {
    console.error('[socket] Redis adapter init failed:', e.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

redis.connect().catch(() => {});

// ── Routes ───────────────────────────────────────────────────
app.use('/auth',     require('./routes/auth'));
app.use('/user',     require('./routes/user'));
app.use('/uploads',  require('./routes/uploads'));
app.use('/contacts', require('./routes/contacts'));
const chatsRouter = require('./routes/chats');
app.use('/chats',    chatsRouter);
app.use('/stories',  require('./routes/stories'));
const channelsRouter = require('./routes/channels');
app.use('/channels', channelsRouter);
app.use('/games',    require('./routes/games'));
const adminRouter = require('./routes/admin');
app.use('/api/admin', adminRouter);

// Wire the chats router so its REST writes broadcast over sockets.
chatsRouter.setBroadcasters({
  // payload.senderId drives block-list suppression in fanOutToChat. Other
  // chat events (typing, delivery, read, reactions) are sender-agnostic.
  // We ALSO mirror a privacy-safe summary (no content) to the admin firehose.
  newMessage: (chatId, payload) => {
    if (EVENT_BUS_KAFKA) {
      // Decoupled delivery: the fan-out worker consumes this and emits via the
      // Redis adapter. (Push still goes out from the route handler directly.)
      kafka.publish(kafka.TOPICS.MESSAGE_CREATED, chatId, {
        event: 'new_message', chatId, payload, senderId: payload?.senderId ?? null,
      });
    } else {
      fanOutToChat(chatId, 'new_message', payload, payload?.senderId ?? null);
    }
    io.to('admin').emit('admin:event', { event: 'new_message', chatId, senderId: payload?.senderId ?? null, type: payload?.type ?? null, messageId: payload?.id ?? null, ts: Date.now() });
  },
  chatEvent:  (chatId, event, payload) => {
    fanOutToChat(chatId, event, payload);
    io.to('admin').emit('admin:event', { event, chatId, ts: Date.now() });
  },
});

// Expose the live runtime to the admin router (online count + socket emitter).
adminRouter.setRuntime({ io, getOnlineCount: () => userSockets.size });

// Broadcast-channel realtime: a new post fans out to everyone in the room.
channelsRouter.setBroadcaster((channelId, event, payload) =>
  io.to(`channel:${channelId}`).emit(event, payload));

// ─── Disappearing messages — periodic cleanup ──────────────────────
// Hard-deletes rows whose expires_at <= NOW(). The lazy filter on
// `GET /messages` covers the gap between expiry and next sweep, so
// users never see expired content even if the sweeper is briefly stuck.
// We don't broadcast a message_deleted event here — the lazy filter on
// reload handles the UI side, and broadcasting tens of thousands of ids
// after a long cluster lag would flood clients.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
async function sweepExpiredMessages() {
  try {
    const r = await db.query(
      `DELETE FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= NOW()
        RETURNING id`
    );
    if (r.rowCount > 0) console.log(`[sweep] hard-deleted ${r.rowCount} expired message(s)`);
  } catch (err) {
    console.error('[sweep] failed:', err.message);
  }
}
const sweepTimer = setInterval(sweepExpiredMessages, SWEEP_INTERVAL_MS);
// Kick off an immediate sweep on boot so a long downtime doesn't leave
// stale ephemeral content visible.
sweepExpiredMessages().catch(() => {});

// ─── Scheduled-messages worker ─────────────────────────────────────
// Every 30 s, claim any rows in `scheduled_messages` whose send_at <= NOW()
// that haven't fired yet, insert them as real `messages`, broadcast
// `new_message`, and stamp `sent_at` so the same row doesn't fire twice.
// FOR UPDATE SKIP LOCKED makes this safe under multiple replicas.
const SCHED_SWEEP_MS  = 30 * 1000;
const SCHED_BATCH     = 50;
const SCHED_PRUNE_DAYS = 30;
async function sweepScheduledMessages() {
  try {
    // Claim a batch
    const claim = await db.query(
      `SELECT id, user_id, chat_id, type, content, meta, reply_to_id
         FROM scheduled_messages
        WHERE sent_at IS NULL AND send_at <= NOW()
        ORDER BY send_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [SCHED_BATCH]
    );
    for (const row of claim.rows) {
      try {
        // Skip if the sender is no longer a member (left after scheduling).
        const memR = await db.query(
          `SELECT 1 FROM chat_members
            WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [row.chat_id, row.user_id]
        );
        if (!memR.rows[0]) {
          // Mark as sent with no message_id so it doesn't reappear; visible in audit.
          await db.query(`UPDATE scheduled_messages SET sent_at = NOW() WHERE id = $1`, [row.id]);
          continue;
        }
        // Insert the real message (mirrors INSERT in POST /chats/:id/messages).
        const mR = await db.query(
          `INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id, expires_at)
           SELECT $1, $2, $3, $4, $5, $6,
                  CASE WHEN c.disappearing_seconds IS NOT NULL
                       THEN NOW() + (c.disappearing_seconds || ' seconds')::INTERVAL
                       ELSE NULL END
             FROM chats c WHERE c.id = $1
           RETURNING *`,
          [row.chat_id, row.user_id, row.type, row.content, row.meta, row.reply_to_id]
        );
        const m = mR.rows[0];
        await db.query(
          `UPDATE chats SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
          [m.id, m.created_at, row.chat_id]
        );
        await db.query(
          `UPDATE scheduled_messages SET sent_at = NOW(), message_id = $2 WHERE id = $1`,
          [row.id, m.id]
        );
        // Broadcast the new message — same shape as publicMessage() in chats.js.
        const payload = {
          id:        m.id,
          chatId:    m.chat_id,
          senderId:  m.sender_id,
          type:      m.type,
          content:   m.content,
          meta:      m.meta,
          replyToId: m.reply_to_id,
          editedAt:  m.edited_at,
          deletedAt: m.deleted_at,
          createdAt: m.created_at,
          expiresAt: m.expires_at ?? null,
        };
        await fanOutToChat(row.chat_id, 'new_message', payload, row.user_id);
      } catch (perRowErr) {
        console.error(`[sched ${row.id}]`, perRowErr.message);
      }
    }
    if (claim.rowCount > 0) console.log(`[sched] delivered ${claim.rowCount} scheduled message(s)`);

    // Prune sent rows older than 30 d.
    await db.query(
      `DELETE FROM scheduled_messages
        WHERE sent_at IS NOT NULL AND sent_at < NOW() - INTERVAL '${SCHED_PRUNE_DAYS} days'`
    );
  } catch (err) {
    console.error('[sched sweep]', err.message);
  }
}
const schedTimer = setInterval(sweepScheduledMessages, SCHED_SWEEP_MS);
sweepScheduledMessages().catch(() => {});

// ─── Stories — periodic prune ──────────────────────────────────────
// Hard-deletes stories whose 24h TTL has elapsed. ON DELETE CASCADE
// cleans up story_views. Same cadence as the messages sweep.
async function sweepExpiredStories() {
  try {
    const r = await db.query(
      `DELETE FROM stories WHERE expires_at <= NOW() RETURNING id`
    );
    if (r.rowCount > 0) console.log(`[sweep] hard-deleted ${r.rowCount} expired stor${r.rowCount === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error('[sweep stories]', err.message);
  }
}
const storiesTimer = setInterval(sweepExpiredStories, SWEEP_INTERVAL_MS);
sweepExpiredStories().catch(() => {});

// Sentry's Express error handler — catches everything that bubbles up
// from route handlers and ships it to Sentry. Must be mounted AFTER
// the routes. No-op if SENTRY_DSN was not set at init.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Health check — db + redis status for monitoring / Nginx probes
app.get('/health', async (_req, res) => {
  let dbOk = false;
  try { dbOk = await db.ping(); } catch {}
  const redisOk = redis.isConnected();
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
    redis: redisOk,
    uptime: process.uptime(),
  });
});

// ── Socket.IO ────────────────────────────────────────────────
// Phase 3a:
//   * JWT-authed handshake — sockets must present a Bearer token at connect
//   * Multi-device fan-out — a user can have N concurrent sockets; we track
//     them in a Set keyed by user id and broadcast to all of them
//   * Chat-room rooms — joined dynamically when client opens a chat;
//     `new_message` broadcasts hit `chat:${chatId}` AND every connected
//     socket of every chat member (via fanOutToChat below) so background
//     devices still receive updates without an open chat room

// userId → Set of socket.id values
const userSockets = new Map();

function trackSocket(socket) {
  const uid = socket.data?.uid;
  if (!uid) return;
  let set = userSockets.get(uid);
  if (!set) { set = new Set(); userSockets.set(uid, set); }
  const wasEmpty = set.size === 0;
  set.add(socket.id);
  // First socket for this user → presence went online
  if (wasEmpty) onUserOnline(uid).catch(err => console.error('[presence on]', err.message));
}

function untrackSocket(socket) {
  const uid = socket.data?.uid;
  if (!uid) return;
  const set = userSockets.get(uid);
  if (!set) return;
  set.delete(socket.id);
  if (set.size === 0) {
    userSockets.delete(uid);
    // Last socket gone → presence went offline
    onUserOffline(uid).catch(err => console.error('[presence off]', err.message));
  }
}

// ─── Presence (Day 12) ─────────────────────────────────────────────
// First connection → flip users.online = TRUE + broadcast.
// Last disconnect → flip users.online = FALSE + stamp last_seen_at + broadcast.
// We broadcast 'presence_changed' to every chat-mate of the affected user,
// so chat lists / chat headers update in real time without polling.
async function onUserOnline(uid) {
  await db.query(
    `UPDATE users SET online = TRUE WHERE id = $1 AND COALESCE(online, FALSE) = FALSE`,
    [uid]
  );
  await broadcastPresence(uid, { userId: uid, online: true, lastSeenAt: null });
}

async function onUserOffline(uid) {
  const now = new Date().toISOString();
  await db.query(
    `UPDATE users SET online = FALSE, last_seen_at = NOW() WHERE id = $1`,
    [uid]
  );
  await broadcastPresence(uid, { userId: uid, online: false, lastSeenAt: now });
}

async function broadcastPresence(uid, payload) {
  try {
    // Respect the user's privacy: if last_seen_visible = FALSE, blank
    // lastSeenAt before broadcasting (online status itself is still shared).
    const r = await db.query(
      `SELECT last_seen_visible FROM users WHERE id = $1`,
      [uid]
    );
    if (r.rows[0] && r.rows[0].last_seen_visible === false) {
      payload = { ...payload, lastSeenAt: null };
    }
    // Find all distinct other-users this user shares any chat with.
    const m = await db.query(
      `SELECT DISTINCT cm2.user_id
         FROM chat_members cm1
         JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id
        WHERE cm1.user_id = $1
          AND cm2.user_id <> $1
          AND cm1.left_at IS NULL
          AND cm2.left_at IS NULL`,
      [uid]
    );
    // Ghost Mode: skip recipients who have hidden `uid`'s online status.
    // The owner of the ghost-mode row is `uid` (the appearing user);
    // target is the recipient who should be kept in the dark.
    const ghosted = await loadGhostTargets(uid, 'hide_online');
    for (const row of m.rows) {
      if (ghosted.has(row.user_id)) continue;
      emitToUid(row.user_id, 'presence_changed', payload);
    }
  } catch (err) {
    console.error('[broadcastPresence]', err.message);
  }
}

// Look up which target users have been ghosted for a specific signal.
// Returns a Set of user_id strings — the recipients to *skip* when fanning
// `senderId`'s signals.
const GHOST_COLS = ['hide_online', 'hide_typing', 'hide_read', 'hide_last_seen'];
async function loadGhostTargets(senderId, column) {
  if (!senderId || !GHOST_COLS.includes(column)) return new Set();
  try {
    const r = await db.query(
      `SELECT target_id FROM ghost_mode WHERE owner_id = $1 AND ${column} = TRUE`,
      [senderId]
    );
    return new Set(r.rows.map(row => row.target_id));
  } catch (err) {
    console.error('[loadGhostTargets]', err.message);
    return new Set();
  }
}

function emitToUid(uid, event, data) {
  // Emit via the per-user room (joined on connect) rather than iterating this
  // node's socket map — so it reaches every device of the user on THIS node and,
  // with the Redis adapter, on ANY node in the cluster.
  io.to(`user:${uid}`).emit(event, data);
  return true;
}

// Fan a chat-scoped event to every connected socket of every chat member.
// `chat:${chatId}` room only contains sockets that explicitly joined it
// (i.e. have the chat open). For background notifications we want every
// device of every member to receive the event — hence the DB lookup.
//
// senderId (optional, Day 11): when provided, recipients who have blocked
// the sender are skipped. Used for `new_message` so a block stops chats
// from reaching the blocker; non-message events (typing, delivery, read)
// pass senderId=null and fan to everyone (we don't suppress those).
// Per-event hint for which ghost-mode column suppresses this signal.
// Events absent from this map are sender-agnostic (delivery, reactions,
// member events, etc.) and always fan to everyone.
const EVENT_TO_GHOST_COL = {
  typing_start:  'hide_typing',
  typing_stop:   'hide_typing',
  message_read:  'hide_read',
};
// Different events stash the originating user under different keys.
function senderOfEvent(event, data) {
  if (!data) return null;
  if (event === 'typing_start' || event === 'typing_stop') return data.uid ?? null;
  if (event === 'message_read') return data.userId ?? null;
  return null;
}

async function fanOutToChat(chatId, event, data, senderId = null) {
  try {
    // Determine whether this event should respect ghost mode, and which
    // signal column to consult. senderId arg wins (used by new_message);
    // otherwise we autodetect from the event name.
    const ghostCol = EVENT_TO_GHOST_COL[event] || null;
    const effectiveSender = senderId || senderOfEvent(event, data);
    const filtered = !!senderId || !!ghostCol;

    // Room emit only when the event is filter-free — otherwise we route
    // entirely via emitToUid so the per-recipient skips actually apply.
    if (!filtered) {
      io.to(`chat:${chatId}`).emit(event, data);
    }

    // Members of this chat
    const r = await db.query(`SELECT * FROM vc_chat_member_ids($1)`, [chatId]);
    const memberIds = r.rows.map(row => row.vc_chat_member_ids).filter(Boolean);

    // Block-list of viewers who blocked the sender — drop those.
    let blockerSet = new Set();
    if (senderId && memberIds.length) {
      const blk = await db.query(
        `SELECT blocker_id FROM user_blocks
          WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])`,
        [senderId, memberIds]
      );
      blockerSet = new Set(blk.rows.map(b => b.blocker_id));
    }

    // Ghost-mode targets for the signal in question.
    let ghostedSet = new Set();
    if (ghostCol && effectiveSender) {
      ghostedSet = await loadGhostTargets(effectiveSender, ghostCol);
    }

    for (const uid of memberIds) {
      if (blockerSet.has(uid)) continue;
      if (ghostedSet.has(uid))  continue;
      emitToUid(uid, event, data);
    }
  } catch (err) {
    console.error('[fanOutToChat]', err.message);
  }
}

// JWT handshake middleware — runs on every new connection BEFORE 'connection'
io.use((socket, next) => {
  // Admin console authenticates the socket with the admin key (not a user JWT).
  const adminKey = socket.handshake.auth?.adminKey;
  if (process.env.ADMIN_KEY && safeKeyEqual(adminKey, process.env.ADMIN_KEY)) {
    socket.data = { admin: true, uid: 'admin' };
    return next();
  }
  try {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return next(new Error('auth_required'));
    const payload = jwtUtil.verifyAccess(token);
    socket.data = { uid: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    return next(new Error(err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token'));
  }
});

io.on('connection', (socket) => {
  // Admin console socket — joins the firehose room, is NOT counted as an
  // online user, and skips all the per-user event handlers below.
  if (socket.data.admin) {
    socket.join('admin');
    socket.emit('ready', { admin: true });
    return;
  }

  trackSocket(socket);
  // Personal room — useful for direct user-targeted events (e.g. invitations)
  socket.join(`user:${socket.data.uid}`);
  socket.emit('ready', { uid: socket.data.uid });

  // ── Chat real-time events ──────────────────────────────────
  socket.on('join_chat', ({ chatId }) => {
    if (!chatId) return;
    socket.join(`chat:${chatId}`);
  });

  socket.on('leave_chat', ({ chatId }) => {
    if (!chatId) return;
    socket.leave(`chat:${chatId}`);
  });

  // Broadcast channels — join/leave the room while viewing a channel.
  socket.on('channel_join', ({ channelId }) => {
    if (channelId) socket.join(`channel:${channelId}`);
  });
  socket.on('channel_leave', ({ channelId }) => {
    if (channelId) socket.leave(`channel:${channelId}`);
  });

  // Live location — relay position updates to the chat room. The sender's
  // location-sharing screen emits; the peers' open chat screens render a
  // live banner. Server only relays (no storage).
  socket.on('live_location_update', async ({ chatId, latitude, longitude, address, until }) => {
    if (!chatId) return;
    // Only relay into a chat the sender is actually a member of (cache the
    // membership check per chat for this socket so it's one query per session).
    socket.data.liveLocOk = socket.data.liveLocOk || {};
    if (socket.data.liveLocOk[chatId] === undefined) {
      try {
        const r = await db.queryAs(socket.data.uid,
          `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
          [chatId, socket.data.uid]);
        socket.data.liveLocOk[chatId] = r.rowCount > 0;
      } catch { socket.data.liveLocOk[chatId] = false; }
    }
    if (!socket.data.liveLocOk[chatId]) return;
    socket.to(`chat:${chatId}`).emit('live_location_update', {
      userId: socket.data.uid, latitude, longitude, address, until,
    });
  });
  socket.on('live_location_stop', ({ chatId }) => {
    if (!chatId) return;
    socket.to(`chat:${chatId}`).emit('live_location_stop', { userId: socket.data.uid });
  });

  socket.on('typing_start', ({ chatId, uid }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('typing_start', { uid });
  });

  socket.on('typing_stop', ({ chatId, uid }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('typing_stop', { uid });
  });

  socket.on('new_message', ({ chatId, messageId }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('message_delivered', { messageId });
  });

  socket.on('message_read', ({ chatId, messageId }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('message_read', { messageId });
  });

  socket.on('message_edited', ({ chatId, messageId, newPlaintext }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('message_edited', { messageId, newPlaintext });
  });

  socket.on('message_deleted', ({ chatId, messageId }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('message_deleted', { messageId });
  });

  socket.on('reaction_updated', ({ chatId, messageId, reactions }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('reaction_updated', { messageId, reactions });
  });

  // ── In-call extras ─────────────────────────────────────────
  socket.on('call_emoji', ({ chatId, emoji, from }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('call_emoji', { emoji, from });
  });

  socket.on('call_chat', ({ chatId, text, from }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('call_chat', { text, from });
  });

  // ── WebRTC signaling ──────────────────────────────────────
  // Targets a specific peer by uid. Sender must include `to: <peer uid>`.
  const relayToPeer = (event) => (data) => {
    if (!data?.to) return;
    emitToUid(data.to, event, data);
  };
  socket.on('webrtc_offer',       relayToPeer('webrtc_offer'));
  socket.on('webrtc_answer',      relayToPeer('webrtc_answer'));
  socket.on('webrtc_ice',         relayToPeer('webrtc_ice'));
  socket.on('webrtc_end',         relayToPeer('webrtc_end'));
  socket.on('call_incoming',      relayToPeer('call_incoming'));
  socket.on('screen_share_start', relayToPeer('screen_share_start'));
  socket.on('screen_share_stop',  relayToPeer('screen_share_stop'));
  // VaultBeam P2P file transfer — own signaling channel so it never collides
  // with an in-progress call.
  socket.on('vaultbeam_offer',    relayToPeer('vaultbeam_offer'));
  socket.on('vaultbeam_answer',   relayToPeer('vaultbeam_answer'));
  socket.on('vaultbeam_ice',      relayToPeer('vaultbeam_ice'));
  socket.on('vaultbeam_end',      relayToPeer('vaultbeam_end'));

  // ── Gaming Platform ───────────────────────────────────────
  // Ephemeral in-memory — coins, rooms, queue. Lost on restart (acceptable
  // until Phase 6+ moves wallet to Postgres).
  const gamePlayers    = io.gamePlayers    || (io.gamePlayers    = new Map());
  const gameRooms      = io.gameRooms      || (io.gameRooms      = new Map());
  const gameMatchQueue = io.gameMatchQueue || (io.gameMatchQueue = new Map());

  socket.on('game_join_lobby', async ({ name }) => {
    const me = socket.data.uid;
    if (!me) return;
    let profile;
    try { profile = await gameStore.loadProfile(me); }
    catch (e) { console.error('[game_join_lobby]', e.message); profile = { coins: 1000, wins: 0 }; }
    gamePlayers.set(me, {
      uid: me,
      name: name || socket.data.email || 'Player',
      socketId: socket.id,
      coins: profile.coins,
      wins: profile.wins,
      inGame: false,
    });
    socket.join('game_lobby');
    socket.emit('game_coins', { coins: profile.coins });
  });

  socket.on('game_leave_lobby', () => socket.leave('game_lobby'));

  socket.on('game_quick_match', async ({ gameType, bet }) => {
    const me = socket.data.uid;
    const player = gamePlayers.get(me);
    if (!player) return;
    const wager = Math.max(0, parseInt(bet, 10) || 0);
    if (player.coins < wager) {
      socket.emit('game_error', { message: 'Not enough coins' });
      return;
    }
    const waitKey = `${gameType}_${wager}`;
    const waiting = gameMatchQueue.get(waitKey);
    if (waiting && waiting.uid !== me) {
      gameMatchQueue.delete(waitKey);
      const roomId = `GAME-${Date.now().toString(36).toUpperCase()}`;
      const room = {
        id: roomId, gameType, bet: wager,
        players: [
          { uid: waiting.uid, name: waiting.name, socketId: waiting.socketId },
          { uid: me, name: player.name, socketId: socket.id },
        ],
        state: {}, turn: waiting.uid, startedAt: Date.now(),
      };
      gameRooms.set(roomId, room);

      // Persist: log the match + deduct the wager from both balances.
      try {
        await gameStore.recordMatch(room);
        const aCoins = await gameStore.adjustCoins(waiting.uid, -wager);
        const bCoins = await gameStore.adjustCoins(me, -wager);
        const wp = gamePlayers.get(waiting.uid); if (wp) { wp.coins = aCoins; wp.inGame = true; }
        player.coins = bCoins; player.inGame = true;
      } catch (e) { console.error('[game_quick_match persist]', e.message); }

      const waitingSocket = io.sockets.sockets.get(waiting.socketId);
      if (waitingSocket) {
        waitingSocket.data.gameRoomId = roomId;
        waitingSocket.emit('game_matched', {
          roomId, gameType, bet: wager,
          opponent: { uid: me, name: player.name }, yourTurn: true,
        });
        waitingSocket.emit('game_coins', { coins: gamePlayers.get(waiting.uid)?.coins ?? 0 });
        waitingSocket.join(`game:${roomId}`);
      }
      socket.data.gameRoomId = roomId;
      socket.emit('game_matched', {
        roomId, gameType, bet: wager,
        opponent: { uid: waiting.uid, name: waiting.name }, yourTurn: false,
      });
      socket.emit('game_coins', { coins: player.coins });
      socket.join(`game:${roomId}`);
    } else {
      gameMatchQueue.set(waitKey, {
        uid: me, name: player.name, socketId: socket.id, gameType, bet: wager,
      });
      socket.emit('game_waiting', { gameType, bet: wager });
    }
  });

  socket.on('game_cancel_match', ({ gameType, bet }) => {
    const me = socket.data.uid;
    const waitKey = `${gameType}_${Math.max(0, parseInt(bet, 10) || 0)}`;
    const waiting = gameMatchQueue.get(waitKey);
    if (waiting && waiting.uid === me) gameMatchQueue.delete(waitKey);
    socket.emit('game_match_cancelled');
  });

  // game-play opens its own socket; it must re-join the game room (the
  // matchmaking socket from the lobby is a different connection). This fixes
  // the prior bug where game-play joined `chat:<room>` and never received the
  // events broadcast to `game:<room>`.
  socket.on('game_rejoin', ({ roomId }) => {
    const me = socket.data.uid;
    const room = gameRooms.get(roomId);
    if (!room) { socket.emit('game_error', { message: 'Match no longer active' }); return; }
    const p = room.players.find(pl => pl.uid === me);
    if (!p) return;
    p.socketId = socket.id;
    socket.data.gameRoomId = roomId;
    socket.join(`game:${roomId}`);
    socket.emit('game_rejoined', { roomId, yourTurn: room.turn === me });
  });

  socket.on('game_move', ({ roomId, move }) => {
    const me = socket.data.uid;
    const room = gameRooms.get(roomId);
    if (!room) return;
    socket.to(`game:${roomId}`).emit('game_move', { uid: me, move });
    room.turn = room.players.find(p => p.uid !== me)?.uid ?? me;
  });

  // Settle a finished room: pay the winner the pot, persist, notify, clean up.
  async function settleGame(roomId, winnerId, reason) {
    const room = gameRooms.get(roomId);
    if (!room) return;
    gameRooms.delete(roomId);
    const pot = room.bet * 2;
    const loserId = room.players.find(p => p.uid !== winnerId)?.uid ?? null;
    let winnerCoins = null;
    try {
      const r = await gameStore.finishMatch(roomId, winnerId, loserId, pot);
      winnerCoins = r.winnerCoins;
    } catch (e) { console.error('[settleGame persist]', e.message); }
    const wp = winnerId && gamePlayers.get(winnerId);
    if (wp) { wp.coins = winnerCoins ?? (wp.coins + pot); wp.wins++; wp.inGame = false; }
    const lp = loserId && gamePlayers.get(loserId);
    if (lp) lp.inGame = false;
    io.to(`game:${roomId}`).emit('game_ended', { winnerId, totalPot: pot, reason });
    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.leave(`game:${roomId}`);
        delete s.data.gameRoomId;
        s.emit('game_coins', { coins: gamePlayers.get(p.uid)?.coins ?? 0 });
      }
    });
  }

  socket.on('game_end', ({ roomId, winnerId, reason }) => {
    settleGame(roomId, winnerId, reason).catch(e => console.error('[game_end]', e.message));
  });

  socket.on('game_chat', ({ roomId, text }) => {
    if (roomId) socket.to(`game:${roomId}`).emit('game_chat', { uid: socket.data.uid, text });
  });

  // ── Disconnect cleanup ────────────────────────────────────
  socket.on('disconnect', () => {
    untrackSocket(socket);
    // Drop out of any pending matchmaking queue.
    for (const [k, w] of gameMatchQueue) if (w.socketId === socket.id) gameMatchQueue.delete(k);
    // Forfeit any active game this socket was in — the remaining player wins.
    const roomId = socket.data.gameRoomId;
    if (roomId) {
      const room = gameRooms.get(roomId);
      if (room) {
        const winnerId = room.players.find(p => p.uid !== socket.data.uid)?.uid ?? null;
        settleGame(roomId, winnerId, 'opponent_left').catch(e => console.error('[disconnect forfeit]', e.message));
      }
    }
  });
});

// ── Graceful shutdown ────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  clearInterval(sweepTimer);
  clearInterval(schedTimer);
  clearInterval(storiesTimer);
  io.close();
  server.close();
  try { await db.shutdown();    } catch (e) { console.error('[server] db.shutdown:',    e.message); }
  try { await redis.shutdown(); } catch (e) { console.error('[server] redis.shutdown:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`VaultChat backend listening on http://${HOST}:${PORT}`);
});
