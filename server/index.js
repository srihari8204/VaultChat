// server/index.js
// VaultChat backend — deployed on Render
// https://vaultchat.onrender.com
//
// WebRTC signaling:
//   call_offer     → forwards offer to recipient
//   call_answer    → forwards answer to caller
//   ice_candidate  → forwards ICE candidates both ways
//   call_end       → notifies remote peer
//
// On connect: saves socketId to Firestore so app can look it up
// On disconnect: removes socketId from Firestore

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const admin      = require('firebase-admin');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin:  '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// ── Firebase Admin SDK ────────────────────────────────────────────
// Initialize with service account for writing socketId to Firestore
// Set FIREBASE_SERVICE_ACCOUNT env var on Render with your JSON key
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set — socketId sync disabled');
  }
} catch (e) {
  console.error('Firebase Admin init error:', e.message);
}

// ── Track uid → socketId mapping in memory ────────────────────────
// Also written to Firestore for cross-server lookup
const uidToSocket = new Map(); // uid → socketId
const socketToUid = new Map(); // socketId → uid

// ── Health endpoint — for cron-job.org uptime monitor ────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    uptime:      Math.floor(process.uptime()),
    connections: uidToSocket.size,
    service:     'VaultChat Backend',
    version:     '2.0.0',
  });
});

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  // ── Register — called right after connect with user's Firebase UID
  socket.on('register', async (uid) => {
    if (!uid) return;

    uidToSocket.set(uid, socket.id);
    socketToUid.set(socket.id, uid);
    socket.join(uid); // join room named by UID for easy targeting

    console.log(`[Socket] User ${uid} registered as ${socket.id}`);

    // Save socketId to Firestore so mobile app can look it up
    if (db) {
      try {
        await db.collection('users').doc(uid).update({
          socketId:          socket.id,
          socketConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
          online:            true,
        });
      } catch (e) {
        console.warn('[Socket] Firestore update failed:', e.message);
      }
    }
  });

  // ── WebRTC: Outgoing call offer ───────────────────────────────
  // Caller sends offer to callee via their socketId
  socket.on('call_offer', ({ toSocketId, offer, callType, callerName, chatId }) => {
    console.log(`[Call] Offer from ${socket.id} to ${toSocketId} (${callType})`);

    io.to(toSocketId).emit('call_offer_for_you', {
      offer,
      fromSocketId: socket.id,
      callType,
      callerName,
      chatId,
    });
  });

  // ── WebRTC: Call answer ───────────────────────────────────────
  // Callee sends answer back to caller
  socket.on('call_answer', ({ toSocketId, answer }) => {
    console.log(`[Call] Answer from ${socket.id} to ${toSocketId}`);

    io.to(toSocketId).emit('call_answered', {
      answer,
      fromSocketId: socket.id,
    });
  });

  // ── WebRTC: ICE candidates ────────────────────────────────────
  // Both peers exchange ICE candidates for NAT traversal
  socket.on('ice_candidate', ({ toSocketId, candidate }) => {
    io.to(toSocketId).emit('ice_candidate', {
      candidate,
      fromSocketId: socket.id,
    });
  });

  // ── WebRTC: End call ──────────────────────────────────────────
  socket.on('call_end', ({ toSocketId }) => {
    console.log(`[Call] Ended by ${socket.id} → ${toSocketId}`);
    io.to(toSocketId).emit('call_ended', { fromSocketId: socket.id });
  });

  // ── Messages: Forward encrypted payload ──────────────────────
  // Server NEVER decrypts — only forwards ciphertext
  // This is used for real-time delivery; Firestore is the source of truth
  socket.on('send_message', ({ toUid, encryptedPayload }) => {
    const toSocketId = uidToSocket.get(toUid);
    if (toSocketId) {
      io.to(toSocketId).emit('receive_message', {
        encryptedPayload,
        fromSocketId: socket.id,
      });
    }
  });

  // ── Typing indicator ──────────────────────────────────────────
  socket.on('typing', ({ toUid, chatId }) => {
    const toSocketId = uidToSocket.get(toUid);
    if (toSocketId) {
      io.to(toSocketId).emit('typing', { chatId, fromSocketId: socket.id });
    }
  });

  socket.on('stop_typing', ({ toUid, chatId }) => {
    const toSocketId = uidToSocket.get(toUid);
    if (toSocketId) {
      io.to(toSocketId).emit('stop_typing', { chatId });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const uid = socketToUid.get(socket.id);
    console.log(`[Socket] Disconnected: ${socket.id} (uid: ${uid})`);

    uidToSocket.delete(uid);
    socketToUid.delete(socket.id);

    // Mark user offline in Firestore
    if (db && uid) {
      try {
        await db.collection('users').doc(uid).update({
          socketId:             null,
          online:               false,
          lastSeen:             admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn('[Socket] Firestore offline update failed:', e.message);
      }
    }
  });
});

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VaultChat backend running on port ${PORT}`);
});
