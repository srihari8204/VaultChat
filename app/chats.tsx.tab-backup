import AsyncStorage from '@react-native-async-storage/async-storage';
// app/chats.tsx
// Chat list: 1:1 + groups, search, starred, mute, archive, online status,
// note-to-self, swipe actions, smart filters, chat folders, gradient avatars

import { getApp } from '@react-native-firebase/app';
import { getAuth } from '@react-native-firebase/auth';
import { collection, doc, getDoc, getFirestore, onSnapshot, orderBy, query, updateDoc, where } from '@react-native-firebase/firestore';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { archiveChat, muteChat, pinChat } from '../services/groupService';

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

// ── Gradient palette for avatars ─────────────────────────────────
const AVATAR_GRADIENTS: [string, string][] = [
  ['#1D4ED8', '#7C3AED'],
  ['#059669', '#10B981'],
  ['#DC2626', '#F97316'],
  ['#7C3AED', '#EC4899'],
  ['#0891B2', '#06B6D4'],
  ['#D97706', '#F59E0B'],
  ['#4F46E5', '#818CF8'],
  ['#BE185D', '#F472B6'],
];

function getGradient(name: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

// ── Smart filter types ───────────────────────────────────────────
type ChatFilter = 'All' | 'Unread' | 'Groups' | 'Pinned' | 'Archive';

const FILTERS: { key: ChatFilter; label: string; icon: string }[] = [
  { key: 'All', label: 'All', icon: '💬' },
  { key: 'Unread', label: 'Unread', icon: '🔵' },
  { key: 'Groups', label: 'Groups', icon: '👥' },
  { key: 'Pinned', label: 'Pinned', icon: '📌' },
  { key: 'Archive', label: 'Archive', icon: '🗄' },
];

// ── Chat folder types ────────────────────────────────────────────
type FolderKey = 'all' | 'work' | 'family' | 'friends' | 'unread';

const FOLDERS: { key: FolderKey; label: string; icon: string }[] = [
  { key: 'all', label: 'All', icon: '📂' },
  { key: 'work', label: 'Work', icon: '💼' },
  { key: 'family', label: 'Family', icon: '🏠' },
  { key: 'friends', label: 'Friends', icon: '🤝' },
];

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
  folder?: FolderKey;
}

