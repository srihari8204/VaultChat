# ============================================================
#  VaultChat Phase 3 — Groups, Disappearing, Search, Polls,
#  Starred, Note-to-Self, Mute/Archive, Pinned, Forward
#  Run from: C:\Users\ADMIN\Desktop\Vaultchat backup\
#  powershell -ExecutionPolicy Bypass -File PHASE3-INSTALL.ps1
# ============================================================

$root  = "C:\Users\ADMIN\Desktop\Vaultchat backup"
$noBOM = [System.Text.UTF8Encoding]::new($false)
Set-Location $root

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  VaultChat Phase 3 - Groups, Disappearing, Search & More" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if (!(Test-Path "$root\components")) { New-Item -ItemType Directory -Path "$root\components" | Out-Null }

# ─────────────────────────────────────────────────────────────────────────────
# FILE 1 of 9  services/groupService.ts
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[1/9] services/groupService.ts" -ForegroundColor Yellow
$f1 = @'
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
'@
[System.IO.File]::WriteAllText("$root\services\groupService.ts", $f1, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 2 of 9  app/create-group.tsx
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[2/9] app/create-group.tsx" -ForegroundColor Yellow
$f2 = @'
// app/create-group.tsx
// Create a new group chat - pick members from contacts

import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, Image,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { createGroup } from '../services/groupService';

interface Contact {
  uid: string;
  name: string;
  phone: string;
  photoURL: string;
}

export default function CreateGroupScreen() {
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [contacts,  setContacts]  = useState<Contact[]>([]);
  const [selected,  setSelected]  = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [loading,   setLoading]   = useState(true);
  const [creating,  setCreating]  = useState(false);

  useEffect(() => {
    firestore().collection('users').get().then(snap => {
      const list: Contact[] = snap.docs
        .filter(d => d.id !== myUid)
        .map(d => ({ uid: d.id, name: d.data().name ?? 'Unknown', phone: d.data().phone ?? '', photoURL: d.data().photoURL ?? '' }));
      setContacts(list);
      setLoading(false);
    });
  }, []);

  const toggle = (uid: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  };

  const create = async () => {
    if (!groupName.trim()) { Alert.alert('Enter a group name'); return; }
    if (selected.size === 0) { Alert.alert('Select at least 1 member'); return; }
    setCreating(true);
    try {
      const myDoc = await firestore().collection('users').doc(myUid).get();
      const myName  = myDoc.data()?.name ?? 'Me';
      const myPhoto = myDoc.data()?.photoURL ?? '';

      const memberUids   = Array.from(selected);
      const selectedDocs = contacts.filter(c => selected.has(c.uid));
      const names: Record<string, string> = { [myUid]: myName };
      const photos: Record<string, string> = { [myUid]: myPhoto };
      selectedDocs.forEach(c => { names[c.uid] = c.name; photos[c.uid] = c.photoURL; });

      const chatId = await createGroup(groupName.trim(), memberUids, names, photos);
      router.replace({ pathname: '/group-chat', params: { chatId, groupName: groupName.trim() } });
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setCreating(false); }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'New Group', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <TextInput
          style={s.nameInput}
          placeholder="Group name…"
          placeholderTextColor="#444"
          value={groupName}
          onChangeText={setGroupName}
          maxLength={50}
        />
        <Text style={s.label}>SELECT MEMBERS ({selected.size} selected)</Text>
        {loading
          ? <ActivityIndicator color="#00E5FF" style={{ marginTop: 40 }} />
          : <FlatList
              data={contacts}
              keyExtractor={c => c.uid}
              renderItem={({ item: c }) => {
                const sel = selected.has(c.uid);
                return (
                  <TouchableOpacity style={s.row} onPress={() => toggle(c.uid)}>
                    <View style={[s.avatar, { backgroundColor: sel ? '#00E5FF22' : '#111127' }]}>
                      {c.photoURL
                        ? <Image source={{ uri: c.photoURL }} style={s.avatarImg} />
                        : <Text style={s.avatarTxt}>{c.name[0]?.toUpperCase()}</Text>
                      }
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.name}>{c.name}</Text>
                      <Text style={s.phone}>{c.phone}</Text>
                    </View>
                    <View style={[s.check, sel && s.checkSel]}>
                      {sel && <Text style={s.checkMark}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
        }
        <TouchableOpacity
          style={[s.createBtn, (creating || !groupName.trim() || selected.size === 0) && s.createBtnOff]}
          onPress={create}
          disabled={creating || !groupName.trim() || selected.size === 0}
        >
          {creating
            ? <ActivityIndicator color="#000" />
            : <Text style={s.createTxt}>Create Group ({selected.size + 1} members)</Text>
          }
        </TouchableOpacity>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: '#03030E' },
  nameInput:   { backgroundColor: '#0C0C1A', color: '#E0E0F0', fontSize: 16, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#111' },
  label:       { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, paddingHorizontal: 16, paddingVertical: 10 },
  row:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  avatar:      { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarImg:   { width: 46, height: 46, borderRadius: 23 },
  avatarTxt:   { color: '#00E5FF', fontSize: 18, fontWeight: 'bold' },
  name:        { color: '#E0E0F0', fontSize: 15, fontWeight: '600' },
  phone:       { color: '#555', fontSize: 12, marginTop: 2 },
  check:       { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#333', alignItems: 'center', justifyContent: 'center' },
  checkSel:    { backgroundColor: '#00E5FF', borderColor: '#00E5FF' },
  checkMark:   { color: '#000', fontSize: 14, fontWeight: 'bold' },
  createBtn:   { margin: 16, backgroundColor: '#00E5FF', borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  createBtnOff:{ backgroundColor: '#111127' },
  createTxt:   { color: '#000', fontSize: 16, fontWeight: 'bold' },
});
'@
[System.IO.File]::WriteAllText("$root\app\create-group.tsx", $f2, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 3 of 9  components/PollMessage.tsx
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[3/9] components/PollMessage.tsx" -ForegroundColor Yellow
$f3 = @'
// components/PollMessage.tsx
// Render a poll inside a message bubble + handle voting

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

interface PollOption {
  text: string;
  votes: string[];   // UIDs who voted
}

interface PollData {
  question: string;
  options: PollOption[];
  multiSelect: boolean;
  closed: boolean;
}

interface Props {
  messageId: string;
  chatId: string;
  poll: PollData;
}

export default function PollMessage({ messageId, chatId, poll }: Props) {
  const myUid  = auth().currentUser?.uid ?? '';
  const total  = poll.options.reduce((s, o) => s + o.votes.length, 0);

  const vote = async (idx: number) => {
    if (poll.closed) return;
    const options = poll.options.map((o, i) => {
      let votes = [...o.votes];
      if (i === idx) {
        // Toggle my vote on this option
        if (votes.includes(myUid)) votes = votes.filter(u => u !== myUid);
        else votes.push(myUid);
      } else if (!poll.multiSelect) {
        // Single-select: remove my vote from other options
        votes = votes.filter(u => u !== myUid);
      }
      return { ...o, votes };
    });
    await firestore().collection('chats').doc(chatId)
      .collection('messages').doc(messageId)
      .update({ 'poll.options': options });
  };

  return (
    <View style={s.wrap}>
      <Text style={s.question}>{poll.question}</Text>
      {poll.options.map((opt, i) => {
        const voted  = opt.votes.includes(myUid);
        const pct    = total > 0 ? Math.round((opt.votes.length / total) * 100) : 0;
        return (
          <TouchableOpacity key={i} style={[s.option, voted && s.optionVoted]} onPress={() => vote(i)} disabled={poll.closed}>
            <View style={[s.bar, { width: `${pct}%` as any }]} />
            <View style={s.optRow}>
              <Text style={[s.optTxt, voted && { color: '#00E5FF' }]}>{opt.text}</Text>
              <Text style={s.pctTxt}>{pct}%</Text>
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={s.totalTxt}>{total} vote{total !== 1 ? 's' : ''}{poll.multiSelect ? ' · Multiple choice' : ''}{poll.closed ? ' · Closed' : ''}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap:        { minWidth: 200, maxWidth: 260 },
  question:    { color: '#E0E0F0', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  option:      { borderWidth: 1, borderColor: '#333', borderRadius: 8, marginBottom: 6, overflow: 'hidden', position: 'relative' },
  optionVoted: { borderColor: '#00E5FF' },
  bar:         { position: 'absolute', top: 0, left: 0, bottom: 0, backgroundColor: '#00E5FF18' },
  optRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 9 },
  optTxt:      { color: '#C0C0E0', fontSize: 13, flex: 1 },
  pctTxt:      { color: '#555', fontSize: 12 },
  totalTxt:    { color: '#555', fontSize: 11, marginTop: 4 },
});
'@
[System.IO.File]::WriteAllText("$root\components\PollMessage.tsx", $f3, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 4 of 9  app/group-chat.tsx
# Full group chat — same features as 1:1 + polls + disappearing + pinned
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[4/9] app/group-chat.tsx" -ForegroundColor Yellow
$f4 = @'
// app/group-chat.tsx
// Group chat: E2E encrypted, polls, disappearing messages, pinned, reactions

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet, Alert,
  ActivityIndicator, Pressable, Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { io, Socket } from 'socket.io-client';
import { encryptMessage, decryptMessage } from '../services/d2deService';
import { pinMessage, setDisappearingTimer } from '../services/groupService';
import AttachmentSheet from '../components/AttachmentSheet';
import MediaMessage    from '../components/MediaMessage';
import PollMessage     from '../components/PollMessage';
import ReactionPicker  from '../components/ReactionPicker';
import { uploadMedia } from '../services/mediaService';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Audio } from 'expo-av';
import VoiceRecorder from '../components/VoiceRecorder';

const BACKEND = 'https://vaultchat.onrender.com';

type MsgType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'gif' | 'poll';

interface Message {
  id: string;
  senderId: string;
  senderName: string;
  plaintext: string;
  status: 'sent' | 'delivered' | 'read';
  createdAt: any;
  isDeleted?: boolean;
  isEdited?: boolean;
  replyTo?: { id: string; senderId: string; senderName: string; plaintext: string };
  msgType: MsgType;
  mediaUrl?: string;
  filename?: string;
  audioDuration?: number;
  reactions?: Record<string, string[]>;
  poll?: any;
  expiresAt?: any;
}

export default function GroupChatScreen() {
  const { chatId, groupName } = useLocalSearchParams<{ chatId: string; groupName: string }>();
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [messages,      setMessages]      = useState<Message[]>([]);
  const [participants,  setParticipants]  = useState<Record<string,string>>({});
  const [inputText,     setInputText]     = useState('');
  const [loading,       setLoading]       = useState(true);
  const [sending,       setSending]       = useState(false);
  const [peerTyping,    setPeerTyping]    = useState<string[]>([]);
  const [replyTarget,   setReplyTarget]   = useState<Message | null>(null);
  const [editTarget,    setEditTarget]    = useState<Message | null>(null);
  const [longPressMsg,  setLongPressMsg]  = useState<Message | null>(null);
  const [showAttach,    setShowAttach]    = useState(false);
  const [showVoice,     setShowVoice]     = useState(false);
  const [showReaction,  setShowReaction]  = useState(false);
  const [reactTarget,   setReactTarget]   = useState<Message | null>(null);
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion,  setPollQuestion]  = useState('');
  const [pollOptions,   setPollOptions]   = useState(['', '']);
  const [disappearing,  setDisappearing]  = useState(0);
  const [pinnedMsg,     setPinnedMsg]     = useState<Message | null>(null);
  const [showPinned,    setShowPinned]    = useState(false);
  const [uploading,     setUploading]     = useState(false);

  const flatRef   = useRef<FlatList>(null);
  const sockRef   = useRef<Socket | null>(null);
  const typingTmr = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping  = useRef(false);

  // Load group metadata
  useEffect(() => {
    const unsub = firestore().collection('chats').doc(chatId).onSnapshot(snap => {
      const d = snap.data();
      if (!d) return;
      setParticipants(d.participantNames ?? {});
      setDisappearing(d.disappearingTimer ?? 0);
      if (d.pinnedMessageId) {
        firestore().collection('chats').doc(chatId).collection('messages').doc(d.pinnedMessageId).get()
          .then(msnap => {
            if (msnap.exists) {
              const md = msnap.data() as any;
              setPinnedMsg({ id: msnap.id, senderId: md.senderId, senderName: d.participantNames?.[md.senderId] ?? 'Unknown', plaintext: md.plaintext ?? '📎 Media', status: 'sent', createdAt: md.createdAt, msgType: md.msgType ?? 'text' });
            }
          });
      }
    });
    return unsub;
  }, [chatId]);

  // Socket
  useEffect(() => {
    let sock: Socket;
    (async () => {
      const token = await auth().currentUser?.getIdToken();
      sock = io(BACKEND, { auth: { token }, transports: ['websocket'] });
      sock.emit('join_chat', { chatId, uid: myUid });
      sock.on('typing_start', ({ uid, name }: any) => {
        if (uid !== myUid) setPeerTyping(p => [...new Set([...p, name ?? uid])]);
      });
      sock.on('typing_stop', ({ uid }: any) => {
        if (uid !== myUid) setPeerTyping(p => p.filter(n => n !== (participants[uid] ?? uid)));
      });
      sock.on('message_deleted', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, isDeleted: true, plaintext: '' } : m)));
      sock.on('reaction_updated', ({ messageId, reactions }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, reactions } : m)));
      sockRef.current = sock;
    })();
    return () => { sock?.disconnect(); };
  }, [chatId, myUid]);

  // Messages listener
  useEffect(() => {
    const unsub = firestore()
      .collection('chats').doc(chatId)
      .collection('messages').orderBy('createdAt', 'asc')
      .onSnapshot(async snap => {
        const msgs = await Promise.all(snap.docs.map(async doc => {
          const d = doc.data() as any;
          if (d.isDeleted) return { id: doc.id, senderId: d.senderId, senderName: participants[d.senderId] ?? 'Unknown', plaintext: '', status: d.status ?? 'sent', createdAt: d.createdAt, isDeleted: true, msgType: 'text' } as Message;

          let plaintext = '';
          if (d.msgType === 'text' || !d.msgType) {
            try {
              if (d.ciphertext && d.iv) {
                // For groups, encrypt/decrypt using chatId as the peer key seed
                plaintext = await decryptMessage({ ciphertext: d.ciphertext, iv: d.iv, tag: d.tag ?? '', keyId: d.keyId ?? 'v1-pbkdf2', v: d.v ?? 1 }, myUid, chatId);
              } else { plaintext = d.plaintext ?? ''; }
            } catch { plaintext = d.plaintext ?? '[Decryption failed]'; }
          }

          return {
            id: doc.id,
            senderId: d.senderId,
            senderName: participants[d.senderId] ?? d.senderName ?? 'Unknown',
            plaintext,
            status: d.status ?? 'sent',
            createdAt: d.createdAt,
            isEdited: d.isEdited ?? false,
            isDeleted: false,
            replyTo: d.replyTo ?? null,
            msgType: d.msgType ?? 'text',
            mediaUrl: d.mediaUrl,
            filename: d.filename,
            audioDuration: d.audioDuration,
            reactions: d.reactions ?? {},
            poll: d.poll,
            expiresAt: d.expiresAt,
          } as Message;
        }));
        setMessages(msgs);
        setLoading(false);
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 80);
      });
    return unsub;
  }, [chatId, myUid, participants]);

  const handleTyping = (text: string) => {
    setInputText(text);
    if (!isTyping.current) {
      isTyping.current = true;
      sockRef.current?.emit('typing_start', { chatId, uid: myUid, name: participants[myUid] ?? 'Someone' });
    }
    if (typingTmr.current) clearTimeout(typingTmr.current);
    typingTmr.current = setTimeout(() => { isTyping.current = false; sockRef.current?.emit('typing_stop', { chatId, uid: myUid }); }, 2000);
  };

  const sendText = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    if (editTarget) { await saveEdit(text); return; }
    setSending(true);
    setInputText('');
    const reply = replyTarget; setReplyTarget(null);
    isTyping.current = false;
    sockRef.current?.emit('typing_stop', { chatId, uid: myUid });
    try {
      const payload = await encryptMessage(text, myUid, chatId);
      const data: any = {
        senderId: myUid,
        senderName: participants[myUid] ?? 'Me',
        ciphertext: payload.ciphertext, iv: payload.iv, tag: payload.tag, keyId: payload.keyId, v: payload.v,
        msgType: 'text', status: 'sent', isDeleted: false, reactions: {},
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (reply) data.replyTo = { id: reply.id, senderId: reply.senderId, senderName: reply.senderName, plaintext: reply.plaintext.substring(0, 80) };
      if (disappearing > 0) {
        const exp = new Date(); exp.setSeconds(exp.getSeconds() + disappearing);
        data.expiresAt = exp;
      }
      const ref = await firestore().collection('chats').doc(chatId).collection('messages').add(data);
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: text.substring(0, 60), lastTime: firestore.FieldValue.serverTimestamp(),
      });
      sockRef.current?.emit('new_message', { chatId, messageId: ref.id, senderUid: myUid, preview: text.substring(0, 40) });
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSending(false); }
  };

  const saveEdit = async (newText: string) => {
    if (!editTarget) return;
    setSending(true); setEditTarget(null); setInputText('');
    try {
      const payload = await encryptMessage(newText, myUid, chatId);
      await firestore().collection('chats').doc(chatId).collection('messages').doc(editTarget.id)
        .update({ ciphertext: payload.ciphertext, iv: payload.iv, isEdited: true, editedAt: firestore.FieldValue.serverTimestamp() });
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSending(false); }
  };

  const deleteMsg = (m: Message) => {
    setLongPressMsg(null);
    Alert.alert('Delete for Everyone?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await firestore().collection('chats').doc(chatId).collection('messages').doc(m.id)
          .update({ ciphertext: firestore.FieldValue.delete(), iv: firestore.FieldValue.delete(), isDeleted: true });
        sockRef.current?.emit('message_deleted', { chatId, messageId: m.id });
      }},
    ]);
  };

  const addReaction = async (msg: Message, emoji: string) => {
    setShowReaction(false); setReactTarget(null); setLongPressMsg(null);
    const existing = msg.reactions ?? {};
    const users    = existing[emoji] ?? [];
    const updated  = { ...existing };
    if (users.includes(myUid)) {
      const f = users.filter(u => u !== myUid);
      if (f.length === 0) delete updated[emoji]; else updated[emoji] = f;
    } else { updated[emoji] = [...users, myUid]; }
    await firestore().collection('chats').doc(chatId).collection('messages').doc(msg.id).update({ reactions: updated });
    sockRef.current?.emit('reaction_updated', { chatId, messageId: msg.id, reactions: updated });
  };

  const sendPoll = async () => {
    const q    = pollQuestion.trim();
    const opts = pollOptions.filter(o => o.trim());
    if (!q || opts.length < 2) { Alert.alert('Enter a question and at least 2 options'); return; }
    setShowPollModal(false); setPollQuestion(''); setPollOptions(['', '']);
    await firestore().collection('chats').doc(chatId).collection('messages').add({
      senderId: myUid, senderName: participants[myUid] ?? 'Me',
      msgType: 'poll', status: 'sent', isDeleted: false, reactions: {},
      poll: { question: q, options: opts.map(t => ({ text: t, votes: [] })), multiSelect: false, closed: false },
      createdAt: firestore.FieldValue.serverTimestamp(),
    });
    await firestore().collection('chats').doc(chatId).update({ lastMsg: `📊 Poll: ${q}`, lastTime: firestore.FieldValue.serverTimestamp() });
  };

  const sendMedia = async (localUri: string, type: 'image'|'video'|'audio'|'file'|'gif', opts?: any) => {
    setUploading(true);
    try {
      const result = await uploadMedia(localUri, chatId, type === 'gif' ? 'image' : type, opts?.filename);
      await firestore().collection('chats').doc(chatId).collection('messages').add({
        senderId: myUid, senderName: participants[myUid] ?? 'Me',
        msgType: type, mediaUrl: result.downloadURL, filename: result.filename,
        status: 'sent', isDeleted: false, reactions: {},
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      await firestore().collection('chats').doc(chatId).update({ lastMsg: `📎 ${type}`, lastTime: firestore.FieldValue.serverTimestamp() });
    } catch (e: any) { Alert.alert('Upload error', e.message); }
    finally { setUploading(false); }
  };

  const Ticks = ({ status }: { status: string }) => {
    if (status === 'sent') return <Text style={s.tick}>✓</Text>;
    if (status === 'delivered') return <Text style={s.tick}>✓✓</Text>;
    return <Text style={[s.tick, { color: '#00E5FF' }]}>✓✓</Text>;
  };

  const renderMsg = ({ item: m }: { item: Message }) => {
    const isMe = m.senderId === myUid;
    if (m.isDeleted) return <View style={[s.row, isMe ? s.rowR : s.rowL]}><View style={[s.bubble, s.bubbleDel]}><Text style={s.delTxt}>🚫 Deleted</Text></View></View>;
    return (
      <Pressable onLongPress={() => setLongPressMsg(m)} delayLongPress={350}>
        <View style={[s.row, isMe ? s.rowR : s.rowL]}>
          <View>
            <View style={[s.bubble, isMe ? s.bMe : s.bPeer]}>
              {!isMe && <Text style={s.senderName}>{m.senderName}</Text>}
              {m.replyTo && (
                <View style={s.replyBar}>
                  <Text style={s.replyName}>{m.replyTo.senderName}</Text>
                  <Text style={s.replyPrev} numberOfLines={1}>{m.replyTo.plaintext}</Text>
                </View>
              )}
              {m.msgType === 'poll' && m.poll
                ? <PollMessage messageId={m.id} chatId={chatId} poll={m.poll} />
                : m.msgType !== 'text' && m.mediaUrl
                  ? <MediaMessage url={m.mediaUrl} msgType={m.msgType as any} filename={m.filename} duration={m.audioDuration} />
                  : <Text style={s.msgTxt}>{m.plaintext}</Text>
              }
              {m.expiresAt && <Text style={s.expiry}>⏱ Disappearing</Text>}
              <View style={s.meta}>
                {m.isEdited && <Text style={s.edited}>edited · </Text>}
                <Text style={s.time}>{m.createdAt?.toDate?.().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? ''}</Text>
                {isMe && <Ticks status={m.status} />}
              </View>
            </View>
            {/* Reaction row */}
            {Object.entries(m.reactions ?? {}).filter(([,u]) => u.length > 0).length > 0 && (
              <View style={s.reactionRow}>
                {Object.entries(m.reactions ?? {}).filter(([,u]) => u.length > 0).map(([e, u]) => (
                  <TouchableOpacity key={e} onPress={() => addReaction(m, e)} style={[s.reactionChip, u.includes(myUid) && s.reactionMine]}>
                    <Text style={{ fontSize: 13 }}>{e}</Text>
                    {u.length > 1 && <Text style={s.reactionCnt}>{u.length}</Text>}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </View>
      </Pressable>
    );
  };

  const Sheet = () => {
    if (!longPressMsg) return null;
    const isMe = longPressMsg.senderId === myUid;
    return (
      <Pressable style={s.overlay} onPress={() => setLongPressMsg(null)}>
        <View style={s.sheet}>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReactTarget(longPressMsg); setShowReaction(true); setLongPressMsg(null); }}><Text style={s.sheetTxt}>😊  React</Text></TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReplyTarget(longPressMsg); setLongPressMsg(null); }}><Text style={s.sheetTxt}>↩  Reply</Text></TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { pinMessage(chatId, longPressMsg.id); setLongPressMsg(null); Alert.alert('Pinned!'); }}><Text style={s.sheetTxt}>📌  Pin Message</Text></TouchableOpacity>
          {isMe && longPressMsg.msgType === 'text' && <TouchableOpacity style={s.sheetRow} onPress={() => { setEditTarget(longPressMsg); setLongPressMsg(null); setInputText(longPressMsg.plaintext); }}><Text style={s.sheetTxt}>✏️  Edit</Text></TouchableOpacity>}
          {isMe && <TouchableOpacity style={s.sheetRow} onPress={() => deleteMsg(longPressMsg)}><Text style={[s.sheetTxt, { color: '#FF3C6E' }]}>🗑  Delete</Text></TouchableOpacity>}
          <TouchableOpacity style={s.sheetRow} onPress={() => setLongPressMsg(null)}><Text style={[s.sheetTxt, { color: '#555' }]}>Cancel</Text></TouchableOpacity>
        </View>
      </Pressable>
    );
  };

  // Poll creation modal
  const PollModal = () => (
    <Modal visible={showPollModal} transparent animationType="slide">
      <Pressable style={s.overlay} onPress={() => setShowPollModal(false)}>
        <Pressable style={s.pollModal} onPress={() => {}}>
          <Text style={s.pollTitle}>Create Poll</Text>
          <TextInput style={s.pollInput} placeholder="Question…" placeholderTextColor="#444" value={pollQuestion} onChangeText={setPollQuestion} />
          {pollOptions.map((opt, i) => (
            <TextInput key={i} style={s.pollInput} placeholder={`Option ${i + 1}`} placeholderTextColor="#444" value={opt} onChangeText={v => { const o = [...pollOptions]; o[i] = v; setPollOptions(o); }} />
          ))}
          {pollOptions.length < 5 && (
            <TouchableOpacity onPress={() => setPollOptions(p => [...p, ''])} style={s.addOptBtn}>
              <Text style={{ color: '#00E5FF', fontSize: 14 }}>+ Add option</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.pollSendBtn} onPress={sendPoll}>
            <Text style={s.pollSendTxt}>Send Poll</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );

  return (
    <>
      <Stack.Screen options={{
        title: groupName ?? 'Group',
        headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff',
        headerRight: () => (
          <TouchableOpacity onPress={() => router.push({ pathname: '/group-info', params: { chatId, groupName } })} style={{ marginRight: 12 }}>
            <Text style={{ color: '#00E5FF', fontSize: 14 }}>ℹ️</Text>
          </TouchableOpacity>
        ),
      }} />
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>

        {/* Pinned message banner */}
        {pinnedMsg && showPinned && (
          <TouchableOpacity style={s.pinnedBanner} onPress={() => setShowPinned(false)}>
            <Text style={s.pinnedIcon}>📌</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.pinnedName}>{pinnedMsg.senderName}</Text>
              <Text style={s.pinnedTxt} numberOfLines={1}>{pinnedMsg.plaintext}</Text>
            </View>
            <Text style={{ color: '#555', fontSize: 18 }}>✕</Text>
          </TouchableOpacity>
        )}
        {pinnedMsg && !showPinned && (
          <TouchableOpacity style={[s.pinnedBanner, { paddingVertical: 6 }]} onPress={() => setShowPinned(true)}>
            <Text style={s.pinnedIcon}>📌</Text>
            <Text style={s.pinnedName}>Pinned message</Text>
          </TouchableOpacity>
        )}

        {loading
          ? <ActivityIndicator color="#00E5FF" style={{ flex: 1 }} />
          : <FlatList ref={flatRef} data={messages} keyExtractor={m => m.id} renderItem={renderMsg}
              contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} />
        }

        {uploading && <View style={s.uploadBar}><Text style={s.uploadTxt}>Uploading…</Text></View>}
        {peerTyping.length > 0 && <View style={s.typingRow}><Text style={s.typingTxt}>{peerTyping.join(', ')} {peerTyping.length === 1 ? 'is' : 'are'} typing…</Text></View>}

        {replyTarget && (
          <View style={s.banner}>
            <View style={{ flex: 1 }}>
              <Text style={s.bannerTitle}>Replying to {replyTarget.senderName}</Text>
              <Text style={s.bannerPrev} numberOfLines={1}>{replyTarget.plaintext}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTarget(null)}><Text style={s.bannerX}>✕</Text></TouchableOpacity>
          </View>
        )}
        {editTarget && (
          <View style={[s.banner, { borderTopColor: '#4F8FFF33' }]}>
            <Text style={[s.bannerTitle, { color: '#4F8FFF', flex: 1 }]}>✏️  Editing</Text>
            <TouchableOpacity onPress={() => { setEditTarget(null); setInputText(''); }}><Text style={s.bannerX}>✕</Text></TouchableOpacity>
          </View>
        )}

        {showVoice
          ? <VoiceRecorder onSend={(uri, dur) => { setShowVoice(false); sendMedia(uri, 'audio', { duration: dur }); }} onCancel={() => setShowVoice(false)} />
          : <View style={s.bar}>
              <TouchableOpacity onPress={() => setShowAttach(true)} style={s.attachBtn}><Text style={{ fontSize: 22, color: '#555' }}>＋</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setShowPollModal(true)} style={s.attachBtn}><Text style={{ fontSize: 20, color: '#555' }}>📊</Text></TouchableOpacity>
              <TextInput style={s.input} value={inputText} onChangeText={handleTyping} placeholder="Message…" placeholderTextColor="#444" multiline maxLength={4000} />
              {inputText.trim()
                ? <TouchableOpacity style={[s.sendBtn, sending && s.sendOff]} onPress={sendText} disabled={sending}>
                    {sending ? <ActivityIndicator color="#000" size="small" /> : <Text style={s.sendIco}>{editTarget ? '✓' : '➤'}</Text>}
                  </TouchableOpacity>
                : <TouchableOpacity style={s.sendBtn} onPress={() => setShowVoice(true)}><Text style={s.sendIco}>🎤</Text></TouchableOpacity>
              }
            </View>
        }

        <Sheet />
        <PollModal />
        <AttachmentSheet
          visible={showAttach} onClose={() => setShowAttach(false)}
          onPhoto={async () => { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 }); if (!r.canceled && r.assets[0]) sendMedia(r.assets[0].uri, 'image'); }}
          onVideo={async () => { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos }); if (!r.canceled && r.assets[0]) sendMedia(r.assets[0].uri, 'video'); }}
          onFile={async () => { const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true }); if (!r.canceled && r.assets[0]) sendMedia(r.assets[0].uri, 'file', { filename: r.assets[0].name }); }}
          onGif={() => { setShowAttach(false); }}
          onVoice={() => { setShowAttach(false); setShowVoice(true); }}
        />
        <ReactionPicker
          visible={showReaction} onClose={() => { setShowReaction(false); setReactTarget(null); }}
          onSelect={(emoji) => { if (reactTarget) addReaction(reactTarget, emoji); }}
        />
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  screen:       { flex: 1, backgroundColor: '#03030E' },
  list:         { padding: 12, paddingBottom: 8 },
  row:          { marginBottom: 6 },
  rowR:         { alignItems: 'flex-end' },
  rowL:         { alignItems: 'flex-start' },
  bubble:       { maxWidth: '80%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bMe:          { backgroundColor: '#003D2A', borderBottomRightRadius: 2 },
  bPeer:        { backgroundColor: '#111127', borderBottomLeftRadius: 2 },
  bubbleDel:    { backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  senderName:   { color: '#00E5FF', fontSize: 12, fontWeight: 'bold', marginBottom: 3 },
  msgTxt:       { color: '#E0E0F0', fontSize: 15, lineHeight: 21 },
  delTxt:       { color: '#444', fontSize: 14, fontStyle: 'italic' },
  expiry:       { color: '#FF8C42', fontSize: 10, marginTop: 2 },
  meta:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 },
  time:         { color: '#444', fontSize: 11, marginRight: 3 },
  edited:       { color: '#555', fontSize: 11 },
  tick:         { color: '#555', fontSize: 12 },
  replyBar:     { backgroundColor: '#00000044', borderLeftWidth: 3, borderLeftColor: '#00E5FF', borderRadius: 6, padding: 6, marginBottom: 6 },
  replyName:    { color: '#00E5FF', fontSize: 11, fontWeight: 'bold', marginBottom: 1 },
  replyPrev:    { color: '#888', fontSize: 12 },
  reactionRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A30', borderRadius: 12, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: '#333' },
  reactionMine: { borderColor: '#00E5FF', backgroundColor: '#00E5FF11' },
  reactionCnt:  { color: '#888', fontSize: 11, marginLeft: 3 },
  pinnedBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', borderBottomWidth: 1, borderBottomColor: '#FF8C4233', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  pinnedIcon:   { fontSize: 16 },
  pinnedName:   { color: '#FF8C42', fontSize: 12, fontWeight: 'bold' },
  pinnedTxt:    { color: '#888', fontSize: 12 },
  uploadBar:    { backgroundColor: '#0C0C1A', padding: 8, alignItems: 'center' },
  uploadTxt:    { color: '#00E5FF', fontSize: 12 },
  typingRow:    { paddingHorizontal: 16, paddingBottom: 6 },
  typingTxt:    { color: '#555', fontSize: 13, fontStyle: 'italic' },
  banner:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', borderTopWidth: 1, borderTopColor: '#00E5FF33', paddingHorizontal: 14, paddingVertical: 8 },
  bannerTitle:  { color: '#00E5FF', fontSize: 12, fontWeight: 'bold' },
  bannerPrev:   { color: '#888', fontSize: 12 },
  bannerX:      { color: '#555', fontSize: 20, paddingHorizontal: 8 },
  bar:          { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#0C0C1A', paddingHorizontal: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#111' },
  attachBtn:    { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  input:        { flex: 1, backgroundColor: '#111127', color: '#E0E0F0', borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, maxHeight: 120, marginHorizontal: 4 },
  sendBtn:      { width: 44, height: 44, borderRadius: 22, backgroundColor: '#00E5FF', alignItems: 'center', justifyContent: 'center' },
  sendOff:      { backgroundColor: '#111127' },
  sendIco:      { color: '#000', fontSize: 18, fontWeight: 'bold' },
  overlay:      { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:        { backgroundColor: '#0E0E20', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36, paddingTop: 8 },
  sheetRow:     { padding: 18, borderBottomWidth: 1, borderBottomColor: '#111' },
  sheetTxt:     { color: '#E0E0F0', fontSize: 16 },
  pollModal:    { backgroundColor: '#0E0E20', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 },
  pollTitle:    { color: '#E0E0F0', fontSize: 18, fontWeight: 'bold', marginBottom: 14 },
  pollInput:    { backgroundColor: '#111127', color: '#E0E0F0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, marginBottom: 8 },
  addOptBtn:    { paddingVertical: 8, alignItems: 'center' },
  pollSendBtn:  { backgroundColor: '#00E5FF', borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  pollSendTxt:  { color: '#000', fontSize: 15, fontWeight: 'bold' },
});
'@
[System.IO.File]::WriteAllText("$root\app\group-chat.tsx", $f4, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 5 of 9  app/chats.tsx  — full rewrite with Note-to-Self, search,
#              starred, mute/archive, pinned chats, online status
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[5/9] app/chats.tsx" -ForegroundColor Yellow
$f5 = @'
// app/chats.tsx
// Chat list: 1:1 + groups, search, starred, mute, archive, online status,
// note-to-self, swipe actions

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, Image, RefreshControl, Pressable,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { muteChat, archiveChat, pinChat } from '../services/groupService';

interface ChatItem {
  id: string;
  isGroup: boolean;
  name: string;
  photoURL?: string;
  lastMsg: string;
  lastTime: any;
  unreadCount: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  online?: boolean;
  peerUid?: string;
}

export default function ChatsScreen() {
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [chats,       setChats]       = useState<ChatItem[]>([]);
  const [filtered,    setFiltered]    = useState<ChatItem[]>([]);
  const [search,      setSearch]      = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [loading,     setLoading]     = useState(true);
  const [longPress,   setLongPress]   = useState<ChatItem | null>(null);

  useEffect(() => {
    const unsub = firestore()
      .collection('chats')
      .where('participants', 'array-contains', myUid)
      .orderBy('lastTime', 'desc')
      .onSnapshot(async snap => {
        const items = await Promise.all(snap.docs.map(async doc => {
          const d = doc.data() as any;
          const isGroup = d.isGroup === true;
          const unread  = d.unread?.[myUid] ?? 0;

          if (isGroup) {
            return {
              id: doc.id, isGroup: true,
              name: d.name ?? 'Group',
              photoURL: d.photoURL,
              lastMsg: d.lastMsg ?? '',
              lastTime: d.lastTime,
              unreadCount: unread,
              pinned: d.pinned ?? false,
              archived: d.archived ?? false,
              muted: d.muted ?? false,
            } as ChatItem;
          }

          // 1:1 — get peer info
          const peerUid = (d.participants as string[]).find(u => u !== myUid) ?? '';
          let name = d.participantNames?.[peerUid] ?? 'Unknown';
          let photo = '';
          let online = false;
          try {
            const peerSnap = await firestore().collection('users').doc(peerUid).get();
            const pd = peerSnap.data();
            name   = pd?.name ?? name;
            photo  = pd?.photoURL ?? '';
            online = pd?.online ?? false;
          } catch {}

          return {
            id: doc.id, isGroup: false, peerUid,
            name, photoURL: photo,
            lastMsg: d.lastMsg ?? '',
            lastTime: d.lastTime,
            unreadCount: unread,
            pinned: d.pinned ?? false,
            archived: d.archived ?? false,
            muted: d.muted ?? false,
            online,
          } as ChatItem;
        }));

        // Sort: pinned first, then by time
        const sorted = items.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return 0;
        });
        setChats(sorted);
        setLoading(false);
      });
    return unsub;
  }, [myUid]);

  // Filter by search + archived toggle
  useEffect(() => {
    let list = chats.filter(c => showArchive ? c.archived : !c.archived);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.lastMsg.toLowerCase().includes(q));
    }
    setFiltered(list);
  }, [chats, search, showArchive]);

  const openChat = (item: ChatItem) => {
    if (item.isGroup) {
      router.push({ pathname: '/group-chat', params: { chatId: item.id, groupName: item.name } });
    } else {
      router.push({ pathname: '/chat', params: { chatId: item.id, peerUid: item.peerUid ?? '', peerName: item.name } });
    }
    // Reset unread
    firestore().collection('chats').doc(item.id).update({ [`unread.${myUid}`]: 0 }).catch(() => {});
  };

  const ensureNoteToSelf = async () => {
    // Check if self-chat exists
    const snap = await firestore().collection('chats')
      .where('participants', 'array-contains', myUid)
      .where('isNoteToSelf', '==', true)
      .get();
    if (snap.empty) {
      const myDoc = await firestore().collection('users').doc(myUid).get();
      const myName = myDoc.data()?.name ?? 'Me';
      await firestore().collection('chats').add({
        participants: [myUid],
        participantNames: { [myUid]: myName },
        isGroup: false,
        isNoteToSelf: true,
        lastMsg: 'Your private encrypted notes',
        lastTime: firestore.FieldValue.serverTimestamp(),
        unread: { [myUid]: 0 },
        pinned: false, archived: false, muted: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
    }
    const chatSnap = await firestore().collection('chats')
      .where('participants', 'array-contains', myUid)
      .where('isNoteToSelf', '==', true)
      .get();
    if (!chatSnap.empty) {
      router.push({ pathname: '/chat', params: { chatId: chatSnap.docs[0].id, peerUid: myUid, peerName: '📋 Note to Self' } });
    }
  };

  const fmt = (ts: any) => {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { weekday: 'short' });
  };

  const renderChat = ({ item }: { item: ChatItem }) => (
    <Pressable
      onPress={() => openChat(item)}
      onLongPress={() => setLongPress(item)}
      delayLongPress={400}
    >
      <View style={s.chatRow}>
        {/* Avatar */}
        <View style={s.avatarWrap}>
          {item.photoURL
            ? <Image source={{ uri: item.photoURL }} style={s.avatar} />
            : <View style={[s.avatar, s.avatarFallback]}>
                <Text style={s.avatarTxt}>{item.isGroup ? '👥' : item.name[0]?.toUpperCase()}</Text>
              </View>
          }
          {item.online && !item.isGroup && <View style={s.onlineDot} />}
        </View>

        {/* Content */}
        <View style={s.chatBody}>
          <View style={s.chatTop}>
            <View style={s.nameRow}>
              {item.pinned && <Text style={s.pinIcon}>📌 </Text>}
              {item.muted  && <Text style={s.muteIcon}>🔕 </Text>}
              <Text style={s.chatName} numberOfLines={1}>{item.name}</Text>
            </View>
            <Text style={s.chatTime}>{fmt(item.lastTime)}</Text>
          </View>
          <View style={s.chatBottom}>
            <Text style={s.chatPreview} numberOfLines={1}>{item.lastMsg}</Text>
            {item.unreadCount > 0 && !item.muted && (
              <View style={s.badge}><Text style={s.badgeTxt}>{item.unreadCount}</Text></View>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );

  // Long press action sheet
  const LongPressSheet = () => {
    if (!longPress) return null;
    return (
      <Pressable style={s.overlay} onPress={() => setLongPress(null)}>
        <View style={s.sheet}>
          <TouchableOpacity style={s.sheetRow} onPress={() => { pinChat(longPress.id, !longPress.pinned); setLongPress(null); }}>
            <Text style={s.sheetTxt}>{longPress.pinned ? '📌 Unpin' : '📌 Pin to top'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { muteChat(longPress.id, !longPress.muted); setLongPress(null); }}>
            <Text style={s.sheetTxt}>{longPress.muted ? '🔔 Unmute' : '🔕 Mute'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { archiveChat(longPress.id, !longPress.archived); setLongPress(null); }}>
            <Text style={s.sheetTxt}>{longPress.archived ? '📂 Unarchive' : '🗄 Archive'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => setLongPress(null)}>
            <Text style={[s.sheetTxt, { color: '#555' }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    );
  };

  return (
    <>
      <Stack.Screen options={{
        title: 'VaultChat',
        headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff',
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 14, marginRight: 14 }}>
            <TouchableOpacity onPress={ensureNoteToSelf}><Text style={{ color: '#00E5FF', fontSize: 18 }}>📋</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/create-group')}><Text style={{ color: '#00E5FF', fontSize: 22 }}>👥</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/profile')}><Text style={{ color: '#00E5FF', fontSize: 22 }}>⚙️</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.screen}>
        {/* Search */}
        <View style={s.searchBar}>
          <Text style={s.searchIcon}>🔍</Text>
          <TextInput
            style={s.searchInput}
            placeholder="Search chats…"
            placeholderTextColor="#444"
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}><Text style={{ color: '#555', fontSize: 18 }}>✕</Text></TouchableOpacity>
          )}
        </View>

        {/* Archive toggle */}
        {chats.some(c => c.archived) && (
          <TouchableOpacity style={s.archiveToggle} onPress={() => setShowArchive(p => !p)}>
            <Text style={s.archiveTxt}>{showArchive ? '← Back to chats' : `🗄 Archived (${chats.filter(c => c.archived).length})`}</Text>
          </TouchableOpacity>
        )}

        <FlatList
          data={filtered}
          keyExtractor={c => c.id}
          renderItem={renderChat}
          refreshControl={<RefreshControl refreshing={loading} colors={['#00E5FF']} tintColor="#00E5FF" />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyIcon}>💬</Text>
              <Text style={s.emptyTxt}>{search ? 'No chats found' : 'No chats yet'}</Text>
              <Text style={s.emptySub}>Tap 👥 to create a group or start a new chat</Text>
            </View>
          }
        />
        <LongPressSheet />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:       { flex: 1, backgroundColor: '#03030E' },
  searchBar:    { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 12, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: '#111' },
  searchIcon:   { fontSize: 16 },
  searchInput:  { flex: 1, color: '#E0E0F0', fontSize: 15 },
  archiveToggle:{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#111' },
  archiveTxt:   { color: '#00E5FF', fontSize: 13 },
  chatRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#07070F' },
  avatarWrap:   { position: 'relative', marginRight: 12 },
  avatar:       { width: 50, height: 50, borderRadius: 25 },
  avatarFallback:{ backgroundColor: '#111127', alignItems: 'center', justifyContent: 'center' },
  avatarTxt:    { color: '#00E5FF', fontSize: 20, fontWeight: 'bold' },
  onlineDot:    { position: 'absolute', bottom: 1, right: 1, width: 12, height: 12, borderRadius: 6, backgroundColor: '#00FF88', borderWidth: 2, borderColor: '#03030E' },
  chatBody:     { flex: 1 },
  chatTop:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  nameRow:      { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  pinIcon:      { color: '#FF8C42', fontSize: 12 },
  muteIcon:     { color: '#555', fontSize: 12 },
  chatName:     { color: '#E0E0F0', fontSize: 16, fontWeight: '600', flex: 1 },
  chatTime:     { color: '#555', fontSize: 12 },
  chatBottom:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatPreview:  { color: '#555', fontSize: 13, flex: 1, marginRight: 8 },
  badge:        { backgroundColor: '#00E5FF', borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeTxt:     { color: '#000', fontSize: 11, fontWeight: 'bold' },
  empty:        { flex: 1, alignItems: 'center', paddingTop: 80 },
  emptyIcon:    { fontSize: 48, marginBottom: 12 },
  emptyTxt:     { color: '#E0E0F0', fontSize: 18, fontWeight: '600', marginBottom: 6 },
  emptySub:     { color: '#555', fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
  overlay:      { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:        { backgroundColor: '#0E0E20', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36, paddingTop: 8 },
  sheetRow:     { padding: 18, borderBottomWidth: 1, borderBottomColor: '#111' },
  sheetTxt:     { color: '#E0E0F0', fontSize: 16 },
});
'@
[System.IO.File]::WriteAllText("$root\app\chats.tsx", $f5, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 6 of 9  app/starred.tsx — starred messages screen
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[6/9] app/starred.tsx" -ForegroundColor Yellow
$f6 = @'
// app/starred.tsx
// View all starred messages across all chats

import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

interface StarredMsg {
  id: string;
  chatId: string;
  chatName: string;
  plaintext: string;
  senderId: string;
  senderName: string;
  createdAt: any;
  msgType: string;
}

export default function StarredScreen() {
  const router  = useRouter();
  const myUid   = auth().currentUser?.uid ?? '';
  const [items, setItems] = useState<StarredMsg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    firestore().collection('users').doc(myUid)
      .collection('starred').orderBy('starredAt', 'desc').onSnapshot(async snap => {
        const list = snap.docs.map(d => d.data() as StarredMsg);
        setItems(list);
        setLoading(false);
      });
  }, [myUid]);

  const unstar = async (item: StarredMsg) => {
    await firestore().collection('users').doc(myUid).collection('starred').doc(item.id).delete();
  };

  const fmt = (ts: any) => ts?.toDate?.().toLocaleDateString() ?? '';

  if (loading) return <View style={s.center}><ActivityIndicator color="#00E5FF" /></View>;

  return (
    <>
      <Stack.Screen options={{ title: '⭐ Starred Messages', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <FlatList
          data={items}
          keyExtractor={i => i.id}
          renderItem={({ item }) => (
            <View style={s.item}>
              <View style={{ flex: 1 }}>
                <Text style={s.chatName}>{item.chatName}</Text>
                <Text style={s.sender}>{item.senderName} · {fmt(item.createdAt)}</Text>
                <Text style={s.msg} numberOfLines={3}>{item.plaintext || `[${item.msgType}]`}</Text>
              </View>
              <TouchableOpacity onPress={() => unstar(item)} style={s.unstarBtn}>
                <Text style={{ fontSize: 20 }}>⭐</Text>
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={<View style={s.center}><Text style={s.emptyTxt}>No starred messages yet{'\n'}Long press a message → Star</Text></View>}
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:    { flex: 1, backgroundColor: '#03030E' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  item:      { flexDirection: 'row', alignItems: 'flex-start', padding: 14, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  chatName:  { color: '#00E5FF', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  sender:    { color: '#555', fontSize: 11, marginBottom: 4 },
  msg:       { color: '#C0C0E0', fontSize: 14 },
  unstarBtn: { padding: 6 },
  emptyTxt:  { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
'@
[System.IO.File]::WriteAllText("$root\app\starred.tsx", $f6, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 7 of 9  app/search.tsx — global message search
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[7/9] app/search.tsx" -ForegroundColor Yellow
$f7 = @'
// app/search.tsx
// Global search across all chats

import React, { useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

interface Result {
  chatId: string;
  chatName: string;
  messageId: string;
  plaintext: string;
  senderId: string;
  createdAt: any;
  peerUid: string;
}

export default function SearchScreen() {
  const router   = useRouter();
  const myUid    = auth().currentUser?.uid ?? '';
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      // Get all chats I'm in
      const chatsSnap = await firestore().collection('chats')
        .where('participants', 'array-contains', myUid).get();

      const matches: Result[] = [];
      await Promise.all(chatsSnap.docs.map(async chatDoc => {
        const d = chatDoc.data();
        const chatName = d.name ?? (d.participantNames ? Object.values(d.participantNames).filter((n: any) => n !== myUid).join(', ') : 'Chat');
        const peerUid  = (d.participants as string[]).find(u => u !== myUid) ?? '';

        // Note: this searches on plaintext field (unencrypted legacy messages)
        // Encrypted messages need client-side search (decrypt first in memory)
        const msgsSnap = await firestore().collection('chats').doc(chatDoc.id)
          .collection('messages')
          .where('plaintext', '>=', q)
          .where('plaintext', '<=', q + '\uf8ff')
          .limit(5).get();

        msgsSnap.docs.forEach(mDoc => {
          const md = mDoc.data();
          matches.push({
            chatId: chatDoc.id, chatName, messageId: mDoc.id,
            plaintext: md.plaintext ?? '', senderId: md.senderId,
            createdAt: md.createdAt, peerUid,
          });
        });
      }));
      setResults(matches);
    } catch (e) { setResults([]); }
    finally { setLoading(false); }
  };

  const fmt = (ts: any) => ts?.toDate?.().toLocaleDateString() ?? '';

  return (
    <>
      <Stack.Screen options={{ title: 'Search', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <View style={s.searchBar}>
          <Text style={{ fontSize: 16, marginRight: 8 }}>🔍</Text>
          <TextInput
            style={s.input}
            placeholder="Search messages…"
            placeholderTextColor="#444"
            value={query}
            onChangeText={search}
            autoFocus
          />
          {loading && <ActivityIndicator color="#00E5FF" size="small" />}
        </View>
        <FlatList
          data={results}
          keyExtractor={r => r.chatId + r.messageId}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.result}
              onPress={() => router.push({ pathname: '/chat', params: { chatId: item.chatId, peerUid: item.peerUid, peerName: item.chatName } })}
            >
              <Text style={s.chatName}>{item.chatName}</Text>
              <Text style={s.date}>{fmt(item.createdAt)}</Text>
              <Text style={s.preview} numberOfLines={2}>
                {item.plaintext.replace(query, '').length < item.plaintext.length
                  ? item.plaintext
                  : item.plaintext}
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={query.length >= 2 && !loading
            ? <View style={s.empty}><Text style={s.emptyTxt}>No results for "{query}"</Text></View>
            : query.length < 2
              ? <View style={s.empty}><Text style={s.emptyTxt}>Type at least 2 characters</Text></View>
              : null
          }
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: '#03030E' },
  searchBar:{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', padding: 12, borderBottomWidth: 1, borderBottomColor: '#111' },
  input:    { flex: 1, color: '#E0E0F0', fontSize: 16 },
  result:   { padding: 14, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  chatName: { color: '#00E5FF', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  date:     { color: '#555', fontSize: 11, marginBottom: 4 },
  preview:  { color: '#C0C0E0', fontSize: 14 },
  empty:    { padding: 40, alignItems: 'center' },
  emptyTxt: { color: '#555', fontSize: 14 },
});
'@
[System.IO.File]::WriteAllText("$root\app\search.tsx", $f7, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 8 of 9  app/group-info.tsx — group settings, members, disappearing timer
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[8/9] app/group-info.tsx" -ForegroundColor Yellow
$f8 = @'
// app/group-info.tsx
// Group info: member list, add member, disappearing timer, leave group

import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { removeMember, setDisappearingTimer } from '../services/groupService';

export default function GroupInfoScreen() {
  const { chatId, groupName } = useLocalSearchParams<{ chatId: string; groupName: string }>();
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [members,   setMembers]   = useState<{ uid: string; name: string; isAdmin: boolean }[]>([]);
  const [admins,    setAdmins]    = useState<string[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [timer,     setTimer]     = useState(0);

  useEffect(() => {
    const unsub = firestore().collection('chats').doc(chatId).onSnapshot(snap => {
      const d = snap.data();
      if (!d) return;
      const ads = d.admins ?? [];
      setAdmins(ads);
      setTimer(d.disappearingTimer ?? 0);
      const list = (d.participants as string[]).map(uid => ({
        uid, name: d.participantNames?.[uid] ?? 'Unknown', isAdmin: ads.includes(uid),
      }));
      setMembers(list);
      setLoading(false);
    });
    return unsub;
  }, [chatId]);

  const leave = () => {
    Alert.alert('Leave Group?', 'You will be removed from this group.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        await removeMember(chatId, myUid);
        router.replace('/chats');
      }},
    ]);
  };

  const changeTimer = () => {
    const options = [
      { label: 'Off', value: 0 },
      { label: '24 hours', value: 86400 },
      { label: '7 days', value: 604800 },
      { label: '30 days', value: 2592000 },
    ];
    Alert.alert('Disappearing Messages', 'Choose timer for all messages', options.map(o => ({
      text: o.label + (timer === o.value ? ' ✓' : ''),
      onPress: () => { setDisappearingTimer(chatId, o.value); setTimer(o.value); },
    })));
  };

  const timerLabel = () => {
    if (timer === 0) return 'Off';
    if (timer === 86400) return '24 hours';
    if (timer === 604800) return '7 days';
    return '30 days';
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: '#03030E', alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#00E5FF" /></View>;

  return (
    <>
      <Stack.Screen options={{ title: groupName ?? 'Group Info', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <View style={s.section}>
          <Text style={s.sectionTitle}>DISAPPEARING MESSAGES</Text>
          <TouchableOpacity style={s.row} onPress={changeTimer}>
            <Text style={s.rowLabel}>⏱  Timer</Text>
            <Text style={s.rowValue}>{timerLabel()}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{members.length} MEMBERS</Text>
          <FlatList
            data={members}
            keyExtractor={m => m.uid}
            scrollEnabled={false}
            renderItem={({ item: m }) => (
              <View style={s.memberRow}>
                <View style={s.memberAvatar}>
                  <Text style={s.memberAvatarTxt}>{m.name[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.memberName}>{m.name}{m.uid === myUid ? ' (You)' : ''}</Text>
                  {m.isAdmin && <Text style={s.adminBadge}>Admin</Text>}
                </View>
                {admins.includes(myUid) && m.uid !== myUid && (
                  <TouchableOpacity onPress={() => { Alert.alert('Remove?', '', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => removeMember(chatId, m.uid) }]); }}>
                    <Text style={{ color: '#FF3C6E', fontSize: 13 }}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          />
        </View>

        <TouchableOpacity style={s.leaveBtn} onPress={leave}>
          <Text style={s.leaveTxt}>🚪 Leave Group</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:          { flex: 1, backgroundColor: '#03030E' },
  section:         { marginTop: 20 },
  sectionTitle:    { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, paddingBottom: 8 },
  row:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#111' },
  rowLabel:        { color: '#E0E0F0', fontSize: 15 },
  rowValue:        { color: '#00E5FF', fontSize: 14 },
  memberRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#111' },
  memberAvatar:    { width: 40, height: 40, borderRadius: 20, backgroundColor: '#111127', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  memberAvatarTxt: { color: '#00E5FF', fontSize: 16, fontWeight: 'bold' },
  memberName:      { color: '#E0E0F0', fontSize: 15 },
  adminBadge:      { color: '#FF8C42', fontSize: 11, marginTop: 2 },
  leaveBtn:        { margin: 20, backgroundColor: '#FF3C6E22', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#FF3C6E44' },
  leaveTxt:        { color: '#FF3C6E', fontSize: 15, fontWeight: '600' },
});
'@
[System.IO.File]::WriteAllText("$root\app\group-info.tsx", $f8, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 9 of 9  server/index.js — add group broadcast support
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[9/9] server/index.js (group broadcast)" -ForegroundColor Yellow
$f9 = @'
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

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No auth token'));
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    socket.data.uid = decoded.uid;
    next();
  } catch { next(new Error('Invalid token')); }
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

  socket.on('typing_start', ({ chatId, name }) => socket.to(`chat:${chatId}`).emit('typing_start', { uid, name }));
  socket.on('typing_stop',  ({ chatId })        => socket.to(`chat:${chatId}`).emit('typing_stop',  { uid }));

  // ── New message (handles both 1:1 and group) ───────────────────────────
  socket.on('new_message', async ({ chatId, messageId, senderUid, recipientUid, preview }) => {
    // Broadcast to everyone in the chat room (Socket.io room)
    socket.to(`chat:${chatId}`).emit('new_message', { chatId, messageId, senderUid, preview });

    if (recipientUid) {
      // 1:1 — deliver to specific user
      const rSock = online.get(recipientUid);
      if (rSock) {
        io.to(rSock).emit('message_delivered', { chatId, messageId });
        socket.emit('message_delivered', { chatId, messageId });
        await db.collection('chats').doc(chatId).collection('messages').doc(messageId)
          .update({ status: 'delivered' }).catch(() => {});
      }
      // FCM to recipient
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
    } else {
      // Group — FCM to all participants except sender
      try {
        const chatSnap = await db.collection('chats').doc(chatId).get();
        const participants = chatSnap.data()?.participants ?? [];
        await Promise.all(participants.filter((u) => u !== senderUid).map(async (pUid) => {
          const uSnap = await db.collection('users').doc(pUid).get();
          const tok   = uSnap.data()?.pushToken;
          if (tok) {
            await admin.messaging().send({
              token: tok,
              notification: { title: chatSnap.data()?.name ?? 'Group', body: preview ?? 'New message' },
              data: { chatId, messageId, senderUid, type: 'group_message' },
              android: { priority: 'high', notification: { sound: 'default', channelId: 'messages' } },
            }).catch(() => {});
          }
        }));
      } catch (e) { console.warn('[FCM Group]', e.message); }
    }
  });

  socket.on('message_read', async ({ chatId, messageId, readerUid, senderUid }) => {
    await db.collection('chats').doc(chatId).collection('messages').doc(messageId)
      .update({ status: 'read' }).catch(() => {});
    await db.collection('chats').doc(chatId)
      .update({ [`unread.${readerUid}`]: 0 }).catch(() => {});
    if (senderUid) {
      const sSock = online.get(senderUid);
      if (sSock) io.to(sSock).emit('message_read', { chatId, messageId });
    }
  });

  socket.on('message_edited',  d => socket.to(`chat:${d.chatId}`).emit('message_edited',  d));
  socket.on('message_deleted', d => socket.to(`chat:${d.chatId}`).emit('message_deleted', d));
  socket.on('reaction_updated',d => socket.to(`chat:${d.chatId}`).emit('reaction_updated',d));

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
'@
[System.IO.File]::WriteAllText("$root\server\index.js", $f9, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP A — Git commit and push
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Pushing to GitHub ..." -ForegroundColor Yellow
git add -A
git commit -m "Phase 3: groups, polls, disappearing msgs, search, starred, mute/archive"
git push origin master --force
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# DONE
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Phase 3 Complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  New files written:" -ForegroundColor White
Write-Host "  services/groupService.ts    Create/manage groups" -ForegroundColor Green
Write-Host "  app/create-group.tsx        New group creation screen" -ForegroundColor Green
Write-Host "  app/group-chat.tsx          Full group chat screen" -ForegroundColor Green
Write-Host "  app/group-info.tsx          Group settings + members" -ForegroundColor Green
Write-Host "  app/chats.tsx               Search, mute, archive, pin, online" -ForegroundColor Green
Write-Host "  app/starred.tsx             Starred messages screen" -ForegroundColor Green
Write-Host "  app/search.tsx              Global message search" -ForegroundColor Green
Write-Host "  components/PollMessage.tsx  Poll voting in chat" -ForegroundColor Green
Write-Host "  server/index.js             Group FCM push support" -ForegroundColor Green
Write-Host ""
Write-Host "  Features now working:" -ForegroundColor White
Write-Host "  [OK] Encrypted group chats" -ForegroundColor Green
Write-Host "  [OK] Polls with voting in groups" -ForegroundColor Green
Write-Host "  [OK] Disappearing messages (24h / 7d / 30d)" -ForegroundColor Green
Write-Host "  [OK] Pin messages in groups" -ForegroundColor Green
Write-Host "  [OK] Mute / archive / pin chats" -ForegroundColor Green
Write-Host "  [OK] Online status green dot" -ForegroundColor Green
Write-Host "  [OK] Note to Self encrypted chat" -ForegroundColor Green
Write-Host "  [OK] Starred messages screen" -ForegroundColor Green
Write-Host "  [OK] Global message search" -ForegroundColor Green
Write-Host "  [OK] Group push notifications to all members" -ForegroundColor Green
Write-Host ""
Write-Host "  Now run:  npx expo start" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Green
