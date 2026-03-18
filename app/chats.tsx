import AsyncStorage from '@react-native-async-storage/async-storage';
﻿// app/chats.tsx
// Chat list: 1:1 + groups, search, starred, mute, archive, online status,
// note-to-self, swipe actions

import { getApp } from '@react-native-firebase/app';
import { getAuth } from '@react-native-firebase/auth';
import { collection, doc, getDoc, getFirestore, onSnapshot, orderBy, query, updateDoc, where } from '@react-native-firebase/firestore';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { archiveChat, muteChat, pinChat } from '../services/groupService';

const app  = getApp();
const auth = getAuth(app);
const db   = getFirestore(app);

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
  const myUid  = auth.currentUser?.uid ?? '';

  const [chats,       setChats]       = useState<ChatItem[]>([]);
  const [filtered,    setFiltered]    = useState<ChatItem[]>([]);
  const [search,      setSearch]      = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [loading,     setLoading]     = useState(true);
  const [longPress,   setLongPress]   = useState<ChatItem | null>(null);

  useEffect(() => {
    if (!myUid) { setLoading(false); return; }

    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', myUid),
      orderBy('lastTime', 'desc')
    );

    const unsub = onSnapshot(q, async snap => {
      const items = await Promise.all(snap.docs.map(async d => {
        const data = d.data() as any;
        const isGroup = data.isGroup === true;
        const unread  = data.unread?.[myUid] ?? 0;

        if (isGroup) {
          return {
            id: d.id, isGroup: true,
            name: data.name ?? 'Group',
            photoURL: data.photoURL,
            lastMsg: data.lastMsg ?? '',
            lastTime: data.lastTime,
            unreadCount: unread,
            pinned: data.pinned ?? false,
            archived: data.archived ?? false,
            muted: data.muted ?? false,
          } as ChatItem;
        }

        const peerUid = (data.participants as string[]).find((u: string) => u !== myUid) ?? '';
        let name = data.participantNames?.[peerUid] ?? 'Unknown';
        let photo = '';
        let online = false;
        try {
          const peerSnap = await getDoc(doc(db, 'users', peerUid));
          const pd = peerSnap.data();
          name   = pd?.name ?? name;
          photo  = pd?.photoURL ?? '';
          online = pd?.online ?? false;
        } catch {}

        return {
          id: d.id, isGroup: false, peerUid,
          name, photoURL: photo,
          lastMsg: data.lastMsg ?? '',
          lastTime: data.lastTime,
          unreadCount: unread,
          pinned: data.pinned ?? false,
          archived: data.archived ?? false,
          muted: data.muted ?? false,
          online,
        } as ChatItem;
      }));

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

  // Filter out hidden chats (runs once on mount, not on chats change)
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem('vc_hidden_chats');
      const hidden: string[] = raw ? JSON.parse(raw) : [];
      setHiddenIds(hidden);
    })();
  }, []);


  useEffect(() => {
    let list = chats
      .filter(c => !hiddenIds.includes(c.id))
      .filter(c => showArchive ? c.archived : !c.archived);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.lastMsg.toLowerCase().includes(q));
    }
    setFiltered(list);
  }, [chats, search, showArchive, hiddenIds]);

  const openChat = (item: ChatItem) => {
    if (item.isGroup) {
      router.push({ pathname: '/group-chat', params: { chatId: item.id, groupName: item.name } });
    } else {
      router.push({ pathname: '/chat', params: { chatId: item.id, peerUid: item.peerUid ?? '', peerName: item.name } });
    }
    updateDoc(doc(db, 'chats', item.id), { [`unread.${myUid}`]: 0 }).catch(() => {});
  };

  const ensureNoteToSelf = async () => {
    if (!myUid) return;
    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', myUid),
      where('isNoteToSelf', '==', true)
    );
    const snap = await (await import('@react-native-firebase/firestore')).getDocs?.(q).catch(() => null);
    router.push({ pathname: '/chat', params: { chatId: 'note-to-self', peerUid: myUid, peerName: '📝 Note to Self' } });
  };

  const fmt = (ts: any) => {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { weekday: 'short' });
  };

  const renderChat = ({ item }: { item: ChatItem }) => (
    <Pressable onPress={() => openChat(item)} onLongPress={() => setLongPress(item)} delayLongPress={400}>
      <View style={s.chatRow}>
        <View style={s.avatarWrap}>
          {item.photoURL
            ? <Image source={{ uri: item.photoURL }} style={s.avatar} />
            : <View style={[s.avatar, s.avatarFallback]}>
                <Text style={s.avatarTxt}>{item.isGroup ? '👥' : item.name[0]?.toUpperCase()}</Text>
              </View>
          }
          {item.online && !item.isGroup && <View style={s.onlineDot} />}
        </View>
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

  
  const hideChat = async (chatId: string) => {
    const raw = await AsyncStorage.getItem('vc_hidden_chats');
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(chatId)) ids.push(chatId);
    await AsyncStorage.setItem('vc_hidden_chats', JSON.stringify(ids));
    setHiddenIds(ids);
    setLongPress(null);
  };

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
            <Text style={s.sheetTxt}>{longPress.archived ? '📚 Unarchive' : '🗄 Archive'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { hideChat(longPress.id); }}>
            <Text style={s.sheetTxt}>{"\uD83D\uDD12 Hide Chat"}</Text>
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
            <TouchableOpacity onPress={ensureNoteToSelf}><Text style={{ color: '#00E5FF', fontSize: 18 }}>📝</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/create-group')}><Text style={{ color: '#00E5FF', fontSize: 22 }}>👥</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/profile')}><Text style={{ color: '#00E5FF', fontSize: 22 }}>⚙️</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.screen}>
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

        {chats.some(c => c.archived) && (
          <TouchableOpacity style={s.archiveToggle} onPress={() => setShowArchive(p => !p)}>
            <Text style={s.archiveTxt}>{showArchive ? '← Back to chats' : `🗄 Archived (${chats.filter(c => c.archived).length})`}</Text>
          </TouchableOpacity>
        )}

        <FlatList
