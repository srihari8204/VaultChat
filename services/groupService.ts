// services/groupService.ts
// Create / manage encrypted group chats

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  photoURL?: string;
  participants: string[];       // UIDs
  participantNames: Record<string, string>;
  participantPhotos: Record<string, string>;
  admins: string[];
  createdBy: string;
  createdAt: any;
  lastMsg: string;
  lastTime: any;
  unread: Record<string, number>;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  disappearingTimer?: number;   // seconds, 0 = off
  pinnedMessageId?: string;
  isGroup: true;
}

export async function createGroup(
  name: string,
  memberUids: string[],
  memberNames: Record<string, string>,
  memberPhotos: Record<string, string>
): Promise<string> {
  const myUid = auth().currentUser!.uid;
  const participants = [myUid, ...memberUids.filter(u => u !== myUid)];

  const unread: Record<string, number> = {};
  participants.forEach(u => { unread[u] = 0; });

  const ref = await firestore().collection('chats').add({
    isGroup: true,
    name,
    participants,
    participantNames: memberNames,
    participantPhotos: memberPhotos,
    admins: [myUid],
    createdBy: myUid,
    lastMsg: `${memberNames[myUid] ?? 'Someone'} created the group`,
    lastTime: firestore.FieldValue.serverTimestamp(),
    unread,
    pinned: false,
    archived: false,
    muted: false,
    disappearingTimer: 0,
    createdAt: firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function addMember(chatId: string, uid: string, name: string, photo: string) {
  await firestore().collection('chats').doc(chatId).update({
    participants: firestore.FieldValue.arrayUnion(uid),
    [`participantNames.${uid}`]: name,
    [`participantPhotos.${uid}`]: photo,
    [`unread.${uid}`]: 0,
  });
}

export async function removeMember(chatId: string, uid: string) {
  await firestore().collection('chats').doc(chatId).update({
    participants: firestore.FieldValue.arrayRemove(uid),
  });
}

export async function setDisappearingTimer(chatId: string, seconds: number) {
  await firestore().collection('chats').doc(chatId).update({ disappearingTimer: seconds });
}

export async function pinMessage(chatId: string, messageId: string) {
  await firestore().collection('chats').doc(chatId).update({ pinnedMessageId: messageId });
}

export async function muteChat(chatId: string, muted: boolean) {
  await firestore().collection('chats').doc(chatId).update({ muted });
}

export async function archiveChat(chatId: string, archived: boolean) {
  await firestore().collection('chats').doc(chatId).update({ archived });
}

export async function pinChat(chatId: string, pinned: boolean) {
  await firestore().collection('chats').doc(chatId).update({ pinned });
}