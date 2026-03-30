# Firebase CRUD Fixes - Implementation Guide

## 🚀 Quick Wins (Can implement today)

---

## 1. Fix Location Service (CRITICAL)

**Before:** `vaultchat-backend/routes/location.js`
```javascript
const locationStore = new Map(); // ❌ Lost on restart

router.post('/share', (req, res) => {
  locationStore.set(id, session);
};
```

**After:** Use Firestore persistence
```javascript
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const admin   = require('firebase-admin');

const db = admin.firestore();

// POST /api/location/share
// Body: { uid, mode, durationMinutes, lat, lng, address }
router.post('/share', async (req, res) => {
  try {
    const { uid, mode, durationMinutes, lat, lng, address } = req.body;
    
    // Validation
    if (!uid || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'uid, lat (number), lng (number) required' });
    }
    
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const id = uuidv4();
    const expiresAt = mode === 'current' && durationMinutes > 0
      ? Date.now() + durationMinutes * 60 * 1000
      : null;

    const session = {
      uid,
      mode,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      address: address || 'Unknown location',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ✅ Persist to Firestore
    await db.collection('location_shares').doc(id).set(session);

    // Schedule cleanup if expiring
    if (expiresAt) {
      setTimeout(async () => {
        try {
          await db.collection('location_shares').doc(id).update({
            active: false,
            endedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error('[Location] Cleanup failed:', e);
        }
      }, durationMinutes * 60 * 1000);
    }

    res.json({ success: true, id, session });
  } catch (err) {
    console.error('[Location] Share failed:', err);
    res.status(500).json({ error: 'Failed to share location' });
  }
});

// PUT /api/location/update/:id
router.put('/update/:id', async (req, res) => {
  try {
    const { lat, lng, address } = req.body;

    // Validation
    if (typeof lat === 'number') {
      if (lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'Invalid latitude' });
      }
    }
    if (typeof lng === 'number') {
      if (lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'Invalid longitude' });
      }
    }

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (typeof lat === 'number') updates.lat = lat;
    if (typeof lng === 'number') updates.lng = lng;
    if (address && typeof address === 'string') updates.address = address;

    await db.collection('location_shares').doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (err) {
    console.error('[Location] Update failed:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// GET /api/location/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection('location_shares').doc(req.params.id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const data = doc.data();
    
    if (data.expiresAt && Date.now() > data.expiresAt.toMillis?.() || data.expiresAt) {
      await db.collection('location_shares').doc(req.params.id).update({
        active: false,
      });
      return res.status(410).json({ error: 'Session expired' });
    }

    res.json({ success: true, session: { id: doc.id, ...data } });
  } catch (err) {
    console.error('[Location] Get failed:', err);
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

// DELETE /api/location/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.collection('location_shares').doc(req.params.id).update({
      active: false,
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Location] Delete failed:', err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

module.exports = router;
```

---

## 2. Fix Chat Service SDK Version (HIGH)

**File:** `services/chatService.ts`

