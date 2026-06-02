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

const db      = require('./db');
const redis   = require('./redis');
const jwtUtil = require('./jwt');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  5000,
  maxHttpBufferSize: 2 * 1024 * 1024,  // 2 MB — accommodates encrypted media metadata
});

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

// Wire the chats router so its REST writes broadcast over sockets.
chatsRouter.setBroadcasters({
  newMessage: (chatId, payload) => fanOutToChat(chatId, 'new_message', payload),
  chatEvent:  (chatId, event, payload) => fanOutToChat(chatId, event, payload),
});

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
  set.add(socket.id);
}

function untrackSocket(socket) {
  const uid = socket.data?.uid;
  if (!uid) return;
  const set = userSockets.get(uid);
  if (!set) return;
  set.delete(socket.id);
  if (set.size === 0) userSockets.delete(uid);
}

function emitToUid(uid, event, data) {
  const set = userSockets.get(uid);
  if (!set || set.size === 0) return false;
  for (const sid of set) io.to(sid).emit(event, data);
  return true;
}

// Fan a chat-scoped event to every connected socket of every chat member.
// `chat:${chatId}` room only contains sockets that explicitly joined it
// (i.e. have the chat open). For background notifications we want every
// device of every member to receive the event — hence the DB lookup.
async function fanOutToChat(chatId, event, data) {
  try {
    // Always emit to the room for active viewers
    io.to(`chat:${chatId}`).emit(event, data);
    // Also fan to background sockets of all members. Uses the SECURITY
    // DEFINER helper from 004_rls.sql so this system query bypasses RLS
    // without needing a user-bound transaction.
    const r = await db.query(`SELECT * FROM vc_chat_member_ids($1)`, [chatId]);
    for (const row of r.rows) {
      // The function returns SETOF UUID — column name is the function name
      const uid = row.vc_chat_member_ids;
      if (uid) emitToUid(uid, event, data);
    }
  } catch (err) {
    console.error('[fanOutToChat]', err.message);
  }
}

