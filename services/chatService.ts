import { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, doc, setDoc, getDoc, getDocs, where, updateDoc, Timestamp } from 'firebase/firestore';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
const db = firestore();

export const getChatId = (uid1: string, uid2: string): string => [uid1, uid2].sort().join('_');

export const sendMessage = async (receiverId: string, text: string, type: 'text' | 'timelock' = 'text', unlockTime?: string) => {
  const sender = auth.currentUser;
  if (!sender) throw new Error('Not logged in');
  const chatId = getChatId(sender.uid, receiverId);
  await setDoc(doc(db, 'chats', chatId), {
    participants: [sender.uid, receiverId],
    lastMessage: type === 'timelock' ? 'TimeLock Message' : text,
    lastMessageAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }, { merge: true });
  await addDoc(collection(db, 'chats', chatId, 'messages'), {
    text, senderId: sender.uid, senderName: sender.displayName || 'Unknown',
    receiverId, type, unlockTime: unlockTime || null,
    locked: type === 'timelock', read: false, createdAt: serverTimestamp(),
  });
};

export const listenToMessages = (receiverId: string, callback: (messages: any[]) => void) => {
  const sender = auth.currentUser;
  if (!sender) return () => {};
  const chatId = getChatId(sender.uid, receiverId);
  const q = query(collection(db, 'chats', chatId, 'messages'), orderBy('createdAt', 'asc'));
  return onSnapshot(q, (snap) => {
    const msgs = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      time: d.data().createdAt ? (d.data().createdAt as Timestamp).toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      sent: d.data().senderId === sender.uid,
    }));
    callback(msgs);
  });
};

export const listenToChats = (callback: (chats: any[]) => void) => {
  const user = auth.currentUser;
  if (!user) return () => {};
  const q = query(collection(db, 'chats'), where('participants', 'array-contains', user.uid), orderBy('updatedAt', 'desc'));
  return onSnapshot(q, async (snap) => {
    const chats = await Promise.all(snap.docs.map(async (d) => {
      const data = d.data();
      const otherId = data.participants.find((id: string) => id !== user.uid);
      const otherUser = otherId ? await getDoc(doc(db, 'users', otherId)) : null;
      const otherData = otherUser?.data();
      return {
        id: d.id, name: otherData?.displayName || 'Unknown',
        photo: otherData?.photoURL || 'https://i.pravatar.cc/150?u=' + otherId,
        lastMsg: data.lastMessage || '',
        time: data.lastMessageAt ? (data.lastMessageAt as Timestamp).toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        online: otherData?.online || false, verified: otherData?.verified || false, otherId,
      };
    }));
    callback(chats);
  });
};

export const markAsRead = async (receiverId: string) => {
  const sender = auth.currentUser;
  if (!sender) return;
  const chatId = getChatId(sender.uid, receiverId);
  const q = query(collection(db, 'chats', chatId, 'messages'), where('read', '==', false), where('receiverId', '==', sender.uid));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map(d => updateDoc(d.ref, { read: true })));
};

export const searchUsers = async (email: string) => {
  const q = query(collection(db, 'users'), where('email', '==', email));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};
