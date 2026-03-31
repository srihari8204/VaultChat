// app/chat.tsx
// Phase 1 + Phase 2: E2E encryption, ticks, typing, reply, edit, delete,
// photos, videos, files, voice messages, GIFs, emoji reactions,
// message formatting (bold, italic, code)

import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text, TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { io, Socket } from 'socket.io-client';
import AttachmentSheet from '../components/AttachmentSheet';
import GifPicker from '../components/GifPicker';
import MediaMessage from '../components/MediaMessage';
import ReactionPicker from '../components/ReactionPicker';
import VoiceRecorder from '../components/VoiceRecorder';
import { getGhostSettings, GhostSettings } from '../services/ghostModeService';
import { decryptMessage, encryptMessage } from '../services/d2deService';
import { uploadMedia } from '../services/mediaService';

import { SERVER_URL as BACKEND } from '../constants/server';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type MsgStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
type MsgType   = 'text' | 'image' | 'video' | 'audio' | 'file' | 'gif';

interface Reactions { [emoji: string]: string[]; }

interface Message {
  id: string;
  senderId: string;
  plaintext: string;
  ciphertext: string;
  iv: string;
  tag?: string;
  keyId?: string;
  v?: number;
  status: MsgStatus;
  createdAt: any;
  isEdited?: boolean;
  isDeleted?: boolean;
  replyTo?: { id: string; senderId: string; plaintext: string };
  msgType: MsgType;
  mediaUrl?: string;
  filename?: string;
  audioDuration?: number;
  reactions?: Reactions;
}

// â”€â”€ Formatting helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function renderFormatted(text: string): React.ReactNode {
  // bold: *text*, italic: _text_, code: `text`
  const parts = text.split(/(\*[^*]+\*|_[^_]+_|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('*') && part.endsWith('*'))
      return <Text key={i} style={{ fontWeight: 'bold' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('_') && part.endsWith('_'))
      return <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <Text key={i} style={{ fontFamily: 'monospace', backgroundColor: '#F3F4F6', color: '#4A9FFF' }}>{part.slice(1, -1)}</Text>;
    return <Text key={i}>{part}</Text>;
  });
}

