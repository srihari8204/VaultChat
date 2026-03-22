// @ts-nocheck
// app/broadcast.tsx — Broadcast Channels (Telegram-style)
// Admin posts, subscribers read. One-to-many encrypted messaging.
// Firestore: channels/{id} + channels/{id}/posts/{postId}

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Alert, StatusBar, TextInput, Modal, Share, ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628', danger: '#FF3C6E' };
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => { let s = ''; for (let i = 0; i < 8; i++) { if (i === 4) s += '-'; s += CHARS[Math.floor(Math.random() * CHARS.length)]; } return s; };

export default function BroadcastScreen() {
  const myUid = auth().currentUser?.uid || '';
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [posts, setPosts] = useState([]);
  const [postText, setPostText] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    const unsub = firestore().collection('channels')
      .where('subscribers', 'array-contains', myUid)
      .orderBy('lastPostAt', 'desc')
      .onSnapshot(snap => {
        setChannels(snap?.docs.map(d => ({ id: d.id, ...d.data() })) || []);
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, [myUid]);

  const createChannel = async () => {
    if (!name.trim()) return;
    try {
      const myDoc = await firestore().collection('users').doc(myUid).get();
      const myName = myDoc.data()?.name || 'Admin';
      const code = genCode();
      await firestore().collection('channels').add({
        name: name.trim(),
        description: desc.trim(),
        adminUid: myUid,
        adminName: myName,
        subscribers: [myUid],
        subscriberCount: 1,
        inviteCode: code,
        createdAt: firestore.FieldValue.serverTimestamp(),
        lastPostAt: firestore.FieldValue.serverTimestamp(),
        lastPost: '',
      });
      setShowCreate(false); setName(''); setDesc('');
      Alert.alert('Channel Created!', 'Invite code: ' + code + '\nShare this to let people subscribe.');
    } catch { Alert.alert('Error', 'Could not create channel'); }
  };

  const openChannel = async (ch) => {
    setSelectedChannel(ch);
    const snap = await firestore().collection('channels').doc(ch.id)
      .collection('posts').orderBy('createdAt', 'desc').limit(50).get();
    setPosts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  };

  const sendPost = async () => {
    if (!postText.trim() || !selectedChannel) return;
    setPosting(true);
    try {
      const myDoc = await firestore().collection('users').doc(myUid).get();
      const myName = myDoc.data()?.name || 'Admin';
      await firestore().collection('channels').doc(selectedChannel.id)
        .collection('posts').add({
          text: postText.trim(),
          authorUid: myUid,
          authorName: myName,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
      await firestore().collection('channels').doc(selectedChannel.id).update({
        lastPost: postText.trim().slice(0, 60),
        lastPostAt: firestore.FieldValue.serverTimestamp(),
      });
      setPosts(prev => [{ id: Date.now().toString(), text: postText.trim(), authorName: myName, createdAt: { toDate: () => new Date() } }, ...prev]);
      setPostText('');
    } catch { Alert.alert('Error', 'Could not post'); }
    setPosting(false);
  };

  const shareInvite = (ch) => {
    Share.share({ message: 'Join my VaultChat channel "' + ch.name + '"!\nCode: ' + ch.inviteCode + '\nhttps://vaultchat.app/channel/' + ch.inviteCode });
  };

  const joinChannel = () => {
    Alert.prompt('Join Channel', 'Enter invite code:', async (code) => {
      if (!code) return;
      const clean = code.trim().toUpperCase();
      const snap = await firestore().collection('channels').where('inviteCode', '==', clean).get();
      if (snap.empty) { Alert.alert('Not Found', 'No channel with that code'); return; }
      const doc = snap.docs[0];
      if (doc.data().subscribers?.includes(myUid)) { Alert.alert('Already Joined'); return; }
      await doc.ref.update({
        subscribers: firestore.FieldValue.arrayUnion(myUid),
        subscriberCount: firestore.FieldValue.increment(1),
      });
      Alert.alert('Joined!', 'You are now subscribed to ' + doc.data().name);
    });
  };

  if (selectedChannel) {
    const isAdmin = selectedChannel.adminUid === myUid;
    return (
      <>
        <Stack.Screen options={{ title: selectedChannel.name, headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff',
          headerRight: () => (
            <TouchableOpacity onPress={() => shareInvite(selectedChannel)} style={{ marginRight: 12 }}>
              <Text style={{ color: C.accent, fontSize: 14, fontWeight: '700' }}>Share</Text>
            </TouchableOpacity>
          ),
        }} />
        <View style={s.container}>
          <View style={s.channelInfo}>
            <Text style={{ color: '#888', fontSize: 12 }}>{selectedChannel.subscriberCount || 1} subscribers {isAdmin ? '\u2022 You are admin' : ''}</Text>
            {selectedChannel.description ? <Text style={{ color: '#666', fontSize: 12, marginTop: 4 }}>{selectedChannel.description}</Text> : null}
          </View>
          <FlatList
            data={posts}
            inverted
            keyExtractor={p => p.id}
            renderItem={({ item }) => (
              <View style={s.postCard}>
                <Text style={s.postAuthor}>{item.authorName}</Text>
                <Text style={s.postText}>{item.text}</Text>
                <Text style={s.postTime}>{item.createdAt?.toDate ? new Date(item.createdAt.toDate()).toLocaleString() : ''}</Text>
              </View>
            )}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={{ color: '#555' }}>No posts yet</Text></View>}
            contentContainerStyle={{ padding: 12 }}
          />
          {isAdmin && (
            <View style={s.postBar}>
              <TextInput style={s.postInput} value={postText} onChangeText={setPostText} placeholder="Write a broadcast..." placeholderTextColor="#555" multiline />
              <TouchableOpacity style={[s.postBtn, !postText.trim() && { opacity: 0.4 }]} onPress={sendPost} disabled={!postText.trim() || posting}>
                {posting ? <ActivityIndicator color="#000" size="small" /> : <Text style={{ color: '#000', fontWeight: '900' }}>POST</Text>}
              </TouchableOpacity>
            </View>
          )}
          {!isAdmin && (
            <View style={s.readOnly}><Text style={{ color: '#666', fontSize: 13 }}>Only the admin can post in this channel</Text></View>
          )}
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Broadcast Channels', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />
        <View style={s.topBtns}>
          <TouchableOpacity style={s.createBtn} onPress={() => setShowCreate(true)}>
            <Text style={s.createTxt}>{"\u2795  Create Channel"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.createBtn, { backgroundColor: '#10B98122', borderColor: '#10B98144' }]} onPress={joinChannel}>
            <Text style={[s.createTxt, { color: '#10B981' }]}>{"\uD83D\uDD17  Join Channel"}</Text>
          </TouchableOpacity>
        </View>
        {loading ? <ActivityIndicator color={C.accent} style={{ marginTop: 30 }} /> : (
          <FlatList
            data={channels}
            keyExtractor={c => c.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.chRow} onPress={() => openChannel(item)}>
                <View style={s.chAvatar}><Text style={{ fontSize: 22 }}>{"\uD83D\uDCE2"}</Text></View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.chName}>{item.name}</Text>
                    <Text style={s.chSubs}>{item.subscriberCount || 1} subs</Text>
                  </View>
                  <Text style={s.chLast} numberOfLines={1}>{item.lastPost || 'No posts yet'}</Text>
                </View>
                {item.adminUid === myUid && <View style={s.adminBadge}><Text style={s.adminTxt}>Admin</Text></View>}
              </TouchableOpacity>
            )}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={{ color: '#555' }}>No channels yet</Text><Text style={{ color: '#444', fontSize: 12, marginTop: 8 }}>Create one or join with an invite code</Text></View>}
          />
        )}
        <Modal visible={showCreate} transparent animationType="slide">
          <View style={s.modalBg}>
            <View style={s.modal}>
              <Text style={s.modalTitle}>Create Broadcast Channel</Text>
              <TextInput style={s.modalInput} value={name} onChangeText={setName} placeholder="Channel name" placeholderTextColor="#555" />
              <TextInput style={[s.modalInput, { height: 80 }]} value={desc} onChangeText={setDesc} placeholder="Description (optional)" placeholderTextColor="#555" multiline />
              <TouchableOpacity style={s.modalBtn} onPress={createChannel}><Text style={{ color: '#000', fontWeight: '800' }}>Create</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setShowCreate(false)}><Text style={{ color: '#555', textAlign: 'center', marginTop: 12 }}>Cancel</Text></TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  topBtns: { flexDirection: 'row', gap: 8, padding: 12 },
  createBtn: { flex: 1, backgroundColor: '#4A9FFF22', borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#4A9FFF44' },
  createTxt: { color: C.accent, fontSize: 13, fontWeight: '700' },
  chRow: { flexDirection: 'row', alignItems: 'center', padding: 14, marginHorizontal: 12, marginBottom: 6, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: '#111' },
  chAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  chName: { color: '#E0E0F0', fontSize: 15, fontWeight: '700' },
  chSubs: { color: '#555', fontSize: 11 },
  chLast: { color: '#666', fontSize: 12, marginTop: 2 },
  adminBadge: { backgroundColor: '#4A9FFF22', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 8 },
  adminTxt: { color: C.accent, fontSize: 10, fontWeight: '800' },
  channelInfo: { padding: 12, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: '#111' },
  postCard: { backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#111' },
  postAuthor: { color: C.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  postText: { color: '#E0E0F0', fontSize: 15, lineHeight: 22 },
  postTime: { color: '#444', fontSize: 10, marginTop: 6, textAlign: 'right' },
  postBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: '#0C0C1A', borderTopWidth: 1, borderTopColor: '#111' },
  postInput: { flex: 1, backgroundColor: '#111127', color: '#E0E0F0', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100, marginRight: 8 },
  postBtn: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10 },
  readOnly: { padding: 14, alignItems: 'center', backgroundColor: '#0C0C1A', borderTopWidth: 1, borderTopColor: '#111' },
  modalBg: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#0E0E20', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 16 },
  modalInput: { backgroundColor: '#111', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: '#fff', fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: '#222' },
  modalBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
});
