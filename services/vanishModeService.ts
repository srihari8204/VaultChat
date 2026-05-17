// services/vanishModeService.ts
// Vanish Mode — messages disappear after both users read them
// Per-chat toggle stored in Firestore chat document
// Deletion happens on the reader's device after confirming both read

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

// Check if vanish mode is enabled for a chat
export async function isVanishModeOn(chatId: string): Promise<boolean> {
  try {
    const doc = await firestore().collection('chats').doc(chatId).get();
    return doc.data()?.vanishMode === true;
  } catch {
    return false;
  }
}

// Toggle vanish mode for a chat
export async function toggleVanishMode(chatId: string): Promise<boolean> {
  const current = await isVanishModeOn(chatId);
  const newVal = !current;
  await firestore().collection('chats').doc(chatId).update({
    vanishMode: newVal,
    vanishModeChangedAt: firestore.FieldValue.serverTimestamp(),
    vanishModeChangedBy: auth().currentUser?.uid ?? '',
  });
  return newVal;
}

// Delete messages that both users have read (called after marking messages as read)
export async function deleteVanishedMessages(chatId: string): Promise<number> {
  try {
    const uid = auth().currentUser?.uid;
    if (!uid) return 0;

    // Get chat doc to check vanish mode
    const chatDoc = await firestore().collection('chats').doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data()?.vanishMode !== true) return 0;

    // Find all messages with status 'read'
    const snap = await firestore()
      .collection('chats').doc(chatId).collection('messages')
      .where('status', '==', 'read')
      .get();

    if (snap.empty) return 0;

    // Delete in batches
    const batch = firestore().batch();
    let count = 0;
    snap.docs.forEach(doc => {
      batch.delete(doc.ref);
      count++;
    });

    if (count > 0) await batch.commit();
    return count;
  } catch {
    return 0;
  }
}

// Add vanish mode system message when toggled
export async function addVanishSystemMessage(chatId: string, enabled: boolean): Promise<void> {
  const uid = auth().currentUser?.uid;
  if (!uid) return;

  await firestore().collection('chats').doc(chatId).collection('messages').add({
    senderId: 'system',
    plaintext: enabled
      ? '👻 Vanish Mode turned ON — messages will disappear after both read'
      : '👻 Vanish Mode turned OFF — messages will be kept',
    ciphertext: '', iv: '',
    msgType: 'text',
    status: 'read',
    isSystem: true,
    isDeleted: false,
    reactions: {},
    createdAt: firestore.FieldValue.serverTimestamp(),
  });
}
