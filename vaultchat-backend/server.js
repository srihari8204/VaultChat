const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingInterval: 10000,
  pingTimeout:  5000,
});

app.use(cors());
app.use(express.json());

// Initialize Firebase Admin (must be before routes)
require('./firebaseAdmin');

// Serve admin panel
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/admin.html'));

// ── Routes ───────────────────────────────────────────────────
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/face', require('./routes/face'));
app.use('/api/secretcode', require('./routes/secretcode'));
app.use('/api/vaultdrop', require('./routes/vaultdrop'));
app.use('/api/location', require('./routes/location'));
app.use('/api/sync-contact', require('./routes/sync-contact'));

// ── In-memory store ──────────────────────────────────────────
const users    = new Map();
const messages = new Map();
const sessions = new Map();
const queue    = new Map();
const testLogs = [];

function log(type, data) {
  const entry = { type, data, ts: Date.now(), id: crypto.randomUUID() };
  testLogs.unshift(entry);
  if (testLogs.length > 500) testLogs.pop();
  io.to('admin').emit('log', entry);
}

// ── REST API ─────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: users.size, uptime: process.uptime() });
});

// Register user
app.post('/api/register', (req, res) => {
  const { name, vaultId } = req.body;
  if (!name || !vaultId) return res.status(400).json({ error: 'Missing fields' });
  if (users.has(vaultId)) return res.status(409).json({ error: 'VaultID already exists' });

  users.set(vaultId, {
    name, vaultId,
    socketId: null,
    online: false,
    joinedAt: Date.now(),
    msgCount: 0,
    lastSeen: null,
    avatar: name.slice(0,2).toUpperCase(),
    color: ['#1D4ED8','#7C3AED'],
  });
  queue.set(vaultId, []);
  log('register', { name, vaultId });
  io.to('admin').emit('users_update', getUserList());
  res.json({ success: true, vaultId });
});

// Get all users
app.get('/api/users', (req, res) => {
  res.json(getUserList());
});

// Get stats
app.get('/api/stats', (req, res) => {
  const onlineCount = [...users.values()].filter(u => u.online).length;
  const totalMsgs   = [...messages.values()].length;
  const delivered   = [...messages.values()].filter(m => m.delivered).length;
  res.json({
    totalUsers: users.size,
    onlineUsers: onlineCount,
    totalMessages: totalMsgs,
    deliveredMessages: delivered,
    pendingMessages: totalMsgs - delivered,
    activeSessions: [...sessions.values()].filter(s => s.active).length,
    uptime: Math.floor(process.uptime()),
    logs: testLogs.slice(0, 50),
  });
});