```typescript
import { 
  collection, 
  doc, 
  addDoc, 
  setDoc,
  updateDoc,
  deleteDoc,
  query, 
  where, 
  orderBy, 
  onSnapshot,
  writeBatch,
  serverTimestamp,
  FieldValue,
  getDoc,
  getDocs,
} from '@react-native-firebase/firestore';
import { getAuth } from '@react-native-firebase/auth';
import { getFirestore } from '@react-native-firebase/firestore';

const auth = getAuth();
const db = getFirestore();

/**
 * Get chat document ID from two user IDs
 */
export const getChatId = (uid1: string, uid2: string): string => 
  [uid1, uid2].sort().join('_');

/**
 * Send a message with proper error handling
 */
export const sendMessage = async (
  receiverId: string,
  text: string,
  type: 'text' | 'timelock' = 'text',
  unlockTime?: string
) => {
  try {
    const sender = auth.currentUser;
    if (!sender) throw new Error('Not logged in');

    // Input validation
    if (!text?.trim()) throw new Error('Message cannot be empty');
    if (text.length > 4096) throw new Error('Message too long (max 4096)');
    if (!receiverId?.trim()) throw new Error('Receiver ID required');

    const chatId = getChatId(sender.uid, receiverId);

    // ✅ Use writeBatch for atomicity
    const batch = writeBatch(db);

    // Ensure chat exists with latest message
    const chatRef = doc(db, 'chats', chatId);
    batch.set(chatRef, {
      participants: [sender.uid, receiverId],
      lastMessage: type === 'timelock' ? 'TimeLock Message' : text,
      lastMessageAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // Add message to subcollection
    const messagesRef = doc(collection(db, `chats/${chatId}/messages`));
    batch.set(messagesRef, {
      text: text.trim(),
      senderId: sender.uid,
      senderName: sender.displayName || 'Unknown',
      receiverId,
      type,
      unlockTime: unlockTime || null,
      locked: type === 'timelock',
      read: false,
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    console.log('[CHAT] Message sent:', chatId);
  } catch (error) {
    console.error('[CHAT] sendMessage failed:', error);
    throw new Error(error?.message || 'Failed to send message');
  }
};

/**
 * Listen to messages with proper cleanup and error handling
 */
export const listenToMessages = (
  receiverId: string,
  callback: (messages: any[]) => void
) => {
  try {
    const sender = auth.currentUser;
    if (!sender) return () => {};

    const chatId = getChatId(sender.uid, receiverId);
    const q = query(
      collection(db, `chats/${chatId}/messages`),
      orderBy('createdAt', 'asc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const msgs = snap.docs.map(d => ({
          id: d.id,
          ...d.data(),
          time: d.data().createdAt
            ? d.data().createdAt.toDate().toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
              })
            : '',
          sent: d.data().senderId === sender.uid,
        }));
        callback(msgs);
      },
      (error) => {
        console.error('[LISTEN_MESSAGES] Error:', error);
      }
    );

    return unsubscribe; // ✅ Proper cleanup function
  } catch (error) {
    console.error('[LISTEN_MESSAGES] Setup failed:', error);
    return () => {};
  }
};

/**
 * Listen to user's chats with error handling
 */
export const listenToChats = (callback: (chats: any[]) => void) => {
  try {
    const user = auth.currentUser;
    if (!user) return () => {};

    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', user.uid),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      async (snap) => {
        try {
          const chats = await Promise.all(
            snap.docs.map(async (d) => {
              const data = d.data();
              const otherId = data.participants?.find(
                (id: string) => id !== user.uid
              );

              if (!otherId) return null;

              const otherUserDoc = await getDoc(doc(db, 'users', otherId));
              const otherData = otherUserDoc.data();

              return {
                id: d.id,
                name: otherData?.name || otherData?.displayName || 'Unknown',
                photo: otherData?.photoURL || `https://i.pravatar.cc/150?u=${otherId}`,
                lastMsg: data.lastMessage || '',
                time: data.lastMessageAt
                  ? data.lastMessageAt.toDate().toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '',
                online: otherData?.online || false,
                verified: otherData?.verified || false,
                otherId,
              };
            })
          );

          callback(chats.filter(Boolean));
        } catch (error) {
          console.error('[LISTEN_CHATS] Processing error:', error);
        }
      },
      (error) => {
        console.error('[LISTEN_CHATS] Listener error:', error);
      }
    );

    return unsubscribe; // ✅ Proper cleanup
  } catch (error) {
    console.error('[LISTEN_CHATS] Setup failed:', error);
    return () => {};
  }
};

/**
 * Mark messages as read
 */
export const markAsRead = async (receiverId: string) => {
  try {
    const sender = auth.currentUser;
    if (!sender) return;

    const chatId = getChatId(sender.uid, receiverId);
    const q = query(
      collection(db, `chats/${chatId}/messages`),
      where('read', '==', false),
      where('receiverId', '==', sender.uid)
    );

    const snap = await getDocs(q);
    
    // ✅ Use batch for multiple updates
    const batch = writeBatch(db);
    snap.docs.forEach(d => {
      batch.update(d.ref, { read: true });
    });
    
    if (snap.docs.length > 0) {
      await batch.commit();
      console.log('[CHAT] Marked', snap.docs.length, 'messages as read');
    }
  } catch (error) {
    console.error('[CHAT] markAsRead failed:', error);
    throw new Error(error?.message || 'Failed to mark messages as read');
  }
};

/**
 * Search users by email
 */
export const searchUsers = async (email: string) => {
  try {
    if (!email?.trim()) throw new Error('Email required');
    if (!email.includes('@')) throw new Error('Invalid email format');

    const q = query(
      collection(db, 'users'),
      where('email', '==', email.toLowerCase().trim())
    );

    const snap = await getDocs(q);
    return snap.docs.map(d => ({ 
      id: d.id, 
      ...d.data() 
    }));
  } catch (error) {
    console.error('[CHAT] searchUsers failed:', error);
    throw new Error(error?.message || 'Search failed');
  }
};

/**
 * Delete a chat and all its messages (cascade delete)
 */
export const deleteChat = async (chatId: string) => {
  try {
    // ✅ Delete subcollection first
    const messagesRef = collection(db, `chats/${chatId}/messages`);
    const messageSnap = await getDocs(messagesRef);

    const batch = writeBatch(db);
    
    // Delete all messages
    messageSnap.docs.forEach(d => batch.delete(d.ref));
    
    // Delete chat document
    batch.delete(doc(db, 'chats', chatId));

    await batch.commit();
    console.log('[CHAT] Chat deleted:', chatId);
  } catch (error) {
    console.error('[CHAT] deleteChat failed:', error);
    throw new Error(error?.message || 'Failed to delete chat');
  }
};
```

---

## 3. Fix Face Authentication with Transactions (CRITICAL)

**File:** `vaultchat-backend/routes/face.js`

```javascript
const express = require("express");
const router  = express.Router();
const admin   = require("firebase-admin");

