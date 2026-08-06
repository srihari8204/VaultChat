// VaultChat backend — Phase 1 (Postgres + custom JWT, no Firebase Admin).
// Keeps the working Socket.IO relays for chat real-time / WebRTC / Walkie
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
const { sendPushToTokens } = require('./push');
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

// Ensure the media bucket exists (no-op unless object storage is configured).
require('./lib/storage').ensureBucket().catch(() => {});

// ── Routes ───────────────────────────────────────────────────
// /config is unauthenticated by design (see routes/config.js) — it must stay
// reachable during boot without a token, since it carries the kill switch.
app.use('/config',   require('./routes/config'));
app.use('/auth',     require('./routes/auth'));
app.use('/user',     require('./routes/user'));
const uploadsRouter = require('./routes/uploads');
app.use('/uploads',  uploadsRouter);
app.use('/ai',       require('./routes/ai'));
app.use('/contacts', require('./routes/contacts'));
const chatsRouter = require('./routes/chats');
app.use('/chats',    chatsRouter);
const storiesRouter = require('./routes/stories');
app.use('/stories',  storiesRouter);
storiesRouter.setBroadcasters({ emitToUid });   // push 'story_posted' to viewers live
app.use('/communities', require('./routes/communities'));
app.use('/call', require('./routes/calls'));   // call wake-up (FCM) + signaling bootstrap
app.use('/link',     require('./routes/link'));
app.use('/gif',      require('./routes/gif'));
const channelsRouter = require('./routes/channels');
app.use('/channels', channelsRouter);
const vaultbeamRouter = require('./routes/vaultbeam');
app.use('/vaultbeam', vaultbeamRouter);
app.use('/nav', require('./routes/nav'));   // routing proxy → self-hosted Valhalla
vaultbeamRouter.setBroadcasters({ emitToUid });   // ring recipient: vb_invite / vb_ready / vb_complete / vb_abort
setInterval(() => vaultbeamRouter.sweepExpired().catch(() => {}), 60 * 60 * 1000); // reap stale relay rows hourly

