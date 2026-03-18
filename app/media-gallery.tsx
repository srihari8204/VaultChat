// @ts-nocheck
// app/media-gallery.tsx — Media Gallery per Chat
// Shows all photos, videos, files shared in a conversation
// Tab view: Photos | Videos | Files | Links
// Pulls from Firestore messages with mediaUrl

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Dimensions, StatusBar, ActivityIndicator, Linking, Image,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const { width: SW } = Dimensions.get('window');
const TILE = (SW - 48) / 3;
const C = { bg: '#020B18', accent: '#4A9FFF', card: '#0A1628' };

type TabId = 'photos' | 'videos' | 'files' | 'links';

export default function MediaGalleryScreen() {
  const { chatId, peerName } = useLocalSearchParams();
  const [tab, setTab] = useState<TabId>('photos');
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadMedia(); }, []);

  const loadMedia = async () => {
    setLoading(true);
    try {
      const snap = await firestore().collection('chats').doc(chatId as string)
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setMedia(all);
    } catch {}
    setLoading(false);
  };

  const photos = media.filter(m => m.msgType === 'image' && m.mediaUrl && !m.isDeleted);
  const videos = media.filter(m => m.msgType === 'video' && m.mediaUrl && !m.isDeleted);
  const files = media.filter(m => m.msgType === 'file' && m.mediaUrl && !m.isDeleted);
  const links = media.filter(m => {
    const txt = m.ciphertext || m.plaintext || '';
    return txt.match(/https?:\/\//i) && !m.isDeleted;
  });

  const tabData = { photos, videos, files, links };
  const current = tabData[tab];

  const formatDate = (ts) => {
    if (!ts?.toDate) return '';
    return ts.toDate().toLocaleDateString();
  };

  const renderPhoto = ({ item }) => (
    <TouchableOpacity style={s.tile} onPress={() => Linking.openURL(item.mediaUrl).catch(() => {})}>
      <Image source={{ uri: item.mediaUrl }} style={s.tileImg} resizeMode="cover" />
    </TouchableOpacity>
  );

  const renderVideo = ({ item }) => (
    <TouchableOpacity style={s.tile} onPress={() => Linking.openURL(item.mediaUrl).catch(() => {})}>
      <View style={[s.tileImg, { backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ fontSize: 28 }}>{"\u25B6\uFE0F"}</Text>
        <Text style={{ color: '#888', fontSize: 10, marginTop: 4 }}>{item.filename || 'Video'}</Text>
      </View>
    </TouchableOpacity>
  );

  const renderFile = ({ item }) => (
    <TouchableOpacity style={s.fileRow} onPress={() => Linking.openURL(item.mediaUrl).catch(() => {})}>
      <View style={s.fileIcon}><Text style={{ fontSize: 22 }}>{"\uD83D\uDCC4"}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={s.fileName} numberOfLines={1}>{item.filename || 'File'}</Text>
        <Text style={s.fileDate}>{formatDate(item.createdAt)}</Text>
      </View>
      <Text style={{ color: C.accent, fontSize: 12 }}>{"\u2193"}</Text>
    </TouchableOpacity>
  );

  const renderLink = ({ item }) => {
    const txt = item.ciphertext || item.plaintext || '';
    const match = txt.match(/https?:\/\/[^\s]+/i);
    const url = match ? match[0] : '';
    return (
      <TouchableOpacity style={s.fileRow} onPress={() => Linking.openURL(url).catch(() => {})}>
        <View style={s.fileIcon}><Text style={{ fontSize: 22 }}>{"\uD83D\uDD17"}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={s.fileName} numberOfLines={2}>{url}</Text>
          <Text style={s.fileDate}>{formatDate(item.createdAt)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const TABS: { id: TabId; label: string; count: number }[] = [
    { id: 'photos', label: 'Photos', count: photos.length },
    { id: 'videos', label: 'Videos', count: videos.length },
    { id: 'files', label: 'Files', count: files.length },
    { id: 'links', label: 'Links', count: links.length },
  ];

  return (
    <>
      <Stack.Screen options={{ title: (peerName as string || 'Chat') + ' Media', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />
        <View style={s.tabs}>
          {TABS.map(t => (
            <TouchableOpacity key={t.id} style={[s.tab, tab === t.id && s.tabActive]} onPress={() => setTab(t.id)}>
              <Text style={[s.tabTxt, tab === t.id && s.tabTxtActive]}>{t.label}</Text>
              <Text style={[s.tabCount, tab === t.id && { color: '#000' }]}>{t.count}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {loading ? <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} /> : (
          tab === 'photos' ? (
            <FlatList data={photos} numColumns={3} keyExtractor={m => m.id} renderItem={renderPhoto}
              contentContainerStyle={{ padding: 12 }} ListEmptyComponent={<Empty label="No photos shared yet" />} />
          ) : tab === 'videos' ? (
            <FlatList data={videos} numColumns={3} keyExtractor={m => m.id} renderItem={renderVideo}
              contentContainerStyle={{ padding: 12 }} ListEmptyComponent={<Empty label="No videos shared yet" />} />
          ) : tab === 'files' ? (
            <FlatList data={files} keyExtractor={m => m.id} renderItem={renderFile}
              contentContainerStyle={{ padding: 12 }} ListEmptyComponent={<Empty label="No files shared yet" />} />
          ) : (
            <FlatList data={links} keyExtractor={m => m.id} renderItem={renderLink}
              contentContainerStyle={{ padding: 12 }} ListEmptyComponent={<Empty label="No links shared yet" />} />
          )
        )}
      </View>
    </>
  );
}

const Empty = ({ label }: { label: string }) => (
  <View style={{ alignItems: 'center', paddingVertical: 60 }}>
    <Text style={{ color: '#555', fontSize: 14 }}>{label}</Text>
  </View>
);

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: '#0A1628' },
  tabActive: { backgroundColor: C.accent },
  tabTxt: { color: '#888', fontSize: 12, fontWeight: '700' },
  tabTxtActive: { color: '#000' },
  tabCount: { color: '#555', fontSize: 10, marginTop: 2 },
  tile: { width: TILE, height: TILE, margin: 4, borderRadius: 8, overflow: 'hidden' },
  tileImg: { width: '100%', height: '100%', backgroundColor: '#111' },
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: '#111' },
  fileIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  fileName: { color: '#E0E0F0', fontSize: 13, fontWeight: '600' },
  fileDate: { color: '#555', fontSize: 11, marginTop: 2 },
});
