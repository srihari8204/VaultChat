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

          // 1:1 Ã¢â‚¬â€ get peer info
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
      router.push({ pathname: '/chat', params: { chatId: chatSnap.docs[0].id, peerUid: myUid, peerName: 'Ã°Å¸â€œâ€¹ Note to Self' } });
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
                <Text style={s.avatarTxt}>{item.isGroup ? 'Ã°Å¸â€˜Â¥' : item.name[0]?.toUpperCase()}</Text>
              </View>
          }
          {item.online && !item.isGroup && <View style={s.onlineDot} />}
        </View>

        {/* Content */}
        <View style={s.chatBody}>
          <View style={s.chatTop}>
            <View style={s.nameRow}>
              {item.pinned && <Text style={s.pinIcon}>Ã°Å¸â€œÅ’ </Text>}
              {item.muted  && <Text style={s.muteIcon}>Ã°Å¸â€â€¢ </Text>}
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
            <Text style={s.sheetTxt}>{longPress.pinned ? 'Ã°Å¸â€œÅ’ Unpin' : 'Ã°Å¸â€œÅ’ Pin to top'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { muteChat(longPress.id, !longPress.muted); setLongPress(null); }}>
            <Text style={s.sheetTxt}>{longPress.muted ? 'Ã°Å¸â€â€ Unmute' : 'Ã°Å¸â€â€¢ Mute'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { archiveChat(longPress.id, !longPress.archived); setLongPress(null); }}>
            <Text style={s.sheetTxt}>{longPress.archived ? 'Ã°Å¸â€œâ€š Unarchive' : 'Ã°Å¸â€”â€ž Archive'}</Text>
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
            <TouchableOpacity onPress={ensureNoteToSelf}><Text style={{ color: '#00E5FF', fontSize: 18 }}>Ã°Å¸â€œâ€¹</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/create-group')}><Text style={{ color: '#00E5FF', fontSize: 22 }}>Ã°Å¸â€˜Â¥</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/profile')}><Text style={{ color: '#00E5FF', fontSize: 22 }}>Ã¢Å¡â„¢Ã¯Â¸Â</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.screen}>
        {/* Search */}
        <View style={s.searchBar}>
          <Text style={s.searchIcon}>Ã°Å¸â€Â</Text>
          <TextInput
            style={s.searchInput}
            placeholder="Search chatsÃ¢â‚¬Â¦"
            placeholderTextColor="#444"
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}><Text style={{ color: '#555', fontSize: 18 }}>Ã¢Å“â€¢</Text></TouchableOpacity>
          )}
        </View>

        {/* Archive toggle */}
        {chats.some(c => c.archived) && (
          <TouchableOpacity style={s.archiveToggle} onPress={() => setShowArchive(p => !p)}>
            <Text style={s.archiveTxt}>{showArchive ? 'Ã¢â€ Â Back to chats' : `Ã°Å¸â€”â€ž Archived (${chats.filter(c => c.archived).length})`}</Text>
          </TouchableOpacity>
        )}

        <FlatList
          data={filtered}
          keyExtractor={c => c.id}
          renderItem={renderChat}
          refreshControl={<RefreshControl refreshing={loading} colors={['#00E5FF']} tintColor="#00E5FF" />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyIcon}>Ã°Å¸â€™Â¬</Text>
              <Text style={s.emptyTxt}>{search ? 'No chats found' : 'No chats yet'}</Text>
              <Text style={s.emptySub}>Tap the groups icon to create a group or start a new chat</Text>
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
