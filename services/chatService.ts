/**
 * services/chatService.ts
 * Chat messaging service with modular Firebase SDK
 * ✅ Modern SDK, proper error handling, batch operations, validation
 */

import { getAuth } from '@react-native-firebase/auth';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    where,
    writeBatch
} from '@react-native-firebase/firestore';

const auth = getAuth();
const db = getFirestore();

/**
 * Get chat document ID from two user IDs (deterministic)
 */
export const getChatId = (uid1: string, uid2: string): string => 
  [uid1, uid2].sort().join('_');

/**
 * Send a message with proper error handling and validation
 * Uses batch write for atomicity between chat doc and message doc
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

    // ✅ Input validation
    if (!text?.trim()) throw new Error('Message cannot be empty');
    if (text.length > 4096) throw new Error('Message too long (max 4096 characters)');
    if (!receiverId?.trim()) throw new Error('Receiver ID required');
    if (type === 'timelock' && !unlockTime) {
      throw new Error('Unlock time required for timelock messages');
    }

    const chatId = getChatId(sender.uid, receiverId);

    // ✅ Use batch write for atomicity
    const batch = writeBatch(db);

    // Update or create chat document
    const chatRef = doc(db, 'chats', chatId);
    batch.set(chatRef, {
      participants: [sender.uid, receiverId],
      lastMessage: type === 'timelock' ? '🔒 TimeLock Message' : text.substring(0, 100),
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
    console.log('[CHAT] Message sent from', sender.uid, 'to', receiverId);
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
        try {
          const msgs = snap.docs.map(d => {
            const data = d.data();
            return {
              id: d.id,
              ...data,
              time: data.createdAt
                ? data.createdAt.toDate().toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '',
              sent: data.senderId === sender.uid,
            };
          });
          callback(msgs);
        } catch (error) {
          console.error('[LISTEN_MESSAGES] Processing error:', error);
        }
      },
      (error) => {
        console.error('[LISTEN_MESSAGES] Listener error:', error);
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

              try {
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
              } catch (error) {
                console.error('[LISTEN_CHATS] Failed to fetch user', otherId, error);
                return null;
              }
            })
          );

          // Filter out null entries
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
 * Mark messages as read using batch operation
 */
export const markAsRead = async (receiverId: string) => {
  try {
    const sender = auth.currentUser;
    if (!sender) throw new Error('Not logged in');

    const chatId = getChatId(sender.uid, receiverId);
    const q = query(
      collection(db, `chats/${chatId}/messages`),
      where('read', '==', false),
      where('receiverId', '==', sender.uid)
    );

    const snap = await getDocs(q);

    if (snap.docs.length === 0) return; // Nothing to update

    // ✅ Use batch for multiple updates
    const batch = writeBatch(db);
    snap.docs.forEach(d => {
      batch.update(d.ref, { read: true });
    });

    await batch.commit();
    console.log('[CHAT] Marked', snap.docs.length, 'messages as read');
  } catch (error) {
    console.error('[CHAT] markAsRead failed:', error);
    throw new Error(error?.message || 'Failed to mark messages as read');
  }
};

/**
 * Search users by email with validation
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
      ...d.data(),
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
    if (!chatId?.trim()) throw new Error('Chat ID required');

    // ✅ Delete subcollection first
    const messagesRef = collection(db, `chats/${chatId}/messages`);
    const messageSnap = await getDocs(messagesRef);

    const batch = writeBatch(db);

    // Delete all messages
    messageSnap.docs.forEach(d => batch.delete(d.ref));

    // Delete chat document
    batch.delete(doc(db, 'chats', chatId));

    await batch.commit();
    console.log('[CHAT] Chat deleted:', chatId, '(', messageSnap.docs.length, 'messages)');
  } catch (error) {
    console.error('[CHAT] deleteChat failed:', error);
    throw new Error(error?.message || 'Failed to delete chat');
  }
};

/**
 * Get user's chat count
 */
export const getChatCount = async (uid: string): Promise<number> => {
  try {
    if (!uid?.trim()) throw new Error('User ID required');

    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', uid)
    );

    const snap = await getDocs(q);
    return snap.docs.length;
  } catch (error) {
    console.error('[CHAT] getChatCount failed:', error);
    return 0;
  }
};

/**
 * Get unread message count for a chat
 */
export const getUnreadCount = async (chatId: string, uid: string): Promise<number> => {
  try {
    if (!chatId?.trim()) throw new Error('Chat ID required');
    if (!uid?.trim()) throw new Error('User ID required');

    const q = query(
      collection(db, `chats/${chatId}/messages`),
      where('read', '==', false),
      where('receiverId', '==', uid)
    );

    const snap = await getDocs(q);
    return snap.docs.length;
  } catch (error) {
    console.error('[CHAT] getUnreadCount failed:', error);
    return 0;
  }
};