// Admin: create test users in bulk
app.post('/api/admin/create-test-users', (req, res) => {
  const { count = 5 } = req.body;
  const created = [];
  const names = ['Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry','Iris','Jack'];
  for (let i = 0; i < Math.min(count, 10); i++) {
    const name    = names[i] || `Tester${i+1}`;
    const vaultId = `VC-TEST-${name.toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    if (!users.has(vaultId)) {
      users.set(vaultId, {
        name, vaultId, socketId: null, online: false,
        joinedAt: Date.now(), msgCount: 0, lastSeen: null,
        avatar: name.slice(0,2).toUpperCase(), isTestUser: true,
        color: [['#1D4ED8','#7C3AED'],['#059669','#0EA5E9'],['#EF4444','#F97316'],['#7C3AED','#EC4899']][i%4],
      });
      queue.set(vaultId, []);
      created.push({ name, vaultId });
    }
  }
  log('bulk_create', { count: created.length, users: created });
  io.to('admin').emit('users_update', getUserList());
  res.json({ success: true, created });
});

// Admin: broadcast test message to all users
app.post('/api/admin/broadcast', (req, res) => {
  const { message } = req.body;
  const msgId = crypto.randomUUID();
  let sent = 0;
  users.forEach((u, vaultId) => {
    if (u.online && u.socketId) {
      io.to(u.socketId).emit('message', {
        id: msgId, from: 'ADMIN', to: vaultId,
        content: message, ts: Date.now(), isAdmin: true,
      });
      sent++;
    }
  });
  log('broadcast', { message, sent });
  res.json({ success: true, sent });
});

// Admin: start test session
app.post('/api/admin/start-session', (req, res) => {
  const sessionId = `SES-${Date.now()}`;
  const onlineUsers = [...users.values()].filter(u => u.online).map(u => u.vaultId);
  sessions.set(sessionId, {
    id: sessionId,
    users: onlineUsers,
    startedAt: Date.now(),
    msgCount: 0,
    active: true,
  });
  log('session_start', { sessionId, users: onlineUsers.length });
  io.to('admin').emit('session_update', getSessionList());
  res.json({ success: true, sessionId, users: onlineUsers.length });
});

// Admin: end session
app.post('/api/admin/end-session', (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) {
    session.active = false;
    session.endedAt = Date.now();
    log('session_end', { sessionId, duration: session.endedAt - session.startedAt });
    io.to('admin').emit('session_update', getSessionList());
  }
  res.json({ success: true });
});

// Admin: clear all test data
app.post('/api/admin/reset', (req, res) => {
  users.clear(); messages.clear(); sessions.clear(); queue.clear();
  testLogs.length = 0;
  log('reset', { by: 'admin' });
  io.to('admin').emit('users_update', []);
  io.to('admin').emit('stats_update', {});
  res.json({ success: true });
});

// ── WebSocket ────────────────────────────────────────────────
// Track which socket is in which chat room
const socketChatMap = new Map(); // socketId -> { uid, chatId }

io.on('connection', (socket) => {
  let currentUser = null;

  // Admin panel connection
  socket.on('admin_join', () => {
    socket.join('admin');
    socket.emit('users_update', getUserList());
    socket.emit('session_update', getSessionList());
    socket.emit('stats_update', getStats());
    log('admin_connect', { socketId: socket.id });
  });

  // ── Chat events (used by chat.tsx / group-chat.tsx) ────────

  // Join a chat room
  socket.on('join_chat', ({ chatId, uid }) => {
    socket.join(`chat:${chatId}`);
    socketChatMap.set(socket.id, { uid, chatId });
    socket.data = { ...socket.data, uid, chatId };
  });

  // Typing indicators
  socket.on('typing_start', ({ chatId, uid }) => {
    socket.to(`chat:${chatId}`).emit('typing_start', { uid });
  });

  socket.on('typing_stop', ({ chatId, uid }) => {
    socket.to(`chat:${chatId}`).emit('typing_stop', { uid });
  });

  // New message notification (Firestore handles storage, this is for real-time push)
  socket.on('new_message', ({ chatId, messageId, senderUid, recipientUid, preview }) => {
    socket.to(`chat:${chatId}`).emit('message_delivered', { messageId });
    log('msg_realtime', { chatId, messageId, from: senderUid });
  });

  // Message read acknowledgment
  socket.on('message_read', ({ chatId, messageId, readerUid, senderUid }) => {
    socket.to(`chat:${chatId}`).emit('message_read', { messageId });
  });

  // Message edit notification
  socket.on('message_edited', ({ chatId, messageId, newPlaintext }) => {
    socket.to(`chat:${chatId}`).emit('message_edited', { messageId, newPlaintext });
  });

  // Message delete notification
  socket.on('message_deleted', ({ chatId, messageId }) => {
    socket.to(`chat:${chatId}`).emit('message_deleted', { messageId });
  });

  // Reaction update
  socket.on('reaction_updated', ({ chatId, messageId, reactions }) => {
    socket.to(`chat:${chatId}`).emit('reaction_updated', { messageId, reactions });
  });

  // ── WebRTC signaling (calls) ───────────────────────────────
  socket.on('screen_share_start', data => {
    const target = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to);
    if (target) target.emit('screen_share_start', data);
  });
  socket.on('screen_share_stop', data => {
    const target = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to);
    if (target) target.emit('screen_share_stop', data);
  });
  socket.on('webrtc_offer',  data => { const t = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to); if (t) t.emit('webrtc_offer', data); });
  socket.on('webrtc_answer', data => { const t = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to); if (t) t.emit('webrtc_answer', data); });
  socket.on('webrtc_ice',    data => { const t = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to); if (t) t.emit('webrtc_ice', data); });
  socket.on('webrtc_end',    data => { const t = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to); if (t) t.emit('webrtc_end', data); });
  socket.on('call_incoming', data => { const t = [...io.sockets.sockets.values()].find(s => s.data?.vaultId === data.to); if (t) t.emit('call_incoming', data); });

  // ── Legacy test console events ─────────────────────────────
  socket.on('identify', ({ vaultId }) => {
    const user = users.get(vaultId);
    if (!user) { socket.emit('error', { msg: 'Unknown VaultID' }); return; }
    currentUser = vaultId;
    user.socketId = socket.id;
    user.online   = true;
    user.lastSeen = Date.now();
    socket.data = { ...socket.data, vaultId };
    socket.join(`user:${vaultId}`);
    log('user_online', { name: user.name, vaultId });
    io.to('admin').emit('users_update', getUserList());

    // Deliver queued messages
    const pending = queue.get(vaultId) || [];
    if (pending.length > 0) {
      pending.forEach(msg => {
        socket.emit('message', msg);
        const m = messages.get(msg.id);
        if (m) m.delivered = true;
      });
      queue.set(vaultId, []);
      log('queue_delivered', { to: vaultId, count: pending.length });
    }
    socket.emit('identify_ok', { name: user.name, queued: pending.length });
  });

  // Send message (legacy test console)
  socket.on('send_message', ({ to, encrypted, msgId }) => {
    if (!currentUser) return;
    const from = users.get(currentUser);
    const toUser = users.get(to);
    if (!from || !toUser) return;

    const msg = {
      id: msgId || crypto.randomUUID(),
      from: currentUser,
      fromName: from.name,
      to,
      encrypted,
      ts: Date.now(),
      delivered: false,
    };
    messages.set(msg.id, msg);
    from.msgCount++;

    sessions.forEach(s => {
      if (s.active && s.users.includes(currentUser)) s.msgCount++;
    });

    if (toUser.online && toUser.socketId) {
      io.to(toUser.socketId).emit('message', msg);
      msg.delivered = true;
      log('msg_delivered', { from: from.name, to: toUser.name, id: msg.id });
    } else {
      const q = queue.get(to) || [];
      q.push(msg);
      queue.set(to, q);
      log('msg_queued', { from: from.name, to: toUser.name, id: msg.id });
    }

    socket.emit('msg_ack', { id: msg.id, delivered: msg.delivered });
    io.to('admin').emit('users_update', getUserList());
    io.to('admin').emit('stats_update', getStats());
  });

  // Typing indicator (legacy)
  socket.on('typing', ({ to, isTyping }) => {
    if (!currentUser) return;
    const toUser = users.get(to);
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('typing', { from: currentUser, isTyping });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    socketChatMap.delete(socket.id);
    if (currentUser) {
      const user = users.get(currentUser);
      if (user) {
        user.online   = false;
        user.socketId = null;
        user.lastSeen = Date.now();
        log('user_offline', { name: user.name, vaultId: currentUser });
        io.to('admin').emit('users_update', getUserList());
      }
    }
  });
});

// Stats broadcast to admin every 5s
setInterval(() => {
  io.to('admin').emit('stats_update', getStats());
}, 5000);

// ── Helpers ──────────────────────────────────────────────────
function getUserList() {
  return [...users.values()].map(u => ({
    name: u.name, vaultId: u.vaultId, online: u.online,
    avatar: u.avatar, color: u.color, msgCount: u.msgCount,
    joinedAt: u.joinedAt, lastSeen: u.lastSeen, isTestUser: u.isTestUser,
    queued: (queue.get(u.vaultId)||[]).length,
  }));
}

function getSessionList() {
  return [...sessions.values()].map(s => ({
    id: s.id, users: s.users.length, startedAt: s.startedAt,
    endedAt: s.endedAt, msgCount: s.msgCount, active: s.active,
    duration: s.endedAt ? s.endedAt - s.startedAt : Date.now() - s.startedAt,
  }));
}

function getStats() {
  const onlineCount = [...users.values()].filter(u => u.online).length;
  const totalMsgs   = [...messages.values()].length;
  const delivered   = [...messages.values()].filter(m => m.delivered).length;
  return {
    totalUsers: users.size, onlineUsers: onlineCount,
    totalMessages: totalMsgs, deliveredMessages: delivered,
    pendingMessages: totalMsgs - delivered,
    activeSessions: [...sessions.values()].filter(s => s.active).length,
    uptime: Math.floor(process.uptime()),
  };
}

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`VaultChat Backend running on http://localhost:${PORT}`);
});