// â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function ChatScreen() {
  const { chatId, peerUid, peerName } = useLocalSearchParams<{
    chatId: string; peerUid: string; peerName: string;
  }>();
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [messages,      setMessages]      = useState<Message[]>([]);
  const [inputText,     setInputText]     = useState('');
  const [loading,       setLoading]       = useState(true);
  const [sending,       setSending]       = useState(false);
  const [uploading,     setUploading]     = useState(false);
  const [uploadPct,     setUploadPct]     = useState(0);
  const [peerTyping,    setPeerTyping]    = useState(false);
  const [replyTarget,   setReplyTarget]   = useState<Message | null>(null);
  const [editTarget,    setEditTarget]    = useState<Message | null>(null);
  const [longPressMsg,  setLongPressMsg]  = useState<Message | null>(null);
  const [forwardMsg,    setForwardMsg]    = useState<Message | null>(null);
  const [forwardChats,  setForwardChats]  = useState<any[]>([]);
  const [showAttach,    setShowAttach]    = useState(false);
  const [showVoice,     setShowVoice]     = useState(false);
  const [showGif,       setShowGif]       = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [reactionTarget,setReactionTarget]= useState<Message | null>(null);

  const [ghostSettings, setGhostSettingsState] = useState<GhostSettings | null>(null);

  const flatRef     = useRef<FlatList>(null);
  const socketRef   = useRef<Socket | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping    = useRef(false);

  // Ghost Mode — load per-contact privacy settings
  useEffect(() => {
    if (!peerUid) return;
    getGhostSettings(peerUid).then(setGhostSettingsState).catch(() => {});
  }, [peerUid]);

  const isGhosted = ghostSettings?.enabled ?? false;

  // â”€â”€ Socket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    let sock: Socket;
    (async () => {
      const token = await auth().currentUser?.getIdToken();
      sock = io(BACKEND, { auth: { token }, transports: ['websocket'] });
      sock.emit('join_chat', { chatId, uid: myUid });

      sock.on('typing_start',      ({ uid }: any) => { if (uid !== myUid) setPeerTyping(true);  });
      sock.on('typing_stop',       ({ uid }: any) => { if (uid !== myUid) setPeerTyping(false); });
      sock.on('message_delivered', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId && m.status === 'sent' ? { ...m, status: 'delivered' } : m)));
      sock.on('message_read', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, status: 'read' } : m)));
      sock.on('message_edited', ({ messageId, newPlaintext }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, plaintext: newPlaintext, isEdited: true } : m)));
      sock.on('message_deleted', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, isDeleted: true, plaintext: '' } : m)));
      sock.on('reaction_updated', ({ messageId, reactions }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, reactions } : m)));

      socketRef.current = sock;
    })();
    return () => { sock?.disconnect(); };
  }, [chatId, myUid]);

  // â”€â”€ Firestore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const markRead = useCallback((docs: any[]) => {
    // Ghost Mode: suppress read receipts when ghosted
    if (isGhosted && ghostSettings?.hideReadReceipts) return;
    const batch = firestore().batch();
    docs.forEach(doc => {
      if (doc.data().senderId !== myUid && doc.data().status !== 'read') {
        batch.update(doc.ref, { status: 'read' });
        socketRef.current?.emit('message_read', { chatId, messageId: doc.id, readerUid: myUid, senderUid: peerUid });
      }
    });
    batch.commit().catch(() => {});
  }, [chatId, myUid, peerUid, isGhosted, ghostSettings]);

  useEffect(() => {
    const unsub = firestore()
      .collection('chats').doc(chatId)
      .collection('messages').orderBy('createdAt', 'asc')
      .onSnapshot(async snap => {
        const msgs = await Promise.all(snap.docs.map(async doc => {
          const d = doc.data() as any;
          if (d.isDeleted) return { id: doc.id, senderId: d.senderId, plaintext: '', ciphertext: '', iv: '', status: d.status ?? 'sent', createdAt: d.createdAt, isDeleted: true, msgType: d.msgType ?? 'text' } as Message;

          let plaintext = '';
          if (d.msgType === 'text') {
            try {
              if (d.ciphertext && d.iv) {
                plaintext = await decryptMessage({ ciphertext: d.ciphertext, iv: d.iv, tag: d.tag ?? '', keyId: d.keyId ?? 'v1-pbkdf2', v: d.v ?? 1 }, myUid, peerUid);
              } else { plaintext = d.plaintext ?? ''; }
            } catch { plaintext = '[Decryption failed]'; }
          }

          return {
            id: doc.id, senderId: d.senderId, plaintext,
            ciphertext: d.ciphertext ?? '', iv: d.iv ?? '',
            status: d.status ?? 'sent', createdAt: d.createdAt,
            isEdited: d.isEdited ?? false, isDeleted: false,
            replyTo: d.replyTo ?? null, msgType: d.msgType ?? 'text',
            mediaUrl: d.mediaUrl, filename: d.filename,
            audioDuration: d.audioDuration,
            reactions: d.reactions ?? {},
          } as Message;
        }));
        setMessages(msgs);
        setLoading(false);
        markRead(snap.docs);
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 80);
      });
    return unsub;
  }, [chatId, myUid, peerUid, markRead]);

  // â”€â”€ Typing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleTyping = (text: string) => {
    setInputText(text);
    // Ghost Mode: suppress typing indicators when ghosted
    if (isGhosted && ghostSettings?.hideTyping) return;
    if (!isTyping.current) { isTyping.current = true; socketRef.current?.emit('typing_start', { chatId, uid: myUid }); }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => { isTyping.current = false; socketRef.current?.emit('typing_stop', { chatId, uid: myUid }); }, 2000);
  };

  // â”€â”€ Core send (text) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const sendTextMessage = async (text: string, reply?: Message | null) => {
    setSending(true);
    isTyping.current = false;
    socketRef.current?.emit('typing_stop', { chatId, uid: myUid });
    const tempId = `temp_${Date.now()}`;
    // Optimistically add message to UI
    const optimistic: Message = {
      id: tempId, senderId: myUid, plaintext: text, ciphertext: '', iv: '',
      status: 'sending', createdAt: { toDate: () => new Date() }, msgType: 'text',
      replyTo: reply ? { id: reply.id, senderId: reply.senderId, plaintext: reply.plaintext.substring(0, 80) } : undefined,
    };
    setMessages(prev => [...prev, optimistic]);
    try {
      const payload = await encryptMessage(text, myUid, peerUid);
      const data: any = {
        senderId: myUid, ciphertext: payload.ciphertext, iv: payload.iv,
        tag: payload.tag, keyId: payload.keyId, v: payload.v,
        msgType: 'text', status: 'sent', isDeleted: false,
        reactions: {},
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (reply) data.replyTo = { id: reply.id, senderId: reply.senderId, plaintext: reply.plaintext.substring(0, 80) };
      const ref = await firestore().collection('chats').doc(chatId).collection('messages').add(data);
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: text.substring(0, 60), lastTime: firestore.FieldValue.serverTimestamp(),
        [`unread.${peerUid}`]: firestore.FieldValue.increment(1),
      });
      socketRef.current?.emit('new_message', { chatId, messageId: ref.id, senderUid: myUid, recipientUid: peerUid, preview: text.substring(0, 40) });
    } catch (e: any) {
      // Mark optimistic message as failed
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' as MsgStatus } : m));
      Alert.alert('Error', e.message);
    }
    finally { setSending(false); }
  };

  // â”€â”€ Send media message (photo/video/audio/file/gif) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const sendMediaMessage = async (
    localUri: string,
    type: 'image' | 'video' | 'audio' | 'file' | 'gif',
    opts?: { filename?: string; duration?: number; gifUrl?: string }
  ) => {
    setUploading(true); setUploadPct(0);
    try {
      let downloadURL = opts?.gifUrl ?? '';
      let filename    = opts?.filename ?? '';
      if (!downloadURL) {
        const result = await uploadMedia(localUri, chatId, type === 'gif' ? 'image' : type, opts?.filename, pct => setUploadPct(pct));
        downloadURL = result.downloadURL;
        filename    = result.filename;
      }
      const data: any = {
        senderId: myUid, msgType: type, mediaUrl: downloadURL,
        filename, status: 'sent', isDeleted: false, reactions: {},
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (type === 'audio' && opts?.duration) data.audioDuration = opts.duration;
      const ref = await firestore().collection('chats').doc(chatId).collection('messages').add(data);
      const preview = type === 'audio' ? 'ðŸŽ¤ Voice message' : type === 'gif' ? 'ðŸŽžï¸ GIF' : type === 'file' ? `ðŸ“„ ${filename}` : `ðŸ“· ${type}`;
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: preview, lastTime: firestore.FieldValue.serverTimestamp(),
        [`unread.${peerUid}`]: firestore.FieldValue.increment(1),
      });
      socketRef.current?.emit('new_message', { chatId, messageId: ref.id, senderUid: myUid, recipientUid: peerUid, preview });
    } catch (e: any) { Alert.alert('Upload error', e.message); }
    finally { setUploading(false); }
  };

  // â”€â”€ Send button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const onSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    if (editTarget) { await saveEdit(text); return; }
    setInputText('');
    const reply = replyTarget; setReplyTarget(null);
    await sendTextMessage(text, reply);
  };

  // â”€â”€ Edit / Delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const startEdit  = (m: Message) => { setEditTarget(m); setLongPressMsg(null); setInputText(m.plaintext); };
  const cancelEdit = () => { setEditTarget(null); setInputText(''); };
  const saveEdit   = async (newText: string) => {
    if (!editTarget) return;
    setSending(true); setEditTarget(null); setInputText('');
    try {
      const payload = await encryptMessage(newText, myUid, peerUid);
      await firestore().collection('chats').doc(chatId).collection('messages').doc(editTarget.id)
        .update({ ciphertext: payload.ciphertext, iv: payload.iv, isEdited: true, editedAt: firestore.FieldValue.serverTimestamp() });
      socketRef.current?.emit('message_edited', { chatId, messageId: editTarget.id, newPlaintext: newText });
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSending(false); }
  };

  const deleteForEveryone = (m: Message) => {
    setLongPressMsg(null);
    Alert.alert('Delete for Everyone?', 'Permanently removed for both users.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await firestore().collection('chats').doc(chatId).collection('messages').doc(m.id)
            .update({ ciphertext: firestore.FieldValue.delete(), iv: firestore.FieldValue.delete(), mediaUrl: firestore.FieldValue.delete(), isDeleted: true });
          socketRef.current?.emit('message_deleted', { chatId, messageId: m.id, deleterUid: myUid });
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  // â”€â”€ Reactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const addReaction = async (msg: Message, emoji: string) => {
    setShowReactions(false); setReactionTarget(null); setLongPressMsg(null);
    const existing: Reactions = msg.reactions ?? {};
    const users: string[] = existing[emoji] ?? [];
    let updated: Reactions;
    if (users.includes(myUid)) {
      // toggle off
      const filtered = users.filter(u => u !== myUid);
      updated = { ...existing };
      if (filtered.length === 0) delete updated[emoji];
      else updated[emoji] = filtered;
    } else {
      updated = { ...existing, [emoji]: [...users, myUid] };
    }
    await firestore().collection('chats').doc(chatId).collection('messages').doc(msg.id)
      .update({ reactions: updated });
    socketRef.current?.emit('reaction_updated', { chatId, messageId: msg.id, reactions: updated });
  };

  // â”€â”€ Pickers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 });
    if (!res.canceled && res.assets[0]) await sendMediaMessage(res.assets[0].uri, 'image');
  };

  const pickVideo = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos });
    if (!res.canceled && res.assets[0]) await sendMediaMessage(res.assets[0].uri, 'video');
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (!res.canceled && res.assets[0]) await sendMediaMessage(res.assets[0].uri, 'file', { filename: res.assets[0].name });
  };

  // â”€â”€ Render message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const Ticks = ({ status }: { status: MsgStatus }) => {
    if (status === 'sending')   return <Text style={s.tick}>â—‹</Text>;
    if (status === 'sent')      return <Text style={s.tick}>âœ“</Text>;
    if (status === 'delivered') return <Text style={s.tick}>âœ“âœ“</Text>;
    return <Text style={[s.tick, { color: '#4A9FFF' }]}>âœ“âœ“</Text>;
  };

  const ReactionRow = ({ msg }: { msg: Message }) => {
    const reactions = msg.reactions ?? {};
    const entries   = Object.entries(reactions).filter(([, uids]) => uids.length > 0);
    if (entries.length === 0) return null;
    return (
      <View style={s.reactionRow}>
        {entries.map(([emoji, uids]) => (
          <TouchableOpacity key={emoji} onPress={() => addReaction(msg, emoji)} style={[s.reactionChip, uids.includes(myUid) && s.reactionChipMine]}>
            <Text style={s.reactionEmoji}>{emoji}</Text>
            {uids.length > 1 && <Text style={s.reactionCount}>{uids.length}</Text>}
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderMsg = ({ item: m }: { item: Message }) => {
    const isMe = m.senderId === myUid;
    if (m.isDeleted) return (
      <View style={[s.row, isMe ? s.rowR : s.rowL]}>
        <View style={[s.bubble, s.bubbleDel]}>
          <Text style={s.delTxt}>ðŸš« Message deleted</Text>
        </View>
      </View>
    );

    return (
      <Pressable onLongPress={() => { setLongPressMsg(m); }} delayLongPress={350}>
        <View style={[s.row, isMe ? s.rowR : s.rowL]}>
          <View>
            <View style={[s.bubble, isMe ? s.bMe : s.bPeer]}>
              {m.replyTo && (
                <View style={s.replyBar}>
                  <Text style={s.replyName}>{m.replyTo.senderId === myUid ? 'You' : peerName}</Text>
                  <Text style={s.replyPrev} numberOfLines={1}>{m.replyTo.plaintext}</Text>
                </View>
              )}

              {m.msgType !== 'text' && m.mediaUrl
                ? <MediaMessage url={m.mediaUrl} msgType={m.msgType} filename={m.filename} duration={m.audioDuration} />
                : <Text style={s.msgTxt}>{renderFormatted(m.plaintext)}</Text>
              }

              <View style={s.meta}>
                {m.isEdited && <Text style={s.edited}>edited Â· </Text>}
                <Text style={s.time}>{m.createdAt?.toDate?.().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? ''}</Text>
                {isMe && <Ticks status={m.status} />}
              </View>
            </View>
            <ReactionRow msg={m} />
          </View>
        </View>
      </Pressable>
    );
  };

  // â”€â”€ Long press sheet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  
  // -- Forward message to another chat --
  const startForward = async (m: Message) => {
    setLongPressMsg(null);
    setForwardMsg(m);
    try {
      const snap = await firestore().collection('chats')
        .where('participants', 'array-contains', myUid)
        .orderBy('lastTime', 'desc').limit(20).get();
      const list: any[] = [];
      for (const d of snap.docs) {
        if (d.id === chatId) continue;
        const data = d.data();
        const otherId = (data.participants || []).find((p: string) => p !== myUid);
        if (!otherId && !data.groupName) continue;
        let name = data.groupName || '';
        if (!name && otherId) {
          const uSnap = await firestore().collection('users').doc(otherId).get();
          name = uSnap.data()?.name || uSnap.data()?.displayName || otherId.slice(0, 8);
        }
        list.push({ chatId: d.id, peerUid: otherId, name, groupName: data.groupName });
      }
      setForwardChats(list);
    } catch { Alert.alert('Error', 'Could not load chats'); setForwardMsg(null); }
  };

  const doForward = async (target: any) => {
    if (!forwardMsg) return;
    try {
      const fwdData: any = {
        senderId: myUid,
        msgType: forwardMsg.msgType || 'text',
        status: 'sent', isDeleted: false, reactions: {},
        isForwarded: true,
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (forwardMsg.msgType === 'text' || !forwardMsg.mediaUrl) {
        fwdData.ciphertext = forwardMsg.ciphertext;
        fwdData.iv = forwardMsg.iv;
        fwdData.tag = forwardMsg.tag;
        fwdData.keyId = forwardMsg.keyId;
        fwdData.v = forwardMsg.v;
        fwdData.plaintext = forwardMsg.plaintext;
      } else {
        fwdData.mediaUrl = forwardMsg.mediaUrl;
        fwdData.filename = forwardMsg.filename;
        if (forwardMsg.audioDuration) fwdData.audioDuration = forwardMsg.audioDuration;
      }
      await firestore().collection('chats').doc(target.chatId).collection('messages').add(fwdData);
      const preview = forwardMsg.plaintext ? forwardMsg.plaintext.substring(0, 40) : forwardMsg.filename || forwardMsg.msgType;
      await firestore().collection('chats').doc(target.chatId).update({
        lastMsg: preview, lastTime: firestore.FieldValue.serverTimestamp(),
      });
      setForwardMsg(null); setForwardChats([]);
      Alert.alert('Forwarded!', 'Message sent to ' + (target.groupName || target.name));
    } catch (e: any) { Alert.alert('Error', e.message); }
  };
const Sheet = () => {
    if (!longPressMsg) return null;
    const isMe = longPressMsg.senderId === myUid;
    return (
      <Pressable style={s.overlay} onPress={() => setLongPressMsg(null)}>
        <View style={s.sheet}>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReactionTarget(longPressMsg); setShowReactions(true); setLongPressMsg(null); }}>
            <Text style={s.sheetTxt}>React</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReplyTarget(longPressMsg); setLongPressMsg(null); }}>
            <Text style={s.sheetTxt}>â†©  Reply</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => startForward(longPressMsg)}>
            <Text style={s.sheetTxt}>{"\u27A1\uFE0F  Forward"}</Text>
          </TouchableOpacity>
          {isMe && longPressMsg.msgType === 'text' && (
            <TouchableOpacity style={s.sheetRow} onPress={() => startEdit(longPressMsg)}>
              <Text style={s.sheetTxt}>âœï¸  Edit</Text>
            </TouchableOpacity>
          )}
          {isMe && (
            <TouchableOpacity style={s.sheetRow} onPress={() => deleteForEveryone(longPressMsg)}>
              <Text style={[s.sheetTxt, { color: '#FF3C6E' }]}>ðŸ—‘  Delete for Everyone</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.sheetRow} onPress={() => setLongPressMsg(null)}>
            <Text style={[s.sheetTxt, { color: '#555' }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    );
  };

  // â”€â”€ Main render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  
  const ForwardModal = () => {
    if (!forwardMsg) return null;
    return (
      <Modal visible={true} transparent animationType="slide" onRequestClose={() => { setForwardMsg(null); setForwardChats([]); }}>
        <Pressable style={s.overlay} onPress={() => { setForwardMsg(null); setForwardChats([]); }}>
          <View style={[s.sheet, { maxHeight: '70%' }]}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 }}>Forward to...</Text>
            {forwardChats.length === 0
              ? <ActivityIndicator color="#00E5FF" style={{ padding: 20 }} />
              : <FlatList data={forwardChats} keyExtractor={c => c.chatId}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={[s.sheetRow, { flexDirection: 'row', alignItems: 'center', gap: 10 }]} onPress={() => doForward(item)}>
                      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#1D4ED8', justifyContent: 'center', alignItems: 'center' }}>
                        <Text style={{ color: '#fff', fontWeight: '900', fontSize: 14 }}>{(item.groupName || item.name || '?')[0].toUpperCase()}</Text>
                      </View>
                      <Text style={s.sheetTxt}>{item.groupName || item.name}</Text>
                    </TouchableOpacity>
                  )}
                />
            }
            <TouchableOpacity style={s.sheetRow} onPress={() => { setForwardMsg(null); setForwardChats([]); }}>
              <Text style={[s.sheetTxt, { color: '#555' }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    );
  };
return (
    <>
      <Stack.Screen options={{
        title: peerName ?? 'Chat',
        headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937',
        headerTitle: () => (
          <View style={{ alignItems: 'flex-start' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }} numberOfLines={1}>{peerName ?? 'Chat'}</Text>
              {isGhosted && <Text style={{ fontSize: 14 }}>{'\uD83D\uDC7B'}</Text>}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ color: '#00D4AA', fontSize: 9, fontWeight: '700' }}>{"\uD83D\uDD12"} END-TO-END ENCRYPTED</Text>
              {isGhosted && <Text style={{ color: '#9CA3AF', fontSize: 9 }}> | GHOST</Text>}
            </View>
          </View>
        ),
        headerRight: () => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginRight: 12 }}>
            <TouchableOpacity onPress={() => router.push({ pathname: '/ghost-mode' as any, params: { contactUid: peerUid, contactName: peerName } })}>
              <Text style={{ fontSize: 18, opacity: isGhosted ? 1 : 0.4 }}>{'\uD83D\uDC7B'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push({ pathname: '/voicecall' as any, params: { chatId, name: peerName } })}>
              <Text style={{ color: '#4A9FFF', fontSize: 20 }}>{"\u260E\uFE0F"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push({ pathname: '/videocall', params: { chatId, peerUid, peerName } })}>
              <Text style={{ color: '#4A9FFF', fontSize: 20 }}>{"\uD83D\uDCF9"}</Text>
            </TouchableOpacity>
          </View>
        ),
      }} />

      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>

        {loading ? <ActivityIndicator color="#00E5FF" style={{ flex: 1 }} /> :
          <FlatList ref={flatRef} data={messages} keyExtractor={m => m.id} renderItem={renderMsg}
            contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} />
        }

        {uploading && (
          <View style={s.uploadBar}>
            <Text style={s.uploadTxt}>Uploadingâ€¦ {uploadPct}%</Text>
            <View style={[s.uploadFill, { width: `${uploadPct}%` as any }]} />
          </View>
        )}

        {peerTyping && <View style={s.typingRow}><Text style={s.typingTxt}>{peerName} is typingâ€¦</Text></View>}

        {replyTarget && (
          <View style={s.banner}>
            <View style={{ flex: 1 }}>
              <Text style={s.bannerTitle}>Replying to {replyTarget.senderId === myUid ? 'yourself' : peerName}</Text>
              <Text style={s.bannerPrev} numberOfLines={1}>{replyTarget.plaintext}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTarget(null)}><Text style={s.bannerX}>âœ•</Text></TouchableOpacity>
          </View>
        )}

        {editTarget && (
          <View style={[s.banner, { borderTopColor: '#4F8FFF33' }]}>
            <Text style={[s.bannerTitle, { color: '#4F8FFF', flex: 1 }]}>âœï¸  Editing message</Text>
            <TouchableOpacity onPress={cancelEdit}><Text style={s.bannerX}>âœ•</Text></TouchableOpacity>
          </View>
        )}

        {showVoice
          ? <VoiceRecorder
              onSend={(uri, dur) => { setShowVoice(false); sendMediaMessage(uri, 'audio', { duration: dur }); }}
              onCancel={() => setShowVoice(false)}
            />
          : <View style={s.bar}>
              <TouchableOpacity onPress={() => setShowAttach(true)} style={s.attachBtn}>
                <Text style={{ fontSize: 22, color: '#555' }}>ï¼‹</Text>
              </TouchableOpacity>
              <TextInput
                style={s.input} value={inputText} onChangeText={handleTyping}
                placeholder="Messageâ€¦" placeholderTextColor="#444" multiline maxLength={4000}
              />
              {inputText.trim()
                ? <TouchableOpacity style={[s.sendBtn, sending && s.sendOff]} onPress={onSend} disabled={sending}>
                    {sending ? <ActivityIndicator color="#000" size="small" /> : <Text style={s.sendIco}>{editTarget ? 'âœ“' : 'âž¤'}</Text>}
                  </TouchableOpacity>
                : <TouchableOpacity style={s.sendBtn} onPress={() => setShowVoice(true)}>
                    <Text style={s.sendIco}>ðŸŽ¤</Text>
                  </TouchableOpacity>
              }
            </View>
        }

        <Sheet />
        <ForwardModal />

        <AttachmentSheet
          visible={showAttach} onClose={() => setShowAttach(false)}
          onPhoto={pickPhoto} onVideo={pickVideo} onFile={pickFile}
          onGif={() => { setShowAttach(false); setShowGif(true); }}
          onVoice={() => { setShowAttach(false); setShowVoice(true); }}
        />

        <GifPicker
          visible={showGif} onClose={() => setShowGif(false)}
          onSelect={(url) => sendMediaMessage(url, 'gif', { gifUrl: url })}
        />

        <ReactionPicker
          visible={showReactions} onClose={() => { setShowReactions(false); setReactionTarget(null); }}
          onSelect={(emoji) => { if (reactionTarget) addReaction(reactionTarget, emoji); }}
        />

      </KeyboardAvoidingView>
    </>
  );
}

