// VaultChat backend — Phase 1 (Postgres + custom JWT, no Firebase Admin).
// Keeps the working Socket.IO relays for chat real-time / WebRTC / Walkie / Games
// (those don't touch Firebase). Per-feature routes that previously used the
// Firestore Admin SDK have been removed and will be reintroduced backed by
// Postgres in subsequent phases.
//
// The pre-cleanup version is preserved at server.js.legacy for reference.

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const db    = require('./db');
const redis = require('./redis');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  5000,
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

redis.connect().catch(() => {});

// ── Routes ───────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/user', require('./routes/user'));

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
// Pure message relays. None of these touch Firebase. Clients send/receive
// realtime events via Socket.IO rooms; storage (Firestore / Postgres) is
// handled by the client (today) and the backend (after Phase 4+).

// Maps a connected socket to its claimed identity. Clients call `identify`
// with their uid (their own — no auth on socket yet; tighten in Phase 2+
// by extracting uid from the JWT on socket handshake).
const uidToSocket = new Map();

function emitToUid(uid, event, data) {
  const socketId = uidToSocket.get(uid);
  if (!socketId) return false;
  io.to(socketId).emit(event, data);
  return true;
}

io.on('connection', (socket) => {
  // ── Identify socket → uid ──────────────────────────────────
  // Lightweight registration so other clients can target this socket.
  socket.on('identify', ({ uid, vaultId }) => {
    const id = uid || vaultId;
    if (!id) return;
    socket.data = { ...socket.data, uid: id, vaultId: id };
    uidToSocket.set(id, socket.id);
    socket.join(`user:${id}`);
    socket.emit('identify_ok');
  });

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
    const uid = socket.data?.uid;
    if (uid && uidToSocket.get(uid) === socket.id) {
      uidToSocket.delete(uid);
    }
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