// JWT handshake middleware — runs on every new connection BEFORE 'connection'
io.use((socket, next) => {
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

  // ── Walkie-Talkie rooms ───────────────────────────────────
  // Ephemeral in-memory rooms — lost on restart (acceptable for the feature).
  const walkieRooms = io.walkieRooms || (io.walkieRooms = new Map());

  socket.on('walkie_join', ({ roomId, uid, name, pin }) => {
    if (!roomId || !uid) return;
    const existing = walkieRooms.get(roomId);
    if (existing && existing.pin && existing.pin !== pin) {
      socket.emit('walkie_error', { message: 'Invalid room PIN' });
      return;
    }
    if (!existing) {
      walkieRooms.set(roomId, { id: roomId, pin: pin || '', host: uid, participants: [] });
    }
    const room = walkieRooms.get(roomId);
    room.participants = room.participants.filter(p => p.uid !== uid);
    room.participants.push({ uid, name, isTalking: false, isMuted: false, socketId: socket.id });
    socket.join(`walkie:${roomId}`);
    io.to(`walkie:${roomId}`).emit('walkie_participants',
      room.participants.map(p => ({ uid: p.uid, name: p.name, isTalking: p.isTalking, isMuted: p.isMuted }))
    );
    socket.to(`walkie:${roomId}`).emit('walkie_user_joined', { uid, name });
  });

  socket.on('walkie_leave', ({ roomId, uid }) => {
    const room = walkieRooms.get(roomId);
    if (!room) return;
    room.participants = room.participants.filter(p => p.uid !== uid);
    if (room.participants.length === 0) walkieRooms.delete(roomId);
    else io.to(`walkie:${roomId}`).emit('walkie_user_left', { uid });
    socket.leave(`walkie:${roomId}`);
  });

  socket.on('walkie_talk_start', ({ roomId, uid }) => {
    const room = walkieRooms.get(roomId);
    if (!room) return;
    const p = room.participants.find(x => x.uid === uid);
    if (p) p.isTalking = true;
    socket.to(`walkie:${roomId}`).emit('walkie_talk_start', { uid });
  });

  socket.on('walkie_talk_stop', ({ roomId, uid }) => {
    const room = walkieRooms.get(roomId);
    if (!room) return;
    const p = room.participants.find(x => x.uid === uid);
    if (p) p.isTalking = false;
    socket.to(`walkie:${roomId}`).emit('walkie_talk_stop', { uid });
  });

  socket.on('walkie_mute', ({ roomId, uid, muted }) => {
    const room = walkieRooms.get(roomId);
    if (!room) return;
    const p = room.participants.find(x => x.uid === uid);
    if (p) p.isMuted = muted;
  });

  socket.on('walkie_ping', ({ roomId, from }) => {
    if (roomId) socket.to(`walkie:${roomId}`).emit('walkie_ping', { from });
  });

  // ── Gaming Platform ───────────────────────────────────────
  // Ephemeral in-memory — coins, rooms, queue. Lost on restart (acceptable
  // until Phase 6+ moves wallet to Postgres).
  const gamePlayers    = io.gamePlayers    || (io.gamePlayers    = new Map());
  const gameRooms      = io.gameRooms      || (io.gameRooms      = new Map());
  const gameMatchQueue = io.gameMatchQueue || (io.gameMatchQueue = new Map());

  socket.on('game_join_lobby', ({ uid, name }) => {
    if (!uid) return;
    const existing = gamePlayers.get(uid);
    gamePlayers.set(uid, {
      uid, name,
      socketId: socket.id,
      coins: existing?.coins ?? 1000,
      wins: existing?.wins ?? 0,
      inGame: false,
    });
    socket.join('game_lobby');
    socket.emit('game_coins', { coins: gamePlayers.get(uid).coins });
  });

  socket.on('game_leave_lobby', () => socket.leave('game_lobby'));

  socket.on('game_quick_match', ({ uid, gameType, bet }) => {
    const player = gamePlayers.get(uid);
    if (!player) return;
    if (player.coins < bet) {
      socket.emit('game_error', { message: 'Not enough coins' });
      return;
    }
    const waitKey = `${gameType}_${bet}`;
    const waiting = gameMatchQueue.get(waitKey);
    if (waiting && waiting.uid !== uid) {
      gameMatchQueue.delete(waitKey);
      const roomId = `GAME-${Date.now().toString(36).toUpperCase()}`;
      const room = {
        id: roomId, gameType, bet,
        players: [
          { uid: waiting.uid, name: waiting.name, socketId: waiting.socketId },
          { uid, name: player.name, socketId: socket.id },
        ],
        state: {}, turn: waiting.uid, startedAt: Date.now(),
      };
      gameRooms.set(roomId, room);
      gamePlayers.get(waiting.uid).coins -= bet;
      player.coins -= bet;
      gamePlayers.get(waiting.uid).inGame = true;
      player.inGame = true;
      const waitingSocket = io.sockets.sockets.get(waiting.socketId);
      if (waitingSocket) {
        waitingSocket.emit('game_matched', {
          roomId, gameType, bet,
          opponent: { uid, name: player.name }, yourTurn: true,
        });
        waitingSocket.join(`game:${roomId}`);
      }
      socket.emit('game_matched', {
        roomId, gameType, bet,
        opponent: { uid: waiting.uid, name: waiting.name }, yourTurn: false,
      });
      socket.join(`game:${roomId}`);
    } else {
      gameMatchQueue.set(waitKey, {
        uid, name: player.name, socketId: socket.id, gameType, bet,
      });
      socket.emit('game_waiting', { gameType, bet });
    }
  });

  socket.on('game_cancel_match', ({ uid, gameType, bet }) => {
    const waitKey = `${gameType}_${bet}`;
    const waiting = gameMatchQueue.get(waitKey);
    if (waiting && waiting.uid === uid) gameMatchQueue.delete(waitKey);
    socket.emit('game_match_cancelled');
  });

  socket.on('game_move', ({ roomId, uid, move }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    socket.to(`game:${roomId}`).emit('game_move', { uid, move });
    room.turn = room.players.find(p => p.uid !== uid)?.uid ?? uid;
  });

  socket.on('game_end', ({ roomId, winnerId, reason }) => {
    const room = gameRooms.get(roomId);
    if (!room) return;
    const totalPot = room.bet * 2;
    const winner = gamePlayers.get(winnerId);
    if (winner) {
      winner.coins += totalPot;
      winner.wins++;
      winner.inGame = false;
    }
    const loserId = room.players.find(p => p.uid !== winnerId)?.uid;
    if (loserId) {
      const loser = gamePlayers.get(loserId);
      if (loser) loser.inGame = false;
    }
    io.to(`game:${roomId}`).emit('game_ended', { winnerId, totalPot, reason });
    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.leave(`game:${roomId}`);
        s.emit('game_coins', { coins: gamePlayers.get(p.uid)?.coins ?? 0 });
      }
    });
    gameRooms.delete(roomId);
  });

  socket.on('game_chat', ({ roomId, uid, text }) => {
    if (roomId) socket.to(`game:${roomId}`).emit('game_chat', { uid, text });
  });

  // ── Disconnect cleanup ────────────────────────────────────
  socket.on('disconnect', () => {
    untrackSocket(socket);
  });
});

// ── Graceful shutdown ────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
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
