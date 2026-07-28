// app/decoy-chats.tsx — Ghost Protocol Decoy Chat List
// Looks IDENTICAL to real chats.tsx but shows fake data
// No visual indicator of duress mode — pixel-perfect clone

import { Ionicons } from '@expo/vector-icons';
import { BRAND_ACCENT } from '../constants/theme';
import React, { useCallback, useState , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  StatusBar, TextInput, SafeAreaView,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { useFocusEffect, useRouter } from 'expo-router';
import { getDecoyChats, type DecoyChat } from '../lib/ghostProtocol';


const GRADS = [
  '#1D4ED8', '#059669', '#DC2626', '#9333EA', '#0891B2', '#7C3AED', '#F59E0B', '#EC4899',
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function DecoyChatList() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [chats, setChats] = useState<DecoyChat[]>([]);

  // Reload from the persistent decoy store on focus so sent messages / preview
  // updates survive navigation and reload (a real account, not a reset clone).
  useFocusEffect(useCallback(() => {
    let alive = true;
    getDecoyChats().then((c) => { if (alive) setChats(c); }).catch(() => {});
    return () => { alive = false; };
  }, []));

  const filtered = chats.filter(c => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'unread' && c.unread === 0) return false;
    return true;
  });

  const renderChat = ({ item }: any) => {
    const color = GRADS[item.name.charCodeAt(0) % GRADS.length];
    const initials = item.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

    return (
      <TouchableOpacity
        style={s.chatRow}
        onPress={() => router.push({ pathname: '/decoy-chat' as any, params: { chatId: item.id, name: item.name } })}
        activeOpacity={0.7}
      >
        <View style={[s.avatar, { backgroundColor: color }]}>
          <Text style={s.avatarTxt}>{initials}</Text>
        </View>
        <View style={s.chatInfo}>
          <View style={s.chatTop}>
            <Text style={s.chatName} numberOfLines={1}>{item.name}</Text>
            <Text style={[s.chatTime, item.unread > 0 && { color: BRAND_ACCENT }]}>{item.time}</Text>
          </View>
          <View style={s.chatBottom}>
            <Text style={s.chatMsg} numberOfLines={1}>{item.lastMsg}</Text>
            {item.unread > 0 && (
              <View style={s.badge}><Text style={s.badgeTxt}>{item.unread}</Text></View>
            )}
            {item.muted && <Text style={{ color: '#6B7280', fontSize: 12 }}>{"\uD83D\uDD15"}</Text>}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" />

      {/* Header — identical to real chats */}
      <View style={s.header}>
        <Text style={s.title}>VaultChat</Text>
        <View style={s.headerRight}>
          <TouchableOpacity onPress={() => router.push('/search' as any)}>
            <Ionicons name="search" size={20} color="#4A9FFF" />
          </TouchableOpacity>
          <TouchableOpacity style={{ marginLeft: 16 }}>
            <Ionicons name="ellipsis-vertical" size={20} color="#4A9FFF" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Filter tabs */}
      <View style={s.filters}>
        {['all', 'unread', 'groups'].map(f => (
          <TouchableOpacity key={f} style={[s.filterBtn, filter === f && s.filterActive]}
            onPress={() => setFilter(f)}>
            <Text style={[s.filterTxt, filter === f && s.filterActiveTxt]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search */}
      <View style={s.searchBar}>
        <TextInput
          style={s.searchInput}
          placeholder="Search chats..."
          placeholderTextColor="#9CA3AF"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {/* Chat list */}
      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        renderItem={renderChat}
        contentContainerStyle={{ paddingBottom: 100 }}
      />

      {/* Bottom tabs — identical to real app */}
      <View style={s.tabBar}>
        <TouchableOpacity style={s.tab}><Ionicons name="chatbubble" size={20} color="#4A9FFF" /><Text style={[s.tabLabel, { color: '#4A9FFF' }]}>Chats</Text></TouchableOpacity>
        <TouchableOpacity style={s.tab} onPress={() => {}}><Ionicons name="call" size={20} color="#6B7280" /><Text style={s.tabLabel}>Calls</Text></TouchableOpacity>
        <TouchableOpacity style={s.tab} onPress={() => {}}><Ionicons name="people" size={20} color="#6B7280" /><Text style={s.tabLabel}>Contacts</Text></TouchableOpacity>
        <TouchableOpacity style={s.tab} onPress={() => {}}><Ionicons name="lock-closed" size={20} color="#6B7280" /><Text style={s.tabLabel}>Vault</Text></TouchableOpacity>
        <TouchableOpacity style={s.tab} onPress={() => {}}><Ionicons name="settings-outline" size={20} color="#6B7280" /><Text style={s.tabLabel}>Settings</Text></TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  title: { color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  filters: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, backgroundColor: '#F9FAFB' },
  filterActive: { backgroundColor: '#4A9FFF' },
  filterTxt: { color: '#6B7280', fontSize: 13, fontWeight: '600' },
  filterActiveTxt: { color: '#000' },
  searchBar: { paddingHorizontal: 16, marginBottom: 8 },
  searchInput: { backgroundColor: '#F9FAFB', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: '#E5E7EB' },
  chatRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  avatar: { width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center' },
  avatarTxt: { color: '#fff', fontWeight: '900', fontSize: 17 },
  chatInfo: { flex: 1, marginLeft: 12 },
  chatTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatName: { color: '#1F2937', fontSize: 15, fontWeight: '700', flex: 1 },
  chatTime: { color: '#6B7280', fontSize: 11 },
  chatBottom: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  chatMsg: { color: '#9CA3AF', fontSize: 13, flex: 1 },
  badge: { backgroundColor: BRAND_ACCENT, borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6, marginLeft: 8 },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: '800' },
  tabBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: '#070D18', borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingVertical: 8, paddingBottom: 24 },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { fontSize: 20, color: '#6B7280' },
  tabLabel: { fontSize: 10, color: '#6B7280', fontWeight: '600' },
});
