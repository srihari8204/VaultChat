// @ts-nocheck
// app/bookmarks.tsx — Message Bookmarks
// Save important messages across all chats into one searchable collection
// Stored in Firestore: users/{uid}/bookmarks/{id}

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  StatusBar, TextInput, ActivityIndicator, Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#020B18', accent: '#F59E0B', card: '#0A1628', green: '#10B981' };

export default function BookmarksScreen() {
  const router = useRouter();
  const myUid = auth().currentUser?.uid || '';
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => { loadBookmarks(); }, []);

  const loadBookmarks = async () => {
    setLoading(true);
    try {
      const snap = await firestore().collection('users').doc(myUid)
        .collection('bookmarks')
        .orderBy('savedAt', 'desc')
        .limit(100)
        .get();
      setBookmarks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch {}
    setLoading(false);
  };

  const removeBookmark = (bm) => {
    Alert.alert('Remove Bookmark?', 'Remove this saved message?', [
      { text: 'Cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        await firestore().collection('users').doc(myUid).collection('bookmarks').doc(bm.id).delete();
        setBookmarks(prev => prev.filter(b => b.id !== bm.id));
      }},
    ]);
  };

  const filtered = bookmarks.filter(bm => {
    if (search) {
      const q = search.toLowerCase();
      if (!bm.text?.toLowerCase().includes(q) && !bm.chatName?.toLowerCase().includes(q)) return false;
    }
    if (filter === 'media' && !bm.hasMedia) return false;
    if (filter === 'links' && !bm.hasLink) return false;
    return true;
  });

  const formatDate = (ts) => {
    if (!ts?.toDate) return '';
    const d = ts.toDate();
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 86400000) return 'Today';
    if (diff < 172800000) return 'Yesterday';
    return d.toLocaleDateString();
  };

  const getMsgIcon = (bm) => {
    if (bm.msgType === 'image') return '\uD83D\uDDBC\uFE0F';
    if (bm.msgType === 'video') return '\uD83C\uDFA5';
    if (bm.msgType === 'audio') return '\uD83C\uDF99\uFE0F';
    if (bm.msgType === 'file') return '\uD83D\uDCC4';
    if (bm.hasLink) return '\uD83D\uDD17';
    return '\uD83D\uDCAC';
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Bookmarks', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.header}>
          <Text style={{ fontSize: 24 }}>{"\uD83D\uDD16"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.headerTitle}>{bookmarks.length} Saved Messages</Text>
            <Text style={s.headerDesc}>Important messages from all your chats</Text>
          </View>
        </View>

        {/* Search */}
        <TextInput style={s.searchInput} value={search} onChangeText={setSearch}
          placeholder="Search bookmarks..." placeholderTextColor="#555" />

        {/* Filters */}
        <View style={s.filters}>
          {['all', 'media', 'links'].map(f => (
            <TouchableOpacity key={f} style={[s.filterBtn, filter === f && s.filterActive]} onPress={() => setFilter(f)}>
              <Text style={[s.filterTxt, filter === f && s.filterActiveTxt]}>{f === 'all' ? 'All' : f === 'media' ? 'Media' : 'Links'}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? <ActivityIndicator color={C.accent} style={{ marginTop: 30 }} /> : (
          <FlatList
            data={filtered}
            keyExtractor={b => b.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.bmRow}
                onPress={() => { if (item.chatId) router.push({ pathname: '/chat' as any, params: { chatId: item.chatId, peerName: item.chatName } }); }}
                onLongPress={() => removeBookmark(item)}>
                <View style={s.bmIcon}><Text style={{ fontSize: 18 }}>{getMsgIcon(item)}</Text></View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.bmChat}>{item.chatName || 'Chat'}</Text>
                    <Text style={s.bmDate}>{formatDate(item.savedAt)}</Text>
                  </View>
                  <Text style={s.bmText} numberOfLines={3}>{item.text || '[' + (item.msgType || 'message') + ']'}</Text>
                  {item.note && <Text style={s.bmNote}>{"\uD83D\uDCDD"} {item.note}</Text>}
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', padding: 40 }}>
                <Text style={{ fontSize: 40 }}>{"\uD83D\uDD16"}</Text>
                <Text style={{ color: '#555', marginTop: 12 }}>No bookmarks yet</Text>
                <Text style={{ color: '#444', fontSize: 12, marginTop: 4 }}>Long-press any message in a chat and tap "Bookmark"</Text>
              </View>
            }
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '900' },
  headerDesc: { color: '#666', fontSize: 12, marginTop: 2 },
  searchInput: { backgroundColor: C.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14, marginBottom: 8, borderWidth: 1, borderColor: '#111' },
  filters: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, backgroundColor: '#0A1628' },
  filterActive: { backgroundColor: C.accent },
  filterTxt: { color: '#888', fontSize: 12, fontWeight: '600' },
  filterActiveTxt: { color: '#000' },
  bmRow: { flexDirection: 'row', backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: '#111' },
  bmIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  bmChat: { color: C.accent, fontSize: 12, fontWeight: '700' },
  bmDate: { color: '#555', fontSize: 10 },
  bmText: { color: '#E0E0F0', fontSize: 13, marginTop: 4, lineHeight: 19 },
  bmNote: { color: '#888', fontSize: 11, marginTop: 4, fontStyle: 'italic' },
});