const db = admin.firestore();
const MATCH_THRESHOLD = 0.82;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// POST /api/face/register
router.post("/register", async (req, res) => {
  try {
    const { uid, encryptedTemplate, deviceId } = req.body;
    
    // Validation
    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ error: "Valid uid required" });
    }
    if (!encryptedTemplate || typeof encryptedTemplate !== 'string') {
      return res.status(400).json({ error: "encryptedTemplate required" });
    }
    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(400).json({ error: "deviceId required" });
    }

    // ✅ Use updateDoc instead of set with merge
    await db.collection("users").doc(uid).update({
      faceTemplate:    encryptedTemplate,
      templateVersion: 1,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
      trustedDevices:  admin.firestore.FieldValue.arrayUnion(deviceId),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[FACE] Register failed:', error);
    res.status(500).json({ error: error.message || "Registration failed" });
  }
});

// POST /api/face/verify
// ✅ Use transaction for atomic read + write
router.post("/verify", async (req, res) => {
  try {
    const { uid, faceVector } = req.body;

    // Validation
    if (!uid || typeof uid !== 'string') {
      return res.status(400).json({ error: "Valid uid required" });
    }
    if (!Array.isArray(faceVector) || faceVector.length === 0) {
      return res.status(400).json({ error: "Valid faceVector array required" });
    }

    // ✅ Transaction ensures read and write are atomic
    const result = await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error("User not found");
      }

      const data = userDoc.data();

      // Check lockout
      const lockedUntil = data.faceLockedUntil?.toDate?.() || null;
      if (lockedUntil && new Date() < lockedUntil) {
        return {
          match: false,
          locked: true,
          lockedUntil: lockedUntil.toISOString(),
        };
      }

      // Get stored template
      const storedVector = data.faceTemplate ? 
        JSON.parse(data.faceTemplate) : 
        [];

      if (!storedVector.length) {
        // First enrollment - auto-trust
        return { match: true, firstTime: true };
      }

      // Calculate similarity
      const score = cosineSimilarity(faceVector, storedVector);
      const match = score >= MATCH_THRESHOLD;

      if (match) {
        // Reset failed attempts
        transaction.update(userRef, {
          failedFaceAttempts: 0,
          faceLockedUntil: null,
          lastVerified: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { match: true, score };
      } else {
        // Increment failed attempts
        const newAttempts = (data.failedFaceAttempts || 0) + 1;
        const updates = {
          failedFaceAttempts: newAttempts,
        };

        // Lock after max attempts
        if (newAttempts >= MAX_FAILED_ATTEMPTS) {
          updates.faceLockedUntil = new Date(
            Date.now() + LOCKOUT_DURATION_MS
          );
        }

        transaction.update(userRef, updates);
        return { 
          match: false, 
          attempts: newAttempts,
          locked: newAttempts >= MAX_FAILED_ATTEMPTS,
        };
      }
    });

    res.json(result);
  } catch (error) {
    console.error('[FACE] Verify failed:', error);
    res.status(500).json({ error: error.message || "Verification failed" });
  }
});

module.exports = router;
```

---

## 4. Add Firestore Indexes Configuration

**File:** `firestore.indexes.json`

```json
{
  "indexes": [
    {
      "collectionGroup": "chats",
      "queryScope": "Collection",
      "fields": [
        { "fieldPath": "participants", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "messages",
      "queryScope": "Collection",
      "fields": [
        { "fieldPath": "read", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "users",
      "queryScope": "Collection",
      "fields": [
        { "fieldPath": "phoneHash", "order": "ASCENDING" }
      ]
    }
  ]
}
```

---

## ✅ Testing the Fixes

```bash
# Test location service
curl -X POST http://localhost:5000/api/location/share \
  -H "Content-Type: application/json" \
  -d '{
    "uid": "user123",
    "lat": 37.7749,
    "lng": -122.4194,
    "address": "San Francisco, CA"
  }'

# Test chat service
curl -X POST http://localhost:5000/api/chat/send \
  -H "Content-Type: application/json" \
  -d '{
    "receiverId": "user456",
    "text": "Hello!",
    "type": "text"
  }'

# Test face verification
curl -X POST http://localhost:5000/api/face/verify \
  -H "Content-Type: application/json" \
  -d '{
    "uid": "user123",
    "faceVector": [0.1, 0.2, 0.3, ...]
  }'
```

---

## 📝 Summary of Changes

| Component | Change | Impact |
|-----------|--------|--------|
| Location Service | Moved from Map to Firestore | ✅ Data persistence |
| Chat Service | Migrated to modular SDK | ✅ Consistency + features |
| Face Verify | Added transaction | ✅ No race conditions |
| All CRUD | Added validation + error handling | ✅ Reliability |
| Indexes | Created composite indexes | ✅ Query performance |

**Status:** All critical fixes ready for implementation ✅
