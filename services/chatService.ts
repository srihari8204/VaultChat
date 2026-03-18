// @ts-nocheck
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const db = firestore();

export const getChatId = (uid1: string, uid2: string): string => [uid1, uid2].sort().join('_');

export const sendMessage = async (receiverId: string, text: string, type: 'text' | 'timelock' = 'text', unlockTime?: string) => {
  const sender = auth().currentUser;
  if (!sender) throw new Error('Not logged in');
  const chatId = getChatId(sender.uid, receiverId);
  await db.collection('chats').doc(chatId).set({
    participants: [sender.uid, receiverId],
    lastMessage: type === 'timelock' ? 'TimeLock Message' : text,
    lastMessageAt: firestore.FieldValue.serverTimestamp(),
    updatedAt: firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await db.collection('chats').doc(chatId).collection('messages').add({
    text, senderId: sender.uid, senderName: sender.displayName || 'Unknown',
    receiverId, type, unlockTime: unlockTime || null,
    locked: type === 'timelock', read: false,
    createdAt: firestore.FieldValue.serverTimestamp(),
  });
};

export const listenToMessages = (receiverId: string, callback: (messages: any[]) => void) => {
  const sender = auth().currentUser;
  if (!sender) return () => {};
  const chatId = getChatId(sender.uid, receiverId);
  return db.collection('chats').doc(chatId).collection('messages')
    .orderBy('createdAt', 'asc')
    .onSnapshot((snap) => {
      const msgs = snap.docs.map(d => ({
        id: d.id, ...d.data(),
        time: d.data().createdAt ? d.data().createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        sent: d.data().senderId === sender.uid,
      }));
      callback(msgs);
    });
};

export const listenToChats = (callback: (chats: any[]) => void) => {
  const user = auth().currentUser;
  if (!user) return () => {};
  return db.collection('chats')
    .where('participants', 'array-contains', user.uid)
    .orderBy('updatedAt', 'desc')
    .onSnapshot(async (snap) => {
      const chats = await Promise.all(snap.docs.map(async (d) => {
        const data = d.data();
        const otherId = data.participants.find((id: string) => id !== user.uid);
        const otherUser = otherId ? await db.collection('users').doc(otherId).get() : null;
        const otherData = otherUser?.data();
        return {
          id: d.id, name: otherData?.displayName || 'Unknown',
          photo: otherData?.photoURL || 'https://i.pravatar.cc/150?u=' + otherId,
          lastMsg: data.lastMessage || '',
          time: data.lastMessageAt ? data.lastMessageAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          online: otherData?.online || false, verified: otherData?.verified || false, otherId,
        };
      }));
      callback(chats);
    });
};

export const markAsRead = async (receiverId: string) => {
  const sender = auth().currentUser;
  if (!sender) return;
  const chatId = getChatId(sender.uid, receiverId);
  const snap = await db.collection('chats').doc(chatId).collection('messages')
    .where('read', '==', false).where('receiverId', '==', sender.uid).get();
  await Promise.all(snap.docs.map(d => d.ref.update({ read: true })));
};

export const searchUsers = async (email: string) => {
  const snap = await db.collection('users').where('email', '==', email).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};