contentContainerStyle={{ paddingBottom: 100 }}
                    data={filtered}
          keyExtractor={c => c.id}
          renderItem={renderChat}
          refreshControl={<RefreshControl refreshing={loading} colors={['#00E5FF']} tintColor="#00E5FF" />}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyIcon}>💬</Text>
              <Text style={s.emptyTxt}>{search ? 'No chats found' : 'No chats yet'}</Text>
              <Text style={s.emptySub}>Tap the groups icon to create a group or start a new chat</Text>
            </View>
          }
        />
        <LongPressSheet />

        {/* Bottom Tab Bar */}
        <View style={s.tabBar}>
          <TouchableOpacity style={s.tabItem} onPress={() => {}}>
            <Text style={[s.tabIcon, { color: '#4A9FFF' }]}>{'💬'}</Text>
            <Text style={[s.tabLbl, { color: '#4A9FFF' }]}>Chats</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.tabItem} onPress={() => router.push('/contacts' as any)}>
            <Text style={s.tabIcon}>{'👥'}</Text>
            <Text style={s.tabLbl}>Contacts</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.tabItem} onPress={() => router.push('/status' as any)}>
            <Text style={s.tabIcon}>{'📷'}</Text>
            <Text style={s.tabLbl}>Status</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.tabItem} onPress={() => router.push('/broadcast' as any)}>
            <Text style={s.tabIcon}>{'📢'}</Text>
            <Text style={s.tabLbl}>Channels</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.tabItem} onPress={() => router.push('/settings' as any)}>
            <Text style={s.tabIcon}>{'⚙️'}</Text>
            <Text style={s.tabLbl}>Settings</Text>
          </TouchableOpacity>
        </View>

        {/* FAB - New Chat */}
        <TouchableOpacity style={s.fab} onPress={() => router.push('/contacts' as any)} activeOpacity={0.8}>
          <Text style={s.fabTxt}>{'✏️'}</Text>
        </TouchableOpacity>

      </View>
    </>
  );
}

