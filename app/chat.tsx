import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet, Alert,
  ActivityIndicator, Pressable,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { io, Socket } from 'socket.io-client';
import { encryptMessage, decryptMessage, EncryptedPayload } from '../services/d2deService';

const BACKEND = 'https://vaultchat.onrender.com';

interface Message {
  id: string;
  senderId: string;
  plaintext: string;
  ciphertext: string;
  iv: string;
  status: 'sending' | 'sent' | 'delivered' | 'read';
  createdAt: any;
  isEdited?: boolean;
  isDeleted?: boolean;
  replyTo?: { id: string; senderId: string; plaintext: string };
  msgType: 'text' | 'image' | 'audio' | 'file';
}

export default function ChatScreen() {
  const { chatId, peerUid, peerName } = useLocalSearchParams<{
    chatId: string; peerUid: string; peerName: string;
  }>();
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [messages,     setMessages]     = useState<Message[]>([]);
  const [inputText,    setInputText]    = useState('');
  const [loading,      setLoading]      = useState(true);
  const [sending,      setSending]      = useState(false);
  const [peerTyping,   setPeerTyping]   = useState(false);
  const [replyTarget,  setReplyTarget]  = useState<Message | null>(null);
  const [editTarget,   setEditTarget]   = useState<Message | null>(null);
  const [longPressMsg, setLongPressMsg] = useState<Message | null>(null);

  const flatRef     = useRef<FlatList>(null);
  const socketRef   = useRef<Socket | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping    = useRef(false);

  // Connect socket
  useEffect(() => {
    let sock: Socket;
    (async () => {
      const token = await auth().currentUser?.getIdToken();
      sock = io(BACKEND, { auth: { token }, transports: ['websocket'] });
      sock.emit('join_chat', { chatId, uid: myUid });

      sock.on('typing_start',      ({ uid }: any) => { if (uid !== myUid) setPeerTyping(true);  });
      sock.on('typing_stop',       ({ uid }: any) => { if (uid !== myUid) setPeerTyping(false); });
      sock.on('message_delivered', ({ messageId }: any) => {
        setMessages(p => p.map(m => m.id === messageId && m.status === 'sent' ? { ...m, status: 'delivered' } : m));
      });
      sock.on('message_read', ({ messageId }: any) => {
        setMessages(p => p.map(m => m.id === messageId ? { ...m, status: 'read' } : m));
      });
      sock.on('message_edited', ({ messageId, newPlaintext }: any) => {
        setMessages(p => p.map(m => m.id === messageId ? { ...m, plaintext: newPlaintext, isEdited: true } : m));
      });
      sock.on('message_deleted', ({ messageId }: any) => {
        setMessages(p => p.map(m => m.id === messageId ? { ...m, isDeleted: true, plaintext: '' } : m));
      });
      socketRef.current = sock;
    })();
    return () => { sock?.disconnect(); };
  }, [chatId, myUid]);

  // Firestore listener
  useEffect(() => {
    const unsub = firestore()
      .collection('chats').doc(chatId)
      .collection('messages').orderBy('createdAt', 'asc')
      .onSnapshot(async snap => {
        const decrypted = await Promise.all(snap.docs.map(async doc => {
          const d = doc.data() as any;
          if (d.isDeleted) return {
            id: doc.id, senderId: d.senderId, plaintext: '', ciphertext: '',
            iv: '', status: d.status ?? 'sent', createdAt: d.createdAt,
            isDeleted: true, msgType: 'text',
          } as Message;

          let plaintext = '';
          try {
            if (d.ciphertext && d.iv) {
              plaintext = await decryptMessage(
                { ciphertext: d.ciphertext, iv: d.iv, tag: d.tag ?? '', keyId: d.keyId ?? 'v1-pbkdf2', v: d.v ?? 1 },
                myUid, peerUid
              );
            } else {
              plaintext = d.plaintext ?? '';
            }
          } catch { plaintext = '[Decryption failed]'; }

          return {
            id: doc.id, senderId: d.senderId, plaintext,
            ciphertext: d.ciphertext ?? '', iv: d.iv ?? '',
            status: d.status ?? 'sent', createdAt: d.createdAt,
            isEdited: d.isEdited ?? false, isDeleted: false,
            replyTo: d.replyTo ?? null, msgType: d.msgType ?? 'text',
          } as Message;
        }));

        setMessages(decrypted);
        setLoading(false);
        markRead(snap.docs);
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 80);
      });
    return unsub;
  }, [chatId, myUid, peerUid]);

  const markRead = useCallback((docs: any[]) => {
    const batch = firestore().batch();
    docs.forEach(doc => {
      if (doc.data().senderId !== myUid && doc.data().status !== 'read') {
        batch.update(doc.ref, { status: 'read' });
        socketRef.current?.emit('message_read', {
          chatId, messageId: doc.id, readerUid: myUid, senderUid: peerUid,
        });
      }
    });
    batch.commit().catch(() => {});
  }, [chatId, myUid, peerUid]);

  const handleTyping = (text: string) => {
    setInputText(text);
    if (!isTyping.current) {
      isTyping.current = true;
      socketRef.current?.emit('typing_start', { chatId, uid: myUid });
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      isTyping.current = false;
      socketRef.current?.emit('typing_stop', { chatId, uid: myUid });
    }, 2000);
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    if (editTarget) { await saveEdit(text); return; }

    setSending(true);
    setInputText('');
    const reply = replyTarget;
    setReplyTarget(null);
    isTyping.current = false;
    socketRef.current?.emit('typing_stop', { chatId, uid: myUid });

    try {
      const payload = await encryptMessage(text, myUid, peerUid);
      const data: any = {
        senderId: myUid,
        ciphertext: payload.ciphertext, iv: payload.iv,
        tag: payload.tag, keyId: payload.keyId, v: payload.v,
        msgType: 'text', status: 'sent', isDeleted: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (reply) data.replyTo = { id: reply.id, senderId: reply.senderId, plaintext: reply.plaintext.substring(0, 80) };

      const ref = await firestore().collection('chats').doc(chatId).collection('messages').add(data);
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: text.substring(0, 60),
        lastTime: firestore.FieldValue.serverTimestamp(),
        [`unread.${peerUid}`]: firestore.FieldValue.increment(1),
      });
      socketRef.current?.emit('new_message', {
        chatId, messageId: ref.id, senderUid: myUid,
        recipientUid: peerUid, preview: text.substring(0, 40),
      });
    } catch (e: any) {
      Alert.alert('Error', 'Send failed: ' + e.message);
    } finally { setSending(false); }
  };

  const startEdit  = (m: Message) => { setEditTarget(m); setLongPressMsg(null); setInputText(m.plaintext); };
  const cancelEdit = () => { setEditTarget(null); setInputText(''); };

  const saveEdit = async (newText: string) => {
    if (!editTarget) return;
    setSending(true); setEditTarget(null); setInputText('');
    try {
      const payload = await encryptMessage(newText, myUid, peerUid);
      await firestore().collection('chats').doc(chatId).collection('messages').doc(editTarget.id)
        .update({ ciphertext: payload.ciphertext, iv: payload.iv, isEdited: true, editedAt: firestore.FieldValue.serverTimestamp() });
      socketRef.current?.emit('message_edited', { chatId, messageId: editTarget.id, newPlaintext: newText });
    } catch (e: any) { Alert.alert('Error', 'Edit failed: ' + e.message); }
    finally { setSending(false); }
  };

  const deleteForEveryone = (m: Message) => {
    setLongPressMsg(null);
    Alert.alert('Delete for Everyone?', 'Permanently removed for both users.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await firestore().collection('chats').doc(chatId).collection('messages').doc(m.id)
            .update({
              ciphertext: firestore.FieldValue.delete(),
              iv: firestore.FieldValue.delete(),
              plaintext: firestore.FieldValue.delete(),
              isDeleted: true,
            });
          socketRef.current?.emit('message_deleted', { chatId, messageId: m.id, deleterUid: myUid });
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  const Ticks = ({ status }: { status: Message['status'] }) => {
    if (status === 'sending')   return <Text style={s.tick}>â—‹</Text>;
    if (status === 'sent')      return <Text style={s.tick}>âœ“</Text>;
    if (status === 'delivered') return <Text style={s.tick}>âœ“âœ“</Text>;
    return <Text style={[s.tick, { color: '#00E5FF' }]}>âœ“âœ“</Text>;
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
      <Pressable onLongPress={() => setLongPressMsg(m)} delayLongPress={350}>
        <View style={[s.row, isMe ? s.rowR : s.rowL]}>
          <View style={[s.bubble, isMe ? s.bMe : s.bPeer]}>
            {m.replyTo && (
              <View style={s.replyBar}>
                <Text style={s.replyName}>{m.replyTo.senderId === myUid ? 'You' : peerName}</Text>
                <Text style={s.replyPrev} numberOfLines={1}>{m.replyTo.plaintext}</Text>
              </View>
            )}
            <Text style={s.msgTxt}>{m.plaintext}</Text>
            <View style={s.meta}>
              {m.isEdited && <Text style={s.edited}>edited Â· </Text>}
              <Text style={s.time}>
                {m.createdAt?.toDate?.().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? ''}
              </Text>
              {isMe && <Ticks status={m.status} />}
            </View>
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
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReplyTarget(longPressMsg); setLongPressMsg(null); }}>
            <Text style={s.sheetTxt}>â†©  Reply</Text>
          </TouchableOpacity>
          {isMe && <TouchableOpacity style={s.sheetRow} onPress={() => startEdit(longPressMsg)}>
            <Text style={s.sheetTxt}>âœï¸  Edit</Text>
          </TouchableOpacity>}
          {isMe && <TouchableOpacity style={s.sheetRow} onPress={() => deleteForEveryone(longPressMsg)}>
            <Text style={[s.sheetTxt, { color: '#FF3C6E' }]}>ðŸ—‘  Delete for Everyone</Text>
          </TouchableOpacity>}
          <TouchableOpacity style={s.sheetRow} onPress={() => setLongPressMsg(null)}>
            <Text style={[s.sheetTxt, { color: '#555' }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    );
  };

  return (
    <>
      <Stack.Screen options={{
        title: peerName ?? 'Chat',
        headerStyle: { backgroundColor: '#0C0C1A' },
        headerTintColor: '#fff',
        headerRight: () => (
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/videocall', params: { chatId, peerUid, peerName } })}
            style={{ marginRight: 12 }}>
            <Text style={{ color: '#00E5FF', fontSize: 18 }}>ðŸ“¹</Text>
          </TouchableOpacity>
        ),
      }} />
      <KeyboardAvoidingView
        style={s.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}>
        {loading
          ? <ActivityIndicator color="#00E5FF" style={{ flex: 1 }} />
          : <FlatList
              ref={flatRef} data={messages} keyExtractor={m => m.id}
              renderItem={renderMsg} contentContainerStyle={s.list}
              onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })}
            />}

        {peerTyping && (
          <View style={s.typingRow}>
            <Text style={s.typingTxt}>{peerName} is typingâ€¦</Text>
          </View>
        )}

        {replyTarget && (
          <View style={s.banner}>
            <View style={{ flex: 1 }}>
              <Text style={s.bannerTitle}>Replying to {replyTarget.senderId === myUid ? 'yourself' : peerName}</Text>
              <Text style={s.bannerPrev} numberOfLines={1}>{replyTarget.plaintext}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTarget(null)}>
              <Text style={s.bannerX}>âœ•</Text>
            </TouchableOpacity>
          </View>
        )}

        {editTarget && (
          <View style={[s.banner, { borderTopColor: '#4F8FFF33' }]}>
            <Text style={[s.bannerTitle, { color: '#4F8FFF', flex: 1 }]}>âœï¸  Editing message</Text>
            <TouchableOpacity onPress={cancelEdit}><Text style={s.bannerX}>âœ•</Text></TouchableOpacity>
          </View>
        )}

        <View style={s.bar}>
          <TextInput
            style={s.input} value={inputText} onChangeText={handleTyping}
            placeholder="Messageâ€¦" placeholderTextColor="#444"
            multiline maxLength={4000}
          />
          <TouchableOpacity
            style={[s.sendBtn, (!inputText.trim() || sending) && s.sendOff]}
            onPress={sendMessage} disabled={!inputText.trim() || sending}>
            {sending
              ? <ActivityIndicator color="#000" size="small" />
              : <Text style={s.sendIco}>{editTarget ? 'âœ“' : 'âž¤'}</Text>}
          </TouchableOpacity>
        </View>
        <Sheet />
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: '#03030E' },
  list:     { padding: 12, paddingBottom: 8 },
  row:      { marginBottom: 6 },
  rowR:     { alignItems: 'flex-end' },
  rowL:     { alignItems: 'flex-start' },
  bubble:   { maxWidth: '78%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bMe:      { backgroundColor: '#003D2A', borderBottomRightRadius: 2 },
  bPeer:    { backgroundColor: '#111127', borderBottomLeftRadius: 2 },
  bubbleDel:{ backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  msgTxt:   { color: '#E0E0F0', fontSize: 15, lineHeight: 21 },
  delTxt:   { color: '#444', fontSize: 14, fontStyle: 'italic' },
  meta:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 },
  time:     { color: '#444', fontSize: 11, marginRight: 3 },
  edited:   { color: '#555', fontSize: 11 },
  tick:     { color: '#555', fontSize: 12 },
  replyBar: { backgroundColor: '#00000044', borderLeftWidth: 3, borderLeftColor: '#00E5FF', borderRadius: 6, padding: 6, marginBottom: 6 },
  replyName:{ color: '#00E5FF', fontSize: 11, fontWeight: 'bold', marginBottom: 1 },
  replyPrev:{ color: '#888', fontSize: 12 },
  typingRow:{ paddingHorizontal: 16, paddingBottom: 6 },
  typingTxt:{ color: '#555', fontSize: 13, fontStyle: 'italic' },
  banner:   { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', borderTopWidth: 1, borderTopColor: '#00E5FF33', paddingHorizontal: 14, paddingVertical: 8 },
  bannerTitle:{ color: '#00E5FF', fontSize: 12, fontWeight: 'bold' },
  bannerPrev: { color: '#888', fontSize: 12 },
  bannerX:    { color: '#555', fontSize: 20, paddingHorizontal: 8 },
  bar:      { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#0C0C1A', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#111' },
  input:    { flex: 1, backgroundColor: '#111127', color: '#E0E0F0', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120, marginRight: 8 },
  sendBtn:  { width: 44, height: 44, borderRadius: 22, backgroundColor: '#00E5FF', alignItems: 'center', justifyContent: 'center' },
  sendOff:  { backgroundColor: '#111127' },
  sendIco:  { color: '#000', fontSize: 18, fontWeight: 'bold' },
  overlay:  { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:    { backgroundColor: '#0E0E20', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36, paddingTop: 8 },
  sheetRow: { padding: 18, borderBottomWidth: 1, borderBottomColor: '#111' },
  sheetTxt: { color: '#E0E0F0', fontSize: 16 },
});