// â”€â”€ Styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: '#FFFFFF' },
  list:        { padding: 12, paddingBottom: 8 },
  row:         { marginBottom: 6 },
  rowR:        { alignItems: 'flex-end' },
  rowL:        { alignItems: 'flex-start' },
  bubble:      { maxWidth: '80%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bMe:         { backgroundColor: '#DCF8C6', borderBottomRightRadius: 2 },
  bPeer:       { backgroundColor: '#F0F0F0', borderBottomLeftRadius: 2 },
  bubbleDel:   { backgroundColor: '#F5F5F5', borderWidth: 1, borderColor: '#E0E0E0' },
  msgTxt:      { color: '#1F2937', fontSize: 15, lineHeight: 21 },
  delTxt:      { color: '#9CA3AF', fontSize: 14, fontStyle: 'italic' },
  meta:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 },
  time:        { color: '#9CA3AF', fontSize: 11, marginRight: 3 },
  edited:      { color: '#9CA3AF', fontSize: 11 },
  tick:        { color: '#9CA3AF', fontSize: 12 },
  replyBar:    { backgroundColor: '#F3F4F6', borderLeftWidth: 3, borderLeftColor: '#4A9FFF', borderRadius: 6, padding: 6, marginBottom: 6 },
  replyName:   { color: '#4A9FFF', fontSize: 11, fontWeight: 'bold', marginBottom: 1 },
  replyPrev:   { color: '#6B7280', fontSize: 12 },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionChip:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 12, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: '#E5E7EB' },
  reactionChipMine: { borderColor: '#4A9FFF', backgroundColor: '#4A9FFF11' },
  reactionEmoji:    { fontSize: 14 },
  reactionCount:    { color: '#6B7280', fontSize: 11, marginLeft: 3 },
  uploadBar:   { backgroundColor: '#F9FAFB', paddingHorizontal: 14, paddingVertical: 6 },
  uploadTxt:   { color: '#4A9FFF', fontSize: 12, marginBottom: 4 },
  uploadFill:  { height: 2, backgroundColor: '#4A9FFF', borderRadius: 1 },
  typingRow:   { paddingHorizontal: 16, paddingBottom: 6 },
  typingTxt:   { color: '#9CA3AF', fontSize: 13, fontStyle: 'italic' },
  banner:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F9FAFB', borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingHorizontal: 14, paddingVertical: 8 },
  bannerTitle: { color: '#4A9FFF', fontSize: 12, fontWeight: 'bold' },
  bannerPrev:  { color: '#6B7280', fontSize: 12 },
  bannerX:     { color: '#9CA3AF', fontSize: 20, paddingHorizontal: 8 },
  bar:         { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#FFFFFF', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB' },
  attachBtn:   { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  input:       { flex: 1, backgroundColor: '#F3F4F6', color: '#1F2937', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120, marginHorizontal: 6 },
  sendBtn:     { width: 44, height: 44, borderRadius: 22, backgroundColor: '#4A9FFF', alignItems: 'center', justifyContent: 'center' },
  sendOff:     { backgroundColor: '#E5E7EB' },
  sendIco:     { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  overlay:     { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000044', justifyContent: 'flex-end' },
  sheet:       { backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36, paddingTop: 8 },
  sheetRow:    { padding: 18, borderBottomWidth: 1, borderBottomColor: '#F1F3F4' },
  sheetTxt:    { color: '#1F2937', fontSize: 16 },
});