export default function ChatsScreen() {
  const router = useRouter();
  const myUid = auth.currentUser?.uid ?? '';

  const [chats, setChats] = useState<ChatItem[]>([]);
  const [filtered, setFiltered] = useState<ChatItem[]>([]);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<ChatFilter>('All');
  const [activeFolder, setActiveFolder] = useState<FolderKey>('all');
  const [loading, setLoading] = useState(true);
  const [longPress, setLongPress] = useState<ChatItem | null>(null);
  const [folderMap, setFolderMap] = useState<Record<string, FolderKey>>({});
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Load folder assignments from AsyncStorage
  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem('vc_chat_folders');
      if (raw) setFolderMap(JSON.parse(raw));
    })();
  }, []);

  const assignFolder = async (chatId: string, folder: FolderKey) => {
    const updated = { ...folderMap, [chatId]: folder };
    setFolderMap(updated);
    await AsyncStorage.setItem('vc_chat_folders', JSON.stringify(updated));
    setShowFolderPicker(false);
    setLongPress(null);
  };

  useEffect(() => {
    if (!myUid) { setLoading(false); router.replace('/welcome'); return; }

    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', myUid),
      orderBy('lastTime', 'desc')
    );

    const unsub = onSnapshot(q, async snap => {
      const items = await Promise.all(snap.docs.map(async d => {
        const data = d.data() as any;
        const isGroup = data.isGroup === true;
        const unread = data.unread?.[myUid] ?? 0;

        if (isGroup) {
          return {
            id: d.id, isGroup: true,
            name: data.name ?? 'Group',
            photoURL: data.photoURL,
            lastMsg: data.lastMsg ?? '',
            lastTime: data.lastTime,
            unreadCount: unread,
            pinned: data.pinned_by?.[myUid] ?? data.pinned ?? false,
            archived: data.archived_by?.[myUid] ?? data.archived ?? false,
            muted: data.muted_by?.[myUid] ?? data.muted ?? false,
          } as ChatItem;
        }

        const peerUid = (data.participants as string[]).find((u: string) => u !== myUid) ?? '';
        let name = data.participantNames?.[peerUid] ?? 'Unknown';
        let photo = '';
        let online = false;
        try {
          const peerSnap = await getDoc(doc(db, 'users', peerUid));
          const pd = peerSnap.data();
          name = pd?.name ?? name;
          photo = pd?.photoURL ?? '';
          online = pd?.online ?? false;
        } catch { }

        return {
          id: d.id, isGroup: false, peerUid,
          name, photoURL: photo,
          lastMsg: data.lastMsg ?? '',
          lastTime: data.lastTime,
          unreadCount: unread,
          pinned: data.pinned_by?.[myUid] ?? data.pinned ?? false,
          archived: data.archived_by?.[myUid] ?? data.archived ?? false,
          muted: data.muted_by?.[myUid] ?? data.muted ?? false,
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

  // Filter out hidden chats (runs once on mount)
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem('vc_hidden_chats');
      const hidden: string[] = raw ? JSON.parse(raw) : [];
      setHiddenIds(hidden);
    })();
  }, []);

  // Apply smart filters + folder + search
  useEffect(() => {
    let list = chats.filter(c => !hiddenIds.includes(c.id));

    // Smart filter
    switch (activeFilter) {
      case 'Unread': list = list.filter(c => c.unreadCount > 0 && !c.archived); break;
      case 'Groups': list = list.filter(c => c.isGroup && !c.archived); break;
      case 'Pinned': list = list.filter(c => c.pinned && !c.archived); break;
      case 'Archive': list = list.filter(c => c.archived); break;
      default: list = list.filter(c => !c.archived); break;
    }

    // Folder filter
    if (activeFolder !== 'all') {
      list = list.filter(c => folderMap[c.id] === activeFolder);
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.lastMsg.toLowerCase().includes(q));
    }

    setFiltered(list);
  }, [chats, search, activeFilter, activeFolder, hiddenIds, folderMap]);

  const openChat = (item: ChatItem) => {
    if (item.isGroup) {
      router.push({ pathname: '/group-chat', params: { chatId: item.id, groupName: item.name } });
    } else {
      router.push({ pathname: '/chat', params: { chatId: item.id, peerUid: item.peerUid ?? '', peerName: item.name } });
    }
    updateDoc(doc(db, 'chats', item.id), { [`unread.${myUid}`]: 0 }).catch(() => { });
  };

  const ensureNoteToSelf = async () => {
    if (!myUid) return;
    router.push({ pathname: '/chat', params: { chatId: 'note-to-self', peerUid: myUid, peerName: '📝 Note to Self' } });
  };

  const fmt = (ts: any) => {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { weekday: 'short' });
  };

  // ── Gradient Avatar ─────────────────────────────────────────────
  const GradientAvatar = ({ name, isGroup }: { name: string; isGroup: boolean }) => {
    const colors = getGradient(name);
    return (
      <LinearGradient colors={colors} style={[s.avatar, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={s.avatarTxt}>{isGroup ? '👥' : name[0]?.toUpperCase()}</Text>
      </LinearGradient>
    );
  };

  const renderChat = ({ item }: { item: ChatItem }) => (
    <Pressable onPress={() => openChat(item)} onLongPress={() => setLongPress(item)} delayLongPress={400}>
      <View style={s.chatRow}>
        <View style={s.avatarWrap}>
          {item.photoURL
            ? <Image source={{ uri: item.photoURL }} style={s.avatar} />
            : <GradientAvatar name={item.name} isGroup={item.isGroup} />
          }
          {item.online && !item.isGroup && <View style={s.onlineDot} />}
        </View>
        <View style={s.chatBody}>
          <View style={s.chatTop}>
            <View style={s.nameRow}>
              {item.pinned && <Text style={s.pinIcon}>📌 </Text>}
              {item.muted && <Text style={s.muteIcon}>🔕 </Text>}
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

  // ── Folder Picker Sheet ─────────────────────────────────────────
  const FolderPickerSheet = () => {
    if (!showFolderPicker || !longPress) return null;
    return (
      <Pressable style={s.overlay} onPress={() => setShowFolderPicker(false)}>
        <View style={s.sheet}>
          <Text style={{ color: '#212529', fontSize: 18, fontWeight: '700', padding: 16, paddingBottom: 8 }}>Move to Folder</Text>
          {FOLDERS.map(f => (
            <TouchableOpacity key={f.key} style={s.sheetRow} onPress={() => assignFolder(longPress.id, f.key)}>
              <Text style={s.sheetTxt}>{f.icon}  {f.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.sheetRow} onPress={() => setShowFolderPicker(false)}>
            <Text style={[s.sheetTxt, { color: '#6C757D' }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    );
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
          <TouchableOpacity style={s.sheetRow} onPress={() => setShowFolderPicker(true)}>
            <Text style={s.sheetTxt}>📂 Move to Folder</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { hideChat(longPress.id); }}>
            <Text style={s.sheetTxt}>{"\uD83D\uDD12 Hide Chat"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => setLongPress(null)}>
            <Text style={[s.sheetTxt, { color: '#6C757D' }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    );
  };

  // ── Filter badge counts ─────────────────────────────────────────
  const unreadCount = chats.filter(c => c.unreadCount > 0 && !c.archived).length;
  const groupCount = chats.filter(c => c.isGroup && !c.archived).length;
  const pinnedCount = chats.filter(c => c.pinned && !c.archived).length;
  const archiveCount = chats.filter(c => c.archived).length;

  const getBadge = (key: ChatFilter): number | null => {
    switch (key) {
      case 'Unread': return unreadCount || null;
      case 'Groups': return groupCount || null;
      case 'Pinned': return pinnedCount || null;
      case 'Archive': return archiveCount || null;
      default: return null;
    }
  };

  return (
    <>
      <Stack.Screen options={{
        title: 'VaultChat',
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#212529',
        headerTitleStyle: { fontSize: 18, fontWeight: '600' },
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 12, marginRight: 0}}>
            <TouchableOpacity onPress={() => router.push('/d2de-status' as any)}><Text style={{ color: '#00D4AA', fontSize: 20 }}>🛡️</Text></TouchableOpacity>
            <TouchableOpacity onPress={ensureNoteToSelf}><Text style={{ color: '#4A9FFF', fontSize: 20 }}>📝</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/create-group')}><Text style={{ color: '#4A9FFF', fontSize: 22 }}>👥</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/profile')}><Text style={{ color: '#4A9FFF', fontSize: 22 }}>⚙️</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.screen}>
        {/* Search Bar */}
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

        {/* Smart Filters */}
        <ScrollView horizontal style={{flexGrow:0}} showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
          {FILTERS.map(f => {
            const isActive = activeFilter === f.key;
            const badge = getBadge(f.key);
            return (
              <TouchableOpacity
                key={f.key}
                style={[s.filterChip, isActive && s.filterChipActive]}
                onPress={() => setActiveFilter(f.key)}
              >
                <Text style={{ fontSize: 10 }}>{f.icon}</Text>
                <Text style={[s.filterTxt, isActive && s.filterTxtActive]}>{f.label}</Text>
                {badge != null && (
                  <View style={[s.filterBadge, isActive && s.filterBadgeActive]}>
                    <Text style={s.filterBadgeTxt}>{badge}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Chat Folders */}
        <ScrollView horizontal style={{flexGrow:0}} showsHorizontalScrollIndicator={false} contentContainerStyle={s.folderRow}>
          {FOLDERS.map(f => {
            const isActive = activeFolder === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                style={[s.folderChip, isActive && s.folderChipActive]}
                onPress={() => setActiveFolder(f.key)}
              >
                <Text style={{ fontSize: 9 }}>{f.icon}</Text>
                <Text style={[s.folderTxt, isActive && s.folderTxtActive]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={s.chatContainer}>
          <FlatList
            contentContainerStyle={{ flexGrow: 1 }}
            data={filtered}
            keyExtractor={c => c.id}
            renderItem={renderChat}
            refreshControl={<RefreshControl refreshing={loading} colors={['#00E5FF']} tintColor="#00E5FF" />}
            ListEmptyComponent={
              <View style={s.empty}>
                <Text style={s.emptyIcon}>💬</Text>
                <Text style={s.emptyTxt}>{search ? 'No chats found' : activeFilter !== 'All' ? `No ${activeFilter.toLowerCase()} chats` : 'No chats yet'}</Text>
                <Text style={s.emptySub}>Tap the groups icon to create a group or start a new chat</Text>
              </View>
            }
          />
        </View>
        <LongPressSheet />
        <FolderPickerSheet />

        {/* Bottom Tab Bar — 6 tabs */}
        <View style={s.tabBar}>
          <TouchableOpacity style={s.tabItem} onPress={() => { }}>
            <Text style={[s.tabIcon, { color: '#4A9FFF' }]}>{'💬'}</Text>
            <Text style={[s.tabLbl, { color: '#4A9FFF' }]}>Chats</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.tabItem} onPress={() => router.push('/calls' as any)}>
            <Text style={s.tabIcon}>{'📞'}</Text>
            <Text style={s.tabLbl}>Calls</Text>
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
    { key: 'Contacts', icon: '👥', route: '/contacts' },
    { key: 'Status', icon: '📷', route: '/status' },
    { key: 'Channels', icon: '📢', route: '/broadcast' },
    { key: 'Settings', icon: '⚙️', route: '/settings' },
  ];

  return (
    <View style={s.tabBar}>
      {tabs.map(tab => (
        <TouchableOpacity
          key={tab.key}
          style={s.tabItem}
          onPress={() => router.push(tab.route as any)}
        >
          <Text style={[s.tabIcon, active === tab.key && { color: '#4A9FFF' }]}>
            {tab.icon}
          </Text>
          <Text style={[s.tabLbl, active === tab.key && { color: '#4A9FFF' }]}>
            {tab.key}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  tabBar: { position: 'absolute', bottom: 50, left: 0, right: 0, flexDirection: 'row', backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E9ECEF', paddingVertical: 6, paddingBottom: 24, shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 8 },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { fontSize: 18, color: '#ADB5BD' },
  tabLbl: { fontSize: 11, color: '#ADB5BD', fontWeight: '500' },
  fab: { position: 'absolute', bottom: 80, right: 16, width: 52, height: 52, borderRadius: 26, backgroundColor: '#4A9FFF', justifyContent: 'center', alignItems: 'center', elevation: 6, shadowColor: '#4A9FFF', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6 },
  fabTxt: { fontSize: 22, color: '#FFFFFF' },

  screen: { flex: 1, backgroundColor: '#FFFFFF', padding:3 },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8F9FA', paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: '#E9ECEF' },
  searchIcon: { fontSize: 16, color: '#6C757D' },
  searchInput: { flex: 1, color: '#000000', fontSize: 16 },

  chatContainer: { flex: 1 },

  // Smart filters
  filterRow: { paddingHorizontal: 16, paddingVertical: 2, gap: 4, borderBottomWidth: 0, marginBottom: 0, maxHeight: 34, flexGrow: 0 },
  filterChip: { 
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8F9FA', borderRadius: 12, borderWidth: 1, borderColor: '#DEE2E6', paddingHorizontal: 8, paddingVertical: 4, maxHeight: 32
  },
  filterChipActive: { backgroundColor: '#4A9FFF15', borderColor: '#4A9FFF' },
  filterTxt: { color: '#495057', fontSize: 12, fontWeight: '500', maxHeight: 16 },
  filterTxtActive: { color: '#4A9FFF' },
  filterBadge: { backgroundColor: '#ADB5BD', borderRadius: 4, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, marginLeft: 3 },
  filterBadgeActive: { backgroundColor: '#4A9FFF' },
  filterBadgeTxt: { color: '#FFFFFF', fontSize: 9, fontWeight: '600' },

  // Chat folders
  folderRow: { paddingHorizontal: 16, paddingVertical: 2, gap: 3,  marginBottom: 0, maxHeight: 34, flexGrow: 0 },
  folderChip: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#F8F9FA', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 3, borderWidth: 1, borderColor: '#DEE2E6' },
  folderChipActive: { backgroundColor: '#7C3AED15', borderColor: '#7C3AED' },
  folderTxt: { color: '#495057', fontSize: 11, fontWeight: '500' },
  folderTxtActive: { color: '#7C3AED' },

  archiveToggle: { paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#E9ECEF' },
  archiveTxt: { color: '#4A9FFF', fontSize: 14, fontWeight: '500' },
  chatRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F3F4' },
  avatarWrap: { position: 'relative', marginRight: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  avatarFallback: { backgroundColor: '#E9ECEF', alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#495057', fontSize: 18, fontWeight: '600' },
  onlineDot: { position: 'absolute', bottom: 0, right: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: '#00FF88', borderWidth: 2, borderColor: '#FFFFFF' },
  chatBody: { flex: 1 },
  chatTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  pinIcon: { color: '#FF8C42', fontSize: 11 },
  muteIcon: { color: '#ADB5BD', fontSize: 11 },
  chatName: { color: '#212529', fontSize: 15, fontWeight: '600', flex: 1 },
  chatTime: { color: '#6C757D', fontSize: 12 },
  chatBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatPreview: { color: '#6C757D', fontSize: 13, flex: 1, marginRight: 8 },
  badge: { backgroundColor: '#4A9FFF', borderRadius: 8, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeTxt: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 0 },
  emptyTxt: { color: '#212529', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  emptySub: { color: '#6C757D', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000060', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24, paddingTop: 12, shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 16 },
  sheetRow: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#F1F3F4' },
  sheetTxt: { color: '#212529', fontSize: 16 },
});
