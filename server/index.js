const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const admin      = require('firebase-admin');

try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./serviceAccount.json');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
} catch { admin.initializeApp(); }

const db     = admin.firestore();
const app    = express();
const server = http.createServer(app);
app.use(express.json());

// Health â€” cron-job.org pings this every 14 min to keep Render alive
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// â”€â”€ AUTH MIDDLEWARE â€” every socket must present a valid Firebase token â”€â”€â”€â”€â”€â”€
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No auth token'));
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    socket.data.uid = decoded.uid;
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

const online = new Map(); // uid -> socket.id

io.on('connection', socket => {
  const uid = socket.data.uid;
  online.set(uid, socket.id);
  db.collection('users').doc(uid).update({
    socketId: socket.id, online: true,
    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  socket.on('join_chat',  ({ chatId }) => chatId && socket.join(`chat:${chatId}`));
  socket.on('leave_chat', ({ chatId }) => socket.leave(`chat:${chatId}`));

  socket.on('typing_start', ({ chatId }) => socket.to(`chat:${chatId}`).emit('typing_start', { uid }));
  socket.on('typing_stop',  ({ chatId }) => socket.to(`chat:${chatId}`).emit('typing_stop',  { uid }));

  socket.on('new_message', async ({ chatId, messageId, senderUid, recipientUid, preview }) => {
    const rSock = online.get(recipientUid);
    if (rSock) {
      io.to(rSock).emit('new_message',      { chatId, messageId, senderUid, preview });
      io.to(rSock).emit('message_delivered',{ chatId, messageId });
      socket.emit('message_delivered',      { chatId, messageId });
      await db.collection('chats').doc(chatId).collection('messages').doc(messageId)
        .update({ status: 'delivered' }).catch(() => {});
    }
    // FCM push
    try {
      const snap = await db.collection('users').doc(recipientUid).get();
      const tok  = snap.data()?.pushToken;
      if (tok) await admin.messaging().send({
        token: tok,
        notification: { title: 'New message', body: preview ?? 'You have a new message' },
        data: { chatId, messageId, senderUid, type: 'new_message' },
        android: { priority: 'high', notification: { sound: 'default', channelId: 'messages' } },
      });
    } catch (e) { console.warn('[FCM]', e.message); }
  });

  socket.on('message_read', async ({ chatId, messageId, readerUid, senderUid }) => {
    await db.collection('chats').doc(chatId).collection('messages').doc(messageId)
      .update({ status: 'read' }).catch(() => {});
    await db.collection('chats').doc(chatId)
      .update({ [`unread.${readerUid}`]: 0 }).catch(() => {});
    const sSock = online.get(senderUid);
    if (sSock) io.to(sSock).emit('message_read', { chatId, messageId });
  });

  socket.on('message_edited',  d => socket.to(`chat:${d.chatId}`).emit('message_edited',  d));
  
  socket.on('reaction_updated', d => socket.to(`chat:${d.chatId}`).emit('reaction_updated', d));
  socket.on('message_deleted', d => socket.to(`chat:${d.chatId}`).emit('message_deleted', d));

  socket.on('disconnect', () => {
    online.delete(uid);
    db.collection('users').doc(uid).update({
      online: false, socketId: '',
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[VaultChat] Port ${PORT}`));
