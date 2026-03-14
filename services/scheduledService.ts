// services/scheduledService.ts
// Schedule a message to send at a future time
// Uses Firestore + background fetch / notification trigger

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import * as Notifications from 'expo-notifications';

export interface ScheduledMessage {
  id: string;
  chatId: string;
  peerUid: string;
  chatName: string;
  plaintext: string;
  scheduledFor: Date;
  sent: boolean;
  createdAt: any;
}

// Save a scheduled message to Firestore
export async function scheduleMessage(
  chatId: string,
  peerUid: string,
  chatName: string,
  plaintext: string,
  scheduledFor: Date
): Promise<string> {
  const myUid = auth().currentUser!.uid;
  const ref   = await firestore()
    .collection('users').doc(myUid)
    .collection('scheduledMessages')
    .add({
      chatId, peerUid, chatName, plaintext,
      scheduledFor: firestore.Timestamp.fromDate(scheduledFor),
      sent: false,
      createdAt: firestore.FieldValue.serverTimestamp(),
    });

  // Also schedule a local notification so the app wakes up to send it
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Scheduled message ready',
      body:  `Send to ${chatName}: "${plaintext.substring(0, 40)}"`,
      data:  { type: 'scheduled', scheduleId: ref.id, chatId, peerUid },
    },
    trigger: { date: scheduledFor },
  });

  return ref.id;
}

// Load all pending scheduled messages for the current user
export async function getPendingScheduled(): Promise<ScheduledMessage[]> {
  const myUid = auth().currentUser!.uid;
  const snap  = await firestore()
    .collection('users').doc(myUid)
    .collection('scheduledMessages')
    .where('sent', '==', false)
    .get();

  return snap.docs.map(d => ({
    id: d.id,
    ...(d.data() as any),
    scheduledFor: d.data().scheduledFor?.toDate(),
  }));
}

// Mark as sent
export async function markScheduledSent(id: string) {
  const myUid = auth().currentUser!.uid;
  await firestore()
    .collection('users').doc(myUid)
    .collection('scheduledMessages').doc(id)
    .update({ sent: true });
}

// Delete a scheduled message
export async function deleteScheduled(id: string) {
  const myUid = auth().currentUser!.uid;
  await firestore()
    .collection('users').doc(myUid)
    .collection('scheduledMessages').doc(id)
    .delete();
}