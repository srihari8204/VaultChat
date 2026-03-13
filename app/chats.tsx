// app/chats.tsx
// Real Firestore live listener — no demo data
// All/Unread/Groups/Pinned/Archived tabs
// Search, Vault Features button, Dark Web Guard button
// Bottom navigation

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface Chat {
  id: string;
  name: string;
  lastMsg: string;
  lastTime: any;          // Firestore Timestamp
  lastTimeMs: number;     // for sorting
  unread: number;
  avatar: string;         // initials
  avatarColor: string;
  isGroup: boolean;
  isPinned: boolean;
  isArchived: boolean;
  participants: string[]; // UIDs
  lastSenderId: string;
}

type Tab = 'All' | 'Unread' | 'Groups' | 'Pinned' | 'Archived';

const TABS: Tab[] = ['All', 'Unread', 'Groups', 'Pinned', 'Archived'];

// Colors cycle for avatars based on first letter
const AVATAR_COLORS = [
  '#00D4AA', '#9B5DE5', '#F5C842', '#FF4D6D',
  '#3B82F6', '#F97316', '#EC4899', '#10B981',
];
function colorForName(name: string): string {
  const idx = (name.charCodeAt(0) || 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}
function initialsFor(name: string): string {
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────
// Format timestamp → readable string
// ─────────────────────────────────────────────────────────────────
function formatTime(ts: any): string {
  if (!ts) return '';
  const d: Date = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr  = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1)  return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr  < 24) return `${diffHr}h`;
  if (diffDay < 7)  return `${diffDay}d`;
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function ChatsScreen() {
  const router  = useRouter();
  const uid     = auth().currentUser?.uid || '';

  const [chats,     setChats]     = useState<Chat[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [tab,       setTab]       = useState<Tab>('All');
  const [search,    setSearch]    = useState('');
  const [searching, setSearching] = useState(false);
  const [refreshing,setRefreshing]= useState(false);

  // ── Firestore real-time listener ──────────────────────────────
  useEffect(() => {
    if (!uid) return;

    const unsub = firestore()
      .collection('chats')
      .where('participants', 'array-contains', uid)
      .orderBy('lastTime', 'desc')
      .onSnapshot(
        snap => {
          const data: Chat[] = snap.docs.map(doc => {
            const d = doc.data();
            const name = d.groupName || getOtherName(d.participants, d.names, uid);
            return {
              id:           doc.id,
              name,
              lastMsg:      d.lastMsg      || '',
              lastTime:     d.lastTime     || null,
              lastTimeMs:   d.lastTime?.toMillis?.() || 0,
              unread:       d.unread?.[uid] || 0,
              avatar:       initialsFor(name),
              avatarColor:  colorForName(name),
              isGroup:      d.isGroup      || false,
              isPinned:     d.pinned?.[uid]|| false,
              isArchived:   d.archived?.[uid] || false,
              participants: d.participants || [],
              lastSenderId: d.lastSenderId || '',
            };
          });
          setChats(data);
          setLoading(false);
          setRefreshing(false);
        },
        err => {
          console.error('[Chats] Firestore error:', err);
          setLoading(false);
          setRefreshing(false);
        }
      );

    return () => unsub();
  }, [uid]);

  // Helper — get the other participant's display name from the names map
  function getOtherName(
    participants: string[],
    names: Record<string, string> = {},
    myUid: string
  ): string {
    const other = participants.find(p => p !== myUid);
    if (other && names[other]) return names[other];
    return 'Unknown';
  }

  // ── Filter logic ──────────────────────────────────────────────
  const filtered = chats.filter(c => {
    const matchSearch = search.length === 0 ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.lastMsg.toLowerCase().includes(search.toLowerCase());

    if (!matchSearch) return false;

    switch (tab) {
      case 'Unread':   return c.unread > 0;
      case 'Groups':   return c.isGroup;
      case 'Pinned':   return c.isPinned && !c.isArchived;
      case 'Archived': return c.isArchived;
      default:         return !c.isArchived; // All = everything except archived
    }
  });

  // ── Pin / Archive (long-press actions, future) ────────────────
  const handlePinChat = async (chatId: string, currentlyPinned: boolean) => {
    await firestore()
      .collection('chats')
      .doc(chatId)
      .update({ [`pinned.${uid}`]: !currentlyPinned });
  };

  const handleArchiveChat = async (chatId: string, currentlyArchived: boolean) => {
    await firestore()
      .collection('chats')
      .doc(chatId)
      .update({ [`archived.${uid}`]: !currentlyArchived });
  };

  // ── Mark unread reset on open ─────────────────────────────────
  const openChat = async (chat: Chat) => {
    // Reset unread count for this user
    if (chat.unread > 0) {
      firestore()
        .collection('chats')
        .doc(chat.id)
        .update({ [`unread.${uid}`]: 0 })
        .catch(() => {});
    }
    router.push({
      pathname: '/chat',
      params: { chatId: chat.id, name: chat.name },
    });
  };

  // ── Render each chat row ───────────────────────────────────────
  const renderChat = useCallback(({ item }: { item: Chat }) => (
    <TouchableOpacity
      style={styles.chatRow}
      onPress={() => openChat(item)}
      onLongPress={() => {
        // Future: show pin/archive/mute action sheet
      }}
      activeOpacity={0.7}
    >
      {/* Pinned indicator */}
      {item.isPinned && (
        <View style={styles.pinDot} />
      )}

      {/* Avatar */}
      <View style={[styles.avatar, { borderColor: item.avatarColor }]}>
        <Text style={[styles.avatarText, { color: item.avatarColor }]}>
          {item.avatar}
        </Text>
        {/* Group badge */}
        {item.isGroup && (
          <View style={styles.groupBadge}>
            <Text style={styles.groupBadgeText}>#</Text>
          </View>
        )}
      </View>

      {/* Chat info */}
      <View style={styles.chatInfo}>
        <View style={styles.chatTop}>
          <Text style={styles.chatName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.chatTime}>{formatTime(item.lastTime)}</Text>
        </View>
        <View style={styles.chatBottom}>
          <Text style={styles.chatMsg} numberOfLines={1}>
            {item.lastMsg ? `🔐 ${item.lastMsg}` : 'Start encrypted conversation'}
          </Text>
          {item.unread > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {item.unread > 99 ? '99+' : item.unread}
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  ), [uid]);

  // ── Empty state ───────────────────────────────────────────────
  const renderEmpty = () => {
    if (loading) return null;
    const messages: Record<Tab, { icon: string; text: string }> = {
      All:      { icon: '💬', text: 'No chats yet. Tap ✏️ to start one.' },
      Unread:   { icon: '✉️', text: 'No unread messages.' },
      Groups:   { icon: '👥', text: 'No group chats yet.' },
      Pinned:   { icon: '📌', text: 'No pinned chats.' },
      Archived: { icon: '📦', text: 'No archived chats.' },
    };
    const { icon, text } = messages[tab];
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyIcon}>{icon}</Text>
        <Text style={styles.emptyText}>{text}</Text>
      </View>
    );
  };

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#111827" barStyle="light-content" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>VaultChat</Text>
          <Text style={styles.headerSub}>END-TO-END ENCRYPTED</Text>
        </View>
        <View style={styles.headerBtns}>
          {/* Dark Web Guard */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => router.push('/dark-web-guard')}
          >
            <Text style={styles.iconBtnEmoji}>🌑</Text>
          </TouchableOpacity>
          {/* Vault Features */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => router.push('/vault-features')}
          >
            <Text style={styles.iconBtnEmoji}>⚡</Text>
          </TouchableOpacity>
          {/* Search toggle */}
          <TouchableOpacity
            style={[styles.iconBtn, searching && styles.iconBtnActive]}
            onPress={() => {
              setSearching(s => !s);
              setSearch('');
            }}
          >
            <Text style={styles.iconBtnEmoji}>🔍</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Search bar (shows when 🔍 tapped) ── */}
      {searching && (
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search chats..."
            placeholderTextColor="#374151"
            autoFocus
            clearButtonMode="while-editing"
          />
        </View>
      )}

      {/* ── Filter tabs ── */}
      <View style={styles.tabsWrap}>
        <FlatList
          data={TABS}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={t => t}
          contentContainerStyle={styles.tabs}
          renderItem={({ item: t }) => {
            // Show unread count badge on Unread tab
            const unreadTotal = t === 'Unread'
              ? chats.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0)
              : 0;
            return (
              <TouchableOpacity
                style={[styles.tab, tab === t && styles.tabActive]}
                onPress={() => setTab(t)}
              >
                <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                  {t}
                </Text>
                {unreadTotal > 0 && t === 'Unread' && (
                  <View style={styles.tabBadge}>
                    <Text style={styles.tabBadgeText}>{unreadTotal}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* ── Chat list ── */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#00D4AA" />
          <Text style={styles.loadingText}>Loading chats...</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={renderChat}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => setRefreshing(true)}
              tintColor="#00D4AA"
              colors={['#00D4AA']}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}

      {/* ── New Chat FAB ── */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push('/contacts')}
        activeOpacity={0.85}
      >
        <Text style={styles.fabIcon}>✏️</Text>
      </TouchableOpacity>

      {/* ── Bottom Nav ── */}
      <BottomNav active="Chats" />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Bottom Navigation — shared across all main screens
// ─────────────────────────────────────────────────────────────────

export function BottomNav({ active }: { active: string }) {
  const router = useRouter();
  const items = [
    { icon: '💬', label: 'Chats',   route: '/chats'   },
    { icon: '⭕', label: 'Status',  route: '/status'  },
    { icon: '📞', label: 'Calls',   route: '/calls'   },
    { icon: '🔒', label: 'Vault',   route: '/vault'   },
    { icon: '🔔', label: 'Alerts',  route: '/alerts'  },
    { icon: '👤', label: 'Profile', route: '/profile' },
  ];
  return (
    <View style={navStyles.nav}>
      {items.map(({ icon, label, route }) => (
        <TouchableOpacity
          key={label}
          style={navStyles.item}
          onPress={() => router.replace(route as any)}
          activeOpacity={0.7}
        >
          <Text style={navStyles.icon}>{icon}</Text>
          <Text style={[navStyles.label, active === label && navStyles.labelActive]}>
            {label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0E1A',
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1E293B',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerSub: {
    fontSize: 9,
    color: '#00D4AA',
    fontWeight: 'bold',
    letterSpacing: 0.5,
    marginTop: 1,
  },
  headerBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  iconBtn: {
    width: 36,
    height: 36,
    backgroundColor: '#1A2235',
    borderRadius: 9,
    borderWidth: 0.5,
    borderColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBtnActive: {
    backgroundColor: '#003328',
    borderColor: '#00D4AA',
  },
  iconBtnEmoji: {
    fontSize: 16,
  },

  // Search
  searchWrap: {
    backgroundColor: '#111827',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  searchInput: {
    backgroundColor: '#1A2235',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    color: '#FFFFFF',
    fontSize: 14,
    borderWidth: 0.5,
    borderColor: '#1E293B',
  },

  // Tabs
  tabsWrap: {
    backgroundColor: '#0A0E1A',
    borderBottomWidth: 0.5,
    borderBottomColor: '#111827',
  },
  tabs: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#1A2235',
    borderWidth: 0.5,
    borderColor: '#1E293B',
    gap: 5,
  },
  tabActive: {
    backgroundColor: '#003328',
    borderColor: '#00D4AA',
  },
  tabText: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#00D4AA',
    fontWeight: 'bold',
  },
  tabBadge: {
    backgroundColor: '#00D4AA',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  tabBadgeText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#0A0E1A',
  },

  // Loading
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: '#64748B',
  },

  // List
  listContent: {
    paddingBottom: 100,
    flexGrow: 1,
  },
  separator: {
    height: 0.5,
    backgroundColor: '#111827',
    marginLeft: 76,
  },

  // Chat row
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: '#0A0E1A',
  },
  pinDot: {
    position: 'absolute',
    left: 6,
    top: '50%',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#00D4AA',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#111827',
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  groupBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: '#9B5DE5',
    borderRadius: 7,
    width: 14,
    height: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#0A0E1A',
  },
  groupBadgeText: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  chatInfo: {
    flex: 1,
  },
  chatTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  chatName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#FFFFFF',
    flex: 1,
    marginRight: 8,
  },
  chatTime: {
    fontSize: 11,
    color: '#64748B',
  },
  chatBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chatMsg: {
    fontSize: 13,
    color: '#64748B',
    flex: 1,
    marginRight: 8,
  },
  badge: {
    backgroundColor: '#00D4AA',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 5,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#0A0E1A',
  },

  // Empty
  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
    gap: 12,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyText: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
  },

  // FAB
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 74,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#6C47FF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#6C47FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  fabIcon: {
    fontSize: 22,
  },
});

const navStyles = StyleSheet.create({
  nav: {
    flexDirection: 'row',
    backgroundColor: '#0D1117',
    borderTopWidth: 0.5,
    borderTopColor: '#1E293B',
    paddingBottom: 16,
    paddingTop: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  icon: {
    fontSize: 20,
  },
  label: {
    fontSize: 9,
    color: '#64748B',
  },
  labelActive: {
    color: '#00D4AA',
    fontWeight: 'bold',
  },
});