// VaultLens (AI avatars). The BullMQ worker renders in its own process; here we
// listen for job completion and emit the result to the user's socket.
//
// Socket ownership: while Node owns Socket.IO, emitToUid delivers directly.
// After the Phase-2 realtime cutover Go owns sockets, so set GO_INTERNAL_URL
// (=http://go-api:4000) and this listener POSTs the emit to Go's reverse
// bridge instead — the BullMQ worker + this listener are the only Node pieces
// left, and they push their results into Go's socket layer.
const vaultlensRouter = require('./routes/vaultlens');
app.use('/vaultlens', vaultlensRouter);
const GO_INTERNAL_URL = (process.env.GO_INTERNAL_URL || '').replace(/\/$/, '');
async function emitToUserSockets(uid, event, payload) {
  if (!GO_INTERNAL_URL) return emitToUid(uid, event, payload); // Node owns sockets
  try {
    await fetch(`${GO_INTERNAL_URL}/internal/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_EMIT_KEY || '' },
      body: JSON.stringify({ userIds: [uid], event, payload }),
    });
  } catch (e) { console.error('[emit→go]', e.message); }
}
// Exactly ONE listener per deployment: when GO_INTERNAL_URL is set (Go owns
// sockets), workers/vaultlens.js hosts the QueueEvents listener and pushes
// into Go's bridge — this API-process listener stays OFF to avoid double
// emits. Unset (Node owns sockets) → this listener runs as always.
if (!GO_INTERNAL_URL) try {
  const { events: vlEvents } = require('./lib/vaultlensQueue');
  const vlStore = require('./lib/storage');
  const qe = vlEvents();
  qe.on('completed', async ({ jobId, returnvalue }) => {
    try {
      const rv = typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue;
      if (!rv?.userId || !rv?.storageKey) return;
      const url = await vlStore.presignGet(rv.storageKey, 3600);
      await emitToUserSockets(rv.userId, 'vaultlens:ready', { id: rv.generationId, url, styleId: rv.styleId });
    } catch (e) { console.error('[vaultlens completed]', e.message); }
  });
  qe.on('failed', async ({ jobId }) => {
    try {
      // Terminal failure → mark 'failed' (auto-refunds quota — excluded from the
      // daily count) and tell the client to flip the card to a retry state.
      const r = await db.query(
        `UPDATE vaultlens_generation SET status = 'failed', completed_at = NOW()
           WHERE id = $1 AND status <> 'done' RETURNING user_id`, [jobId]);
      const uid = r.rows[0]?.user_id;
      if (uid) await emitToUserSockets(uid, 'vaultlens:failed', { id: jobId });
    } catch (e) { console.error('[vaultlens failed]', e.message); }
  });
  console.log('[vaultlens] QueueEvents listener active');
} catch (e) { console.warn('[vaultlens] QueueEvents not started:', e.message); }
const adminRouter = require('./routes/admin');
app.use('/api/admin', adminRouter);

// ── Internal emit bridge (Phase 2) ──────────────────────────────────────
// Go-served routes bridge their socket emits here while Node still owns all
// sockets (until Step 5). Reachable ONLY in-network: Caddy refuses /internal/*
// from outside, and the key must match INTERNAL_EMIT_KEY. Body:
//   { rooms?: ['user:<uid>', 'chat:<id>', ...], userIds?: [uid...], event, payload }
app.post('/internal/emit', (req, res) => {
  const key = process.env.INTERNAL_EMIT_KEY || '';
  if (!key || req.get('x-internal-key') !== key) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { rooms, userIds, event, payload, broadcast } = req.body || {};
  if (!event || typeof event !== 'string') return res.status(400).json({ error: 'event required' });
  if (broadcast === true) {
    io.emit(event, payload); // every connected socket (admin /broadcast)
    return res.json({ ok: true, broadcast: true });
  }
  const targets = [
    ...(Array.isArray(rooms) ? rooms.filter(r => typeof r === 'string') : []),
    ...(Array.isArray(userIds) ? userIds.filter(u => typeof u === 'string').map(u => `user:${u}`) : []),
  ];
  for (const room of targets) io.to(room).emit(event, payload);
  res.json({ ok: true, rooms: targets.length });
});

// Broadcast a chat-route write over sockets. Named (not inline in
// setBroadcasters) so the internal bridge below can reuse the EXACT paths —
// Go-served /chats calls land here and take the same kafka-or-fanout route.
// payload.senderId drives block-list suppression in fanOutToChat. We ALSO
// mirror a privacy-safe summary (no content) to the admin firehose.
function broadcastNewMessage(chatId, payload) {
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
}
function broadcastChatEvent(chatId, event, payload) {
  fanOutToChat(chatId, event, payload);
  io.to('admin').emit('admin:event', { event, chatId, ts: Date.now() });
}

// Wire the chats router so its REST writes broadcast over sockets.
chatsRouter.setBroadcasters({ newMessage: broadcastNewMessage, chatEvent: broadcastChatEvent });

// Uploads router broadcasts 'media_revoked' to every chat referencing a revoked
// attachment, so recipients destroy their media key + plaintext immediately.
uploadsRouter.setBroadcasters({ chatEvent: broadcastChatEvent });

// Bridge form of the same broadcasters, for chat routes served by Go.
// { kind:'new_message', chatId, payload } | { kind:'chat_event', chatId, event, payload }
app.post('/internal/chat-event', (req, res) => {
  const key = process.env.INTERNAL_EMIT_KEY || '';
  if (!key || req.get('x-internal-key') !== key) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { kind, chatId, event, payload } = req.body || {};
  if (!chatId || typeof chatId !== 'string') return res.status(400).json({ error: 'chatId required' });
  if (kind === 'new_message') broadcastNewMessage(chatId, payload);
  else if (kind === 'chat_event' && typeof event === 'string') broadcastChatEvent(chatId, event, payload);
  else return res.status(400).json({ error: 'bad kind' });
  res.json({ ok: true });
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

// ─── Delete-on-delivery (WhatsApp model) ──────────────────────────────
// Once a message has been DELIVERED to every active recipient, the server no
// longer needs the body — the recipients hold it in their local-first SQLite.
// We NULL the content (keep the row for ordering/receipts; no socket event so
// clients that already cached it are unaffected). New devices restore old
// history from encrypted backup, exactly like WhatsApp.
//
// Gated by env so it's safe to deploy OFF and enable once you're comfortable
// that clients reliably cache on receipt (they do — see local-first sweep).
//   DELETE_ON_DELIVERY=true        — enable purging
//   DELETE_ON_DELIVERY_GRACE_SEC   — min age before purge (default 120s)
//   DELETE_ON_DELIVERY_MAX_AGE_DAYS— also purge undelivered bodies older than
//                                    this (default 0 = never; set e.g. 30)
const DOD_ON        = process.env.DELETE_ON_DELIVERY === 'true';
const DOD_GRACE_SEC = parseInt(process.env.DELETE_ON_DELIVERY_GRACE_SEC || '120', 10);
const DOD_MAX_DAYS  = parseInt(process.env.DELETE_ON_DELIVERY_MAX_AGE_DAYS || '0', 10);
async function sweepDeliveredMessages() {
  if (!DOD_ON) return;
  try {
    // Purge content of messages delivered to ALL other active members.
    const r = await db.query(
      `UPDATE messages m
          SET content = NULL
        WHERE m.content IS NOT NULL
          AND m.deleted_at IS NULL
          AND m.created_at < NOW() - ($1 || ' seconds')::interval
          AND EXISTS (
            SELECT 1 FROM chat_members o
             WHERE o.chat_id = m.chat_id AND o.left_at IS NULL AND o.user_id <> m.sender_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM chat_members cm
             WHERE cm.chat_id = m.chat_id
               AND cm.left_at IS NULL
               AND cm.user_id <> m.sender_id
               AND (cm.last_delivered_message_id IS NULL OR cm.last_delivered_message_id < m.id)
          )
        RETURNING m.id`,
      [String(DOD_GRACE_SEC)],
    );
    let purged = r.rowCount || 0;
    // Optional hard cap: drop bodies older than N days even if not delivered to
    // everyone (e.g. a member who never came back online).
    if (DOD_MAX_DAYS > 0) {
      const c = await db.query(
        `UPDATE messages SET content = NULL
          WHERE content IS NOT NULL AND deleted_at IS NULL
            AND created_at < NOW() - ($1 || ' days')::interval
          RETURNING id`,
        [String(DOD_MAX_DAYS)],
      );
      purged += c.rowCount || 0;
    }
    if (purged > 0) console.log(`[delete-on-delivery] purged ${purged} delivered message bodies`);
  } catch (err) {
    console.error('[delete-on-delivery] failed:', err.message);
  }
}
const deliveredSweepTimer = DOD_ON ? setInterval(sweepDeliveredMessages, SWEEP_INTERVAL_MS) : null;
if (DOD_ON) { sweepDeliveredMessages().catch(() => {}); console.log('[delete-on-delivery] ENABLED'); }

// ─── Media retention — purge delivered/expired attachment bytes ────
// WhatsApp-style: once every recipient has downloaded an attachment (or after a
// hard TTL backstop for the never-online case), delete the BYTES from storage.
// The metadata row stays, so anyone who already cached the media locally still
// renders it; offline recipients keep the bytes on the server until they fetch.
const attStore = require('./lib/storage');
const attFs    = require('fs').promises;
const attPath  = require('path');
const ATT_DIR  = attPath.resolve(process.env.UPLOAD_DIR || attPath.join(process.cwd(), 'uploads'));
const MEDIA_TTL_DAYS = parseInt(process.env.MEDIA_TTL_DAYS || '14', 10);

async function sweepDeliveredAttachments() {
  try {
    const r = await db.query(
      `SELECT a.id, a.storage_path, a.storage_backend
         FROM attachments a
        WHERE a.purged_at IS NULL
          AND a.storage_path IS NOT NULL
          AND (
            a.created_at < NOW() - ($1 || ' days')::INTERVAL          -- TTL backstop
            OR (
              (SELECT COUNT(*) FROM attachment_deliveries d WHERE d.attachment_id = a.id) > 0
              AND (SELECT COUNT(*) FROM attachment_deliveries d WHERE d.attachment_id = a.id)
                  >= (SELECT COUNT(DISTINCT cm.user_id)
                        FROM messages m
                        JOIN chat_members cm ON cm.chat_id = m.chat_id
                                            AND cm.left_at IS NULL
                                            AND cm.user_id <> a.owner_user_id
                       WHERE m.meta->>'attachmentId' = a.id::text)
            )
          )
        LIMIT 500`,
      [String(MEDIA_TTL_DAYS)]
    );
    let purged = 0;
    for (const att of r.rows) {
      try {
        if (att.storage_backend === 's3') await attStore.deleteObject(att.storage_path);
        else await attFs.unlink(attPath.join(ATT_DIR, att.storage_path)).catch(() => {});
        await db.query(`UPDATE attachments SET purged_at = NOW() WHERE id = $1`, [att.id]);
        purged++;
      } catch { /* skip this one, retry next sweep */ }
    }
    if (purged > 0) console.log(`[media-retention] purged ${purged} delivered/expired attachment(s)`);
  } catch (err) {
    console.error('[media-retention] failed:', err.message);
  }
}
const mediaRetentionTimer = setInterval(sweepDeliveredAttachments, SWEEP_INTERVAL_MS);
sweepDeliveredAttachments().catch(() => {});

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

// Reverse of loadGhostTargets: owners who have hidden `column` FROM `targetId`.
// Used so a joiner isn't shown viewers who've ghosted them.
async function loadGhostOwners(targetId, column) {
  if (!targetId || !GHOST_COLS.includes(column)) return new Set();
  try {
    const r = await db.query(
      `SELECT owner_id FROM ghost_mode WHERE target_id = $1 AND ${column} = TRUE`,
      [targetId]
    );
    return new Set(r.rows.map(row => row.owner_id));
  } catch (err) {
    console.error('[loadGhostOwners]', err.message);
    return new Set();
  }
}

// ── Live Chat Viewers (feature #58) — "who is viewing this chat right now" ──
// EPHEMERAL by design: Redis only, NEVER a Postgres table, no history.
//   cv:h:{chatId}  hash  field=userId → JSON {activity, ts}   (current viewers)
//   cv:exp         zset  member=`{chatId}|{userId}` score=ts  (30s expiry sweep)
// Fan-out reuses the existing chat rooms + per-user rooms. Ghost Mode
// (hide_online) hides you from a contact's viewer list; the per-chat toggle is
// enforced client-side (opted-out clients simply never emit).
const CV_TTL_MS = 30000;
const cvRedis = () => (redis.isConnected() ? redis.client : null);

async function cvTouch(chatId, uid, activity) {
  const c = cvRedis();
  if (!c) return { isNew: false, changed: false, activity: activity || 'reading' };
  const now = Date.now();
  const prev = await c.hget(`cv:h:${chatId}`, uid);
  let prevAct = null;
  if (prev) { try { prevAct = JSON.parse(prev).activity; } catch {} }
  const act = activity || prevAct || 'reading';
  await c.hset(`cv:h:${chatId}`, uid, JSON.stringify({ activity: act, ts: now }));
  await c.zadd('cv:exp', now, `${chatId}|${uid}`);
  c.pexpire(`cv:h:${chatId}`, CV_TTL_MS * 3).catch(() => {});   // drop idle chat hashes
  return { isNew: !prev, changed: !!prev && !!activity && activity !== prevAct, activity: act };
}

async function cvRemove(chatId, uid) {
  const c = cvRedis();
  if (!c) return;
  await c.hdel(`cv:h:${chatId}`, uid);
  await c.zrem('cv:exp', `${chatId}|${uid}`);
}

async function cvList(chatId) {
  const c = cvRedis();
  if (!c) return [];
  const h = await c.hgetall(`cv:h:${chatId}`);
  const out = [];
  for (const [uid, val] of Object.entries(h || {})) {
    let activity = 'reading';
    try { activity = JSON.parse(val).activity || 'reading'; } catch {}
    out.push({ userId: uid, activity });
  }
  return out;
}

// Periodic sweep: any viewer whose heartbeat is >30s stale is dropped and a
// viewer_left is broadcast (covers crashes / network drops with no LEFT).
setInterval(async () => {
  const c = cvRedis();
  if (!c) return;
  try {
    const expired = await c.zrangebyscore('cv:exp', 0, Date.now() - CV_TTL_MS);
    for (const member of expired) {
      const i = member.indexOf('|');
      if (i < 0) { await c.zrem('cv:exp', member); continue; }
      const chatId = member.slice(0, i), uid = member.slice(i + 1);
      await c.hdel(`cv:h:${chatId}`, uid);
      await c.zrem('cv:exp', member);
      io.to(`chat:${chatId}`).emit('viewer_left', { chatId, userId: uid });
    }
  } catch (err) { /* ephemeral — fail soft */ }
}, 10000).unref?.();

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
  // location screen emits; the peers' open chat screens render a live banner.
  // Server only RELAYS (no storage) and is ZERO-KNOWLEDGE: the position is an
  // opaque `blob` (client-side AES-256-GCM under a per-session key delivered E2E
  // in the initial 'location' message). We never see coordinates. `until` is a
  // non-sensitive expiry timestamp. Legacy plaintext fields are tolerated for
  // cross-version rollout but new clients send only `blob`.
  socket.on('live_location_update', async ({ chatId, blob, latitude, longitude, address, until }) => {
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
    const out = { userId: socket.data.uid, until };
    if (blob) out.blob = blob;                                  // E2E path (preferred)
    else if (latitude != null) { out.latitude = latitude; out.longitude = longitude; out.address = address; } // legacy
    socket.to(`chat:${chatId}`).emit('live_location_update', out);
  });
  socket.on('live_location_stop', ({ chatId }) => {
    if (!chatId) return;
    socket.to(`chat:${chatId}`).emit('live_location_stop', { userId: socket.data.uid });
  });

  // Route via fanOutToChat so it reaches every member's user-room (the chat
  // list shows "typing…" too, not just the open chat) and honours hide_typing
  // ghost-mode. chatId is included so each screen filters to the right chat.
  socket.on('typing_start', ({ chatId, uid }) => {
    if (chatId) fanOutToChat(chatId, 'typing_start', { uid, chatId });
  });

  socket.on('typing_stop', ({ chatId, uid }) => {
    if (chatId) fanOutToChat(chatId, 'typing_stop', { uid, chatId });
  });

  // ── Live Chat Viewers (feature #58) — ephemeral presence, never persisted ──
  // status: 'VIEWING' (also the 10s heartbeat) | 'LEFT'.  activity: reading|typing|uploading.
  socket.on('chat_view', async ({ chatId, status, activity, resync }) => {
    if (!chatId) return;
    const uid = socket.data.uid;
    try {
      if (status === 'LEFT') {
        await cvRemove(chatId, uid);
        io.to(`chat:${chatId}`).emit('viewer_left', { chatId, userId: uid });
        return;
      }
      // VIEWING = first open, 10s heartbeat, activity change, or reconnect resync.
      const { isNew, changed, activity: act } = await cvTouch(chatId, uid, activity);
      if (!isNew && !changed && !resync) return;         // plain heartbeat — no broadcast, no queries

      const hideFrom = await loadGhostTargets(uid, 'hide_online');   // contacts I hide from
      const viewers = await cvList(chatId);

      if (isNew) {
        // Tell everyone already viewing (except contacts I've ghosted) that I joined.
        for (const v of viewers) {
          if (v.userId === uid || hideFrom.has(v.userId)) continue;
          emitToUid(v.userId, 'viewer_joined', { chatId, userId: uid, activity: act });
        }
      } else if (changed) {
        for (const v of viewers) {
          if (v.userId === uid || hideFrom.has(v.userId)) continue;
          emitToUid(v.userId, 'viewer_activity', { chatId, userId: uid, activity: act });
        }
      }
      // First open OR reconnect → send ME the authoritative list (minus anyone
      // who has ghosted me, minus myself). Plain activity changes skip this.
      if (isNew || resync) {
        const hiddenFromMe = await loadGhostOwners(uid, 'hide_online');
        socket.emit('viewer_list', {
          chatId,
          viewers: viewers.filter(v => v.userId !== uid && !hiddenFromMe.has(v.userId)),
        });
      }
    } catch (err) { /* ephemeral — fail soft, no user-visible error */ }
  });

  socket.on('new_message', ({ chatId, messageId }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('message_delivered', { messageId });
  });

  // NOTE: the legacy `message_read` socket relay was removed here. It re-broadcast
  // a read pointer directly, bypassing the read-receipt reciprocity gate in
  // POST /chats/:id/read (routes/chats.js) — so an opted-out user's read still
  // leaked to the peer. Read receipts now flow ONLY through the gated REST path.
  // (The `new_message`→`message_delivered` relay above stays: the grey delivered
  // tick is intentionally never gated by the read-receipt setting.)

  // NOTE: legacy `message_edited` / `message_deleted` socket relays removed —
  // they re-broadcast CLIENT-supplied payloads with no ownership/age check, so
  // any room member could spoof an edit/delete of anyone's message (transient
  // UI-only, but still a spoof). The authoritative REST paths (PATCH/DELETE
  // /chats/:id/messages/:msgId) already broadcast the real gated events; the
  // live client is REST-only for both.

  socket.on('reaction_updated', ({ chatId, messageId, reactions }) => {
    if (chatId) socket.to(`chat:${chatId}`).emit('reaction_updated', { messageId, reactions });
  });

  // NOTE: the in-call extras (`call_emoji`, `call_chat`) were chat-room
  // broadcasts that re-emitted a CLIENT-supplied `from` — the same spoofing
  // shape the message_edited/message_deleted relays above were removed for, and
  // they reached every chat member rather than the people actually on the call.
  // Both now ride relayToPeer (below), which requires a `to`, stamps the
  // authenticated sender, and forwards the payload verbatim so the body can be
  // an E2EE envelope instead of plaintext. No client had ever used either event.

  // ── WebRTC signaling ──────────────────────────────────────
  // Targets a specific peer by uid. Sender must include `to: <peer uid>`.
  const relayToPeer = (event) => (data) => {
    if (!data?.to) return;
    // Stamp the authenticated sender so the peer can always identify the source.
    // Critical for webrtc_end (hangup): the client used to omit `from`, so the
    // peer's "did my call partner hang up?" check never matched and the call
    // screen stayed open on the other device.
    emitToUid(data.to, event, { ...data, from: socket.data.uid, fromUid: socket.data.uid });
  };
  socket.on('webrtc_offer',       relayToPeer('webrtc_offer'));
  socket.on('webrtc_answer',      relayToPeer('webrtc_answer'));
  socket.on('webrtc_ice',         relayToPeer('webrtc_ice'));
  socket.on('webrtc_end',         relayToPeer('webrtc_end'));
  // E2EE session re-key request (Stage-2 auto-recovery): a device that can't
  // decrypt a peer's messages asks that peer to drop its stale session so its
  // next message re-runs X3DH. Carries no content — just {to} — so relaying
  // this cleartext control signal leaks nothing (the ratchet state is local).
  socket.on('e2ee_rekey',         relayToPeer('e2ee_rekey'));
  // Calls: relay over the socket AND fire a high-priority push, so the callee
  // is alerted even when the app is killed / in doze (the socket is dead then).
  // The client suppresses the notification when it's in the foreground (the
  // socket already shows the in-app incoming-call screen) to avoid a double.
  socket.on('call_incoming', async (data) => {
    if (!data?.to) return;
    emitToUid(data.to, 'call_incoming', { ...data, from: socket.data.uid, fromUid: socket.data.uid });
    try {
      // If the callee has a live socket, the app is running and shows the call
      // in-app / via Notifee already — only wake the device when there's NO
      // socket (killed / doze), to avoid double-ringing.
      const live = await io.in(`user:${data.to}`).fetchSockets();
      if (live.length > 0) return;

      const r = await db.query(
        `SELECT push_token FROM devices WHERE user_id = $1 AND push_token IS NOT NULL`,
        [data.to],
      );
      const tokens = r.rows.map(x => x.push_token).filter(Boolean);
      if (tokens.length) {
        // Expo push → FCM (the app's google-services project). High-priority +
        // the 'calls' channel wakes the device; the client renders the Notifee
        // full-screen call.
        await sendPushToTokens(tokens, {
          title: data.callerName || 'Incoming call',
          body: data.type === 'video' ? '📹 Video call' : '📞 Voice call',
          channelId: 'calls',
          categoryId: 'incoming_call',
          sound: 'default',
          data: {
            type: 'call',
            chatId: data.chatId || '',
            fromUid: socket.data.uid,
            callerName: data.callerName || '',
            callType: data.type === 'video' ? 'video' : 'audio',
          },
        });
      }
    } catch (e) { /* best-effort wake-up push */ }
  });
  socket.on('screen_share_start', relayToPeer('screen_share_start'));
  socket.on('screen_share_stop',  relayToPeer('screen_share_stop'));
  // In-call chat + reactions — addressed, authenticated, body opaque (E2EE).
  socket.on('call_chat',          relayToPeer('call_chat'));
  socket.on('call_emoji',         relayToPeer('call_emoji'));
  // VaultBeam P2P file transfer — own signaling channel so it never collides
  // with an in-progress call.
  socket.on('vaultbeam_offer',    relayToPeer('vaultbeam_offer'));
  socket.on('vaultbeam_answer',   relayToPeer('vaultbeam_answer'));
  socket.on('vaultbeam_ice',      relayToPeer('vaultbeam_ice'));
  socket.on('vaultbeam_end',      relayToPeer('vaultbeam_end'));
  // Direct-tier (LAN / P2P) negotiation for VaultBeam large-file transfer:
  //   pull  — recipient: "I'm ready, let's try direct"
  //   ready — sender: "here's my LAN endpoint" (+ a WebRTC offer via vaultbeam_offer)
  //   tier  — recipient: "direct failed, fall back to relay"
  // All are opaque routing (to/from); the file bytes never touch this server.
  socket.on('vaultbeam_pull',     relayToPeer('vaultbeam_pull'));
  socket.on('vaultbeam_ready',    relayToPeer('vaultbeam_ready'));
  socket.on('vaultbeam_tier',     relayToPeer('vaultbeam_tier'));
  //   have  — recipient: sealed verified-chunk bitmap, so the sender skips what
  //           the peer already holds (seamless resume). Opaque routing.
  socket.on('vaultbeam_have',     relayToPeer('vaultbeam_have'));

  // ── Group calls (mesh) ────────────────────────────────────────────
  // A call room per chat. Joiners learn the existing roster; the per-pair
  // WebRTC offer/answer/ice still flow through relayToPeer (tagged to/from).
  // Glare is avoided client-side (smaller uid offers).
  socket.on('join_call', async ({ chatId }) => {
    if (!chatId) return;
    const room = `call:${chatId}`;
    let existing = [];
    try {
      const socks = await io.in(room).fetchSockets();
      existing = [...new Set(socks.map(s => s.data?.uid).filter(u => u && u !== socket.data.uid))];
    } catch {}
    socket.join(room);
    socket.emit('call_roster', { chatId, peers: existing });
    socket.to(room).emit('call_peer_joined', { chatId, uid: socket.data.uid });
  });
  socket.on('leave_call', ({ chatId }) => {
    if (!chatId) return;
    const room = `call:${chatId}`;
    socket.to(room).emit('call_peer_left', { chatId, uid: socket.data.uid });
    socket.leave(room);
  });

  // ── Disconnect cleanup ────────────────────────────────────
  socket.on('disconnect', () => {
    untrackSocket(socket);
    // Tell any active call rooms this participant dropped.
    for (const room of socket.rooms) {
      if (typeof room === 'string' && room.startsWith('call:')) {
        socket.to(room).emit('call_peer_left', { chatId: room.slice(5), uid: socket.data.uid });
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