interface BottomNavProps {
  active: string;
}

export function BottomNav({ active }: BottomNavProps) {
  const router = useRouter();

  const tabs = [
    { key: 'Chats', icon: '💬', route: '/chats' },
    { key: 'Calls', icon: '📞', route: '/calls' },
    { key: 'Status', icon: '📱', route: '/status' },
    { key: 'Alerts', icon: '🚨', route: '/alerts' },
  ];

  return (
    <View style={s.tabBar}>
      {tabs.map(tab => (
        <TouchableOpacity
          key={tab.key}
          style={s.tabItem}
          onPress={() => router.push(tab.route as any)}
        >
          <Text style={[s.tabIcon, active === tab.key && { color: '#00E5FF' }]}>
            {tab.icon}
          </Text>
          <Text style={[s.tabLbl, active === tab.key && { color: '#00E5FF' }]}>
            {tab.key}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  tabBar:  { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: '#070D18', borderTopWidth: 1, borderTopColor: '#111', paddingVertical: 8, paddingBottom: 28 },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { fontSize: 20, color: '#555' },
  tabLbl:  { fontSize: 10, color: '#555', fontWeight: '600' },
  fab:     { position: 'absolute', bottom: 90, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: '#4A9FFF', justifyContent: 'center', alignItems: 'center', elevation: 8, shadowColor: '#4A9FFF', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
  fabTxt:  { fontSize: 24, color: '#fff' },

  screen:        { flex: 1, backgroundColor: '#03030E' },
  searchBar:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 12, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: '#111' },
  searchIcon:    { fontSize: 16 },
  searchInput:   { flex: 1, color: '#E0E0F0', fontSize: 15 },
  archiveToggle: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#111' },
  archiveTxt:    { color: '#00E5FF', fontSize: 13 },
  chatRow:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#07070F' },
  avatarWrap:    { position: 'relative', marginRight: 12 },
  avatar:        { width: 50, height: 50, borderRadius: 25 },
  avatarFallback:{ backgroundColor: '#111127', alignItems: 'center', justifyContent: 'center' },
  avatarTxt:     { color: '#00E5FF', fontSize: 20, fontWeight: 'bold' },
  onlineDot:     { position: 'absolute', bottom: 1, right: 1, width: 12, height: 12, borderRadius: 6, backgroundColor: '#00FF88', borderWidth: 2, borderColor: '#03030E' },
  chatBody:      { flex: 1 },
  chatTop:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  nameRow:       { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  pinIcon:       { color: '#FF8C42', fontSize: 12 },
  muteIcon:      { color: '#555', fontSize: 12 },
  chatName:      { color: '#E0E0F0', fontSize: 16, fontWeight: '600', flex: 1 },
  chatTime:      { color: '#555', fontSize: 12 },
  chatBottom:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatPreview:   { color: '#555', fontSize: 13, flex: 1, marginRight: 8 },
  badge:         { backgroundColor: '#00E5FF', borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeTxt:      { color: '#000', fontSize: 11, fontWeight: 'bold' },
  empty:         { flex: 1, alignItems: 'center', paddingTop: 80 },
  emptyIcon:     { fontSize: 48, marginBottom: 12 },
  emptyTxt:      { color: '#E0E0F0', fontSize: 18, fontWeight: '600', marginBottom: 6 },
  emptySub:      { color: '#555', fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
  overlay:       { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:         { backgroundColor: '#0E0E20', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36, paddingTop: 8 },
  sheetRow:      { padding: 18, borderBottomWidth: 1, borderBottomColor: '#111' },
  sheetTxt:      { color: '#E0E0F0', fontSize: 16 },
});
