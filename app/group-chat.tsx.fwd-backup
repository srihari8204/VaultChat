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
              setPinnedMsg({ id: msnap.id, senderId: md.senderId, senderName: d.participantNames?.[md.senderId] ?? 'Unknown', plaintext: md.plaintext ?? 'ðŸ“Ž Media', status: 'sent', createdAt: md.createdAt, msgType: md.msgType ?? 'text' });
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
    await firestore().collection('chats').doc(chatId).update({ lastMsg: `ðŸ“Š Poll: ${q}`, lastTime: firestore.FieldValue.serverTimestamp() });
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
      await firestore().collection('chats').doc(chatId).update({ lastMsg: `ðŸ“Ž ${type}`, lastTime: firestore.FieldValue.serverTimestamp() });
    } catch (e: any) { Alert.alert('Upload error', e.message); }
    finally { setUploading(false); }
  };

  const Ticks = ({ status }: { status: string }) => {
    if (status === 'sent') return <Text style={s.tick}>âœ“</Text>;
    if (status === 'delivered') return <Text style={s.tick}>âœ“âœ“</Text>;
    return <Text style={[s.tick, { color: '#00E5FF' }]}>âœ“âœ“</Text>;
  };

  const renderMsg = ({ item: m }: { item: Message }) => {
    const isMe = m.senderId === myUid;
    if (m.isDeleted) return <View style={[s.row, isMe ? s.rowR : s.rowL]}><View style={[s.bubble, s.bubbleDel]}><Text style={s.delTxt}>ðŸš« Deleted</Text></View></View>;
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
              {m.expiresAt && <Text style={s.expiry}>â± Disappearing</Text>}
              <View style={s.meta}>
                {m.isEdited && <Text style={s.edited}>edited Â· </Text>}
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
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReactTarget(longPressMsg); setShowReaction(true); setLongPressMsg(null); }}><Text style={s.sheetTxt}>ðŸ˜Š  React</Text></TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReplyTarget(longPressMsg); setLongPressMsg(null); }}><Text style={s.sheetTxt}>â†©  Reply</Text></TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { pinMessage(chatId, longPressMsg.id); setLongPressMsg(null); Alert.alert('Pinned!'); }}><Text style={s.sheetTxt}>ðŸ“Œ  Pin Message</Text></TouchableOpacity>
          {isMe && longPressMsg.msgType === 'text' && <TouchableOpacity style={s.sheetRow} onPress={() => { setEditTarget(longPressMsg); setLongPressMsg(null); setInputText(longPressMsg.plaintext); }}><Text style={s.sheetTxt}>âœï¸  Edit</Text></TouchableOpacity>}
          {isMe && <TouchableOpacity style={s.sheetRow} onPress={() => deleteMsg(longPressMsg)}><Text style={[s.sheetTxt, { color: '#FF3C6E' }]}>ðŸ—‘  Delete</Text></TouchableOpacity>}
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
          <TextInput style={s.pollInput} placeholder="Questionâ€¦" placeholderTextColor="#444" value={pollQuestion} onChangeText={setPollQuestion} />
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
            <Text style={{ color: '#00E5FF', fontSize: 14 }}>â„¹ï¸</Text>
          </TouchableOpacity>
        ),
      }} />
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>

        {/* Pinned message banner */}
        {pinnedMsg && showPinned && (
          <TouchableOpacity style={s.pinnedBanner} onPress={() => setShowPinned(false)}>
            <Text style={s.pinnedIcon}>ðŸ“Œ</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.pinnedName}>{pinnedMsg.senderName}</Text>
              <Text style={s.pinnedTxt} numberOfLines={1}>{pinnedMsg.plaintext}</Text>
            </View>
            <Text style={{ color: '#555', fontSize: 18 }}>âœ•</Text>
          </TouchableOpacity>
        )}
        {pinnedMsg && !showPinned && (
          <TouchableOpacity style={[s.pinnedBanner, { paddingVertical: 6 }]} onPress={() => setShowPinned(true)}>
            <Text style={s.pinnedIcon}>ðŸ“Œ</Text>
            <Text style={s.pinnedName}>Pinned message</Text>
          </TouchableOpacity>
        )}

        {loading
          ? <ActivityIndicator color="#00E5FF" style={{ flex: 1 }} />
          : <FlatList ref={flatRef} data={messages} keyExtractor={m => m.id} renderItem={renderMsg}
              contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} />
        }

        {uploading && <View style={s.uploadBar}><Text style={s.uploadTxt}>Uploadingâ€¦</Text></View>}
        {peerTyping.length > 0 && <View style={s.typingRow}><Text style={s.typingTxt}>{peerTyping.join(', ')} {peerTyping.length === 1 ? 'is' : 'are'} typingâ€¦</Text></View>}

        {replyTarget && (
          <View style={s.banner}>
            <View style={{ flex: 1 }}>
              <Text style={s.bannerTitle}>Replying to {replyTarget.senderName}</Text>
              <Text style={s.bannerPrev} numberOfLines={1}>{replyTarget.plaintext}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTarget(null)}><Text style={s.bannerX}>âœ•</Text></TouchableOpacity>
          </View>
        )}
        {editTarget && (
          <View style={[s.banner, { borderTopColor: '#4F8FFF33' }]}>
            <Text style={[s.bannerTitle, { color: '#4F8FFF', flex: 1 }]}>âœï¸  Editing</Text>
            <TouchableOpacity onPress={() => { setEditTarget(null); setInputText(''); }}><Text style={s.bannerX}>âœ•</Text></TouchableOpacity>
          </View>
        )}

        {showVoice
          ? <VoiceRecorder onSend={(uri, dur) => { setShowVoice(false); sendMedia(uri, 'audio', { duration: dur }); }} onCancel={() => setShowVoice(false)} />
          : <View style={s.bar}>
              <TouchableOpacity onPress={() => setShowAttach(true)} style={s.attachBtn}><Text style={{ fontSize: 22, color: '#555' }}>ï¼‹</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setShowPollModal(true)} style={s.attachBtn}><Text style={{ fontSize: 20, color: '#555' }}>ðŸ“Š</Text></TouchableOpacity>
              <TextInput style={s.input} value={inputText} onChangeText={handleTyping} placeholder="Messageâ€¦" placeholderTextColor="#444" multiline maxLength={4000} />
              {inputText.trim()
                ? <TouchableOpacity style={[s.sendBtn, sending && s.sendOff]} onPress={sendText} disabled={sending}>
                    {sending ? <ActivityIndicator color="#000" size="small" /> : <Text style={s.sendIco}>{editTarget ? 'âœ“' : 'âž¤'}</Text>}
                  </TouchableOpacity>
                : <TouchableOpacity style={s.sendBtn} onPress={() => setShowVoice(true)}><Text style={s.sendIco}>ðŸŽ¤</Text></TouchableOpacity>
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